/**
 * MongoDB index management for the REST namespace.
 *
 * The connection itself lives in ./mongoose.js — hcs-sync uses one Mongoose
 * connection for everything, and ensureKashflowIndexes is handed its db.
 */
import config from '../config.js';
import logger from '../util/logger.js';

function isMongoAuthError(err) {
  const message = String(err?.message || '');
  return (
    message.includes('requires authentication') ||
    message.includes('not authorized') ||
    message.includes('Authentication failed') ||
    err?.code === 13
  );
}

async function ensureUniqueKeyIndex(db, collectionName, keyField, keyType = 'any') {
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
}

/** Create a non-unique index (for query performance on secondary fields). */
async function ensureSecondaryIndex(db, collectionName, keyField) {
  const col = db.collection(collectionName);
  const indexName = `${keyField}_1`;
  // Drop any existing index (may have been unique previously).
  try {
    await col.dropIndex(indexName);
  } catch (err) {
    const codeName = err?.codeName || '';
    if (codeName !== 'IndexNotFound' && err?.code !== 27) throw err;
  }
  await col.createIndex({ [keyField]: 1 }, { name: indexName });
}

/**
 * Create a non-unique compound index.
 *
 * These are also declared on the Mongoose schemas, but hcs-sync writes
 * through the native driver and `autoIndex` is not something to rely on in
 * production, so the reconciliation query paths are ensured explicitly here
 * alongside every other index this module manages.
 *
 * No explicit name: Mongoose's autoIndex may already have created the same
 * key under the driver's default name, and supplying our own would collide
 * with it on every run. Letting the driver derive the name makes this
 * idempotent whichever path got there first.
 */
async function ensureCompoundIndex(db, collectionName, keySpec, options = {}) {
  const col = db.collection(collectionName);
  try {
    // Options must match what the schema declares, or the two paths fight
    // over the same auto-generated index name on every run.
    await col.createIndex(keySpec, { background: true, ...options });
  } catch (err) {
    // An equivalent index under a different name is not a failure.
    const codeName = err?.codeName || '';
    if (codeName !== 'IndexOptionsConflict' && codeName !== 'IndexKeySpecsConflict') throw err;
    logger.warn({ collectionName, keySpec, err: err.message }, 'Compound index already exists under different options');
  }
}

async function dropIndexIfExists(db, collectionName, indexName) {
  const col = db.collection(collectionName);
  try {
    await col.dropIndex(indexName);
    logger.warn({ collectionName, indexName }, 'Dropped legacy index');
  } catch (err) {
    const codeName = err?.codeName || '';
    if (codeName !== 'IndexNotFound' && err?.code !== 27) throw err;
  }
}

// Repair legacy indexes that cause dup-key errors on missing fields.
// Two common breakages:
// - Old unique indexes on capitalized keys (e.g. `Code_1`, `Number_1`).
// - Old unique indexes on `uuid` (or `UUID`), which treat missing as null.
// - Old unique indexes on code/number that were previously the dedup key.
// We drop the legacy index and recreate a compatible partial unique index
// on our normalized Id field.
//
// Returns the collections whose unique uuid index was dropped and must be
// recreated as a partial unique index.
async function repairLegacyUniqueIndexes(db, managedUniqueFields) {
  const collectionsNeedingUuid = new Set();
  const legacyUniqueFieldsToDowngrade = ['code', 'number'];
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
        await dropIndexIfExists(db, collectionName, idx.name);
        continue;
      }

      // Drop old unique indexes on code/number (now secondary, non-unique).
      if (legacyUniqueFieldsToDowngrade.includes(lower)) {
        await dropIndexIfExists(db, collectionName, idx.name);
        continue;
      }

      // If the index is on a case-variant of our managed key fields (Id vs id),
      // drop it and rely on the normalized index ensureKashflowIndexes creates.
      if (desiredFields.map((f) => f.toLowerCase()).includes(lower) && !desiredFields.includes(keyField)) {
        await dropIndexIfExists(db, collectionName, idx.name);
      }
    }
  }
  return collectionsNeedingUuid;
}

export async function ensureKashflowIndexes(db) {
  // Indexes to make upserts efficient and enforce uniqueness on the KashFlow Id.
  try {
    // Primary unique dedup key: Id (KashFlow-assigned numeric identifier).
    // Secondary non-unique indexes: code/number (for query performance).
    const managedUniqueFields = {
      customers: ['Id'],
      suppliers: ['Id'],
      nominals: ['Id'],
      invoices: ['Id'],
      quotes: ['Id'],
      purchases: ['Id'],
      projects: ['Id'],
      bankaccounts: ['Id'],
      // Keyed on the (AccountId, Id) composite, not a bare Id: an internal
      // transfer is two ledger lines sharing one KashFlow Id, one per account.
      // Listed here so the legacy-index repair below still reaches this
      // collection (it is also what converts a legacy unique `uuid` index into
      // a partial one); the composite itself is created in `compoundJobs`.
      banktransactions: ['AccountId', 'Id'],
      // Keyed on the synthetic "<AccountId>:<Id>" composite — KashFlow's
      // reconciliation Id is only unique within an account.
      bankreconciliations: ['ReconKey'],
      journals: ['Id'],
      products: ['Id'],
      purchaseorders: ['Id'],
      quotecategories: ['Number'],
      purchaseordercategories: ['Number'],
      currencies: ['Id'],
      countries: ['Id'],
      accountingperiods: ['Id'],
      vatreturns: ['Id'],
    };

    const collectionsNeedingUuid = await repairLegacyUniqueIndexes(db, managedUniqueFields);

    // Primary unique indexes on Id (dedup key).
    const indexJobs = [
      ensureUniqueKeyIndex(db, 'customers', 'Id'),
      ensureUniqueKeyIndex(db, 'suppliers', 'Id'),
      ensureUniqueKeyIndex(db, 'nominals', 'Id'),
      ensureUniqueKeyIndex(db, 'invoices', 'Id'),
      ensureUniqueKeyIndex(db, 'quotes', 'Id'),
      ensureUniqueKeyIndex(db, 'purchases', 'Id'),
      ensureUniqueKeyIndex(db, 'projects', 'Id'),
      ensureUniqueKeyIndex(db, 'bankaccounts', 'Id'),
      ensureUniqueKeyIndex(db, 'bankreconciliations', 'ReconKey', 'string'),
      ensureUniqueKeyIndex(db, 'journals', 'Id'),
      ensureUniqueKeyIndex(db, 'products', 'Id'),
      ensureUniqueKeyIndex(db, 'purchaseorders', 'Id'),
      ensureUniqueKeyIndex(db, 'quotecategories', 'Number'),
      ensureUniqueKeyIndex(db, 'purchaseordercategories', 'Number'),
      ensureUniqueKeyIndex(db, 'currencies', 'Id'),
      ensureUniqueKeyIndex(db, 'countries', 'Id'),
      ensureUniqueKeyIndex(db, 'accountingperiods', 'Id'),
      ensureUniqueKeyIndex(db, 'vatreturns', 'Id'),
    ];

    // Secondary non-unique indexes on Code/Number for query performance.
    // Field names are capitalized to match the KashFlow API payload keys.
    const secondaryJobs = [
      ensureSecondaryIndex(db, 'customers', 'Code'),
      ensureSecondaryIndex(db, 'suppliers', 'Code'),
      ensureSecondaryIndex(db, 'nominals', 'Code'),
      ensureSecondaryIndex(db, 'invoices', 'Number'),
      ensureSecondaryIndex(db, 'quotes', 'Number'),
      ensureSecondaryIndex(db, 'purchases', 'Number'),
      ensureSecondaryIndex(db, 'projects', 'Number'),
      ensureSecondaryIndex(db, 'bankaccounts', 'Code'),
      // Downgrades the legacy unique `Id_1` to non-unique, which is what makes
      // room for both halves of a transfer. Must happen before the first sync
      // writes them or the second half fails with a duplicate key error.
      ensureSecondaryIndex(db, 'banktransactions', 'Id'),
      ensureSecondaryIndex(db, 'journals', 'Number'),
      ensureSecondaryIndex(db, 'products', 'Code'),
      ensureSecondaryIndex(db, 'purchaseorders', 'Number'),
      ensureSecondaryIndex(db, 'currencies', 'Code'),
      ensureSecondaryIndex(db, 'countries', 'Code'),
    ];

    // Compound indexes serving hcs-app's bank reconciliation query paths.
    const compoundJobs = [
      // The dedup key. Options mirror the hcs-schemas declaration exactly, or
      // this and Mongoose's autoIndex fight over the same derived name.
      ensureCompoundIndex(db, 'banktransactions', { AccountId: 1, Id: 1 }, { unique: true, sparse: true }),
      // Per-account unreconciled worklist, ordered newest first.
      ensureCompoundIndex(db, 'banktransactions', { AccountId: 1, Reconciled: 1, Date: -1 }),
      // Resolving a bank line to the document it settles.
      ensureCompoundIndex(db, 'banktransactions', { EntityName: 1, ResourceNumber: 1 }),
      // Candidate lookup by issue date when suggesting matches.
      ensureCompoundIndex(db, 'invoices', { IssuedDate: -1 }),
      ensureCompoundIndex(db, 'purchases', { IssuedDate: -1 }),
      // Resolving a batch-payment bank line to the documents it settled.
      // sparse to match the hcs-schemas declaration: most documents have no
      // batch payment, so the index only covers those that do.
      ensureCompoundIndex(db, 'invoices', { 'PaymentLines.BulkPaymentNumber': 1 }, { sparse: true }),
      ensureCompoundIndex(db, 'purchases', { 'PaymentLines.BulkPaymentNumber': 1 }, { sparse: true }),
      ensureCompoundIndex(db, 'bankreconciliations', { AccountId: 1, EndDate: -1 }),
    ];

    for (const collectionName of collectionsNeedingUuid) {
      indexJobs.push(ensureUniqueKeyIndex(db, collectionName, 'uuid', 'string'));
    }

    // Audit log indexes for the sync change-tracking collection.
    const auditJobs = [
      db.collection('audit_log').createIndex(
        { collection: 1, documentId: 1, timestamp: -1 },
        { name: 'audit_col_doc_ts', background: true }
      ),
      db.collection('audit_log').createIndex(
        { runId: 1 },
        { name: 'audit_runId', background: true }
      ),
      db.collection('audit_log').createIndex(
        { timestamp: -1 },
        { name: 'audit_ts', background: true }
      ),
    ];

    await Promise.all([...indexJobs, ...secondaryJobs, ...compoundJobs, ...auditJobs]);
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
