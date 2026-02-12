import dotenv from 'dotenv';
dotenv.config();

function buildMongoUriFromParts(env) {
  const host = env.MONGO_HOST || '';
  if (!host) return '';

  const port = String(env.MONGO_PORT || '27017');
  const username = env.MONGO_USERNAME || '';
  const password = env.MONGO_PASSWORD || '';

  const hasAuth = Boolean(username && password);
  const authPart = hasAuth
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : '';

  const authSource = env.MONGO_AUTH_SOURCE || 'admin';
  const query = hasAuth && authSource ? `?authSource=${encodeURIComponent(authSource)}` : '';

  return `mongodb://${authPart}${host}:${port}${query}`;
}

const config = {
  baseUrl: process.env.BASE_URL || process.env.KASHFLOW_BASE_URL || 'https://api.kashflow.com/v2',
  token: process.env.SESSION_TOKEN || process.env.KASHFLOW_SESSION_TOKEN || '',
  timeoutMs: Number(process.env.HTTP_TIMEOUT_MS || 30000),
  concurrency: Number(process.env.CONCURRENCY || 4),
  mongoUri: process.env.MONGO_URI || buildMongoUriFromParts(process.env) || '',
  mongoDbName: process.env.MONGO_DB_NAME || '',
  mongoMigrateEnvelopes: /^1|true|yes$/i.test(String(process.env.MONGO_MIGRATE_ENVELOPES || 'false')),
  mongoValidateDocs: /^1|true|yes$/i.test(String(process.env.MONGO_VALIDATE_DOCS || 'false')),
  mongoValidateModels: /^1|true|yes$/i.test(String(process.env.MONGO_VALIDATE_MODELS || 'false')),
  keepUserLoggedIn: /^1|true|yes$/i.test(String(process.env.KEEP_USER_LOGGED_IN || 'false')),
};

export default config;