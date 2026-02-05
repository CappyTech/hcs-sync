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

function buildUpsertUpdate({ keyField, keyValue, payload, syncedAt, runId }) {
  const $set = { [keyField]: keyValue, data: payload, syncedAt };
  const $setOnInsert = runId
    ? { createdAt: syncedAt, createdByRunId: runId }
    : { createdAt: syncedAt };
  return { $set, $setOnInsert };
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
  target.attemptedOps += Number(stats.attemptedOps || 0);
  target.affected += Number(stats.affected || 0);
  target.upserted += Number(stats.upserted || 0);
  target.matched += Number(stats.matched || 0);
  target.modified += Number(stats.modified || 0);
  return target;
}

async function run(options = {}) {
  const runId = options?.runId ? String(options.runId) : null;
  const start = Date.now();
  let stage = 'initialising';
  const mongoSummary = {};
  const mongoDetails = {};
  const heartbeat = setInterval(() => {
    logger.info({ stage, uptimeMs: Date.now() - start }, 'Sync heartbeat');
  }, 5000);
  // Don’t keep the process alive just for the heartbeat timer.
  try { heartbeat.unref?.(); } catch {}

  try {
    stage = 'kashflow:auth';
    const kf = await createClient();
    logger.info('Starting KashFlow admin sync (Node.js)');

    // Prove KashFlow connectivity/auth early.
    // Some KashFlow tenants don’t expose /metadata; treat a successful “small list” as connectivity too.
    try {
      stage = 'kashflow:metadata';
      progress.setStage(stage);
      const meta = await kf.metadata.get();
      logger.info({ hasMeta: Boolean(meta) }, 'KashFlow connectivity check ok');
    } catch (err) {
      if (err?.response?.status === 404) {
        try {
          stage = 'kashflow:probe';
          progress.setStage(stage);
          const sample = await kf.customers.list({ perpage: 1 });
          logger.info({ sampleCount: Array.isArray(sample) ? sample.length : 0 }, 'KashFlow connectivity check ok (probe fallback)');
        } catch (probeErr) {
          logger.error({ status: probeErr.response?.status, message: probeErr.message, data: probeErr.response?.data }, 'KashFlow connectivity probe failed');
          throw probeErr;
        }
      } else {
        logger.error({ status: err.response?.status, message: err.message, data: err.response?.data }, 'KashFlow connectivity check failed');
        throw err;
      }
    }

    // Optional MongoDB sink (skip if not configured).
    let db = null;
    if (isMongoEnabled()) {
      stage = 'mongo:connect';
      progress.setStage(stage);
      db = await getMongoDb();
      await ensureKashflowIndexes(db);
    } else {
      logger.warn('MongoDB not configured; running in fetch-only mode (no upserts)');
    }

    stage = 'fetch:lists';
    progress.setStage(stage);
    const [customers, suppliers, projects, nominals] = await Promise.all([
      kf.customers.listAll({ perpage: 200 }),
      kf.suppliers.listAll({ perpage: 200 }),
      kf.projects.listAll({ perpage: 200 }),
      kf.nominals.list(),

    ]);

    const customerCodes = (customers || []).map(pickCode).filter((x) => !isMissingKey(x));
    const supplierCodes = (suppliers || []).map(pickCode).filter((x) => !isMissingKey(x));

    // Upsert list payloads (fast path) + optionally fetch details (canonical).
    if (db) {
      stage = 'upsert:lists';
      progress.setStage(stage);
      const now = new Date();
      // List payload upserts
      const upsertCustomers = createBulkUpserter(db.collection('customers'), { captureUpserts: true });
      const customersSkip = createSkipCounter();
      for (const c of customers || []) {
        const code = pickCode(c);
        if (isMissingKey(code)) {
          customersSkip.incMissingKey();
          continue;
        }
        await upsertCustomers.push({
          updateOne: {
            filter: { code },
            update: buildUpsertUpdate({ keyField: 'code', keyValue: code, payload: c, syncedAt: now, runId }),
            upsert: true,
          }
        });
      }
      await upsertCustomers.flush();
      mongoSummary.customers = addMongoStats(mongoSummary.customers, upsertCustomers.getStats());
      mongoDetails.customers = upsertCustomers.getUpsertedFilters();
      logger.info({ mongo: { customers: upsertCustomers.getStats() } }, 'Mongo upsert summary (customers list)');
      if (customersSkip.getMissingKey() > 0) {
        logger.warn({ skippedMissingCode: customersSkip.getMissingKey() }, 'Skipped customer upserts with missing code');
      }

    const upsertSuppliers = createBulkUpserter(db.collection('suppliers'), { captureUpserts: true });
    const suppliersSkip = createSkipCounter();
    for (const s of suppliers || []) {
      const code = pickCode(s);
      if (isMissingKey(code)) {
        suppliersSkip.incMissingKey();
        continue;
      }
      await upsertSuppliers.push({
        updateOne: {
          filter: { code },
          update: buildUpsertUpdate({ keyField: 'code', keyValue: code, payload: s, syncedAt: now, runId }),
          upsert: true,
        }
      });
    }
    await upsertSuppliers.flush();
    mongoSummary.suppliers = addMongoStats(mongoSummary.suppliers, upsertSuppliers.getStats());
    mongoDetails.suppliers = upsertSuppliers.getUpsertedFilters();
    logger.info({ mongo: { suppliers: upsertSuppliers.getStats() } }, 'Mongo upsert summary (suppliers list)');
    if (suppliersSkip.getMissingKey() > 0) {
      logger.warn({ skippedMissingCode: suppliersSkip.getMissingKey() }, 'Skipped supplier upserts with missing code');
    }

    const upsertProjects = createBulkUpserter(db.collection('projects'), { captureUpserts: true });
    const projectsSkip = createSkipCounter();
    for (const p of projects || []) {
      const number = pickNumber(p);
      if (number === null || typeof number === 'undefined') {
        projectsSkip.incMissingKey();
        continue;
      }
      await upsertProjects.push({
        updateOne: {
          filter: { number },
          update: buildUpsertUpdate({ keyField: 'number', keyValue: number, payload: p, syncedAt: now, runId }),
          upsert: true,
        }
      });
    }
    await upsertProjects.flush();
    mongoSummary.projects = addMongoStats(mongoSummary.projects, upsertProjects.getStats());
    mongoDetails.projects = upsertProjects.getUpsertedFilters();
    logger.info({ mongo: { projects: upsertProjects.getStats() } }, 'Mongo upsert summary (projects list)');
    if (projectsSkip.getMissingKey() > 0) {
      logger.warn({ skippedMissingNumber: projectsSkip.getMissingKey() }, 'Skipped project upserts with missing number');
    }

      const upsertNominals = createBulkUpserter(db.collection('nominals'), { captureUpserts: true });
      const nominalsSkip = createSkipCounter();
      for (const n of nominals || []) {
        const code = pickCode(n);
        if (isMissingKey(code)) {
          nominalsSkip.incMissingKey();
          continue;
        }
        await upsertNominals.push({
          updateOne: {
            filter: { code },
            update: buildUpsertUpdate({ keyField: 'code', keyValue: code, payload: n, syncedAt: now, runId }),
            upsert: true,
          }
        });
      }
      await upsertNominals.flush();
      mongoSummary.nominals = addMongoStats(mongoSummary.nominals, upsertNominals.getStats());
      mongoDetails.nominals = upsertNominals.getUpsertedFilters();
      logger.info({ mongo: { nominals: upsertNominals.getStats() } }, 'Mongo upsert summary (nominals list)');
      if (nominalsSkip.getMissingKey() > 0) {
        logger.warn({ skippedMissingCode: nominalsSkip.getMissingKey() }, 'Skipped nominal upserts with missing code');
      }
    }

    // Fetch details for customers/suppliers to capture fields only present in single-item endpoints.
    if (db && customerCodes.length > 0) {
    stage = 'customers:details';
    progress.setStage(stage);
    progress.setItemTotal('customers', customerCodes.length);
    progress.setItemDone('customers', 0);
    const upserter = createBulkUpserter(db.collection('customers'), { captureUpserts: true });
    const runNow = new Date();
    const fetchCustomer = createPool(
      config.concurrency || 4,
      'customers',
      async (code) => {
        const full = await kf.customers.get(code);
        await upserter.push({
          updateOne: {
            filter: { code },
            update: buildUpsertUpdate({ keyField: 'code', keyValue: code, payload: full, syncedAt: runNow, runId }),
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
    } else {
      progress.setItemTotal('customers', customerCodes.length);
      progress.setItemDone('customers', customerCodes.length);
    }

    if (db && supplierCodes.length > 0) {
    stage = 'suppliers:details';
    progress.setStage(stage);
    progress.setItemTotal('suppliers', supplierCodes.length);
    progress.setItemDone('suppliers', 0);
    const upserter = createBulkUpserter(db.collection('suppliers'), { captureUpserts: true });
    const runNow = new Date();
    const fetchSupplier = createPool(
      config.concurrency || 4,
      'suppliers',
      async (code) => {
        const full = await kf.suppliers.get(code);
        await upserter.push({
          updateOne: {
            filter: { code },
            update: buildUpsertUpdate({ keyField: 'code', keyValue: code, payload: full, syncedAt: runNow, runId }),
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
    } else {
      progress.setItemTotal('suppliers', supplierCodes.length);
      progress.setItemDone('suppliers', supplierCodes.length);
    }

    progress.setItemTotal('projects', (projects || []).length);
    progress.setItemDone('projects', (projects || []).length);
    logger.info({ projectsCount: projects?.length || 0 }, 'Fetched projects');
    progress.setItemTotal('nominals', (nominals || []).length);
    progress.setItemDone('nominals', (nominals || []).length);
    logger.info({ nominalsCount: nominals?.length || 0 }, 'Fetched nominals');

    stage = 'invoices:per-customer';
    progress.setStage(stage);
    progress.setItemTotal('invoices', (customers || []).length);
    progress.setItemDone('invoices', 0);
    logger.info({ customers: customerCodes.length, concurrency: config.concurrency || 4 }, 'Starting per-customer invoices fetch');
    let invoicesSkippedMissingNumber = 0;
    const invoicesUpserter = db ? createBulkUpserter(db.collection('invoices'), { captureUpserts: true }) : null;
    const invoicesByCustomer = await createPool(
    config.concurrency || 4,
    'invoices',
    async (code) => {
      const list = await kf.invoices.listAll({ perpage: 200, customerCode: code });
      if (db && list?.length) {
        const runNow = new Date();
        for (const item of list) {
          const number = pickNumber(item);
          if (number === null || typeof number === 'undefined') {
            invoicesSkippedMissingNumber += 1;
            continue;
          }
          await invoicesUpserter.push({
            updateOne: {
              filter: { number },
              update: buildUpsertUpdate({ keyField: 'number', keyValue: number, payload: item, syncedAt: runNow, runId }),
              upsert: true,
            }
          });
        }
      }
      progress.incItem('invoices', 1);
      return list?.length || 0;
    },
    ({ done, total }) => {
      const step = Math.max(1, Math.ceil(total / 10));
      if (done % step === 0 || done === total) logger.info({ label: 'invoices', done, total }, 'Per-customer fetch progress');
    }
    )(customerCodes);
    if (invoicesUpserter) {
      await invoicesUpserter.flush();
      mongoSummary.invoices = addMongoStats(mongoSummary.invoices, invoicesUpserter.getStats());
      mongoDetails.invoices = invoicesUpserter.getUpsertedFilters();
      logger.info({ mongo: { invoices: invoicesUpserter.getStats() } }, 'Mongo upsert summary (invoices)');
    }

    stage = 'quotes:per-customer';
    progress.setStage(stage);
    progress.setItemTotal('quotes', (customers || []).length);
    progress.setItemDone('quotes', 0);
    logger.info({ customers: customerCodes.length, concurrency: config.concurrency || 4 }, 'Starting per-customer quotes fetch');
    let quotesSkippedMissingNumber = 0;
    const quotesUpserter = db ? createBulkUpserter(db.collection('quotes'), { captureUpserts: true }) : null;
    const quotesByCustomer = await createPool(
    config.concurrency || 4,
    'quotes',
    async (code) => {
      const list = await kf.quotes.listAll({ perpage: 200, customerCode: code });
      if (db && list?.length) {
        const runNow = new Date();
        for (const item of list) {
          const number = pickNumber(item);
          if (number === null || typeof number === 'undefined') {
            quotesSkippedMissingNumber += 1;
            continue;
          }
          await quotesUpserter.push({
            updateOne: {
              filter: { number },
              update: buildUpsertUpdate({ keyField: 'number', keyValue: number, payload: item, syncedAt: runNow, runId }),
              upsert: true,
            }
          });
        }
      }
      progress.incItem('quotes', 1);
      return list?.length || 0;
    },
    ({ done, total }) => {
      const step = Math.max(1, Math.ceil(total / 10));
      if (done % step === 0 || done === total) logger.info({ label: 'quotes', done, total }, 'Per-customer fetch progress');
    }
    )(customerCodes);
    if (quotesUpserter) {
      await quotesUpserter.flush();
      mongoSummary.quotes = addMongoStats(mongoSummary.quotes, quotesUpserter.getStats());
      mongoDetails.quotes = quotesUpserter.getUpsertedFilters();
      logger.info({ mongo: { quotes: quotesUpserter.getStats() } }, 'Mongo upsert summary (quotes)');
    }

    stage = 'purchases:per-supplier';
    progress.setStage(stage);
    progress.setItemTotal('purchases', (suppliers || []).length);
    progress.setItemDone('purchases', 0);
    logger.info({ suppliers: supplierCodes.length, concurrency: config.concurrency || 4 }, 'Starting per-supplier purchases fetch');
    let purchasesSkippedMissingNumber = 0;
    const purchasesUpserter = db ? createBulkUpserter(db.collection('purchases'), { captureUpserts: true }) : null;
    const purchasesBySupplier = await createPool(
    config.concurrency || 4,
    'purchases',
    async (code) => {
      const list = await kf.purchases.listAll({ perpage: 200, supplierCode: code });
      if (db && list?.length) {
        const runNow = new Date();
        for (const item of list) {
          const number = pickNumber(item);
          if (number === null || typeof number === 'undefined') {
            purchasesSkippedMissingNumber += 1;
            continue;
          }
          await purchasesUpserter.push({
            updateOne: {
              filter: { number },
              update: buildUpsertUpdate({ keyField: 'number', keyValue: number, payload: item, syncedAt: runNow, runId }),
              upsert: true,
            }
          });
        }
      }
      progress.incItem('purchases', 1);
      return list?.length || 0;
    },
    ({ done, total }) => {
      const step = Math.max(1, Math.ceil(total / 10));
      if (done % step === 0 || done === total) logger.info({ label: 'purchases', done, total }, 'Per-supplier fetch progress');
    }
    )(supplierCodes);
    if (purchasesUpserter) {
      await purchasesUpserter.flush();
      mongoSummary.purchases = addMongoStats(mongoSummary.purchases, purchasesUpserter.getStats());
      mongoDetails.purchases = purchasesUpserter.getUpsertedFilters();
      logger.info({ mongo: { purchases: purchasesUpserter.getStats() } }, 'Mongo upsert summary (purchases)');
    }

    const invoicesTotal = invoicesByCustomer.reduce((a, b) => a + (Number(b) || 0), 0);
    const quotesTotal = quotesByCustomer.reduce((a, b) => a + (Number(b) || 0), 0);
    const purchasesTotal = purchasesBySupplier.reduce((a, b) => a + (Number(b) || 0), 0);
    if (invoicesSkippedMissingNumber > 0) {
      logger.warn({ skippedMissingNumber: invoicesSkippedMissingNumber }, 'Skipped invoice upserts with missing number');
    }
    if (quotesSkippedMissingNumber > 0) {
      logger.warn({ skippedMissingNumber: quotesSkippedMissingNumber }, 'Skipped quote upserts with missing number');
    }
    if (purchasesSkippedMissingNumber > 0) {
      logger.warn({ skippedMissingNumber: purchasesSkippedMissingNumber }, 'Skipped purchase upserts with missing number');
    }
    logger.info({ invoicesCount: invoicesTotal }, 'Fetched invoices (per customer)');
    logger.info({ quotesCount: quotesTotal }, 'Fetched quotes (per customer)');
    logger.info({ purchasesCount: purchasesTotal }, 'Fetched purchases (per supplier)');

    const counts = {
      customers: customers?.length || 0,
      suppliers: suppliers?.length || 0,
      projects: projects?.length || 0,
      nominals: nominals?.length || 0,
      invoices: invoicesTotal,
      quotes: quotesTotal,
      purchases: purchasesTotal,
    };
    stage = 'finalising';
    logger.info({ counts, durationMs: Date.now() - start }, 'KashFlow admin sync (Node.js) finished');
    // Provide previous counts hook for history delta tracking (if available via env or progress)
    const previousCounts = null; // placeholder for future persisted state
    const mongo = db ? mongoSummary : null;
    const mongoUpserts = db ? mongoDetails : null;
    return { counts, previousCounts, mongo, mongoUpserts };
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