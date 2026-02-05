import mongoose from 'mongoose';
import config from '../config.js';

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
    .then(() => mongoose)
    .finally(() => {
      // Allow retries if connect fails.
      if (mongoose.connection?.readyState !== 1) connectPromise = null;
    });

  return connectPromise;
}

export async function disconnectMongoose() {
  connectPromise = null;
  if (mongoose.connection?.readyState === 0) return;
  await mongoose.disconnect();
}
