import logger from '../util/logger.js';
import createClient from '../kashflow/client.js';

async function run() {
  const kf = createClient();

  logger.info('Starting KashFlow admin sync (JS)');

  // Example: fetch key resources to validate connectivity
  const [customers, suppliers, projects, nominals] = await Promise.all([
    kf.customers.list({ page: 1 }),
    kf.suppliers.list({ page: 1 }),
    kf.projects.list({ page: 1 }),
    kf.nominals.list(),
  ]);

  logger.info({ customersCount: customers?.length || 0 }, 'Fetched customers');
  logger.info({ suppliersCount: suppliers?.length || 0 }, 'Fetched suppliers');
  logger.info({ projectsCount: projects?.length || 0 }, 'Fetched projects');
  logger.info({ nominalsCount: nominals?.length || 0 }, 'Fetched nominals');

  // TODO: implement upsert logic to local DB or target system
  // Placeholder: iterate invoices and purchases in small pages
  const invoices = await kf.invoices.list({ page: 1 });
  const purchases = await kf.purchases.list({ page: 1 });
  logger.info({ invoicesCount: invoices?.length || 0 }, 'Fetched invoices');
  logger.info({ purchasesCount: purchases?.length || 0 }, 'Fetched purchases');

  logger.info('KashFlow admin sync (JS) finished');
}

// Allow running directly: node js/sync/run.js
if (process.argv[1] && process.argv[1].endsWith('run.js')) {
  run().catch((err) => {
    logger.error({ err }, 'Sync failed');
    process.exitCode = 1;
  });
}

export default run;
