import dotenv from 'dotenv';
dotenv.config();

const config = {
  baseUrl: process.env.BASE_URL || process.env.KASHFLOW_BASE_URL || 'https://api.kashflow.com/v2',
  token: process.env.SESSION_TOKEN || process.env.KASHFLOW_SESSION_TOKEN || '',
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
};

export default config;