/**
 * The upsert engine: how one KashFlow payload becomes a MongoDB write, and how
 * batches of those writes are sent and audited.
 *
 * Shared by the full sync (run.js) and the single-entity pull (pull.js) so a
 * document written either way is built identically.
 */
import crypto from 'node:crypto';
import logger from '../util/logger.js';
import { SYNC_INTERNAL_FIELDS } from '../server/models/kashflow.js';
import deepDiff, { stableStringify } from '../util/deepDiff.js';

function computePayloadHash(data) {
  return crypto.createHash('sha256').update(stableStringify(data)).digest('hex').slice(0, 16);
}

function buildUpsertUpdate({ keyField, keyValue, payload, runId, model, protectedFields }) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const syncConfig = model?.syncConfig || {};

  // Apply the model's transform here, at the single choke point every upsert
  // passes through. Previously transform was declared in syncConfig but only
  // ever invoked explicitly by the purchase detail fanout, so declaring one on
  // any other model was a silent no-op.
  //
  // This is what converts KashFlow's "YYYY-MM-DD HH:mm:ss" strings into real
  // Dates. It cannot be left to Mongoose: the pipeline below wraps every value
  // in $literal and the write goes out through the native driver, so schema
  // casting never runs and a `Date` field declaration alone stores a string.
  //
  // Transforms mutate in place and must be idempotent — a row may be built more
  // than once across list and detail phases.
  if (typeof syncConfig.transform === 'function') {
    try {
      syncConfig.transform(source);
    } catch (err) {
      // A malformed row must not abort the whole batch; it is written untransformed.
      logger.warn({ keyField, keyValue, err: err.message }, 'syncConfig.transform failed; upserting raw payload');
    }
  }

  const protectedSet = new Set(protectedFields || syncConfig.protectedFields || []);
  const volatileSet = new Set(syncConfig.volatileFields || []);
  const flattened = {};
  const volatile = {};
  for (const [k, v] of Object.entries(source)) {
    if (!k) continue;
    if (SYNC_INTERNAL_FIELDS.has(k)) continue;
    if (k.startsWith('$')) continue;
    if (k.includes('.') || k.includes('\u0000')) continue;
    if (protectedSet.has(k)) continue;
    if (volatileSet.has(k)) { volatile[k] = v; continue; }
    flattened[k] = v;
  }

  // Compute a stable content hash so we can detect unchanged documents.
  // Volatile fields are deliberately not part of it — see below.
  const newHash = computePayloadHash({ ...flattened, [keyField]: keyValue });
  const newUuid = crypto.randomUUID();
  const hashChanged = { $ne: ['$_kfHash', { $literal: newHash }] };

  // Build an aggregation pipeline update (MongoDB 4.2+) so that timestamps
  // are only written when data actually changes:
  //   syncedAt / createdAt / uuid / createdByRunId  → insert-only via $ifNull
  //   updatedAt                                     → only when _kfHash changes
  //   _kfHash                                       → content hash for change detection
  // This means modifiedCount only increments when KashFlow data changed.
  // Data fields are wrapped in $literal to prevent misinterpretation by the
  // aggregation engine (e.g. strings starting with '$', operator-shaped objects).
  //
  // Soft-delete handling:
  //   deletedAt (lowercase) — a legacy hcs-sync-only flag never returned by the KashFlow
  //   API. Always cleared to null; placed after the spread so it cannot be re-introduced
  //   by a stale payload field.
  //
  //   DeletedAt (PascalCase) — a real KashFlow field: present (with a date) for records
  //   KashFlow has voided/deleted, absent for active records. Placed before the spread so
  //   it defaults to null for active records (KashFlow omits it) but is overridden by the
  //   KashFlow value when the record is genuinely deleted.
  //
  // Volatile fields (syncConfig.volatileFields) are server-computed values that
  // KashFlow re-derives per request and can hand back differently for identical
  // data. They are kept out of the hash AND only rewritten when the hash moves,
  // because doing either alone still churns: a value excluded from the hash but
  // still $set unconditionally changes the document anyway, and modifiedCount
  // counts the write, not the hash.
  //
  // The concrete case is bankTransaction.Balance — KashFlow's running balance.
  // It sorts by Date with no tiebreak, so rows sharing a date come back in a
  // different order each fetch and their running balances are permuted among
  // them. That rewrote ~200 rows an hour on the largest account, every one of
  // them reporting "data changed" to Discord and filling audit_log, while no
  // accounting fact had moved. Nothing reads the field: hcs-schemas declares it
  // list-only and server-computed, and reconciliation works from PaidIn/PaidOut
  // plus the account-level BankBalance.
  //
  // Refreshing on hash change (rather than insert-only) keeps the stored value
  // roughly current for the row it belongs to without letting it drive a write
  // on its own.
  const pipelineSet = {
    DeletedAt: { $literal: null },
    ...Object.fromEntries(Object.entries(flattened).map(([k, v]) => [k, { $literal: v }])),
    ...Object.fromEntries(Object.entries(volatile).map(([k, v]) => [k, {
      $cond: {
        if:   hashChanged,
        then: { $literal: v },
        else: { $ifNull: [`$${k}`, { $literal: v }] },
      },
    }])),
    [keyField]: { $literal: keyValue },
    _kfHash: { $literal: newHash },
    deletedAt: { $literal: null },
    syncedAt:        { $ifNull: ['$syncedAt',        '$$NOW'] },
    createdAt:       { $ifNull: ['$createdAt',       '$$NOW'] },
    uuid:            { $ifNull: ['$uuid',            { $literal: newUuid }] },
    ...(runId ? { createdByRunId: { $ifNull: ['$createdByRunId', { $literal: String(runId) }] } } : {}),
    updatedAt: {
      $cond: {
        if:   hashChanged,
        then: '$$NOW',
        else: { $ifNull: ['$updatedAt', '$$NOW'] },
      },
    },
  };

  // pipeline._rawSet is a JS-only property (not serialised to BSON) that
  // the audit engine reads for deepDiff comparisons.
  //
  // pipeline._rawVolatile names the fields the audit must ignore. deepDiff walks
  // the UNION of the stored document's keys and _rawSet's, so simply leaving a
  // volatile field out of _rawSet would report it 'removed' on every single run
  // — noisier than the churn this exists to stop.
  const pipeline = [{ $set: pipelineSet }, { $unset: 'data' }];
  pipeline._rawSet = { DeletedAt: null, ...flattened, [keyField]: keyValue, deletedAt: null };
  if (volatileSet.size) pipeline._rawVolatile = [...volatileSet];
  return pipeline;
}

/**
 * Soft-delete the bank transactions KashFlow has stopped returning for an
 * account — but only once their absence has been corroborated over time.
 *
 * Without any sweep the mirror keeps deleted transactions forever, which is not
 * cosmetic for reconciliation: a phantom line sits on the worklist looking
 * perfectly reconcilable and can be matched against a document it never paid for.
 *
 * The caller must only reach here after a SUCCESSFUL, NON-EMPTY fetch — sweeping
 * on a failed or empty response would mark an entire account's history deleted.
 * Those two guards still matter, but they are not sufficient. The largest
 * account's ~8,400 rows arrive over ~40 paginated requests, and individual rows
 * have vanished from one run's pages while plainly still existing: 6717455 and
 * 6717590 were soft-deleted at 10:00 on 2026-08-06 and returned an hour later,
 * so for that hour two real ledger lines were hidden from /bank by hcs-app's
 * LIVE_BANK_LINE filter. A partial fetch neither throws nor comes back empty, so
 * it passes both existing guards untouched.
 *
 * Hence missingSince: the first run that fails to see a row records when, and
 * only a row still missing after graceMs is soft-deleted. The window is measured
 * in time rather than counted in runs so that two manual runs a minute apart
 * cannot corroborate each other. graceMs of 0 restores the previous behaviour of
 * deleting on first absence.
 *
 * Reappearance self-heals in two places: buildUpsertUpdate clears deletedAt on
 * every upsert, and the timer reset below covers rows that are back but whose
 * stale missingSince would otherwise make the next single missed page an
 * instant deletion.
 *
 * @returns {Promise<{pending: number, softDeleted: number}>}
 */
async function sweepMissingBankTransactions({ model, accountId, seen, now, graceMs = 0 }) {
  const result = { pending: 0, softDeleted: 0 };
  if (!seen?.length) return result;

  const missing = { AccountId: accountId, Id: { $nin: seen }, deletedAt: null };

  await model.updateMany(
    { AccountId: accountId, Id: { $in: seen }, missingSince: { $ne: null } },
    { $set: { missingSince: null } },
  );

  const firstAbsence = await model.updateMany(
    { ...missing, missingSince: null },
    { $set: { missingSince: now } },
  );
  result.pending = firstAbsence?.modifiedCount || 0;

  const cutoff = new Date(now.getTime() - graceMs);
  const confirmed = await model.updateMany(
    { ...missing, missingSince: { $ne: null, $lte: cutoff } },
    { $set: { deletedAt: now } },
  );
  result.softDeleted = confirmed?.modifiedCount || 0;

  return result;
}

function extractUpsertedEntries(out) {
  if (!out) return [];
  // Mongoose 8 / mongodb driver 6: upsertedIds is a plain object keyed by op index
  // e.g. { "0": ObjectId(...), "5": ObjectId(...) }
  if (out.upsertedIds && typeof out.upsertedIds === 'object' && !Array.isArray(out.upsertedIds)) {
    return Object.entries(out.upsertedIds).map(([idx, _id]) => ({ index: Number(idx), _id }));
  }
  // Fallback: some drivers return an array of { index, _id } directly
  if (Array.isArray(out.upsertedIds)) return out.upsertedIds;
  if (typeof out.getUpsertedIds === 'function') return out.getUpsertedIds() || [];
  return [];
}

/** Batch-read existing documents before the bulkWrite for audit diffing. */
async function preReadForAudit(collection, audit, opsToWrite) {
  if (!audit?.auditCollection) return null;
  try {
    const filters = opsToWrite.map((op) => op?.updateOne?.filter).filter(Boolean);
    if (!filters.length) return null;
    const query = collection.find({ $or: filters });
    const existingDocs = typeof query.lean === 'function'
      ? await query.lean()
      : await query.toArray();
    const docMap = new Map();
    for (const doc of existingDocs) {
      for (const f of filters) {
        const fKeys = Object.keys(f);
        const matches = fKeys.every((k) => doc[k] != null && String(doc[k]) === String(f[k]));
        if (matches) {
          docMap.set(JSON.stringify(f), doc);
          break;
        }
      }
    }
    return docMap;
  } catch (err) {
    logger.warn({ err: err?.message }, 'Audit pre-read failed (non-fatal)');
    return null;
  }
}

/**
 * Compute diffs using the pre-read map and write audit entries.
 * @returns {Promise<{creates: number, changes: number}>} audit entries produced, by action
 */
async function writeAuditEntries(audit, opsToWrite, docMap, upsertedEntries) {
  const counts = { creates: 0, changes: 0 };
  if (!audit?.auditCollection || !docMap) return counts;
  try {
    const upsertedSet = new Set((upsertedEntries || []).map((e) => e?.index));
    const auditEntries = [];
    const now = new Date();

    for (let i = 0; i < opsToWrite.length; i++) {
      const op = opsToWrite[i];
      const filter = op?.updateOne?.filter;
      if (!filter) continue;
      // Pipeline updates store raw payload on _rawSet (not serialised to BSON);
      // legacy updates use $set directly.
      const update = op?.updateOne?.update;
      const setFields = Array.isArray(update) ? update._rawSet : update?.$set;
      if (!setFields) continue;

      const filterKey = JSON.stringify(filter);
      const existing = docMap.get(filterKey) || null;
      const isCreate = !existing || upsertedSet.has(i);

      if (isCreate) {
        auditEntries.push({
          collection: audit.collectionName,
          documentId: filter.Id ?? filter.Code ?? filter.Number ?? null,
          filter,
          runId: audit.runId || null,
          action: 'create',
          changes: [],
          timestamp: now,
        });
        counts.creates++;
        continue;
      }

      // Volatile fields are not written unless real content changed, so
      // diffing them would report a change the write never made.
      const volatileFields = Array.isArray(update) ? update._rawVolatile : null;
      const changes = volatileFields?.length
        ? deepDiff(existing, setFields, {
          skipFields: new Set([...SYNC_INTERNAL_FIELDS, ...volatileFields]),
        })
        : deepDiff(existing, setFields);
      if (!changes.length) continue;

      auditEntries.push({
        collection: audit.collectionName,
        documentId: filter.Id ?? filter.Code ?? filter.Number ?? null,
        filter,
        runId: audit.runId || null,
        action: 'update',
        changes,
        timestamp: now,
      });
      counts.changes++;
    }

    if (auditEntries.length) {
      await audit.auditCollection.insertMany(auditEntries, { ordered: false });
    }
  } catch (err) {
    logger.warn({ err: err?.message, collection: audit.collectionName }, 'Audit write failed (non-fatal)');
  }
  return counts;
}

function createBulkUpserter(collection, batchSize = 250) {
  const options = typeof batchSize === 'object' && batchSize !== null ? batchSize : null;
  const resolvedBatchSize = options ? Number(options.batchSize || 250) : Number(batchSize || 250);
  const captureUpserts = Boolean(options?.captureUpserts);
  const maxCapturedUpserts = Number(options?.maxCapturedUpserts || 2000);

  // Audit options: { auditCollection, runId, collectionName }
  const audit = options?.audit || null;
  let auditedChanges = 0;
  let auditedCreates = 0;

  let pending = [];
  let attemptedOps = 0;
  let affected = 0;
  let upserted = 0;
  let modified = 0;
  let matched = 0;
  let writeChain = Promise.resolve();
  const upsertedFilters = [];
  let upsertedFiltersTruncated = false;

  const applyResult = (out) => {
    upserted += out?.upsertedCount || 0;
    modified += out?.modifiedCount || 0;
    matched += out?.matchedCount || 0;
    affected += (out?.upsertedCount || 0) + (out?.matchedCount || 0);
  };

  const enqueueWrite = async (opsToWrite) => {
    if (!opsToWrite.length) return;
    attemptedOps += opsToWrite.length;

    const filtersForOps = captureUpserts
      ? opsToWrite.map((op) => op?.updateOne?.filter ?? null)
      : null;

    writeChain = writeChain.then(async () => {
      // Pre-read for audit before the write so we capture the "before" state.
      const preReadDocs = audit ? await preReadForAudit(collection, audit, opsToWrite) : null;

      // Pipeline updates handle timestamps internally via $ifNull / $cond.
      // Only inject timestamps for legacy non-pipeline updates.
      const tsNow = new Date();
      for (const op of opsToWrite) {
        const u = op?.updateOne?.update;
        if (u && !Array.isArray(u)) {
          if (u.$set) u.$set.updatedAt = tsNow;
          if (!u.$setOnInsert) u.$setOnInsert = {};
          u.$setOnInsert.createdAt = tsNow;
        }
      }

      // Use native MongoDB driver — Mongoose 8's bulkWrite casting silently
      // drops complex array sub-documents (LineItems, PaymentLines) during cast.
      const out = await collection.collection.bulkWrite(opsToWrite, { ordered: false });
      applyResult(out);

      const upsertedEntries = extractUpsertedEntries(out);

      if (captureUpserts && filtersForOps) {
        for (const entry of upsertedEntries) {
          const idx = entry?.index;
          if (!Number.isInteger(idx) || idx < 0 || idx >= filtersForOps.length) continue;
          const filter = filtersForOps[idx];
          if (!filter) continue;
          if (upsertedFilters.length >= maxCapturedUpserts) {
            upsertedFiltersTruncated = true;
            continue;
          }
          upsertedFilters.push(filter);
        }
      }

      // Post-write: compute diffs and write audit entries.
      if (preReadDocs) {
        const audited = await writeAuditEntries(audit, opsToWrite, preReadDocs, upsertedEntries);
        auditedCreates += audited.creates;
        auditedChanges += audited.changes;
      }
    });
    await writeChain;
  };

  const push = async (op) => {
    pending.push(op);
    if (pending.length < resolvedBatchSize) return;
    const opsToWrite = pending;
    pending = [];
    await enqueueWrite(opsToWrite);
  };

  const flush = async () => {
    const opsToWrite = pending;
    pending = [];
    await enqueueWrite(opsToWrite);
    await writeChain;
  };

  return {
    push,
    flush,
    getStats: () => ({ attemptedOps, affected, upserted, matched, modified }),
    getAuditStats: () => ({ auditedChanges, auditedCreates }),
    getUpsertedFilters: () => ({ filters: upsertedFilters.slice(), truncated: upsertedFiltersTruncated, maxCapturedUpserts }),
  };
}

/**
 * Stamp detailSyncedAt on an update built by buildUpsertUpdate.
 *
 * By default it moves only when the content hash does, like updatedAt — the
 * full sync re-fetches every detail every run, and an unconditional stamp
 * would rewrite every document each time. A manual pull passes
 * { onlyIfChanged: false }: it is an explicit refresh, and recording that it
 * happened is the point.
 */
function applyDetailSyncedAt(update, now, { onlyIfChanged = true } = {}) {
  update[0].$set.detailSyncedAt = onlyIfChanged
    ? { $cond: { if: { $ne: ['$_kfHash', update[0].$set._kfHash] }, then: { $literal: now }, else: { $ifNull: ['$detailSyncedAt', { $literal: now }] } } }
    : { $literal: now };
  update._rawSet.detailSyncedAt = now;
}

export {
  buildUpsertUpdate,
  applyDetailSyncedAt,
  createBulkUpserter,
  sweepMissingBankTransactions,
};
