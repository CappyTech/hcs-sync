/**
 * The MongoDB connection. hcs-sync uses this one Mongoose connection for
 * everything — the sync, pulls, run history and settings through models, and
 * the history page and dedup through getMongoDb() on the same connection.
 *
 * Which database it uses: the one named in MONGO_URI's path when MONGO_URI is
 * set, otherwise MONGO_DB_NAME (the URI is built from MONGO_HOST with it). A
 * MONGO_URI with no database in its path lands on Mongoose's default, "test".
 */
import mongoose from 'mongoose';
import config from '../config.js';
import logger from '../util/logger.js';

// Import KashFlow models so they are registered on the Mongoose instance.
// This is a side-effect import; the models register themselves via mongoose.model().
import '../server/models/kashflow.js';

let connectPromise = null;

function buildMongoUri() {
  if (config.mongoUri) return config.mongoUri;
  if (!config.mongoHost) return '';

  const dbName = config.mongoDbName || 'kashflow';

  const hasCreds = Boolean(config.mongoUsername || config.mongoPassword);
  const authPart = hasCreds
    ? `${encodeURIComponent(config.mongoUsername || '')}:${encodeURIComponent(config.mongoPassword || '')}@`
    : '';

  const params = new URLSearchParams();
  if (config.mongoAuthSource) params.set('authSource', config.mongoAuthSource);
  const query = params.toString();

  return `mongodb://${authPart}${config.mongoHost}:${config.mongoPort}/${encodeURIComponent(dbName)}${query ? `?${query}` : ''}`;
}

export function isMongooseEnabled() {
  return Boolean(buildMongoUri());
}

export async function connectMongoose() {
  const uri = buildMongoUri();
  if (!uri) {
    throw new Error('MongoDB is not configured (set MONGO_URI or MONGO_HOST/MONGO_PORT)');
  }

  if (mongoose.connection?.readyState === 1) return mongoose;
  if (connectPromise) return connectPromise;

  connectPromise = mongoose
    .connect(uri, {
      // Keep defaults; advanced options should go in MONGO_URI.
    })
    .then(() => {
      warnIfDatabaseNameIgnored();
      return mongoose;
    })
    .finally(() => {
      // Allow retries if connect fails.
      if (mongoose.connection?.readyState !== 1) connectPromise = null;
    });

  return connectPromise;
}

/**
 * The native Db handle for this same connection, for code that works with raw
 * collections (the history page's drilldown and audit trail, dedup).
 */
export async function getMongoDb() {
  await connectMongoose();
  return mongoose.connection.db;
}

/**
 * MONGO_DB_NAME only takes effect when the URI is built from MONGO_HOST. With
 * MONGO_URI set, the database comes from the URI's path, so a different
 * MONGO_DB_NAME is ignored — say so rather than leave it to be discovered.
 */
function warnIfDatabaseNameIgnored() {
  if (!config.mongoUri) return;
  const database = mongoose.connection?.name;
  if (!database || database === config.mongoDbName) return;
  logger.warn(
    { database, mongoDbName: config.mongoDbName },
    `Using database "${database}" from MONGO_URI; MONGO_DB_NAME ("${config.mongoDbName}") is ignored when MONGO_URI is set. `
      + 'Put the intended database in the MONGO_URI path to silence this.',
  );
}

export async function disconnectMongoose() {
  connectPromise = null;
  if (mongoose.connection?.readyState === 0) return;
  await mongoose.disconnect();
}
