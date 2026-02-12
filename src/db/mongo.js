import mongoose from 'mongoose';
import config from '../config.js';
import logger from '../util/logger.js';

let db;
let loggedVersion = false;
const migrationPromises = new Map();

function redactMongoUri(uri) {
  if (!uri) return '';
  try {
    const u = new URL(uri);
    // Preserve scheme + hosts + path/options, but hide credentials.
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString();
  } catch {
    // Fallback for non-standard URIs or parse failures.
    return String(uri).replace(/\/\/[^@/]+@/g, '//***:***@');
  }
}

export function isDbEnabled() {
  return Boolean(config.mongoUri && config.mongoDbName);
}

export async function getDb() {
  if (!isDbEnabled()) {
    throw new Error('MongoDB not configured: set MONGO_URI and MONGO_DB_NAME');
  }
  if (db) return db;

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(config.mongoUri, {
      dbName: config.mongoDbName,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
      // Pin to Stable API v1 for forward compatibility with MongoDB 8+
      serverApi: { version: '1', strict: true, deprecationErrors: true },
    });
  }

  db = mongoose.connection.db;
  if (!loggedVersion) {
    try {
      const admin = db.admin();

      logger.info(
        {
          mongoDbName: config.mongoDbName,
          mongoUri: redactMongoUri(config.mongoUri),
          migrateEnvelopes: Boolean(config.mongoMigrateEnvelopes),
        },
        'MongoDB configured'
      );

      try {
        let hello;
        try {
          hello = await admin.command({ hello: 1 });
        } catch {
          hello = await admin.command({ isMaster: 1 });
        }
        logger.info(
          {
            me: hello?.me,
            setName: hello?.setName,
            primary: hello?.primary,
            hosts: hello?.hosts,
            isWritablePrimary: hello?.isWritablePrimary ?? hello?.ismaster,
          },
          'MongoDB topology'
        );
      } catch (e) {
        logger.warn({ err: e?.message }, 'MongoDB topology check failed');
      }

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
    await mongoose.disconnect();
  } catch (e) {
    logger.warn({ err: e?.message }, 'Mongo close failed');
  } finally {
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

function validateNormalizedDoc(collectionName, doc) {
  if (!isPlainObject(doc)) {
    return { ok: false, reason: 'notPlainObject' };
  }
  const id = pickId(doc);
  if (!id) {
    return { ok: false, reason: 'missingIdentifier' };
  }

  // Minimal per-collection expectations (kept intentionally loose)
  if ((collectionName === 'customers' || collectionName === 'suppliers') && !String(doc.Code ?? doc.code ?? '')) {
    return { ok: false, reason: 'missingCode' };
  }
  if (collectionName === 'projects' && !String(doc.ProjectNumber ?? doc.projectNumber ?? doc.Code ?? doc.code ?? '')) {
    return { ok: false, reason: 'missingProjectNumber' };
  }
  if (collectionName === 'nominals' && !String(doc.NominalCode ?? doc.nominalCode ?? doc.Code ?? doc.code ?? '')) {
    return { ok: false, reason: 'missingNominalCode' };
  }
  // invoices/quotes/purchases can key off Number or Code; pickId already enforces at least one.

  return { ok: true, id };
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
  let skipped = 0;
  const skipReasons = {};
  for (const d of docs) {
    const normalized = normalizeDoc(d, now);
    let id = pickId(normalized);

    if (config.mongoValidateDocs) {
      const verdict = validateNormalizedDoc(collectionName, normalized);
      if (!verdict.ok) {
        skipped += 1;
        skipReasons[verdict.reason] = (skipReasons[verdict.reason] || 0) + 1;
        continue;
      }
      id = verdict.id;
    }

    if (!id) {
      skipped += 1;
      skipReasons.missingIdentifier = (skipReasons.missingIdentifier || 0) + 1;
      continue;
    }
    // Never $set _id; it is set via the update filter.
    // eslint-disable-next-line no-unused-vars
    const { _id, data, ...setDoc } = normalized || {};
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
  const upserts = (res.upsertedCount || 0) + (res.modifiedCount || 0);
  if (config.mongoValidateDocs && skipped > 0) {
    logger.warn(
      { collectionName, skipped, skipReasons },
      'Mongo upsert skipped invalid docs'
    );
  }
  return { upserts };
}

export default {
  isDbEnabled,
  getDb,
  closeDb,
  upsertMany,
};
