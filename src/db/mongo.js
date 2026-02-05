import { MongoClient } from 'mongodb';
import config from '../config.js';
import logger from '../util/logger.js';

let cached = null;

function isMongoAuthError(err) {
  const message = String(err?.message || '');
  return (
    message.includes('requires authentication') ||
    message.includes('not authorized') ||
    message.includes('Authentication failed') ||
    err?.code === 13
  );
}

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

  // Keep it simple. If you need more advanced options (replicaSet/tls/etc), use MONGO_URI.
  return `mongodb://${authPart}${config.mongoHost}:${config.mongoPort}/${encodeURIComponent(dbName)}${query ? `?${query}` : ''}`;
}

export function isMongoEnabled() {
  return Boolean(buildMongoUri());
}

export async function getMongoDb() {
  const uri = buildMongoUri();
  if (!uri) {
    throw new Error('MongoDB is not configured (set MONGO_URI or MONGO_HOST/MONGO_PORT)');
  }

  if (cached?.db) return cached.db;

  const client = new MongoClient(uri, {
    // Keep defaults; caller controls lifecycle.
  });

  await client.connect();
  const db = client.db(config.mongoDbName);
  cached = { client, db };
  logger.info({ mongoDbName: config.mongoDbName }, 'MongoDB connected');
  return db;
}

export async function closeMongo() {
  if (!cached?.client) return;
  try {
    await cached.client.close();
  } finally {
    cached = null;
  }
}

export async function ensureKashflowIndexes(db) {
  // Minimal indexes to make upserts efficient and enforce uniqueness.
  try {
    const ensureUniqueKeyIndex = async (collectionName, keyField, keyType = 'any') => {
      const col = db.collection(collectionName);
      const indexName = `${keyField}_1`;

      // Some Mongo-compatible servers (e.g. AWS DocumentDB) support only a limited
      // subset of operators in partialFilterExpression. In particular, `$ne` and
      // `$type` can be rejected.
      //
      // Strategy:
      // 1) Clean up legacy bad docs (null/empty key) by unsetting the key.
      // 2) Use a minimal partial unique index on `$exists: true`.
      //
      // This avoids duplicate-key failures like { code: null } and stays compatible.
      try {
        await col.updateMany({ [keyField]: null }, { $unset: { [keyField]: '' } });
      } catch {}
      if (keyType === 'string') {
        try {
          await col.updateMany({ [keyField]: '' }, { $unset: { [keyField]: '' } });
        } catch {}
      }

      const partialFilterExpression = { [keyField]: { $exists: true } };

      // If a previous version created a plain unique index, it can fail when old docs contain
      // null/missing keys (e.g. { code: null }). Replace it with a partial unique index.
      try {
        await col.dropIndex(indexName);
      } catch (err) {
        const codeName = err?.codeName || '';
        if (codeName !== 'IndexNotFound' && err?.code !== 27) {
          throw err;
        }
      }

      await col.createIndex(
        { [keyField]: 1 },
        {
          name: indexName,
          unique: true,
          partialFilterExpression,
        }
      );
    };

    const dropIndexIfExists = async (collectionName, indexName) => {
      const col = db.collection(collectionName);
      try {
        await col.dropIndex(indexName);
        logger.warn({ collectionName, indexName }, 'Dropped legacy index');
      } catch (err) {
        const codeName = err?.codeName || '';
        if (codeName !== 'IndexNotFound' && err?.code !== 27) throw err;
      }
    };

    const managedUniqueFields = {
      customers: ['code'],
      suppliers: ['code'],
      nominals: ['code'],
      invoices: ['number'],
      quotes: ['number'],
      purchases: ['number'],
      projects: ['number'],
    };

    // Repair legacy indexes that cause dup-key errors on missing fields.
    // Two common breakages:
    // - Old unique indexes on capitalized keys (e.g. `Code_1`, `Number_1`).
    // - Old unique indexes on `uuid` (or `UUID`), which treat missing as null.
    // We drop the legacy index and recreate a compatible partial unique index
    // on our normalized lower-case field.
    const collectionsNeedingUuid = new Set();
    for (const [collectionName, desiredFields] of Object.entries(managedUniqueFields)) {
      const col = db.collection(collectionName);
      let indexes = [];
      try {
        indexes = await col.indexes();
      } catch {
        continue;
      }

      for (const idx of indexes) {
        if (!idx?.unique) continue;
        if (idx?.name === '_id_') continue;
        const key = idx?.key && typeof idx.key === 'object' ? idx.key : null;
        const keyFields = key ? Object.keys(key) : [];
        if (keyFields.length !== 1) continue;

        const keyField = keyFields[0];
        const lower = String(keyField || '').toLowerCase();
        if (!lower) continue;

        // Any unique uuid index can break inserts; convert to partial unique.
        if (lower === 'uuid') {
          collectionsNeedingUuid.add(collectionName);
          await dropIndexIfExists(collectionName, idx.name);
          continue;
        }

        // If the index is on a case-variant of our managed key fields (Code vs code,
        // Number vs number), drop it and rely on the normalized index we create below.
        if (desiredFields.includes(lower) && keyField !== lower) {
          await dropIndexIfExists(collectionName, idx.name);
        }
      }
    }

    const indexJobs = [
      ensureUniqueKeyIndex('customers', 'code', 'string'),
      ensureUniqueKeyIndex('suppliers', 'code', 'string'),
      ensureUniqueKeyIndex('nominals', 'code', 'string'),
      ensureUniqueKeyIndex('invoices', 'number'),
      ensureUniqueKeyIndex('quotes', 'number'),
      ensureUniqueKeyIndex('purchases', 'number'),
      ensureUniqueKeyIndex('projects', 'number'),
    ];

    for (const collectionName of collectionsNeedingUuid) {
      indexJobs.push(ensureUniqueKeyIndex(collectionName, 'uuid', 'string'));
    }

    await Promise.all(indexJobs);
  } catch (err) {
    if (isMongoAuthError(err)) {
      throw new Error(
        `MongoDB authentication failed while creating indexes (${err.message}). ` +
          `Fix by setting MONGO_URI with credentials (e.g. mongodb://user:pass@host:27017/${config.mongoDbName}?authSource=admin) ` +
          `or set MONGO_USERNAME/MONGO_PASSWORD (+ optional MONGO_AUTH_SOURCE) alongside MONGO_HOST/MONGO_PORT/MONGO_DB_NAME.`
      );
    }
    throw err;
  }
}
