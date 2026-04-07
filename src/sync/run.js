import crypto from 'node:crypto';
import mongoose from 'mongoose';
import logger from '../util/logger.js';
import createClient from '../kashflow/client.js';
import config from '../config.js';
import progress from '../server/progress.js';
import { connectMongoose, isMongooseEnabled } from '../db/mongoose.js';
import { ensureKashflowIndexes } from '../db/mongo.js';
import { Customer, Supplier, Invoice, Quote, Purchase, Project, Nominal, VATRate, SYNC_INTERNAL_FIELDS, toDate, computeCisTaxPeriod, preparePurchaseForUpsert } from '../server/models/kashflow.js';
import deepDiff from '../util/deepDiff.js';

function createPool(limit, label, handler, onProgress) {
  return async (items) => {
    const results = new Array(items.length);
    let nextIndex = 0;
    let done = 0;
    const total = items.length;
    const workers = new Array(Math.min(limit, total)).fill(0).map(async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= total) return;
        try {
          results[idx] = await handler(items[idx], idx);
        } finally {
          done += 1;
          if (onProgress) onProgress({ label, done, total });
        }
      }
    });
    await Promise.all(workers);
    return results;
  };
}

function buildUpsertUpdate({ keyField, keyValue, payload, syncedAt, runId, model, protectedFields }) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const syncConfig = model?.syncConfig || {};
  const protectedSet = new Set(protectedFields || syncConfig.protectedFields || []);
  const flattened = {};
  for (const [k, v] of Object.entries(source)) {
    if (!k) continue;
    if (SYNC_INTERNAL_FIELDS.has(k)) continue;
    if (k.startsWith('$')) continue;
    if (k.includes('.') || k.includes('\u0000')) continue;
    if (protectedSet.has(k)) continue;
    flattened[k] = v;
  }

  // Store KashFlow fields at the document root so list views show real fields.
  // Preserve our normalized key field (e.g. `code`/`number`) and sync metadata.
  const $set = { ...flattened, [keyField]: keyValue, syncedAt };
  // Assign a v4 UUID on first insert; existing docs keep their uuid untouched.
  // Mongoose timestamps handles createdAt/updatedAt automatically.
  const $setOnInsert = {
    uuid: crypto.randomUUID(),
    ...(runId ? { createdByRunId: runId } : {}),
  };

  // Clean up legacy envelope docs that stored the payload under `data`.
  const $unset = { data: '' };
  return { $set, $setOnInsert, $unset };
}

function createBulkUpserter(collection, batchSize = 250) {
  const options = typeof batchSize === 'object' && batchSize !== null ? batchSize : null;
  const resolvedBatchSize = options ? Number(options.batchSize || 250) : Number(batchSize || 250);
  const captureUpserts = Boolean(options?.captureUpserts);
  const maxCapturedUpserts = Number(options?.maxCapturedUpserts || 2000);

  // Audit options: { auditCollection, runId, collectionName }
  const audit = options?.audit || null;
  let auditedChanges = 0;
  let auditedCreates = 0;

  let pending = [];
  let attemptedOps = 0;
  let affected = 0;
  let upserted = 0;
  let modified = 0;
  let matched = 0;
  let writeChain = Promise.resolve();
  const upsertedFilters = [];
  let upsertedFiltersTruncated = false;

  const extractUpsertedEntries = (out) => {
    if (!out) return [];
    // Mongoose 8 / mongodb driver 6: upsertedIds is a plain object keyed by op index
    // e.g. { "0": ObjectId(...), "5": ObjectId(...) }
    if (out.upsertedIds && typeof out.upsertedIds === 'object' && !Array.isArray(out.upsertedIds)) {
      return Object.entries(out.upsertedIds).map(([idx, _id]) => ({ index: Number(idx), _id }));
    }
    // Fallback: some drivers return an array of { index, _id } directly
    if (Array.isArray(out.upsertedIds)) return out.upsertedIds;
    if (typeof out.getUpsertedIds === 'function') return out.getUpsertedIds() || [];
    return [];
  };

  const applyResult = (out) => {
    upserted += out?.upsertedCount || 0;
    modified += out?.modifiedCount || 0;
    matched += out?.matchedCount || 0;
    affected += (out?.upsertedCount || 0) + (out?.matchedCount || 0);
  };

  /** Batch-read existing documents before the bulkWrite for audit diffing. */
  const preReadForAudit = async (opsToWrite) => {
    if (!audit?.auditCollection) return null;
    try {
      const filters = opsToWrite.map((op) => op?.updateOne?.filter).filter(Boolean);
      if (!filters.length) return null;
      const existingDocs = typeof collection.lean === 'function'
        ? await collection.find({ $or: filters }).lean()
        : await collection.find({ $or: filters }).toArray();
      const docMap = new Map();
      for (const doc of existingDocs) {
        for (const f of filters) {
          const fKeys = Object.keys(f);
          const matches = fKeys.every((k) => doc[k] != null && String(doc[k]) === String(f[k]));
          if (matches) {
            docMap.set(JSON.stringify(f), doc);
            break;
          }
        }
      }
      return docMap;
    } catch (err) {
      logger.warn({ err: err?.message }, 'Audit pre-read failed (non-fatal)');
      return null;
    }
  };

  /** Compute diffs using the pre-read map and write audit entries. */
  const writeAuditEntries = async (opsToWrite, docMap, upsertedEntries) => {
    if (!audit?.auditCollection || !docMap) return;
    try {
      const upsertedSet = new Set((upsertedEntries || []).map((e) => e?.index));
      const auditEntries = [];
      const now = new Date();

      for (let i = 0; i < opsToWrite.length; i++) {
        const op = opsToWrite[i];
        const filter = op?.updateOne?.filter;
        if (!filter) continue;
        const setFields = op?.updateOne?.update?.$set;
        if (!setFields) continue;

        const filterKey = JSON.stringify(filter);
        const existing = docMap.get(filterKey) || null;
        const isCreate = !existing || upsertedSet.has(i);

        if (isCreate) {
          auditEntries.push({
            collection: audit.collectionName,
            documentId: filter.Id ?? filter.Code ?? filter.Number ?? null,
            filter,
            runId: audit.runId || null,
            action: 'create',
            changes: [],
            timestamp: now,
          });
          auditedCreates++;
          continue;
        }

        const changes = deepDiff(existing, setFields);
        if (!changes.length) continue;

        auditEntries.push({
          collection: audit.collectionName,
          documentId: filter.Id ?? filter.Code ?? filter.Number ?? null,
          filter,
          runId: audit.runId || null,
          action: 'update',
          changes,
          timestamp: now,
        });
        auditedChanges++;
      }

      if (auditEntries.length) {
        await audit.auditCollection.insertMany(auditEntries, { ordered: false });
      }
    } catch (err) {
      logger.warn({ err: err?.message, collection: audit.collectionName }, 'Audit write failed (non-fatal)');
    }
  };

  const enqueueWrite = async (opsToWrite) => {
    if (!opsToWrite.length) return;
    attemptedOps += opsToWrite.length;

    const filtersForOps = captureUpserts
      ? opsToWrite.map((op) => op?.updateOne?.filter ?? null)
      : null;

    writeChain = writeChain.then(async () => {
      // Pre-read for audit before the write so we capture the "before" state.
      const preReadDocs = audit ? await preReadForAudit(opsToWrite) : null;

      const out = await collection.bulkWrite(opsToWrite, { ordered: false, timestamps: true });
      applyResult(out);

      const upsertedEntries = extractUpsertedEntries(out);

      if (captureUpserts && filtersForOps) {
        for (const entry of upsertedEntries) {
          const idx = entry?.index;
          if (!Number.isInteger(idx) || idx < 0 || idx >= filtersForOps.length) continue;
          const filter = filtersForOps[idx];
          if (!filter) continue;
          if (upsertedFilters.length >= maxCapturedUpserts) {
            upsertedFiltersTruncated = true;
            continue;
          }
          upsertedFilters.push(filter);
        }
      }

      // Post-write: compute diffs and write audit entries.
      if (preReadDocs) {
        await writeAuditEntries(opsToWrite, preReadDocs, upsertedEntries);
      }
    });
    await writeChain;
  };

  const push = async (op) => {
    pending.push(op);
    if (pending.length < resolvedBatchSize) return;
    const opsToWrite = pending;
    pending = [];
    await enqueueWrite(opsToWrite);
  };

  const flush = async () => {
    const opsToWrite = pending;
    pending = [];
    await enqueueWrite(opsToWrite);
    await writeChain;
  };

  return {
    push,
    flush,
    getStats: () => ({ attemptedOps, affected, upserted, matched, modified }),
    getAuditStats: () => ({ auditedChanges, auditedCreates }),
    getUpsertedFilters: () => ({ filters: upsertedFilters.slice(), truncated: upsertedFiltersTruncated, maxCapturedUpserts }),
  };
}

function pickCode(x) {
  return x?.Code ?? x?.code ?? x?.CustomerCode ?? x?.SupplierCode ?? null;
}

function pickNumber(x) {
  return x?.Number ?? x?.number ?? null;
}

function pickId(x) {
  return x?.Id ?? x?.id ?? null;
}

// Re-exported from Supplier model syncConfig for backward compatibility.
const SUPPLIER_PROTECTED_FIELDS = Supplier.syncConfig.protectedFields;

function isMissingKey(value) {
  if (value === null || typeof value === 'undefined') return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

function createSkipCounter() {
  let skippedMissingKey = 0;
  return {
    incMissingKey: () => {
      skippedMissingKey += 1;
    },
    getMissingKey: () => skippedMissingKey,
  };
}

function addMongoStats(target, stats) {
  if (!stats) return target;
  if (!target) target = { attemptedOps: 0, affected: 0, upserted: 0, matched: 0, modified: 0 };
  const n = (v) => Number(v) || 0;
  target.attemptedOps = n(target.attemptedOps) + n(stats.attemptedOps);
  target.affected = n(target.affected) + n(stats.affected);
  target.upserted = n(target.upserted) + n(stats.upserted);
  target.matched = n(target.matched) + n(stats.matched);
  target.modified = n(target.modified) + n(stats.modified);
  return target;
}

async function run(options = {}) {
  const runId = options?.runId ? String(options.runId) : null;
  const recordLog = typeof options?.recordLog === 'function' ? options.recordLog : null;
  const start = Date.now();
  let stage = 'initialising';

  const emitLog = (level, message, meta) => {
    if (!recordLog) return;
    Promise.resolve(
      recordLog({
        level,
        message,
        stage,
        meta,
      })
    ).catch(() => {});
  };

  const setStage = (nextStage) => {
    stage = nextStage;
    progress.setStage(stage);
    emitLog('info', 'Stage changed', { stage });
  };

  const mongoSummary = {};
  const mongoDetails = {};
  const heartbeat = setInterval(() => {
    logger.info({ stage, uptimeMs: Date.now() - start }, 'Sync heartbeat');
  }, 5000);
  // Don’t keep the process alive just for the heartbeat timer.
  try { heartbeat.unref?.(); } catch {}

  try {
    setStage('kashflow:auth');
    const kf = await createClient();
    logger.info('Starting KashFlow admin sync (Node.js)');
    emitLog('info', 'Starting KashFlow admin sync');

    // Prove KashFlow connectivity/auth early.
    // Some KashFlow tenants don’t expose /metadata; treat a successful “small list” as connectivity too.
    try {
      setStage('kashflow:metadata');
      const meta = await kf.metadata.get();
      logger.info({ hasMeta: Boolean(meta) }, 'KashFlow connectivity check ok');
      emitLog('info', 'KashFlow connectivity check ok', { method: 'metadata', hasMeta: Boolean(meta) });
    } catch (err) {
      if (err?.response?.status === 404) {
        try {
          setStage('kashflow:probe');
          const sample = await kf.customers.list({ perpage: 1 });
          logger.info({ sampleCount: Array.isArray(sample) ? sample.length : 0 }, 'KashFlow connectivity check ok (probe fallback)');
          emitLog('info', 'KashFlow connectivity check ok', { method: 'probe', sampleCount: Array.isArray(sample) ? sample.length : 0 });
        } catch (probeErr) {
          logger.error({ status: probeErr.response?.status, message: probeErr.message, data: probeErr.response?.data }, 'KashFlow connectivity probe failed');
          emitLog('error', 'KashFlow connectivity probe failed', { status: probeErr?.response?.status || null, message: probeErr?.message || null });
          throw probeErr;
        }
      } else {
        logger.error({ status: err.response?.status, message: err.message, data: err.response?.data }, 'KashFlow connectivity check failed');
        emitLog('error', 'KashFlow connectivity check failed', { status: err?.response?.status || null, message: err?.message || null });
        throw err;
      }
    }

    // Optional MongoDB sink (skip if not configured).
    let mongoEnabled = false;
    if (isMongooseEnabled()) {
      setStage('mongo:connect');
      await connectMongoose();
      const db = mongoose.connection.db;
      await ensureKashflowIndexes(db);
      mongoEnabled = true;
      emitLog('info', 'Mongo connected');
    } else {
      logger.warn('MongoDB not configured; running in fetch-only mode (no upserts)');
      emitLog('warn', 'Mongo not configured; running in fetch-only mode');
    }

    const auditCol = mongoEnabled ? mongoose.connection.db.collection('audit_log') : null;
    const auditOpts = (collectionName) => auditCol ? { auditCollection: auditCol, runId, collectionName } : null;

    setStage('fetch:lists');
    const [customers, suppliers, projects, nominals, vatRatesRaw] = await Promise.all([
      kf.customers.listAll({ perpage: 200 }),
      kf.suppliers.listAll({ perpage: 200 }),
      kf.projects.listAll({ perpage: 200 }),
      kf.nominals.list(),
      kf.vatRates.list().catch((e) => { logger.warn({ err: e.message }, 'Failed to fetch VAT rates'); return []; }),
    ]);

    const customerCodes = (customers || []).map(pickCode).filter((x) => !isMissingKey(x));
    const supplierCodes = (suppliers || []).map(pickCode).filter((x) => !isMissingKey(x));

    emitLog('info', 'Fetched KashFlow lists', {
      customers: customers?.length || 0,
      suppliers: suppliers?.length || 0,
      projects: projects?.length || 0,
      nominals: nominals?.length || 0,
      vatRates: vatRatesRaw?.length || 0,
    });

    // Upsert list payloads (fast path) + optionally fetch details (canonical).
    if (mongoEnabled) {
      setStage('upsert:lists');
      const now = new Date();
      // List payload upserts
      const upsertCustomers = createBulkUpserter(Customer, { captureUpserts: true, audit: auditOpts('customers') });
      const customersSkip = createSkipCounter();
      for (const c of customers || []) {
        const id = pickId(c);
        if (id == null) {
          customersSkip.incMissingKey();
          continue;
        }
        await upsertCustomers.push({
          updateOne: {
            filter: { Id: id },
            update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: c, syncedAt: now, runId, model: Customer }),
            upsert: true,
          }
        });
      }
      await upsertCustomers.flush();
      mongoSummary.customers = addMongoStats(mongoSummary.customers, upsertCustomers.getStats());
      mongoDetails.customers = upsertCustomers.getUpsertedFilters();
      logger.info({ mongo: { customers: upsertCustomers.getStats() } }, 'Mongo upsert summary (customers list)');
      emitLog('info', 'Mongo upsert summary (customers list)', { stats: upsertCustomers.getStats() });
      if (customersSkip.getMissingKey() > 0) {
        logger.warn({ skippedMissingId: customersSkip.getMissingKey() }, 'Skipped customer upserts with missing Id');
        emitLog('warn', 'Skipped customer upserts with missing Id', { count: customersSkip.getMissingKey() });
      }

    const upsertSuppliers = createBulkUpserter(Supplier, { captureUpserts: true, audit: auditOpts('suppliers') });
    const suppliersSkip = createSkipCounter();
    for (const s of suppliers || []) {
      const id = pickId(s);
      if (id == null) {
        suppliersSkip.incMissingKey();
        continue;
      }
      await upsertSuppliers.push({
        updateOne: {
          filter: { Id: id },
          update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: s, syncedAt: now, runId, model: Supplier }),
          upsert: true,
        }
      });
    }
    await upsertSuppliers.flush();
    mongoSummary.suppliers = addMongoStats(mongoSummary.suppliers, upsertSuppliers.getStats());
    mongoDetails.suppliers = upsertSuppliers.getUpsertedFilters();
    logger.info({ mongo: { suppliers: upsertSuppliers.getStats() } }, 'Mongo upsert summary (suppliers list)');
    emitLog('info', 'Mongo upsert summary (suppliers list)', { stats: upsertSuppliers.getStats() });
    if (suppliersSkip.getMissingKey() > 0) {
      logger.warn({ skippedMissingId: suppliersSkip.getMissingKey() }, 'Skipped supplier upserts with missing Id');
      emitLog('warn', 'Skipped supplier upserts with missing Id', { count: suppliersSkip.getMissingKey() });
    }

    const upsertProjects = createBulkUpserter(Project, { captureUpserts: true, audit: auditOpts('projects') });
    const projectsSkip = createSkipCounter();
    for (const p of projects || []) {
      const id = pickId(p);
      const number = pickNumber(p);
      const keyField = id != null ? 'Id' : 'Number';
      const keyValue = id != null ? id : number;
      if (keyValue == null) {
        projectsSkip.incMissingKey();
        continue;
      }
      await upsertProjects.push({
        updateOne: {
          filter: { [keyField]: keyValue },
          update: buildUpsertUpdate({ keyField, keyValue, payload: p, syncedAt: now, runId, model: Project }),
          upsert: true,
        }
      });
    }
    await upsertProjects.flush();
    mongoSummary.projects = addMongoStats(mongoSummary.projects, upsertProjects.getStats());
    mongoDetails.projects = upsertProjects.getUpsertedFilters();
    logger.info({ mongo: { projects: upsertProjects.getStats() } }, 'Mongo upsert summary (projects list)');
    emitLog('info', 'Mongo upsert summary (projects list)', { stats: upsertProjects.getStats() });
    if (projectsSkip.getMissingKey() > 0) {
      logger.warn({ skippedMissingId: projectsSkip.getMissingKey() }, 'Skipped project upserts with missing Id/number');
      emitLog('warn', 'Skipped project upserts with missing Id/number', { count: projectsSkip.getMissingKey() });
    }

      const upsertNominals = createBulkUpserter(Nominal, { captureUpserts: true, audit: auditOpts('nominals') });
      const nominalsSkip = createSkipCounter();
      for (const n of nominals || []) {
        const id = pickId(n);
        const code = pickCode(n);
        const keyField = id != null ? 'Id' : 'Code';
        const keyValue = id != null ? id : code;
        if (keyValue == null || (typeof keyValue === 'string' && keyValue.trim() === '')) {
          nominalsSkip.incMissingKey();
          continue;
        }
        await upsertNominals.push({
          updateOne: {
            filter: { [keyField]: keyValue },
            update: buildUpsertUpdate({ keyField, keyValue, payload: n, syncedAt: now, runId, model: Nominal }),
            upsert: true,
          }
        });
      }
      await upsertNominals.flush();
      mongoSummary.nominals = addMongoStats(mongoSummary.nominals, upsertNominals.getStats());
      mongoDetails.nominals = upsertNominals.getUpsertedFilters();
      logger.info({ mongo: { nominals: upsertNominals.getStats() } }, 'Mongo upsert summary (nominals list)');
      emitLog('info', 'Mongo upsert summary (nominals list)', { stats: upsertNominals.getStats() });
      if (nominalsSkip.getMissingKey() > 0) {
        logger.warn({ skippedMissingId: nominalsSkip.getMissingKey() }, 'Skipped nominal upserts with missing Id/code');
        emitLog('warn', 'Skipped nominal upserts with missing Id/code', { count: nominalsSkip.getMissingKey() });
      }

      // VAT rates (from /vat/settings/vatrates → [{ VATId, VATRate, VATText }])
      if (vatRatesRaw && vatRatesRaw.length > 0) {
        const upsertVatRates = createBulkUpserter(VATRate, { captureUpserts: true, audit: auditOpts('vatrates') });
        for (const row of vatRatesRaw) {
          if (typeof row !== 'object' || row == null) continue;
          const vatId = row.VATId;
          if (vatId == null) continue;
          const vatRate = typeof row.VATRate === 'number' ? row.VATRate : parseFloat(row.VATRate);
          const payload = {
            ...row,
            VATId: vatId,
            VATRate: Number.isFinite(vatRate) ? vatRate : null,
            Rate: Number.isFinite(vatRate) ? vatRate : null,
            CountryCode: 'GB',
          };
          await upsertVatRates.push({
            updateOne: {
              filter: { VATId: vatId },
              update: buildUpsertUpdate({ keyField: 'VATId', keyValue: vatId, payload, syncedAt: now, runId, model: VATRate }),
              upsert: true,
            }
          });
        }
        await upsertVatRates.flush();
        mongoSummary.vatRates = addMongoStats(mongoSummary.vatRates, upsertVatRates.getStats());
        mongoDetails.vatRates = upsertVatRates.getUpsertedFilters();
        logger.info({ mongo: { vatRates: upsertVatRates.getStats() } }, 'Mongo upsert summary (vatRates)');
        emitLog('info', 'Mongo upsert summary (vatRates)', { stats: upsertVatRates.getStats() });
      }
    }

    // Fetch details for customers/suppliers to capture fields only present in single-item endpoints.
    if (mongoEnabled && customerCodes.length > 0) {
    setStage('customers:details');
    progress.setItemTotal('customers', customerCodes.length);
    progress.setItemDone('customers', 0);
    const upserter = createBulkUpserter(Customer, { captureUpserts: true, audit: auditOpts('customers') });
    const runNow = new Date();
    const fetchCustomer = createPool(
      config.concurrency || 4,
      'customers',
      async (code) => {
        const full = await kf.customers.get(code);
        const id = pickId(full);
        if (id == null) {
          progress.incItem('customers', 1);
          return 0;
        }
        await upserter.push({
          updateOne: {
            filter: { Id: id },
            update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId, model: Customer }),
            upsert: true,
          }
        });
        progress.incItem('customers', 1);
        return 1;
      },
      undefined
    );
    await fetchCustomer(customerCodes);
    await upserter.flush();
    mongoSummary.customers = addMongoStats(mongoSummary.customers, upserter.getStats());
    // Merge any new upserts captured during the details pass.
    const customerAdded = upserter.getUpsertedFilters();
    if (customerAdded?.filters?.length) {
      const existing = mongoDetails.customers?.filters || [];
      mongoDetails.customers = {
        filters: existing.concat(customerAdded.filters).slice(0, customerAdded.maxCapturedUpserts || 2000),
        truncated: Boolean(mongoDetails.customers?.truncated) || Boolean(customerAdded.truncated),
        maxCapturedUpserts: customerAdded.maxCapturedUpserts || 2000,
      };
    }
    logger.info({ mongo: { customers: upserter.getStats() } }, 'Mongo upsert summary (customers details)');
    emitLog('info', 'Mongo upsert summary (customers details)', { stats: upserter.getStats() });
    } else {
      progress.setItemTotal('customers', customerCodes.length);
      progress.setItemDone('customers', customerCodes.length);
    }

    if (mongoEnabled && supplierCodes.length > 0) {
    setStage('suppliers:details');
    progress.setItemTotal('suppliers', supplierCodes.length);
    progress.setItemDone('suppliers', 0);
    const upserter = createBulkUpserter(Supplier, { captureUpserts: true, audit: auditOpts('suppliers') });
    const runNow = new Date();
    const fetchSupplier = createPool(
      config.concurrency || 4,
      'suppliers',
      async (code) => {
        const full = await kf.suppliers.get(code);
        const id = pickId(full);
        if (id == null) {
          progress.incItem('suppliers', 1);
          return 0;
        }
        await upserter.push({
          updateOne: {
            filter: { Id: id },
            update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId, model: Supplier }),
            upsert: true,
          }
        });
        progress.incItem('suppliers', 1);
        return 1;
      },
      undefined
    );
    await fetchSupplier(supplierCodes);
    await upserter.flush();
    mongoSummary.suppliers = addMongoStats(mongoSummary.suppliers, upserter.getStats());
    const supplierAdded = upserter.getUpsertedFilters();
    if (supplierAdded?.filters?.length) {
      const existing = mongoDetails.suppliers?.filters || [];
      mongoDetails.suppliers = {
        filters: existing.concat(supplierAdded.filters).slice(0, supplierAdded.maxCapturedUpserts || 2000),
        truncated: Boolean(mongoDetails.suppliers?.truncated) || Boolean(supplierAdded.truncated),
        maxCapturedUpserts: supplierAdded.maxCapturedUpserts || 2000,
      };
    }
    logger.info({ mongo: { suppliers: upserter.getStats() } }, 'Mongo upsert summary (suppliers details)');
    emitLog('info', 'Mongo upsert summary (suppliers details)', { stats: upserter.getStats() });
    } else {
      progress.setItemTotal('suppliers', supplierCodes.length);
      progress.setItemDone('suppliers', supplierCodes.length);
    }

    // Fetch full details for each project (list may omit some fields).
    const detailConcurrency = config.detailConcurrency || 8;
    const projectNumbers = (projects || []).map(pickNumber).filter((x) => x != null);
    if (mongoEnabled && projectNumbers.length > 0) {
      setStage('projects:details');
      progress.setItemTotal('projects', projectNumbers.length);
      progress.setItemDone('projects', 0);
      const projectDetailUpserter = createBulkUpserter(Project, { captureUpserts: true, audit: auditOpts('projects') });
      const runNow = new Date();
      let projectsDetailFailed = 0;
      const fetchProject = createPool(
        detailConcurrency,
        'projects',
        async (number) => {
          try {
            const full = await kf.projects.get(number);
            if (!full || typeof full !== 'object') {
              projectsDetailFailed += 1;
              logger.warn({ projectNumber: number }, 'Project detail returned empty response');
              progress.incItem('projects', 1);
              return 0;
            }
            const id = pickId(full);
            const keyField = id != null ? 'Id' : 'Number';
            const keyValue = id != null ? id : number;
            await projectDetailUpserter.push({
              updateOne: {
                filter: { [keyField]: keyValue },
                update: buildUpsertUpdate({ keyField, keyValue, payload: full, syncedAt: runNow, runId, model: Project }),
                upsert: true,
              }
            });
            progress.incItem('projects', 1);
            return 1;
          } catch (err) {
            projectsDetailFailed += 1;
            logger.warn({ projectNumber: number, err: err.message }, 'Failed to process project detail');
            progress.incItem('projects', 1);
            return 0;
          }
        },
        undefined
      );
      await fetchProject(projectNumbers);
      await projectDetailUpserter.flush();
      mongoSummary.projects = addMongoStats(mongoSummary.projects, projectDetailUpserter.getStats());
      const projectAdded = projectDetailUpserter.getUpsertedFilters();
      if (projectAdded?.filters?.length) {
        const existing = mongoDetails.projects?.filters || [];
        mongoDetails.projects = {
          filters: existing.concat(projectAdded.filters).slice(0, projectAdded.maxCapturedUpserts || 2000),
          truncated: Boolean(mongoDetails.projects?.truncated) || Boolean(projectAdded.truncated),
          maxCapturedUpserts: projectAdded.maxCapturedUpserts || 2000,
        };
      }
      if (projectsDetailFailed > 0) {
        logger.warn({ projectsDetailFailed }, 'Some project detail fetches failed');
        emitLog('warn', 'Some project detail fetches failed', { projectsDetailFailed });
      }
      logger.info({ mongo: { projects: projectDetailUpserter.getStats() } }, 'Mongo upsert summary (projects details)');
      emitLog('info', 'Mongo upsert summary (projects details)', { stats: projectDetailUpserter.getStats() });
    } else {
      progress.setItemTotal('projects', (projects || []).length);
      progress.setItemDone('projects', (projects || []).length);
    }
    logger.info({ projectsCount: projects?.length || 0 }, 'Fetched projects');
    progress.setItemTotal('nominals', (nominals || []).length);
    progress.setItemDone('nominals', (nominals || []).length);
    logger.info({ nominalsCount: nominals?.length || 0 }, 'Fetched nominals');

    // ── Invoices: Phase 1 — list + upsert summaries + collect numbers ──
    setStage('invoices:per-customer');
    progress.setItemTotal('invoices', (customers || []).length);
    progress.setItemDone('invoices', 0);
    logger.info({ customers: customerCodes.length, concurrency: config.concurrency || 4 }, 'Starting per-customer invoices list fetch');
    emitLog('info', 'Starting per-customer invoices list fetch', { customers: customerCodes.length, concurrency: config.concurrency || 4 });
    let invoicesSkippedMissingId = 0;
    const invoiceEntries = []; // { id, number } pairs for detail phase
    const invoicesListUpserter = mongoEnabled ? createBulkUpserter(Invoice, { captureUpserts: true, audit: auditOpts('invoices') }) : null;
    const invoicesByCustomer = await createPool(
    config.concurrency || 4,
    'invoices',
    async (code) => {
      const list = await kf.invoices.listAll({ perpage: 200, customerCode: code });
      if (list?.length) {
        const runNow = new Date();
        for (const item of list) {
          const id = pickId(item);
          if (id == null) { invoicesSkippedMissingId += 1; continue; }
          const number = pickNumber(item);
          if (number != null) invoiceEntries.push({ id, number });
          if (invoicesListUpserter) {
            await invoicesListUpserter.push({
              updateOne: {
                filter: { Id: id },
                update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: item, syncedAt: runNow, runId, model: Invoice }),
                upsert: true,
              }
            });
          }
        }
      }
      progress.incItem('invoices', 1);
      return list?.length || 0;
    },
    ({ done, total }) => {
      const step = Math.max(1, Math.ceil(total / 10));
      if (done % step === 0 || done === total) logger.info({ label: 'invoices', done, total }, 'Per-customer list progress');
    }
    )(customerCodes);
    if (invoicesListUpserter) {
      await invoicesListUpserter.flush();
      mongoSummary.invoices = addMongoStats(mongoSummary.invoices, invoicesListUpserter.getStats());
      mongoDetails.invoices = invoicesListUpserter.getUpsertedFilters();
      logger.info({ mongo: { invoices: invoicesListUpserter.getStats() } }, 'Mongo upsert summary (invoices list)');
      emitLog('info', 'Mongo upsert summary (invoices list)', { stats: invoicesListUpserter.getStats() });
    }

    // ── Invoices: Phase 2 — detail fanout with high concurrency ──
    let invoicesDetailFailed = 0;
    if (mongoEnabled && invoiceEntries.length > 0) {
      setStage('invoices:details');
      progress.setItemTotal('invoices', invoiceEntries.length);
      progress.setItemDone('invoices', 0);
      logger.info({ count: invoiceEntries.length, concurrency: detailConcurrency }, 'Starting invoice detail fanout');
      emitLog('info', 'Starting invoice detail fanout', { count: invoiceEntries.length, concurrency: detailConcurrency });
      const invoiceDetailUpserter = createBulkUpserter(Invoice, { captureUpserts: true, audit: auditOpts('invoices') });
      const runNow = new Date();
      await createPool(
        detailConcurrency,
        'invoices',
        async ({ id, number }) => {
          try {
            const full = await kf.invoices.get(number);
            if (!full || typeof full !== 'object') {
              invoicesDetailFailed += 1;
              logger.warn({ invoiceNumber: number, invoiceId: id }, 'Invoice detail returned empty response');
              progress.incItem('invoices', 1);
              return 0;
            }
            const update = buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId, model: Invoice });
            update.$set.detailSyncedAt = runNow;
            await invoiceDetailUpserter.push({
              updateOne: {
                filter: { Id: id },
                update,
                upsert: true,
              }
            });
            progress.incItem('invoices', 1);
            return 1;
          } catch (err) {
            invoicesDetailFailed += 1;
            logger.warn({ invoiceNumber: number, invoiceId: id, err: err.message }, 'Failed to process invoice detail');
            progress.incItem('invoices', 1);
            return 0;
          }
        },
        ({ done, total }) => {
          const step = Math.max(1, Math.ceil(total / 20));
          if (done % step === 0 || done === total) logger.info({ label: 'invoiceDetails', done, total }, 'Invoice detail progress');
        }
      )(invoiceEntries);
      await invoiceDetailUpserter.flush();
      mongoSummary.invoices = addMongoStats(mongoSummary.invoices, invoiceDetailUpserter.getStats());
      const invoiceAdded = invoiceDetailUpserter.getUpsertedFilters();
      if (invoiceAdded?.filters?.length) {
        const existing = mongoDetails.invoices?.filters || [];
        mongoDetails.invoices = {
          filters: existing.concat(invoiceAdded.filters).slice(0, invoiceAdded.maxCapturedUpserts || 2000),
          truncated: Boolean(mongoDetails.invoices?.truncated) || Boolean(invoiceAdded.truncated),
          maxCapturedUpserts: invoiceAdded.maxCapturedUpserts || 2000,
        };
      }
      logger.info({ mongo: { invoices: invoiceDetailUpserter.getStats() } }, 'Mongo upsert summary (invoices details)');
      emitLog('info', 'Mongo upsert summary (invoices details)', { stats: invoiceDetailUpserter.getStats() });
    }
    if (invoicesDetailFailed > 0) {
      logger.warn({ invoicesDetailFailed }, 'Some invoice detail fetches failed; those documents used summary data');
      emitLog('warn', 'Some invoice detail fetches failed', { invoicesDetailFailed });
    }

    // ── Quotes: Phase 1 — list + upsert summaries + collect numbers ──
    setStage('quotes:per-customer');
    progress.setItemTotal('quotes', (customers || []).length);
    progress.setItemDone('quotes', 0);
    logger.info({ customers: customerCodes.length, concurrency: config.concurrency || 4 }, 'Starting per-customer quotes list fetch');
    emitLog('info', 'Starting per-customer quotes list fetch', { customers: customerCodes.length, concurrency: config.concurrency || 4 });
    let quotesSkippedMissingId = 0;
    const quoteEntries = []; // { id, number } pairs for detail phase
    const quotesListUpserter = mongoEnabled ? createBulkUpserter(Quote, { captureUpserts: true, audit: auditOpts('quotes') }) : null;
    const quotesByCustomer = await createPool(
    config.concurrency || 4,
    'quotes',
    async (code) => {
      const list = await kf.quotes.listAll({ perpage: 200, customerCode: code });
      if (list?.length) {
        const runNow = new Date();
        for (const item of list) {
          const id = pickId(item);
          if (id == null) { quotesSkippedMissingId += 1; continue; }
          const number = pickNumber(item);
          if (number != null) quoteEntries.push({ id, number });
          if (quotesListUpserter) {
            await quotesListUpserter.push({
              updateOne: {
                filter: { Id: id },
                update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: item, syncedAt: runNow, runId, model: Quote }),
                upsert: true,
              }
            });
          }
        }
      }
      progress.incItem('quotes', 1);
      return list?.length || 0;
    },
    ({ done, total }) => {
      const step = Math.max(1, Math.ceil(total / 10));
      if (done % step === 0 || done === total) logger.info({ label: 'quotes', done, total }, 'Per-customer list progress');
    }
    )(customerCodes);
    if (quotesListUpserter) {
      await quotesListUpserter.flush();
      mongoSummary.quotes = addMongoStats(mongoSummary.quotes, quotesListUpserter.getStats());
      mongoDetails.quotes = quotesListUpserter.getUpsertedFilters();
      logger.info({ mongo: { quotes: quotesListUpserter.getStats() } }, 'Mongo upsert summary (quotes list)');
      emitLog('info', 'Mongo upsert summary (quotes list)', { stats: quotesListUpserter.getStats() });
    }

    // ── Quotes: Phase 2 — detail fanout with high concurrency ──
    let quotesDetailFailed = 0;
    if (mongoEnabled && quoteEntries.length > 0) {
      setStage('quotes:details');
      progress.setItemTotal('quotes', quoteEntries.length);
      progress.setItemDone('quotes', 0);
      logger.info({ count: quoteEntries.length, concurrency: detailConcurrency }, 'Starting quote detail fanout');
      emitLog('info', 'Starting quote detail fanout', { count: quoteEntries.length, concurrency: detailConcurrency });
      const quoteDetailUpserter = createBulkUpserter(Quote, { captureUpserts: true, audit: auditOpts('quotes') });
      const runNow = new Date();
      await createPool(
        detailConcurrency,
        'quotes',
        async ({ id, number }) => {
          try {
            const full = await kf.quotes.get(number);
            if (!full || typeof full !== 'object') {
              quotesDetailFailed += 1;
              logger.warn({ quoteNumber: number, quoteId: id }, 'Quote detail returned empty response');
              progress.incItem('quotes', 1);
              return 0;
            }
            const update = buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId, model: Quote });
            update.$set.detailSyncedAt = runNow;
            await quoteDetailUpserter.push({
              updateOne: {
                filter: { Id: id },
                update,
                upsert: true,
              }
            });
            progress.incItem('quotes', 1);
            return 1;
          } catch (err) {
            quotesDetailFailed += 1;
            logger.warn({ quoteNumber: number, quoteId: id, err: err.message }, 'Failed to process quote detail');
            progress.incItem('quotes', 1);
            return 0;
          }
        },
        ({ done, total }) => {
          const step = Math.max(1, Math.ceil(total / 20));
          if (done % step === 0 || done === total) logger.info({ label: 'quoteDetails', done, total }, 'Quote detail progress');
        }
      )(quoteEntries);
      await quoteDetailUpserter.flush();
      mongoSummary.quotes = addMongoStats(mongoSummary.quotes, quoteDetailUpserter.getStats());
      const quoteAdded = quoteDetailUpserter.getUpsertedFilters();
      if (quoteAdded?.filters?.length) {
        const existing = mongoDetails.quotes?.filters || [];
        mongoDetails.quotes = {
          filters: existing.concat(quoteAdded.filters).slice(0, quoteAdded.maxCapturedUpserts || 2000),
          truncated: Boolean(mongoDetails.quotes?.truncated) || Boolean(quoteAdded.truncated),
          maxCapturedUpserts: quoteAdded.maxCapturedUpserts || 2000,
        };
      }
      logger.info({ mongo: { quotes: quoteDetailUpserter.getStats() } }, 'Mongo upsert summary (quotes details)');
      emitLog('info', 'Mongo upsert summary (quotes details)', { stats: quoteDetailUpserter.getStats() });
    }
    if (quotesDetailFailed > 0) {
      logger.warn({ quotesDetailFailed }, 'Some quote detail fetches failed; those documents used summary data');
      emitLog('warn', 'Some quote detail fetches failed', { quotesDetailFailed });
    }

    // ── Purchases: Phase 1 — list + upsert summaries + collect numbers ──
    setStage('purchases:per-supplier');
    progress.setItemTotal('purchases', (suppliers || []).length);
    progress.setItemDone('purchases', 0);
    logger.info({ suppliers: supplierCodes.length, concurrency: config.concurrency || 4 }, 'Starting per-supplier purchases list fetch');
    emitLog('info', 'Starting per-supplier purchases list fetch', { suppliers: supplierCodes.length, concurrency: config.concurrency || 4 });
    let purchasesSkippedMissingId = 0;
    const purchaseEntries = []; // { id, number } pairs for detail phase
    const purchasesListUpserter = mongoEnabled ? createBulkUpserter(Purchase, { captureUpserts: true, audit: auditOpts('purchases') }) : null;
    const purchasesBySupplier = await createPool(
    config.concurrency || 4,
    'purchases',
    async (code) => {
      const list = await kf.purchases.listAll({ perpage: 200, supplierCode: code });
      if (list?.length) {
        const runNow = new Date();
        for (const item of list) {
          const id = pickId(item);
          if (id == null) { purchasesSkippedMissingId += 1; continue; }
          const number = pickNumber(item);
          if (number != null) purchaseEntries.push({ id, number });
          if (purchasesListUpserter) {
            await purchasesListUpserter.push({
              updateOne: {
                filter: { Id: id },
                update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: item, syncedAt: runNow, runId, model: Purchase }),
                upsert: true,
              }
            });
          }
        }
      }
      progress.incItem('purchases', 1);
      return list?.length || 0;
    },
    ({ done, total }) => {
      const step = Math.max(1, Math.ceil(total / 10));
      if (done % step === 0 || done === total) logger.info({ label: 'purchases', done, total }, 'Per-supplier list progress');
    }
    )(supplierCodes);
    if (purchasesListUpserter) {
      await purchasesListUpserter.flush();
      mongoSummary.purchases = addMongoStats(mongoSummary.purchases, purchasesListUpserter.getStats());
      mongoDetails.purchases = purchasesListUpserter.getUpsertedFilters();
      logger.info({ mongo: { purchases: purchasesListUpserter.getStats() } }, 'Mongo upsert summary (purchases list)');
      emitLog('info', 'Mongo upsert summary (purchases list)', { stats: purchasesListUpserter.getStats() });
    }
    const purchasesTotal_ = purchasesBySupplier.reduce((s, c) => s + (c || 0), 0);
    logger.info({
      purchasesListTotal: purchasesTotal_,
      purchasesWithNumber: purchaseEntries.length,
      purchasesSkippedMissingId,
      purchasesMissingNumber: purchasesTotal_ - purchaseEntries.length - purchasesSkippedMissingId,
    }, 'Purchase Phase 1 summary');
    emitLog('info', 'Purchase Phase 1 summary', {
      listed: purchasesTotal_,
      withNumber: purchaseEntries.length,
      missingId: purchasesSkippedMissingId,
    });

    // ── Purchases: Phase 2 — detail fanout with high concurrency ──
    let purchasesDetailFailed = 0;
    let purchasesDetailNoLineItems = 0;
    if (mongoEnabled && purchaseEntries.length > 0) {
      setStage('purchases:details');
      progress.setItemTotal('purchases', purchaseEntries.length);
      progress.setItemDone('purchases', 0);
      logger.info({ count: purchaseEntries.length, concurrency: detailConcurrency }, 'Starting purchase detail fanout');
      emitLog('info', 'Starting purchase detail fanout', { count: purchaseEntries.length, concurrency: detailConcurrency });
      const purchaseDetailUpserter = createBulkUpserter(Purchase, { captureUpserts: true, audit: auditOpts('purchases') });
      const runNow = new Date();
      await createPool(
        detailConcurrency,
        'purchases',
        async ({ id, number }) => {
          try {
            const full = await kf.purchases.get(number);
            if (!full || typeof full !== 'object') {
              purchasesDetailFailed += 1;
              logger.warn({ purchaseNumber: number, purchaseId: id }, 'Purchase detail returned empty response');
              progress.incItem('purchases', 1);
              return 0;
            }
            const lineItemsCount = Array.isArray(full.LineItems) ? full.LineItems.length : 0;
            const paymentLinesCount = Array.isArray(full.PaymentLines) ? full.PaymentLines.length : 0;
            if (lineItemsCount === 0) {
              purchasesDetailNoLineItems += 1;
              logger.warn({ purchaseNumber: number, purchaseId: id, paymentLinesCount }, 'Purchase detail returned 0 LineItems');
            }
            Purchase.syncConfig.transform(full);
            const update = buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId, model: Purchase });
            update.$set.detailSyncedAt = runNow;
            await purchaseDetailUpserter.push({
              updateOne: {
                filter: { Id: id },
                update,
                upsert: true,
              }
            });
            progress.incItem('purchases', 1);
            return 1;
          } catch (err) {
            purchasesDetailFailed += 1;
            logger.warn({ purchaseNumber: number, purchaseId: id, err: err.message }, 'Failed to process purchase detail');
            progress.incItem('purchases', 1);
            return 0;
          }
        },
        ({ done, total }) => {
          const step = Math.max(1, Math.ceil(total / 20));
          if (done % step === 0 || done === total) logger.info({ label: 'purchaseDetails', done, total }, 'Purchase detail progress');
        }
      )(purchaseEntries);
      await purchaseDetailUpserter.flush();
      mongoSummary.purchases = addMongoStats(mongoSummary.purchases, purchaseDetailUpserter.getStats());
      const purchaseAdded = purchaseDetailUpserter.getUpsertedFilters();
      if (purchaseAdded?.filters?.length) {
        const existing = mongoDetails.purchases?.filters || [];
        mongoDetails.purchases = {
          filters: existing.concat(purchaseAdded.filters).slice(0, purchaseAdded.maxCapturedUpserts || 2000),
          truncated: Boolean(mongoDetails.purchases?.truncated) || Boolean(purchaseAdded.truncated),
          maxCapturedUpserts: purchaseAdded.maxCapturedUpserts || 2000,
        };
      }
      logger.info({ mongo: { purchases: purchaseDetailUpserter.getStats() } }, 'Mongo upsert summary (purchases details)');
      emitLog('info', 'Mongo upsert summary (purchases details)', { stats: purchaseDetailUpserter.getStats() });
    }
    if (purchasesDetailFailed > 0) {
      logger.warn({ purchasesDetailFailed }, 'Some purchase detail fetches failed; those documents used summary data');
      emitLog('warn', 'Some purchase detail fetches failed', { purchasesDetailFailed });
    }
    if (purchasesDetailNoLineItems > 0) {
      logger.warn({ purchasesDetailNoLineItems, total: purchaseEntries.length }, 'Some purchase detail responses had 0 LineItems');
      emitLog('warn', 'Some purchase detail responses had 0 LineItems', { purchasesDetailNoLineItems });
    }

    const invoicesTotal = invoicesByCustomer.reduce((a, b) => a + (Number(b) || 0), 0);
    const quotesTotal = quotesByCustomer.reduce((a, b) => a + (Number(b) || 0), 0);
    const purchasesTotal = purchasesBySupplier.reduce((a, b) => a + (Number(b) || 0), 0);
    if (invoicesSkippedMissingId > 0) {
      logger.warn({ skippedMissingId: invoicesSkippedMissingId }, 'Skipped invoice upserts with missing Id');
    }
    if (quotesSkippedMissingId > 0) {
      logger.warn({ skippedMissingId: quotesSkippedMissingId }, 'Skipped quote upserts with missing Id');
    }
    if (purchasesSkippedMissingId > 0) {
      logger.warn({ skippedMissingId: purchasesSkippedMissingId }, 'Skipped purchase upserts with missing Id');
    }
    logger.info({ invoicesCount: invoicesTotal }, 'Fetched invoices (per customer)');
    logger.info({ quotesCount: quotesTotal }, 'Fetched quotes (per customer)');
    logger.info({ purchasesCount: purchasesTotal }, 'Fetched purchases (per supplier)');

    emitLog('info', 'Fetched transactional items', { invoices: invoicesTotal, quotes: quotesTotal, purchases: purchasesTotal });

    const counts = {
      customers: customers?.length || 0,
      suppliers: suppliers?.length || 0,
      projects: projects?.length || 0,
      nominals: nominals?.length || 0,
      vatRates: vatRatesRaw?.length || 0,
      invoices: invoicesTotal,
      quotes: quotesTotal,
      purchases: purchasesTotal,
    };
    setStage('finalising');
    logger.info({ counts, durationMs: Date.now() - start }, 'KashFlow admin sync (Node.js) finished');
    emitLog('success', 'Sync finished', { counts, durationMs: Date.now() - start });
    // Provide previous counts hook for history delta tracking (if available via env or progress)
    const previousCounts = null; // placeholder for future persisted state
    const mongo = mongoEnabled ? mongoSummary : null;
    const mongoUpserts = mongoEnabled ? mongoDetails : null;
    return { counts, previousCounts, mongo, mongoUpserts };
  } catch (err) {
    emitLog('error', 'Sync runner failed', { message: err?.message || null, status: err?.response?.status || null });
    throw err;
  } finally {
    try { clearInterval(heartbeat); } catch {}
  }
}

if (process.argv[1] && process.argv[1].endsWith('run.js')) {
  run().catch((err) => {
    logger.error({ err }, 'Sync failed');
    process.exitCode = 1;
  });
}

export default run;

// Named exports for unit testing of internal helpers
export {
  createPool,
  buildUpsertUpdate,
  createBulkUpserter,
  pickCode,
  pickNumber,
  pickId,
  isMissingKey,
  toDate,
  computeCisTaxPeriod,
  preparePurchaseForUpsert,
  createSkipCounter,
  addMongoStats,
  SUPPLIER_PROTECTED_FIELDS,
};