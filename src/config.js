import dotenv from 'dotenv';
dotenv.config();

const config = {
  baseUrl: process.env.BASE_URL || process.env.KASHFLOW_BASE_URL || 'https://api.kashflow.com/v2',
  timeoutMs: Number(process.env.HTTP_TIMEOUT_MS || 30000),
  concurrency: Number(process.env.CONCURRENCY || 4),
  detailConcurrency: Number(process.env.DETAIL_CONCURRENCY || 8),
  mongoUri: process.env.MONGO_URI || '',
  mongoHost: process.env.MONGO_HOST || '',
  mongoPort: Number(process.env.MONGO_PORT || 27017),
  mongoDbName: process.env.MONGO_DB_NAME || 'kashflow',
  mongoUsername: process.env.MONGO_USERNAME || process.env.MONGO_USER || '',
  mongoPassword: process.env.MONGO_PASSWORD || process.env.MONGO_PASS || '',
  mongoAuthSource: process.env.MONGO_AUTH_SOURCE || process.env.MONGO_AUTHSOURCE || '',

  cronEnabled: String(process.env.CRON_ENABLED || '').toLowerCase() === 'true' || process.env.CRON_ENABLED === '1',
  cronSchedule: process.env.CRON_SCHEDULE || '0 * * * *',
  cronTimezone: process.env.CRON_TIMEZONE || 'Europe/London',
  cronHealthStaleMs: Number(process.env.CRON_HEALTH_STALE_MS || 0),

  // How long a bank transaction must stay absent from KashFlow before the sweep
  // soft-deletes it. KashFlow paginates the largest account over ~40 requests
  // and has dropped individual rows between pages, so a single absence is not
  // evidence of a deletion. Default 2h ⇒ two consecutive hourly runs must agree.
  // Set to 0 to soft-delete on first absence (the pre-0.11.2 behaviour).
  bankSweepGraceMs: Number(process.env.BANK_SWEEP_GRACE_MS ?? 2 * 60 * 60 * 1000),

  // The same window for quotes, which KashFlow deletes when it converts one to
  // an invoice. A quote absent from its customer's listing gets missingSince,
  // and deletedAt once still absent after this long. Default 2h, as for bank.
  quoteSweepGraceMs: Number(process.env.QUOTE_SWEEP_GRACE_MS ?? 2 * 60 * 60 * 1000),

  // The same for invoices and projects that disappear from their customer's
  // KashFlow listing. Both are rarely deleted and an invoice is a financial
  // record, so the default window is a day rather than 2h: a listing that is
  // wrong for a few runs never hides one.
  invoiceSweepGraceMs: Number(process.env.INVOICE_SWEEP_GRACE_MS ?? 24 * 60 * 60 * 1000),
  projectSweepGraceMs: Number(process.env.PROJECT_SWEEP_GRACE_MS ?? 24 * 60 * 60 * 1000),

  // The same for customers deleted from KashFlow. A deleted customer's quotes,
  // invoices and projects are swept with their own windows above.
  customerSweepGraceMs: Number(process.env.CUSTOMER_SWEEP_GRACE_MS ?? 24 * 60 * 60 * 1000),

  // The same for purchases that disappear from their supplier's KashFlow
  // listing (a financial record, so a day, as for invoices), and for suppliers
  // deleted from KashFlow, whose purchases are swept with the purchase window.
  purchaseSweepGraceMs: Number(process.env.PURCHASE_SWEEP_GRACE_MS ?? 24 * 60 * 60 * 1000),
  supplierSweepGraceMs: Number(process.env.SUPPLIER_SWEEP_GRACE_MS ?? 24 * 60 * 60 * 1000),

  // Debug page: how far syncedAt may lead detailSyncedAt before the diagnosis
  // reports STALE_DETAIL. A record created in a run gets syncedAt when it is
  // first written and detailSyncedAt from a clock taken when the detail phase
  // began, so within one run syncedAt can lead by up to that phase's length
  // (runs take ~6 min). Default 1h covers a slow run several times over.
  staleDetailToleranceMs: Number(process.env.STALE_DETAIL_TOLERANCE_MS ?? 60 * 60 * 1000),

  // Freshness check (src/sync/freshness.js): after each run, the highest stored
  // quote/invoice/project/purchase Number is compared with KashFlow's next free
  // number. A gap larger than this many documents makes the run "completed with
  // warnings" and posts to Discord. A few recently-deleted documents at the top
  // of a sequence legitimately leave a small gap, hence not 0.
  freshnessGapThreshold: Number(process.env.FRESHNESS_GAP_THRESHOLD ?? 5),
};

export default config;