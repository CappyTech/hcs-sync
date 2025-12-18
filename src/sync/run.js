import logger from '../util/logger.js';
import createClient from '../kashflow/client.js';

async function run() {
  const kf = await createClient();
  logger.info('Starting KashFlow admin sync (Node.js)');

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

  const invoices = await kf.invoices.list({ page: 1 });
  const purchases = await kf.purchases.list({ page: 1 });
  logger.info({ invoicesCount: invoices?.length || 0 }, 'Fetched invoices');
  logger.info({ purchasesCount: purchases?.length || 0 }, 'Fetched purchases');

  const counts = {
    customers: customers?.length || 0,
    suppliers: suppliers?.length || 0,
    projects: projects?.length || 0,
    nominals: nominals?.length || 0,
    invoices: invoices?.length || 0,
    purchases: purchases?.length || 0,
  };
  logger.info({ counts }, 'KashFlow admin sync (Node.js) finished');
  return { counts };
}

if (process.argv[1] && process.argv[1].endsWith('run.js')) {
  run().catch((err) => {
    logger.error({ err }, 'Sync failed');
    process.exitCode = 1;
  });
}

export default run;