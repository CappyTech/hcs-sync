import { MongoClient } from 'mongodb';
import config from '../config.js';
import logger from '../util/logger.js';

let client; // cached MongoClient
let db;
let loggedVersion = false;

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

export async function upsertMany(collectionName, docs = []) {
  if (!isDbEnabled() || !Array.isArray(docs) || docs.length === 0) return { upserts: 0 };
  const database = await getDb();
  const col = database.collection(collectionName);
  const now = new Date();
  const ops = [];
  for (const d of docs) {
    const id = pickId(d);
    if (!id) continue;
    ops.push({
      updateOne: {
        filter: { _id: id },
        update: {
          $set: { ...d, updatedAt: now },
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
