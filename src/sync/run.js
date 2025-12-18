import logger from '../util/logger.js';
import createClient from '../kashflow/client.js';
import config from '../config.js';
import progress from '../server/progress.js';

async function run() {
  const start = Date.now();
  let stage = 'initialising';
  const heartbeat = setInterval(() => {
    logger.info({ stage, uptimeMs: Date.now() - start }, 'Sync heartbeat');
  }, 5000);

  const kf = await createClient();
  logger.info('Starting KashFlow admin sync (Node.js)');

  progress.setStage('fetch:lists');
  const [customers, suppliers, projects, nominals] = await Promise.all([
    kf.customers.listAll({ perpage: 200 }),
    kf.suppliers.listAll({ perpage: 200 }),
    kf.projects.listAll({ perpage: 200 }),
    kf.nominals.list(),

  ]);

  progress.setItemTotal('customers', (customers || []).length);
  progress.setItemDone('customers', (customers || []).length);
  logger.info({ customersCount: customers?.length || 0 }, 'Fetched customers');
  progress.setItemTotal('suppliers', (suppliers || []).length);
  progress.setItemDone('suppliers', (suppliers || []).length);
  logger.info({ suppliersCount: suppliers?.length || 0 }, 'Fetched suppliers');
  progress.setItemTotal('projects', (projects || []).length);
  progress.setItemDone('projects', (projects || []).length);
  logger.info({ projectsCount: projects?.length || 0 }, 'Fetched projects');
  progress.setItemTotal('nominals', (nominals || []).length);
  progress.setItemDone('nominals', (nominals || []).length);
  logger.info({ nominalsCount: nominals?.length || 0 }, 'Fetched nominals');
  // Helper: limited concurrency mapper with progress logging
  const pool = async (items, limit, label, handler) => {
    const results = [];
    let i = 0;
    let done = 0;
    const total = items.length;
    const step = Math.max(1, Math.ceil(total / 10));
    const workers = new Array(Math.min(limit, total)).fill(0).map(async () => {
      while (i < total) {
        const idx = i++;
        try {
          results[idx] = await handler(items[idx]);
        } catch (e) {
          logger.warn({ code: items[idx], label }, 'Per-code fetch failed');
          results[idx] = 0;
        } finally {
          done += 1;
          if (done % step === 0 || done === total) {
            logger.info({ label, done, total }, 'Per-code fetch progress');
          }
        }
      }
    });
    await Promise.all(workers);
    return results;
  };

  const customerCodes = (customers || []).map((c) => c.Code || c.code).filter(Boolean);
  const supplierCodes = (suppliers || []).map((s) => s.Code || s.code).filter(Boolean);

  stage = 'invoices:per-customer';
  progress.setStage(stage);
  progress.setItemTotal('invoices', (customers || []).length);
  progress.setItemDone('invoices', 0);
  logger.info({ customers: customerCodes.length, concurrency: config.concurrency || 4 }, 'Starting per-customer invoices fetch');
  const invoiceCounts = await pool(
    customerCodes,
    config.concurrency || 4,
    'invoices',
    async (code) => {
      const n = (await kf.invoices.listAll({ perpage: 200, customerCode: code })).length;
      progress.incItem('invoices', 1);
      return n;
    }
  );
  stage = 'quotes:per-customer';
  progress.setStage(stage);
  progress.setItemTotal('quotes', (customers || []).length);
  progress.setItemDone('quotes', 0);
  logger.info({ customers: customerCodes.length, concurrency: config.concurrency || 4 }, 'Starting per-customer quotes fetch');
  const quoteCounts = await pool(
    customerCodes,
    config.concurrency || 4,
    'quotes',
    async (code) => {
      const n = (await kf.quotes.listAll({ perpage: 200, customerCode: code })).length;
      progress.incItem('quotes', 1);
      return n;
    }
  );
  stage = 'purchases:per-supplier';
  progress.setStage(stage);
  progress.setItemTotal('purchases', (suppliers || []).length);
  progress.setItemDone('purchases', 0);
  logger.info({ suppliers: supplierCodes.length, concurrency: config.concurrency || 4 }, 'Starting per-supplier purchases fetch');
  const purchaseCounts = await pool(
    supplierCodes,
    config.concurrency || 4,
    'purchases',
    async (code) => {
      const n = (await kf.purchases.listAll({ perpage: 200, supplierCode: code })).length;
      progress.incItem('purchases', 1);
      return n;
    }
  );

  const invoicesTotal = invoiceCounts.reduce((a, b) => a + (Number(b) || 0), 0);
  const quotesTotal = quoteCounts.reduce((a, b) => a + (Number(b) || 0), 0);
  const purchasesTotal = purchaseCounts.reduce((a, b) => a + (Number(b) || 0), 0);
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
  clearInterval(heartbeat);
  // Provide previous counts hook for history delta tracking (if available via env or progress)
  const previousCounts = null; // placeholder for future persisted state
  return { counts, previousCounts };
}

if (process.argv[1] && process.argv[1].endsWith('run.js')) {
  run().catch((err) => {
    logger.error({ err }, 'Sync failed');
    process.exitCode = 1;
  });
}

export default run;