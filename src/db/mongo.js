import { MongoClient } from 'mongodb';
import config from '../config.js';
import logger from '../util/logger.js';

let client; // cached MongoClient
let db;
let loggedVersion = false;
const migrationPromises = new Map();

export function isDbEnabled() {
  return Boolean(config.mongoUri && config.mongoDbName);
}

export async function getDb() {
  if (!isDbEnabled()) {
    throw new Error('MongoDB not configured: set MONGO_URI and MONGO_DB_NAME');
  }
  if (db) return db;
  if (!client) {
    client = new MongoClient(config.mongoUri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
      // Pin to Stable API v1 for forward compatibility with MongoDB 8+
      serverApi: { version: '1', strict: true, deprecationErrors: true },
    });
  }
  await client.connect();
  db = client.db(config.mongoDbName);
  if (!loggedVersion) {
    try {
      const admin = db.admin();
      let info;
      try {
        info = await admin.serverStatus();
      } catch {
        info = await admin.command({ buildInfo: 1 });
      }
      const payload = info?.version ? { version: info.version, gitVersion: info.gitVersion } : info;
      logger.info(payload || {}, 'MongoDB connected');
      loggedVersion = true;
    } catch (e) {
      logger.warn({ err: e?.message }, 'MongoDB version check failed');
    }
  }
  return db;
}

export async function closeDb() {
  try {
    await client?.close();
  } catch (e) {
    logger.warn({ err: e?.message }, 'Mongo close failed');
  } finally {
    client = undefined;
    db = undefined;
  }
}

function pickId(doc) {
  // Try common identifier fields found in KashFlow payloads
  const code = doc?.Code ?? doc?.code ?? null;
  const number = doc?.Number ?? doc?.number ?? null;
  const project = doc?.ProjectNumber ?? doc?.projectNumber ?? null;
  const nominal = doc?.NominalCode ?? doc?.nominalCode ?? null;
  return String(code ?? number ?? project ?? nominal ?? '') || null;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeDoc(d, now) {
  if (!d || typeof d !== 'object') return d;

  if (isPlainObject(d.data)) {
    const root = { ...d.data, syncedAt: d.syncedAt ?? now };

    const stableCode = d.data.Code ?? d.data.code ?? d.code ?? null;
    if (stableCode != null) {
      if (root.Code == null) root.Code = stableCode;
      if (root.code == null) root.code = stableCode;
    } else {
      if (root.code != null && root.Code == null) root.Code = root.code;
      if (root.Code != null && root.code == null) root.code = root.Code;
    }

    return root;
  }

  return d;
}

async function maybeMigrateEnvelopeDocs(col, collectionName) {
  if (!config.mongoMigrateEnvelopes) return;
  if (migrationPromises.has(collectionName)) {
    await migrationPromises.get(collectionName);
    return;
  }

  const p = (async () => {
    try {
      const res = await col.updateMany(
        { data: { $type: 'object' } },
        [
          {
            $set: {
              _tmpCode: {
                $ifNull: [
                  '$data.Code',
                  { $ifNull: ['$data.code', { $ifNull: ['$Code', '$code'] }] },
                ],
              },
              _tmpSyncedAt: { $ifNull: ['$syncedAt', '$updatedAt'] },
            },
          },
          {
            $replaceRoot: {
              newRoot: {
                $mergeObjects: [
                  '$data',
                  {
                    _id: '$_id',
                    Code: '$_tmpCode',
                    code: '$_tmpCode',
                    syncedAt: '$_tmpSyncedAt',
                    createdAt: '$createdAt',
                    updatedAt: '$updatedAt',
                  },
                ],
              },
            },
          },
          { $unset: ['_tmpCode', '_tmpSyncedAt'] },
        ]
      );
      const matched = res?.matchedCount ?? 0;
      const modified = res?.modifiedCount ?? 0;
      if (matched > 0 || modified > 0) {
        logger.info(
          { collectionName, matched, modified },
          'Mongo envelope migration applied'
        );
      }
    } catch (e) {
      logger.warn(
        { collectionName, err: e?.message },
        'Mongo envelope migration failed'
      );
    }
  })();

  migrationPromises.set(collectionName, p);
  try {
    await p;
  } finally {
    // Keep the promise cached so we only attempt once per process.
  }
}

export async function upsertMany(collectionName, docs = []) {
  if (!isDbEnabled() || !Array.isArray(docs) || docs.length === 0) return { upserts: 0 };
  const database = await getDb();
  const col = database.collection(collectionName);
  await maybeMigrateEnvelopeDocs(col, collectionName);
  const now = new Date();
  const ops = [];
  for (const d of docs) {
    const normalized = normalizeDoc(d, now);
    const id = pickId(normalized);
    if (!id) continue;
    // Never $set _id; it is set via the update filter.
    // eslint-disable-next-line no-unused-vars
    const { _id, ...setDoc } = normalized || {};
    ops.push({
      updateOne: {
        filter: { _id: id },
        update: {
          $set: { ...setDoc, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      }
    });
  }
  if (ops.length === 0) return { upserts: 0 };
  const res = await col.bulkWrite(ops, { ordered: false });
  return { upserts: (res.upsertedCount || 0) + (res.modifiedCount || 0) };
}

export default {
  isDbEnabled,
  getDb,
  closeDb,
  upsertMany,
};
