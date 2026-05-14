import crypto from 'node:crypto';
import mongoose from 'mongoose';
import logger from '../util/logger.js';
import createClient from '../kashflow/client.js';
import config from '../config.js';
import progress from '../server/progress.js';
import { connectMongoose, isMongooseEnabled } from '../db/mongoose.js';
import { ensureKashflowIndexes } from '../db/mongo.js';
import { Customer, Supplier, Invoice, Quote, Purchase, Project, Nominal, VATRate, SYNC_INTERNAL_FIELDS, toDate, computeCisTaxPeriod, preparePurchaseForUpsert } from '../server/models/kashflow.js';
import deepDiff, { stableStringify } from '../util/deepDiff.js';

function computePayloadHash(data) {
  return crypto.createHash('sha256').update(stableStringify(data)).digest('hex').slice(0, 16);
}

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

  // Compute a stable content hash so we can detect unchanged documents.
  const newHash = computePayloadHash({ ...flattened, [keyField]: keyValue });
  const newUuid = crypto.randomUUID();

  // Build an aggregation pipeline update (MongoDB 4.2+) so that timestamps
  // are only written when data actually changes:
  //   syncedAt / createdAt / uuid / createdByRunId  → insert-only via $ifNull
  //   updatedAt                                     → only when _kfHash changes
  //   _kfHash                                       → content hash for change detection
  // This means modifiedCount only increments when KashFlow data changed.
  // Data fields are wrapped in $literal to prevent misinterpretation by the
  // aggregation engine (e.g. strings starting with '$', operator-shaped objects).
  const pipelineSet = {
    ...Object.fromEntries(Object.entries(flattened).map(([k, v]) => [k, { $literal: v }])),
    [keyField]: { $literal: keyValue },
    _kfHash: { $literal: newHash },
    syncedAt:        { $ifNull: ['$syncedAt',        '$$NOW'] },
    createdAt:       { $ifNull: ['$createdAt',       '$$NOW'] },
    uuid:            { $ifNull: ['$uuid',            { $literal: newUuid }] },
    ...(runId ? { createdByRunId: { $ifNull: ['$createdByRunId', { $literal: String(runId) }] } } : {}),
    updatedAt: {
      $cond: {
        if:   { $ne: ['$_kfHash', { $literal: newHash }] },
        then: '$$NOW',
        else: { $ifNull: ['$updatedAt', '$$NOW'] },
      },
    },
  };

  // pipeline._rawSet is a JS-only property (not serialised to BSON) that
  // the audit engine reads for deepDiff comparisons.
  const pipeline = [{ $set: pipelineSet }, { $unset: 'data' }];
  pipeline._rawSet = { ...flattened, [keyField]: keyValue };
  return pipeline;
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
        // Pipeline updates store raw payload on _rawSet (not serialised to BSON);
        // legacy updates use $set directly.
        const update = op?.updateOne?.update;
        const setFields = Array.isArray(update) ? update._rawSet : update?.$set;
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

      // Pipeline updates handle timestamps internally via $ifNull / $cond.
      // Only inject timestamps for legacy non-pipeline updates.
      const tsNow = new Date();
      for (const op of opsToWrite) {
        const u = op?.updateOne?.update;
        if (u && !Array.isArray(u)) {
          if (u.$set) u.$set.updatedAt = tsNow;
          if (!u.$setOnInsert) u.$setOnInsert = {};
          u.$setOnInsert.createdAt = tsNow;
        }
      }

      // Use native MongoDB driver — Mongoose 8's bulkWrite casting silently
      // drops complex array sub-documents (LineItems, PaymentLines) during cast.
      const out = await collection.collection.bulkWrite(opsToWrite, { ordered: false });
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

    // Prove KashFlow connectivity — fetch one customer to confirm auth and API access.
    setStage('kashflow:probe');
    try {
      await kf.customers.list({ perpage: 1 });
      logger.info('KashFlow connectivity check ok');
      emitLog('info', 'KashFlow connectivity check ok');
    } catch (probeErr) {
      logger.error({ status: probeErr.response?.status, message: probeErr.message, data: probeErr.response?.data }, 'KashFlow connectivity probe failed');
      emitLog('error', 'KashFlow connectivity probe failed', { status: probeErr?.response?.status || null, message: probeErr?.message || null });
      throw probeErr;
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

    // Upsert list payloads concurrently across independent collections.
    if (mongoEnabled) {
      setStage('upsert:lists');
      const now = new Date();
      await Promise.all([
        (async () => {
          const up = createBulkUpserter(Customer, { captureUpserts: true, audit: auditOpts('customers') });
          const skip = createSkipCounter();
          for (const c of customers || []) {
            const id = pickId(c);
            if (id == null) { skip.incMissingKey(); continue; }
            await up.push({ updateOne: { filter: { Id: id }, update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: c, syncedAt: now, runId, model: Customer }), upsert: true } });
          }
          await up.flush();
          mongoSummary.customers = addMongoStats(mongoSummary.customers, up.getStats());
          mongoDetails.customers = up.getUpsertedFilters();
          logger.info({ mongo: { customers: up.getStats() } }, 'Mongo upsert summary (customers list)');
          emitLog('info', 'Mongo upsert summary (customers list)', { stats: up.getStats() });
          if (skip.getMissingKey() > 0) { logger.warn({ skippedMissingId: skip.getMissingKey() }, 'Skipped customer upserts with missing Id'); emitLog('warn', 'Skipped customer upserts with missing Id', { count: skip.getMissingKey() }); }
        })(),
        (async () => {
          const up = createBulkUpserter(Supplier, { captureUpserts: true, audit: auditOpts('suppliers') });
          const skip = createSkipCounter();
          for (const s of suppliers || []) {
            const id = pickId(s);
            if (id == null) { skip.incMissingKey(); continue; }
            await up.push({ updateOne: { filter: { Id: id }, update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: s, syncedAt: now, runId, model: Supplier }), upsert: true } });
          }
          await up.flush();
          mongoSummary.suppliers = addMongoStats(mongoSummary.suppliers, up.getStats());
          mongoDetails.suppliers = up.getUpsertedFilters();
          logger.info({ mongo: { suppliers: up.getStats() } }, 'Mongo upsert summary (suppliers list)');
          emitLog('info', 'Mongo upsert summary (suppliers list)', { stats: up.getStats() });
          if (skip.getMissingKey() > 0) { logger.warn({ skippedMissingId: skip.getMissingKey() }, 'Skipped supplier upserts with missing Id'); emitLog('warn', 'Skipped supplier upserts with missing Id', { count: skip.getMissingKey() }); }
        })(),
        (async () => {
          const up = createBulkUpserter(Project, { captureUpserts: true, audit: auditOpts('projects') });
          const skip = createSkipCounter();
          for (const p of projects || []) {
            const id = pickId(p);
            const number = pickNumber(p);
            const keyField = id != null ? 'Id' : 'Number';
            const keyValue = id != null ? id : number;
            if (keyValue == null) { skip.incMissingKey(); continue; }
            await up.push({ updateOne: { filter: { [keyField]: keyValue }, update: buildUpsertUpdate({ keyField, keyValue, payload: p, syncedAt: now, runId, model: Project }), upsert: true } });
          }
          await up.flush();
          mongoSummary.projects = addMongoStats(mongoSummary.projects, up.getStats());
          mongoDetails.projects = up.getUpsertedFilters();
          logger.info({ mongo: { projects: up.getStats() } }, 'Mongo upsert summary (projects list)');
          emitLog('info', 'Mongo upsert summary (projects list)', { stats: up.getStats() });
          if (skip.getMissingKey() > 0) { logger.warn({ skippedMissingId: skip.getMissingKey() }, 'Skipped project upserts with missing Id/number'); emitLog('warn', 'Skipped project upserts with missing Id/number', { count: skip.getMissingKey() }); }
        })(),
        (async () => {
          const up = createBulkUpserter(Nominal, { captureUpserts: true, audit: auditOpts('nominals') });
          const skip = createSkipCounter();
          for (const n of nominals || []) {
            const id = pickId(n);
            const code = pickCode(n);
            const keyField = id != null ? 'Id' : 'Code';
            const keyValue = id != null ? id : code;
            if (keyValue == null || (typeof keyValue === 'string' && keyValue.trim() === '')) { skip.incMissingKey(); continue; }
            await up.push({ updateOne: { filter: { [keyField]: keyValue }, update: buildUpsertUpdate({ keyField, keyValue, payload: n, syncedAt: now, runId, model: Nominal }), upsert: true } });
          }
          await up.flush();
          mongoSummary.nominals = addMongoStats(mongoSummary.nominals, up.getStats());
          mongoDetails.nominals = up.getUpsertedFilters();
          logger.info({ mongo: { nominals: up.getStats() } }, 'Mongo upsert summary (nominals list)');
          emitLog('info', 'Mongo upsert summary (nominals list)', { stats: up.getStats() });
          if (skip.getMissingKey() > 0) { logger.warn({ skippedMissingId: skip.getMissingKey() }, 'Skipped nominal upserts with missing Id/code'); emitLog('warn', 'Skipped nominal upserts with missing Id/code', { count: skip.getMissingKey() }); }
        })(),
        (async () => {
          if (!vatRatesRaw?.length) return;
          const up = createBulkUpserter(VATRate, { captureUpserts: true, audit: auditOpts('vatrates') });
          for (const row of vatRatesRaw) {
            if (typeof row !== 'object' || row == null) continue;
            const vatId = row.VATId;
            if (vatId == null) continue;
            const vatRate = typeof row.VATRate === 'number' ? row.VATRate : parseFloat(row.VATRate);
            const payload = { ...row, VATId: vatId, VATRate: Number.isFinite(vatRate) ? vatRate : null, Rate: Number.isFinite(vatRate) ? vatRate : null, CountryCode: 'GB' };
            await up.push({ updateOne: { filter: { VATId: vatId }, update: buildUpsertUpdate({ keyField: 'VATId', keyValue: vatId, payload, syncedAt: now, runId, model: VATRate }), upsert: true } });
          }
          await up.flush();
          mongoSummary.vatRates = addMongoStats(mongoSummary.vatRates, up.getStats());
          mongoDetails.vatRates = up.getUpsertedFilters();
          logger.info({ mongo: { vatRates: up.getStats() } }, 'Mongo upsert summary (vatRates)');
          emitLog('info', 'Mongo upsert summary (vatRates)', { stats: up.getStats() });
        })(),
      ]);
    }

    // Detail fetch phases — customers, suppliers, projects, invoices, quotes, purchases all run concurrently.
    // Within each transactional entity, phase 1 (list) runs first then feeds phase 2 (details).
    const detailConcurrency = config.detailConcurrency || 8;
    const projectNumbers = (projects || []).map(pickNumber).filter((x) => x != null);
    const [, , , invoicesTotal, quotesTotal, purchasesTotal] = await Promise.all([

      // ── Customer details ──────────────────────────────────────────────────
      (async () => {
        if (!mongoEnabled || customerCodes.length === 0) {
          progress.setItemTotal('customers', customerCodes.length);
          progress.setItemDone('customers', customerCodes.length);
          return;
        }
        setStage('customers:details');
        progress.setItemTotal('customers', customerCodes.length);
        progress.setItemDone('customers', 0);
        const upserter = createBulkUpserter(Customer, { captureUpserts: true, audit: auditOpts('customers') });
        const runNow = new Date();
        await createPool(config.concurrency || 4, 'customers', async (code) => {
          const full = await kf.customers.get(code);
          const id = pickId(full);
          if (id == null) { progress.incItem('customers', 1); return 0; }
          await upserter.push({ updateOne: { filter: { Id: id }, update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId, model: Customer }), upsert: true } });
          progress.incItem('customers', 1);
          return 1;
        }, undefined)(customerCodes);
        await upserter.flush();
        mongoSummary.customers = addMongoStats(mongoSummary.customers, upserter.getStats());
        const added = upserter.getUpsertedFilters();
        if (added?.filters?.length) {
          const existing = mongoDetails.customers?.filters || [];
          mongoDetails.customers = { filters: existing.concat(added.filters).slice(0, added.maxCapturedUpserts || 2000), truncated: Boolean(mongoDetails.customers?.truncated) || Boolean(added.truncated), maxCapturedUpserts: added.maxCapturedUpserts || 2000 };
        }
        logger.info({ mongo: { customers: upserter.getStats() } }, 'Mongo upsert summary (customers details)');
        emitLog('info', 'Mongo upsert summary (customers details)', { stats: upserter.getStats() });
      })(),

      // ── Supplier details ──────────────────────────────────────────────────
      (async () => {
        if (!mongoEnabled || supplierCodes.length === 0) {
          progress.setItemTotal('suppliers', supplierCodes.length);
          progress.setItemDone('suppliers', supplierCodes.length);
          return;
        }
        setStage('suppliers:details');
        progress.setItemTotal('suppliers', supplierCodes.length);
        progress.setItemDone('suppliers', 0);
        const upserter = createBulkUpserter(Supplier, { captureUpserts: true, audit: auditOpts('suppliers') });
        const runNow = new Date();
        await createPool(config.concurrency || 4, 'suppliers', async (code) => {
          const full = await kf.suppliers.get(code);
          const id = pickId(full);
          if (id == null) { progress.incItem('suppliers', 1); return 0; }
          await upserter.push({ updateOne: { filter: { Id: id }, update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId, model: Supplier }), upsert: true } });
          progress.incItem('suppliers', 1);
          return 1;
        }, undefined)(supplierCodes);
        await upserter.flush();
        mongoSummary.suppliers = addMongoStats(mongoSummary.suppliers, upserter.getStats());
        const added = upserter.getUpsertedFilters();
        if (added?.filters?.length) {
          const existing = mongoDetails.suppliers?.filters || [];
          mongoDetails.suppliers = { filters: existing.concat(added.filters).slice(0, added.maxCapturedUpserts || 2000), truncated: Boolean(mongoDetails.suppliers?.truncated) || Boolean(added.truncated), maxCapturedUpserts: added.maxCapturedUpserts || 2000 };
        }
        logger.info({ mongo: { suppliers: upserter.getStats() } }, 'Mongo upsert summary (suppliers details)');
        emitLog('info', 'Mongo upsert summary (suppliers details)', { stats: upserter.getStats() });
      })(),

      // ── Project details ───────────────────────────────────────────────────
      (async () => {
        if (!mongoEnabled || projectNumbers.length === 0) {
          progress.setItemTotal('projects', (projects || []).length);
          progress.setItemDone('projects', (projects || []).length);
          logger.info({ projectsCount: projects?.length || 0 }, 'Fetched projects');
          return;
        }
        setStage('projects:details');
        progress.setItemTotal('projects', projectNumbers.length);
        progress.setItemDone('projects', 0);
        const projectDetailUpserter = createBulkUpserter(Project, { captureUpserts: true, audit: auditOpts('projects') });
        const runNow = new Date();
        let projectsDetailFailed = 0;
        await createPool(detailConcurrency, 'projects', async (number) => {
          try {
            const full = await kf.projects.get(number);
            if (!full || typeof full !== 'object') { projectsDetailFailed += 1; logger.warn({ projectNumber: number }, 'Project detail returned empty response'); progress.incItem('projects', 1); return 0; }
            const id = pickId(full);
            const keyField = id != null ? 'Id' : 'Number';
            const keyValue = id != null ? id : number;
            await projectDetailUpserter.push({ updateOne: { filter: { [keyField]: keyValue }, update: buildUpsertUpdate({ keyField, keyValue, payload: full, syncedAt: runNow, runId, model: Project }), upsert: true } });
            progress.incItem('projects', 1);
            return 1;
          } catch (err) {
            projectsDetailFailed += 1;
            logger.warn({ projectNumber: number, err: err.message }, 'Failed to process project detail');
            progress.incItem('projects', 1);
            return 0;
          }
        }, undefined)(projectNumbers);
        await projectDetailUpserter.flush();
        mongoSummary.projects = addMongoStats(mongoSummary.projects, projectDetailUpserter.getStats());
        const added = projectDetailUpserter.getUpsertedFilters();
        if (added?.filters?.length) {
          const existing = mongoDetails.projects?.filters || [];
          mongoDetails.projects = { filters: existing.concat(added.filters).slice(0, added.maxCapturedUpserts || 2000), truncated: Boolean(mongoDetails.projects?.truncated) || Boolean(added.truncated), maxCapturedUpserts: added.maxCapturedUpserts || 2000 };
        }
        if (projectsDetailFailed > 0) { logger.warn({ projectsDetailFailed }, 'Some project detail fetches failed'); emitLog('warn', 'Some project detail fetches failed', { projectsDetailFailed }); }
        logger.info({ mongo: { projects: projectDetailUpserter.getStats() } }, 'Mongo upsert summary (projects details)');
        emitLog('info', 'Mongo upsert summary (projects details)', { stats: projectDetailUpserter.getStats() });
        logger.info({ projectsCount: projects?.length || 0 }, 'Fetched projects');
      })(),

      // ── Invoices: per-customer list then detail fanout ────────────────────
      (async () => {
        setStage('invoices:per-customer');
        progress.setItemTotal('invoices', (customers || []).length);
        progress.setItemDone('invoices', 0);
        logger.info({ customers: customerCodes.length, concurrency: config.concurrency || 4 }, 'Starting per-customer invoices list fetch');
        emitLog('info', 'Starting per-customer invoices list fetch', { customers: customerCodes.length, concurrency: config.concurrency || 4 });
        let invoicesSkippedMissingId = 0;
        const invoiceEntries = [];
        const invoicesByCustomer = await createPool(config.concurrency || 4, 'invoices', async (code) => {
          const list = await kf.invoices.listAll({ perpage: 200, customerCode: code });
          if (list?.length) {
            for (const item of list) {
              const id = pickId(item);
              if (id == null) { invoicesSkippedMissingId += 1; continue; }
              const number = pickNumber(item);
              if (number != null) invoiceEntries.push({ id, number });
            }
          }
          progress.incItem('invoices', 1);
          return list?.length || 0;
        }, ({ done, total }) => { const step = Math.max(1, Math.ceil(total / 10)); if (done % step === 0 || done === total) logger.info({ label: 'invoices', done, total }, 'Per-customer list progress'); })(customerCodes);
        const invoicesTotal = invoicesByCustomer.reduce((a, b) => a + (Number(b) || 0), 0);
        let invoicesDetailFailed = 0;
        if (mongoEnabled && invoiceEntries.length > 0) {
          setStage('invoices:details');
          progress.setItemTotal('invoices', invoiceEntries.length);
          progress.setItemDone('invoices', 0);
          logger.info({ count: invoiceEntries.length, concurrency: detailConcurrency }, 'Starting invoice detail fanout');
          emitLog('info', 'Starting invoice detail fanout', { count: invoiceEntries.length, concurrency: detailConcurrency });
          const invoiceDetailUpserter = createBulkUpserter(Invoice, { captureUpserts: true, audit: auditOpts('invoices') });
          const runNow = new Date();
          await createPool(detailConcurrency, 'invoices', async ({ id, number }) => {
            try {
              const full = await kf.invoices.get(number);
              if (!full || typeof full !== 'object') { invoicesDetailFailed += 1; logger.warn({ invoiceNumber: number, invoiceId: id }, 'Invoice detail returned empty response'); progress.incItem('invoices', 1); return 0; }
              const update = buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId, model: Invoice });
              update[0].$set.detailSyncedAt = { $literal: runNow };
              update._rawSet.detailSyncedAt = runNow;
              await invoiceDetailUpserter.push({ updateOne: { filter: { Id: id }, update, upsert: true } });
              progress.incItem('invoices', 1);
              return 1;
            } catch (err) { invoicesDetailFailed += 1; logger.warn({ invoiceNumber: number, invoiceId: id, err: err.message }, 'Failed to process invoice detail'); progress.incItem('invoices', 1); return 0; }
          }, ({ done, total }) => { const step = Math.max(1, Math.ceil(total / 20)); if (done % step === 0 || done === total) logger.info({ label: 'invoiceDetails', done, total }, 'Invoice detail progress'); })(invoiceEntries);
          await invoiceDetailUpserter.flush();
          mongoSummary.invoices = addMongoStats(mongoSummary.invoices, invoiceDetailUpserter.getStats());
          const added = invoiceDetailUpserter.getUpsertedFilters();
          if (added?.filters?.length) {
            const existing = mongoDetails.invoices?.filters || [];
            mongoDetails.invoices = { filters: existing.concat(added.filters).slice(0, added.maxCapturedUpserts || 2000), truncated: Boolean(mongoDetails.invoices?.truncated) || Boolean(added.truncated), maxCapturedUpserts: added.maxCapturedUpserts || 2000 };
          }
          logger.info({ mongo: { invoices: invoiceDetailUpserter.getStats() } }, 'Mongo upsert summary (invoices details)');
          emitLog('info', 'Mongo upsert summary (invoices details)', { stats: invoiceDetailUpserter.getStats() });
        }
        if (invoicesSkippedMissingId > 0) logger.warn({ skippedMissingId: invoicesSkippedMissingId }, 'Skipped invoice upserts with missing Id');
        if (invoicesDetailFailed > 0) { logger.warn({ invoicesDetailFailed }, 'Some invoice detail fetches failed; those documents used summary data'); emitLog('warn', 'Some invoice detail fetches failed', { invoicesDetailFailed }); }
        logger.info({ invoicesCount: invoicesTotal }, 'Fetched invoices (per customer)');
        return invoicesTotal;
      })(),

      // ── Quotes: per-customer list then detail fanout ──────────────────────
      (async () => {
        setStage('quotes:per-customer');
        progress.setItemTotal('quotes', (customers || []).length);
        progress.setItemDone('quotes', 0);
        logger.info({ customers: customerCodes.length, concurrency: config.concurrency || 4 }, 'Starting per-customer quotes list fetch');
        emitLog('info', 'Starting per-customer quotes list fetch', { customers: customerCodes.length, concurrency: config.concurrency || 4 });
        let quotesSkippedMissingId = 0;
        const quoteEntries = [];
        const quotesByCustomer = await createPool(config.concurrency || 4, 'quotes', async (code) => {
          const list = await kf.quotes.listAll({ perpage: 200, customerCode: code });
          if (list?.length) {
            for (const item of list) {
              const id = pickId(item);
              if (id == null) { quotesSkippedMissingId += 1; continue; }
              const number = pickNumber(item);
              if (number != null) quoteEntries.push({ id, number });
            }
          }
          progress.incItem('quotes', 1);
          return list?.length || 0;
        }, ({ done, total }) => { const step = Math.max(1, Math.ceil(total / 10)); if (done % step === 0 || done === total) logger.info({ label: 'quotes', done, total }, 'Per-customer list progress'); })(customerCodes);
        const quotesTotal = quotesByCustomer.reduce((a, b) => a + (Number(b) || 0), 0);
        let quotesDetailFailed = 0;
        if (mongoEnabled && quoteEntries.length > 0) {
          setStage('quotes:details');
          progress.setItemTotal('quotes', quoteEntries.length);
          progress.setItemDone('quotes', 0);
          logger.info({ count: quoteEntries.length, concurrency: detailConcurrency }, 'Starting quote detail fanout');
          emitLog('info', 'Starting quote detail fanout', { count: quoteEntries.length, concurrency: detailConcurrency });
          const quoteDetailUpserter = createBulkUpserter(Quote, { captureUpserts: true, audit: auditOpts('quotes') });
          const runNow = new Date();
          await createPool(detailConcurrency, 'quotes', async ({ id, number }) => {
            try {
              const full = await kf.quotes.get(number);
              if (!full || typeof full !== 'object') { quotesDetailFailed += 1; logger.warn({ quoteNumber: number, quoteId: id }, 'Quote detail returned empty response'); progress.incItem('quotes', 1); return 0; }
              const update = buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId, model: Quote });
              update[0].$set.detailSyncedAt = { $literal: runNow };
              update._rawSet.detailSyncedAt = runNow;
              await quoteDetailUpserter.push({ updateOne: { filter: { Id: id }, update, upsert: true } });
              progress.incItem('quotes', 1);
              return 1;
            } catch (err) { quotesDetailFailed += 1; logger.warn({ quoteNumber: number, quoteId: id, err: err.message }, 'Failed to process quote detail'); progress.incItem('quotes', 1); return 0; }
          }, ({ done, total }) => { const step = Math.max(1, Math.ceil(total / 20)); if (done % step === 0 || done === total) logger.info({ label: 'quoteDetails', done, total }, 'Quote detail progress'); })(quoteEntries);
          await quoteDetailUpserter.flush();
          mongoSummary.quotes = addMongoStats(mongoSummary.quotes, quoteDetailUpserter.getStats());
          const added = quoteDetailUpserter.getUpsertedFilters();
          if (added?.filters?.length) {
            const existing = mongoDetails.quotes?.filters || [];
            mongoDetails.quotes = { filters: existing.concat(added.filters).slice(0, added.maxCapturedUpserts || 2000), truncated: Boolean(mongoDetails.quotes?.truncated) || Boolean(added.truncated), maxCapturedUpserts: added.maxCapturedUpserts || 2000 };
          }
          logger.info({ mongo: { quotes: quoteDetailUpserter.getStats() } }, 'Mongo upsert summary (quotes details)');
          emitLog('info', 'Mongo upsert summary (quotes details)', { stats: quoteDetailUpserter.getStats() });
        }
        if (quotesSkippedMissingId > 0) logger.warn({ skippedMissingId: quotesSkippedMissingId }, 'Skipped quote upserts with missing Id');
        if (quotesDetailFailed > 0) { logger.warn({ quotesDetailFailed }, 'Some quote detail fetches failed; those documents used summary data'); emitLog('warn', 'Some quote detail fetches failed', { quotesDetailFailed }); }
        logger.info({ quotesCount: quotesTotal }, 'Fetched quotes (per customer)');
        return quotesTotal;
      })(),

      // ── Purchases: per-supplier list then detail fanout ───────────────────
      (async () => {
        setStage('purchases:per-supplier');
        progress.setItemTotal('purchases', (suppliers || []).length);
        progress.setItemDone('purchases', 0);
        logger.info({ suppliers: supplierCodes.length, concurrency: config.concurrency || 4 }, 'Starting per-supplier purchases list fetch');
        emitLog('info', 'Starting per-supplier purchases list fetch', { suppliers: supplierCodes.length, concurrency: config.concurrency || 4 });
        let purchasesSkippedMissingId = 0;
        const purchaseEntries = [];
        const purchasesBySupplier = await createPool(config.concurrency || 4, 'purchases', async (code) => {
          const list = await kf.purchases.listAll({ perpage: 200, supplierCode: code });
          if (list?.length) {
            for (const item of list) {
              const id = pickId(item);
              if (id == null) { purchasesSkippedMissingId += 1; continue; }
              const number = pickNumber(item);
              if (number != null) purchaseEntries.push({ id, number });
            }
          }
          progress.incItem('purchases', 1);
          return list?.length || 0;
        }, ({ done, total }) => { const step = Math.max(1, Math.ceil(total / 10)); if (done % step === 0 || done === total) logger.info({ label: 'purchases', done, total }, 'Per-supplier list progress'); })(supplierCodes);
        const purchasesTotal = purchasesBySupplier.reduce((s, c) => s + (c || 0), 0);
        logger.info({ purchasesListTotal: purchasesTotal, purchasesWithNumber: purchaseEntries.length, purchasesSkippedMissingId, purchasesMissingNumber: purchasesTotal - purchaseEntries.length - purchasesSkippedMissingId }, 'Purchase Phase 1 summary');
        emitLog('info', 'Purchase Phase 1 summary', { listed: purchasesTotal, withNumber: purchaseEntries.length, missingId: purchasesSkippedMissingId });
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
          await createPool(detailConcurrency, 'purchases', async ({ id, number }) => {
            try {
              const full = await kf.purchases.get(number);
              if (!full || typeof full !== 'object') { purchasesDetailFailed += 1; logger.warn({ purchaseNumber: number, purchaseId: id }, 'Purchase detail returned empty response'); progress.incItem('purchases', 1); return 0; }
              const lineItemsCount = Array.isArray(full.LineItems) ? full.LineItems.length : 0;
              const paymentLinesCount = Array.isArray(full.PaymentLines) ? full.PaymentLines.length : 0;
              if (lineItemsCount === 0) { purchasesDetailNoLineItems += 1; logger.warn({ purchaseNumber: number, purchaseId: id, paymentLinesCount }, 'Purchase detail returned 0 LineItems'); }
              Purchase.syncConfig.transform(full);
              const update = buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId, model: Purchase });
              update[0].$set.detailSyncedAt = { $literal: runNow };
              update._rawSet.detailSyncedAt = runNow;
              await purchaseDetailUpserter.push({ updateOne: { filter: { Id: id }, update, upsert: true } });
              progress.incItem('purchases', 1);
              return 1;
            } catch (err) { purchasesDetailFailed += 1; logger.warn({ purchaseNumber: number, purchaseId: id, err: err.message }, 'Failed to process purchase detail'); progress.incItem('purchases', 1); return 0; }
          }, ({ done, total }) => { const step = Math.max(1, Math.ceil(total / 20)); if (done % step === 0 || done === total) logger.info({ label: 'purchaseDetails', done, total }, 'Purchase detail progress'); })(purchaseEntries);
          await purchaseDetailUpserter.flush();
          mongoSummary.purchases = addMongoStats(mongoSummary.purchases, purchaseDetailUpserter.getStats());
          const added = purchaseDetailUpserter.getUpsertedFilters();
          if (added?.filters?.length) {
            const existing = mongoDetails.purchases?.filters || [];
            mongoDetails.purchases = { filters: existing.concat(added.filters).slice(0, added.maxCapturedUpserts || 2000), truncated: Boolean(mongoDetails.purchases?.truncated) || Boolean(added.truncated), maxCapturedUpserts: added.maxCapturedUpserts || 2000 };
          }
          logger.info({ mongo: { purchases: purchaseDetailUpserter.getStats() } }, 'Mongo upsert summary (purchases details)');
          emitLog('info', 'Mongo upsert summary (purchases details)', { stats: purchaseDetailUpserter.getStats() });
        }
        if (purchasesDetailFailed > 0) { logger.warn({ purchasesDetailFailed }, 'Some purchase detail fetches failed; those documents used summary data'); emitLog('warn', 'Some purchase detail fetches failed', { purchasesDetailFailed }); }
        if (purchasesDetailNoLineItems > 0) { logger.warn({ purchasesDetailNoLineItems, total: purchaseEntries.length }, 'Some purchase detail responses had 0 LineItems'); emitLog('warn', 'Some purchase detail responses had 0 LineItems', { purchasesDetailNoLineItems }); }
        if (purchasesSkippedMissingId > 0) logger.warn({ skippedMissingId: purchasesSkippedMissingId }, 'Skipped purchase upserts with missing Id');
        logger.info({ purchasesCount: purchasesTotal }, 'Fetched purchases (per supplier)');
        return purchasesTotal;
      })(),
    ]);

    progress.setItemTotal('nominals', (nominals || []).length);
    progress.setItemDone('nominals', (nominals || []).length);
    logger.info({ nominalsCount: nominals?.length || 0 }, 'Fetched nominals');
    emitLog('info', 'Fetched transactional items', { invoices: invoicesTotal ?? 0, quotes: quotesTotal ?? 0, purchases: purchasesTotal ?? 0 })
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