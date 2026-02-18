import crypto from 'node:crypto';
import logger from '../util/logger.js';
import createClient from '../kashflow/client.js';
import config from '../config.js';
import progress from '../server/progress.js';
import { ensureKashflowIndexes, getMongoDb, isMongoEnabled } from '../db/mongo.js';

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

function buildUpsertUpdate({ keyField, keyValue, payload, syncedAt, runId, protectedFields }) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const protectedSet = new Set(protectedFields || []);
  const flattened = {};
  for (const [k, v] of Object.entries(source)) {
    if (!k) continue;
    if (k === '_id') continue;
    if (k === 'data') continue;
    if (k === 'uuid') continue;
    if (k === 'syncedAt') continue;
    if (k === 'createdAt') continue;
    if (k === 'createdByRunId') continue;
    if (k.startsWith('$')) continue;
    if (k.includes('.') || k.includes('\u0000')) continue;
    if (protectedSet.has(k)) continue;
    flattened[k] = v;
  }

  // Store KashFlow fields at the document root so list views show real fields.
  // Preserve our normalized key field (e.g. `code`/`number`) and sync metadata.
  const $set = { ...flattened, [keyField]: keyValue, syncedAt };
  // Assign a v4 UUID on first insert; existing docs keep their uuid untouched.
  const $setOnInsert = {
    uuid: crypto.randomUUID(),
    createdAt: syncedAt,
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
    if (typeof out.getUpsertedIds === 'function') return out.getUpsertedIds() || [];
    if (Array.isArray(out.upsertedIds)) return out.upsertedIds;
    if (out.upsertedIds && typeof out.upsertedIds === 'object') return Object.values(out.upsertedIds);
    return [];
  };

  const applyResult = (out) => {
    upserted += out?.upsertedCount || 0;
    modified += out?.modifiedCount || 0;
    matched += out?.matchedCount || 0;
    // `matchedCount` already includes those that were modified.
    affected += (out?.upsertedCount || 0) + (out?.matchedCount || 0);
  };

  const enqueueWrite = async (opsToWrite) => {
    if (!opsToWrite.length) return;
    attemptedOps += opsToWrite.length;

    const filtersForOps = captureUpserts
      ? opsToWrite.map((op) => op?.updateOne?.filter ?? null)
      : null;

    writeChain = writeChain.then(async () => {
      const out = await collection.bulkWrite(opsToWrite, { ordered: false });
      applyResult(out);

      if (captureUpserts && filtersForOps) {
        const entries = extractUpsertedEntries(out);
        for (const entry of entries) {
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
    });
    // Backpressure: don’t let memory grow unbounded.
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

// CIS fields managed by hcs-app – must not be overwritten by sync.
const SUPPLIER_PROTECTED_FIELDS = ['Subcontractor', 'IsSubcontractor', 'CISRate', 'CISNumber'];

function isMissingKey(value) {
  if (value === null || typeof value === 'undefined') return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

// ── Purchase date / CIS tax-period helpers ──────────────────────────────

/**
 * Convert a KashFlow date string (e.g. "2025-12-10 12:00:00") to a JS Date.
 * Returns null for null / undefined / empty / unparseable values.
 */
function toDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Compute the CIS TaxYear and TaxMonth for a given date.
 *
 * Rules:
 *   Tax year starts 6 April.  A date before 6 April belongs to the previous year.
 *   Tax month 1 = 6 Apr – 5 May, month 2 = 6 May – 5 Jun, …, month 12 = 6 Mar – 5 Apr.
 *
 * Returns { TaxYear: Number, TaxMonth: Number } or null if the date is invalid.
 */
function computeCisTaxPeriod(date) {
  const d = toDate(date);
  if (!d) return null;

  const year  = d.getFullYear();
  const month = d.getMonth();  // 0-based (0 = Jan, 3 = Apr)
  const day   = d.getDate();

  // Tax year that this date falls in (labelled by the starting calendar year).
  const taxYear = (month > 3 || (month === 3 && day >= 6)) ? year : year - 1;

  // Months elapsed since 6 April of the tax year.
  let monthDiff = (month - 3) + (year - taxYear) * 12;
  if (day < 6) monthDiff -= 1;
  const taxMonth = monthDiff + 1; // 1-based

  return { TaxYear: taxYear, TaxMonth: taxMonth };
}

/**
 * Mutate a purchase item in-place:
 *   1. Convert date-string fields to proper JS Date objects.
 *   2. Compute and set TaxYear / TaxMonth from the earliest payment date.
 */
function preparePurchaseForUpsert(item) {
  // --- Convert top-level date fields --------------------------------
  item.PaidDate   = toDate(item.PaidDate);
  item.IssuedDate = toDate(item.IssuedDate);
  item.DueDate    = toDate(item.DueDate);

  // --- Convert PaymentLines date fields -----------------------------
  if (Array.isArray(item.PaymentLines)) {
    for (const pl of item.PaymentLines) {
      pl.PayDate = toDate(pl.PayDate);
      pl.Date    = toDate(pl.Date);
    }
  }

  // --- Derive reference date (priority order) -----------------------
  let refDate = null;
  if (Array.isArray(item.PaymentLines)) {
    for (const pl of item.PaymentLines) {
      if (pl.PayDate) { refDate = pl.PayDate; break; }
    }
  }
  if (!refDate && item.PaidDate)   refDate = item.PaidDate;
  if (!refDate && item.IssuedDate) refDate = item.IssuedDate;

  // --- Compute CIS tax period ---------------------------------------
  const period = computeCisTaxPeriod(refDate);
  if (period) {
    item.TaxYear  = period.TaxYear;
    item.TaxMonth = period.TaxMonth;
  }

  return item;
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
  target.attemptedOps += Number(stats.attemptedOps || 0);
  target.affected += Number(stats.affected || 0);
  target.upserted += Number(stats.upserted || 0);
  target.matched += Number(stats.matched || 0);
  target.modified += Number(stats.modified || 0);
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
    let db = null;
    if (isMongoEnabled()) {
      setStage('mongo:connect');
      db = await getMongoDb();
      await ensureKashflowIndexes(db);
      emitLog('info', 'Mongo connected');
    } else {
      logger.warn('MongoDB not configured; running in fetch-only mode (no upserts)');
      emitLog('warn', 'Mongo not configured; running in fetch-only mode');
    }

    setStage('fetch:lists');
    const [customers, suppliers, projects, nominals] = await Promise.all([
      kf.customers.listAll({ perpage: 200 }),
      kf.suppliers.listAll({ perpage: 200 }),
      kf.projects.listAll({ perpage: 200 }),
      kf.nominals.list(),

    ]);

    const customerCodes = (customers || []).map(pickCode).filter((x) => !isMissingKey(x));
    const supplierCodes = (suppliers || []).map(pickCode).filter((x) => !isMissingKey(x));

    emitLog('info', 'Fetched KashFlow lists', {
      customers: customers?.length || 0,
      suppliers: suppliers?.length || 0,
      projects: projects?.length || 0,
      nominals: nominals?.length || 0,
    });

    // Upsert list payloads (fast path) + optionally fetch details (canonical).
    if (db) {
      setStage('upsert:lists');
      const now = new Date();
      // List payload upserts
      const upsertCustomers = createBulkUpserter(db.collection('customers'), { captureUpserts: true });
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
            update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: c, syncedAt: now, runId }),
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

    const upsertSuppliers = createBulkUpserter(db.collection('suppliers'), { captureUpserts: true });
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
          update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: s, syncedAt: now, runId, protectedFields: SUPPLIER_PROTECTED_FIELDS }),
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

    const upsertProjects = createBulkUpserter(db.collection('projects'), { captureUpserts: true });
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
          update: buildUpsertUpdate({ keyField, keyValue, payload: p, syncedAt: now, runId }),
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

      const upsertNominals = createBulkUpserter(db.collection('nominals'), { captureUpserts: true });
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
            update: buildUpsertUpdate({ keyField, keyValue, payload: n, syncedAt: now, runId }),
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
    }

    // Fetch details for customers/suppliers to capture fields only present in single-item endpoints.
    if (db && customerCodes.length > 0) {
    setStage('customers:details');
    progress.setItemTotal('customers', customerCodes.length);
    progress.setItemDone('customers', 0);
    const upserter = createBulkUpserter(db.collection('customers'), { captureUpserts: true });
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
            update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId }),
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

    if (db && supplierCodes.length > 0) {
    setStage('suppliers:details');
    progress.setItemTotal('suppliers', supplierCodes.length);
    progress.setItemDone('suppliers', 0);
    const upserter = createBulkUpserter(db.collection('suppliers'), { captureUpserts: true });
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
            update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId, protectedFields: SUPPLIER_PROTECTED_FIELDS }),
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
    if (db && projectNumbers.length > 0) {
      setStage('projects:details');
      progress.setItemTotal('projects', projectNumbers.length);
      progress.setItemDone('projects', 0);
      const projectDetailUpserter = createBulkUpserter(db.collection('projects'), { captureUpserts: true });
      const runNow = new Date();
      let projectsDetailFailed = 0;
      const fetchProject = createPool(
        detailConcurrency,
        'projects',
        async (number) => {
          let full;
          try {
            full = await kf.projects.get(number);
          } catch (err) {
            projectsDetailFailed += 1;
            logger.warn({ projectNumber: number, err: err.message }, 'Failed to fetch project detail, skipping');
            progress.incItem('projects', 1);
            return 0;
          }
          const id = pickId(full);
          const keyField = id != null ? 'Id' : 'Number';
          const keyValue = id != null ? id : number;
          await projectDetailUpserter.push({
            updateOne: {
              filter: { [keyField]: keyValue },
              update: buildUpsertUpdate({ keyField, keyValue, payload: full, syncedAt: runNow, runId }),
              upsert: true,
            }
          });
          progress.incItem('projects', 1);
          return 1;
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
    const invoicesListUpserter = db ? createBulkUpserter(db.collection('invoices'), { captureUpserts: true }) : null;
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
                update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: item, syncedAt: runNow, runId }),
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
    if (db && invoiceEntries.length > 0) {
      setStage('invoices:details');
      progress.setItemTotal('invoices', invoiceEntries.length);
      progress.setItemDone('invoices', 0);
      logger.info({ count: invoiceEntries.length, concurrency: detailConcurrency }, 'Starting invoice detail fanout');
      emitLog('info', 'Starting invoice detail fanout', { count: invoiceEntries.length, concurrency: detailConcurrency });
      const invoiceDetailUpserter = createBulkUpserter(db.collection('invoices'), { captureUpserts: true });
      const runNow = new Date();
      await createPool(
        detailConcurrency,
        'invoices',
        async ({ id, number }) => {
          let full;
          try {
            full = await kf.invoices.get(number);
          } catch (err) {
            invoicesDetailFailed += 1;
            logger.warn({ invoiceNumber: number, err: err.message }, 'Failed to fetch invoice detail');
            progress.incItem('invoices', 1);
            return 0;
          }
          await invoiceDetailUpserter.push({
            updateOne: {
              filter: { Id: id },
              update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId }),
              upsert: true,
            }
          });
          progress.incItem('invoices', 1);
          return 1;
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
    const quotesListUpserter = db ? createBulkUpserter(db.collection('quotes'), { captureUpserts: true }) : null;
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
                update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: item, syncedAt: runNow, runId }),
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
    if (db && quoteEntries.length > 0) {
      setStage('quotes:details');
      progress.setItemTotal('quotes', quoteEntries.length);
      progress.setItemDone('quotes', 0);
      logger.info({ count: quoteEntries.length, concurrency: detailConcurrency }, 'Starting quote detail fanout');
      emitLog('info', 'Starting quote detail fanout', { count: quoteEntries.length, concurrency: detailConcurrency });
      const quoteDetailUpserter = createBulkUpserter(db.collection('quotes'), { captureUpserts: true });
      const runNow = new Date();
      await createPool(
        detailConcurrency,
        'quotes',
        async ({ id, number }) => {
          let full;
          try {
            full = await kf.quotes.get(number);
          } catch (err) {
            quotesDetailFailed += 1;
            logger.warn({ quoteNumber: number, err: err.message }, 'Failed to fetch quote detail');
            progress.incItem('quotes', 1);
            return 0;
          }
          await quoteDetailUpserter.push({
            updateOne: {
              filter: { Id: id },
              update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId }),
              upsert: true,
            }
          });
          progress.incItem('quotes', 1);
          return 1;
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
    const purchasesListUpserter = db ? createBulkUpserter(db.collection('purchases'), { captureUpserts: true }) : null;
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
                update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: item, syncedAt: runNow, runId }),
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

    // ── Purchases: Phase 2 — detail fanout with high concurrency ──
    let purchasesDetailFailed = 0;
    if (db && purchaseEntries.length > 0) {
      setStage('purchases:details');
      progress.setItemTotal('purchases', purchaseEntries.length);
      progress.setItemDone('purchases', 0);
      logger.info({ count: purchaseEntries.length, concurrency: detailConcurrency }, 'Starting purchase detail fanout');
      emitLog('info', 'Starting purchase detail fanout', { count: purchaseEntries.length, concurrency: detailConcurrency });
      const purchaseDetailUpserter = createBulkUpserter(db.collection('purchases'), { captureUpserts: true });
      const runNow = new Date();
      await createPool(
        detailConcurrency,
        'purchases',
        async ({ id, number }) => {
          let full;
          try {
            full = await kf.purchases.get(number);
          } catch (err) {
            purchasesDetailFailed += 1;
            logger.warn({ purchaseNumber: number, err: err.message }, 'Failed to fetch purchase detail');
            progress.incItem('purchases', 1);
            return 0;
          }
          preparePurchaseForUpsert(full);
          await purchaseDetailUpserter.push({
            updateOne: {
              filter: { Id: id },
              update: buildUpsertUpdate({ keyField: 'Id', keyValue: id, payload: full, syncedAt: runNow, runId }),
              upsert: true,
            }
          });
          progress.incItem('purchases', 1);
          return 1;
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
      invoices: invoicesTotal,
      quotes: quotesTotal,
      purchases: purchasesTotal,
    };
    setStage('finalising');
    logger.info({ counts, durationMs: Date.now() - start }, 'KashFlow admin sync (Node.js) finished');
    emitLog('success', 'Sync finished', { counts, durationMs: Date.now() - start });
    // Provide previous counts hook for history delta tracking (if available via env or progress)
    const previousCounts = null; // placeholder for future persisted state
    const mongo = db ? mongoSummary : null;
    const mongoUpserts = db ? mongoDetails : null;
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