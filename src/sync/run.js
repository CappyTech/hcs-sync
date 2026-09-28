import crypto from 'node:crypto';
import mongoose from 'mongoose';
import logger from '../util/logger.js';
import createClient from '../kashflow/client.js';
import config from '../config.js';
import progress from '../server/progress.js';
import { connectMongoose, isMongooseEnabled } from '../db/mongoose.js';
import { ensureKashflowIndexes } from '../db/mongo.js';
import { Customer, Supplier, Invoice, Quote, Purchase, Project, Nominal, VATRate, BankAccount, BankTransaction, BankReconciliation, Journal, Product, PurchaseOrder, QuoteCategory, PurchaseOrderCategory, Currency, Country, AccountingPeriod, VatReturn, SYNC_INTERNAL_FIELDS, toDate, computeCisTaxPeriod, preparePurchaseForUpsert } from '../server/models/kashflow.js';
import deepDiff, { stableStringify } from '../util/deepDiff.js';

function computePayloadHash(data) {
  return crypto.createHash('sha256').update(stableStringify(data)).digest('hex').slice(0, 16);
}

function createPool(limit, label, handler, onProgress) {
  return async (items) => {
    const results = new Array(items.length);
    let nextIndex = 0;
    let done = 0;
    const total = items.length;
    const workers = new Array(Math.min(limit, total)).fill(0).map(async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= total) return;
        try {
          results[idx] = await handler(items[idx], idx);
        } finally {
          done += 1;
          if (onProgress) onProgress({ label, done, total });
        }
      }
    });
    await Promise.all(workers);
    return results;
  };
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
export async function sweepMissingBankTransactions({ model, accountId, seen, now, graceMs = 0 }) {
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

function pickCode(x) {
  return x?.Code ?? x?.code ?? x?.CustomerCode ?? x?.SupplierCode ?? null;
}

function pickNumber(x) {
  return x?.Number ?? x?.number ?? null;
}

function pickId(x) {
  return x?.Id ?? x?.id ?? null;
}

// Re-exported from Supplier model syncConfig for backward compatibility.
const SUPPLIER_PROTECTED_FIELDS = Supplier.syncConfig.protectedFields;

function isMissingKey(value) {
  if (value === null || typeof value === 'undefined') return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

function createSkipCounter() {
  let skippedMissingKey = 0;
  return {
    incMissingKey: () => {
      skippedMissingKey += 1;
    },
    getMissingKey: () => skippedMissingKey,
  };
}

function addMongoStats(target, stats) {
  if (!stats) return target;
  if (!target) target = { attemptedOps: 0, affected: 0, upserted: 0, matched: 0, modified: 0 };
  const n = (v) => Number(v) || 0;
  target.attemptedOps = n(target.attemptedOps) + n(stats.attemptedOps);
  target.affected = n(target.affected) + n(stats.affected);
  target.upserted = n(target.upserted) + n(stats.upserted);
  target.matched = n(target.matched) + n(stats.matched);
  target.modified = n(target.modified) + n(stats.modified);
  return target;
}

/**
 * Replace this run's count for every collection whose KashFlow fetch failed with
 * the previous run's count, so a transient fetch error is neither reported nor
 * persisted as a drop to zero.
 *
 * A failed fetch means we did not observe the collection this run — not that it
 * emptied. Carrying the prior count forward makes before === after downstream, so
 * summariseRunChanges emits no delta, and it also stops the mirror-image phantom
 * on recovery (a real 0 stored this run would read as "0 → 40" next run). A
 * collection with no prior count (nothing to carry) is left untouched.
 *
 * Pure and side-effect-free: returns a new object, mutates neither argument.
 *
 * @param {object|null} prev   previous run's counts
 * @param {object|null} curr   this run's counts
 * @param {Iterable<string>} failed  count-keys whose fetch failed this run
 * @returns {object} counts with failed-fetch collections carried forward
 */
function carryForwardFailedCounts(prev, curr, failed) {
  const out = { ...(curr || {}) };
  if (!prev) return out;
  for (const name of failed || []) {
    if (prev[name] != null) out[name] = prev[name];
  }
  return out;
}

// ── Run context ──────────────────────────────────────────────────────────────
// Per-run state shared by the phase helpers below: stage and log plumbing, the
// Mongo write tallies that become the run summary, and the audit wiring.

function createRunContext({ runId, recordLog }) {
  const ctx = {
    runId,
    stage: 'initialising',
    mongoSummary: {},
    mongoDetails: {},
    auditCol: null,
  };
  ctx.emitLog = (level, message, meta) => {
    if (!recordLog) return;
    Promise.resolve(recordLog({ level, message, stage: ctx.stage, meta })).catch(() => {});
  };
  ctx.setStage = (nextStage) => {
    ctx.stage = nextStage;
    progress.setStage(nextStage);
    ctx.emitLog('info', 'Stage changed', { stage: nextStage });
  };
  ctx.auditOpts = (collectionName) => (
    ctx.auditCol ? { auditCollection: ctx.auditCol, runId, collectionName } : null
  );
  return ctx;
}

/**
 * Fold one upserter's results into the run summary and log them.
 *
 * Accumulates rather than assigns: the bank-transaction and reconciliation
 * fan-outs write the same summaryKey once per account, and a plain assignment
 * left mongoDetails holding only the last account's filters.
 */
function recordUpserterResult(ctx, summaryKey, upserter, label = summaryKey) {
  const stats = upserter.getStats();
  ctx.mongoSummary[summaryKey] = addMongoStats(ctx.mongoSummary[summaryKey], stats);
  const added = upserter.getUpsertedFilters();
  const existing = ctx.mongoDetails[summaryKey];
  if (added?.filters?.length) {
    const cap = added.maxCapturedUpserts || 2000;
    ctx.mongoDetails[summaryKey] = {
      filters: (existing?.filters || []).concat(added.filters).slice(0, cap),
      truncated: Boolean(existing?.truncated) || Boolean(added.truncated),
      maxCapturedUpserts: cap,
    };
  } else if (!existing) {
    ctx.mongoDetails[summaryKey] = added;
  }
  logger.info({ mongo: { [summaryKey]: stats } }, `Mongo upsert summary (${label})`);
  ctx.emitLog('info', `Mongo upsert summary (${label})`, { stats });
}

function logProgressEvery(label, steps, message) {
  return ({ done, total }) => {
    const step = Math.max(1, Math.ceil(total / steps));
    if (done % step === 0 || done === total) logger.info({ label, done, total }, message);
  };
}

// ── Key pickers ──────────────────────────────────────────────────────────────

/** Key on the first of `keyFields` the row actually carries. */
function firstPresentKey(keyFields) {
  return (row) => {
    for (const keyField of keyFields) {
      if (!isMissingKey(row[keyField])) return { keyField, keyValue: row[keyField] };
    }
    return null;
  };
}

/** Nominals and bank accounts: Id when present, otherwise Code (either casing). */
function pickIdOrCode(row) {
  const id = pickId(row);
  const keyValue = id != null ? id : pickCode(row);
  if (isMissingKey(keyValue)) return null;
  return { keyField: id != null ? 'Id' : 'Code', keyValue };
}

// ── List phase ───────────────────────────────────────────────────────────────

/**
 * Fetch every list endpoint in parallel.
 *
 * Customers, suppliers, projects and nominals are required: the run cannot do
 * anything useful without them, so their failure fails the run. Everything else
 * is best-effort — a failure is logged, recorded in `failedFetches` and turned
 * into an empty list so the rest of the run continues.
 */
async function fetchLists(kf, failedFetches) {
  const listOrEmpty = (key, label, promise) =>
    promise.catch((e) => { logger.warn({ err: e.message }, `Failed to fetch ${label}`); failedFetches.add(key); return []; });

  const [
    customers, suppliers, projects, nominals, vatRates, bankAccounts,
    journals, products, purchaseOrders, quoteCategories,
    purchaseOrderCategories, currencies, countries,
    accountingPeriods, vatReturns,
  ] = await Promise.all([
    kf.customers.listAll({ perpage: 200 }),
    kf.suppliers.listAll({ perpage: 200 }),
    kf.projects.listAll({ perpage: 200 }),
    kf.nominals.list(),
    listOrEmpty('vatRates', 'VAT rates', kf.vatRates.list()),
    listOrEmpty('bankAccounts', 'bank accounts', kf.bankAccounts.list()),
    listOrEmpty('journals', 'journals', kf.journals.listAll({ perpage: 200 })),
    listOrEmpty('products', 'products', kf.products.listAll({ perpage: 200 })),
    listOrEmpty('purchaseOrders', 'purchase orders', kf.purchaseOrders.listAll({ perpage: 200 })),
    listOrEmpty('quoteCategories', 'quote categories', kf.quoteCategories.list()),
    listOrEmpty('purchaseOrderCategories', 'purchase order categories', kf.purchaseOrderCategories.list()),
    listOrEmpty('currencies', 'currencies', kf.currencies.list()),
    listOrEmpty('countries', 'countries', kf.countries.list()),
    listOrEmpty('accountingPeriods', 'accounting periods', kf.accountingPeriods.list()),
    listOrEmpty('vatReturns', 'VAT returns', kf.vatReturns.list()),
  ]);

  return {
    customers, suppliers, projects, nominals, vatRates, bankAccounts,
    journals, products, purchaseOrders, quoteCategories,
    purchaseOrderCategories, currencies, countries,
    accountingPeriods, vatReturns,
  };
}

/**
 * Generic list upsert for entities with no detail phase. The key is picked per
 * row — by default the first of `keyFields` present (e.g. Id, then Code).
 *
 * `scope`, when given, is merged into every filter, making the effective key
 * the composite (scope..., keyField). Bank transactions need this: KashFlow
 * returns an internal transfer in both accounts' feeds, so the key has to be
 * per-account or the two halves overwrite each other.
 */
async function upsertSimpleList(ctx, { model, rows, summaryKey, collectionName, keyFields, pickKey = firstPresentKey(keyFields), scope, label }) {
  if (!rows?.length) return;
  const up = createBulkUpserter(model, { captureUpserts: true, audit: ctx.auditOpts(collectionName) });
  const skip = createSkipCounter();
  for (const row of rows) {
    if (typeof row !== 'object' || row == null) continue;
    const key = pickKey(row);
    if (!key) { skip.incMissingKey(); continue; }
    const { keyField, keyValue } = key;
    await up.push({ updateOne: { filter: { ...(scope || {}), [keyField]: keyValue }, update: buildUpsertUpdate({ keyField, keyValue, payload: row, runId: ctx.runId, model }), upsert: true } });
  }
  await up.flush();
  recordUpserterResult(ctx, summaryKey, up, label);
  if (skip.getMissingKey() > 0) {
    logger.warn({ skippedMissingKey: skip.getMissingKey() }, `Skipped ${summaryKey} upserts with missing key`);
    ctx.emitLog('warn', `Skipped ${summaryKey} upserts with missing key`, { count: skip.getMissingKey() });
  }
}

// Entities whose list payload is all there is — no detail phase.
const LIST_ONLY_ENTITIES = [
  { model: Journal,               summaryKey: 'journals',                collectionName: 'journals',                keyFields: ['Id', 'Number'] },
  { model: Product,               summaryKey: 'products',                collectionName: 'products',                keyFields: ['Id', 'Code'] },
  { model: PurchaseOrder,         summaryKey: 'purchaseOrders',          collectionName: 'purchaseorders',          keyFields: ['Id', 'Number'] },
  { model: QuoteCategory,         summaryKey: 'quoteCategories',         collectionName: 'quotecategories',         keyFields: ['Number'] },
  { model: PurchaseOrderCategory, summaryKey: 'purchaseOrderCategories', collectionName: 'purchaseordercategories', keyFields: ['Number'] },
  { model: Currency,              summaryKey: 'currencies',              collectionName: 'currencies',              keyFields: ['Id', 'Code'] },
  { model: Country,               summaryKey: 'countries',               collectionName: 'countries',               keyFields: ['Id', 'Code'] },
  { model: AccountingPeriod,      summaryKey: 'accountingPeriods',       collectionName: 'accountingperiods',       keyFields: ['Id'] },
  { model: VatReturn,             summaryKey: 'vatReturns',              collectionName: 'vatreturns',              keyFields: ['Id'] },
];

/** KashFlow returns VATRate as a string; store it as a number and stamp the country. */
function normaliseVatRate(row) {
  const parsed = typeof row.VATRate === 'number' ? row.VATRate : parseFloat(row.VATRate);
  const rate = Number.isFinite(parsed) ? parsed : null;
  return { ...row, VATRate: rate, Rate: rate, CountryCode: 'GB' };
}

/**
 * Upsert the list payloads for collections that have no detail phase.
 *
 * Customers, suppliers and projects are intentionally excluded here — they are
 * always written via the detail phase, with a more complete payload. Writing
 * them twice per run would cause _kfHash to oscillate between the list-field
 * hash and the detail-field hash, producing spurious Modified counts every sync.
 */
async function upsertListPhase(ctx, lists) {
  ctx.setStage('upsert:lists');
  const vatRateRows = (lists.vatRates || [])
    .filter((row) => typeof row === 'object' && row != null)
    .map(normaliseVatRate);
  await Promise.all([
    ...LIST_ONLY_ENTITIES.map((spec) => upsertSimpleList(ctx, { ...spec, rows: lists[spec.summaryKey] })),
    upsertSimpleList(ctx, { model: Nominal, rows: lists.nominals, summaryKey: 'nominals', collectionName: 'nominals', pickKey: pickIdOrCode, label: 'nominals list' }),
    upsertSimpleList(ctx, { model: VATRate, rows: vatRateRows, summaryKey: 'vatRates', collectionName: 'vatrates', keyFields: ['VATId'] }),
    upsertSimpleList(ctx, { model: BankAccount, rows: lists.bankAccounts, summaryKey: 'bankAccounts', collectionName: 'bankaccounts', pickKey: pickIdOrCode }),
  ]);
}

// ── Bank phases ──────────────────────────────────────────────────────────────

/**
 * Bank transactions — fetched per account (KashFlow has no global endpoint).
 * Best-effort: a failing account is logged and skipped so it never breaks the run.
 *
 * @returns {Promise<{fetched: number, softDeleted: number, failures: Array<{accountId, message}>}>}
 *   `failures` lists the accounts whose fetch failed outright. Kept rather than
 *   only logged: it is the difference between "the collection shrank" and "we
 *   did not look", and without it the run reports a clean success.
 */
async function syncBankTransactions(ctx, kf, bankAccounts) {
  const result = { fetched: 0, softDeleted: 0, failures: [] };
  ctx.setStage('banktransactions:fetch');
  const now = new Date();
  for (const account of bankAccounts) {
    const accountId = pickId(account);
    if (accountId == null) continue;
    try {
      const txs = await kf.bankTransactions.listAll(accountId, { perpage: 200 });
      if (!txs?.length) continue;
      result.fetched += txs.length;

      // Stamp the row with the account whose feed returned it, and key on
      // that plus Id.
      //
      // KashFlow's own `AccountId` cannot carry this. An internal transfer
      // is returned by BOTH accounts' feeds — each rendered from that
      // account's point of view (PaidIn/PaidOut swapped, Balance being that
      // account's running balance, Type naming the *other* account) — but
      // with the SAME `AccountId` in both payloads. It names the account the
      // transaction was entered against, which for 105 rows here is not even
      // one of the accounts KashFlow lists. So it does not identify the
      // ledger line, and keying on Id alone made the two feeds overwrite
      // each other every run: 422 documents churning hourly, with the larger
      // account's half never surviving because it is synced first.
      //
      // The feed is the only authority on which account a line belongs to.
      for (const t of txs) {
        if (t && typeof t === 'object' && !Array.isArray(t)) t.AccountId = accountId;
      }
      await upsertSimpleList(ctx, { model: BankTransaction, rows: txs, summaryKey: 'bankTransactions', collectionName: 'banktransactions', keyFields: ['Id'], scope: { AccountId: accountId } });

      // Soft-delete anything KashFlow no longer returns for this account.
      // Reached only after a successful, non-empty fetch — see
      // sweepMissingBankTransactions for why that is not enough on its own.
      const seen = txs.map(t => t?.Id).filter(v => v != null);
      const swept = await sweepMissingBankTransactions({
        model: BankTransaction, accountId, seen, now, graceMs: config.bankSweepGraceMs,
      });
      if (swept.pending > 0) {
        logger.info({ accountId, pending: swept.pending }, 'Bank transactions absent from KashFlow; awaiting grace window');
        ctx.emitLog('info', 'Bank transactions absent from KashFlow; awaiting grace window', { accountId, count: swept.pending });
      }
      if (swept.softDeleted > 0) {
        result.softDeleted += swept.softDeleted;
        logger.info({ accountId, softDeleted: swept.softDeleted }, 'Soft-deleted bank transactions no longer in KashFlow');
        ctx.emitLog('info', 'Soft-deleted bank transactions no longer in KashFlow', { accountId, count: swept.softDeleted });
      }
    } catch (e) {
      result.failures.push({ accountId, message: e.message });
      logger.warn({ accountId, err: e.message }, 'Failed to fetch bank transactions for account');
      ctx.emitLog('warn', 'Failed to fetch bank transactions for account', { accountId, message: e.message });
    }
  }
  ctx.emitLog('info', 'Fetched bank transactions', {
    accounts: bankAccounts.length,
    transactions: result.fetched,
    softDeleted: result.softDeleted,
    failedAccounts: result.failures.map((f) => f.accountId),
  });
  return result;
}

/**
 * Bank reconciliations — also per account, and mirrored READ-ONLY: hcs-app
 * reconciles locally and never writes back. They are synced so we can compare
 * our state against KashFlow's and take the StartBalance/EndBalance anchors for
 * period sign-off.
 *
 * The list endpoint is asked for reconciliations without their transaction
 * arrays (excludetransactions=true). The per-reconciliation transaction list
 * duplicates data we already hold in banktransactions, and pulling it for every
 * reconciliation on every hourly run would be a large amount of I/O for data
 * that is already there.
 *
 * @returns {Promise<number>} reconciliations upserted
 */
async function syncBankReconciliations(ctx, kf, bankAccounts) {
  let total = 0;
  ctx.setStage('bankreconciliations:fetch');
  for (const account of bankAccounts) {
    const accountId = pickId(account);
    if (accountId == null) continue;
    try {
      const recons = await kf.bankReconciliations.listAll(accountId, {
        perpage: 200,
        excludetransactions: true,
      });
      if (!recons?.length) continue;

      // KashFlow scopes reconciliation Ids under an account and returns the
      // account nowhere in the body, so both AccountId and the ReconKey
      // composite are injected here. They must be set before the upsert
      // runs, because the engine reads the key field off the row to build
      // its filter — a transform would be too late.
      const rows = [];
      for (const r of recons) {
        if (typeof r !== 'object' || r == null) continue;
        if (r.Id == null) continue;
        r.AccountId = accountId;
        r.ReconKey = `${accountId}:${r.Id}`;
        rows.push(r);
      }
      if (!rows.length) continue;

      total += rows.length;
      await upsertSimpleList(ctx, { model: BankReconciliation, rows, summaryKey: 'bankReconciliations', collectionName: 'bankreconciliations', keyFields: ['ReconKey'] });
    } catch (e) {
      // Best-effort, matching the bank-transaction loop: a failing account is
      // logged and skipped so it never breaks the run.
      logger.warn({ accountId, err: e.message }, 'Failed to fetch bank reconciliations for account');
      ctx.emitLog('warn', 'Failed to fetch bank reconciliations for account', { accountId, message: e.message });
    }
  }
  ctx.emitLog('info', 'Fetched bank reconciliations', { accounts: bankAccounts.length, reconciliations: total });
  return total;
}

// ── Detail phases ────────────────────────────────────────────────────────────

/** detailSyncedAt moves only when the content hash does, like updatedAt. */
function applyDetailSyncedAt(update, now) {
  update[0].$set.detailSyncedAt = { $cond: { if: { $ne: ['$_kfHash', update[0].$set._kfHash] }, then: { $literal: now }, else: { $ifNull: ['$detailSyncedAt', { $literal: now }] } } };
  update._rawSet.detailSyncedAt = now;
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Fetch each item's full detail from KashFlow and upsert it.
 *
 * @param {object} opts
 * @param {string} opts.summaryKey   run-summary / progress key, e.g. 'invoices'
 * @param {string} opts.noun         singular, for log lines, e.g. 'invoice'
 * @param {Array}  opts.items        what fetchDetail is called with
 * @param {(item) => Promise<object>} opts.fetchDetail
 * @param {(full, item) => {keyField, keyValue}|null} opts.resolveKey  null skips the row
 * @param {(full, item) => void} [opts.prepare]  mutate the payload before upsert
 * @param {boolean} [opts.stampDetailSyncedAt]
 * @param {boolean} [opts.tolerateErrors]  false lets a failed fetch fail the run
 * @param {(item) => object} [opts.logContext]  identifies the item in log lines
 * @param {string} [opts.progressLogLabel]  when set, logs progress every 5%
 */
async function upsertDetails(ctx, {
  model, summaryKey, collectionName, noun, items, concurrency,
  fetchDetail, resolveKey, prepare,
  stampDetailSyncedAt = false,
  tolerateErrors = true,
  logContext = (item) => ({ item }),
  progressLogLabel,
}) {
  progress.setItemTotal(summaryKey, items.length);
  progress.setItemDone(summaryKey, 0);
  const upserter = createBulkUpserter(model, { captureUpserts: true, audit: ctx.auditOpts(collectionName) });
  const runNow = new Date();
  let failed = 0;

  const upsertOne = async (item) => {
    const full = await fetchDetail(item);
    if (!full || typeof full !== 'object') {
      failed += 1;
      logger.warn(logContext(item), `${capitalise(noun)} detail returned empty response`);
      return 0;
    }
    const key = resolveKey(full, item);
    if (!key) return 0;
    if (prepare) prepare(full, item);
    // buildUpsertUpdate applies the model's syncConfig.transform itself.
    const update = buildUpsertUpdate({ ...key, payload: full, runId: ctx.runId, model });
    if (stampDetailSyncedAt) applyDetailSyncedAt(update, runNow);
    await upserter.push({ updateOne: { filter: { [key.keyField]: key.keyValue }, update, upsert: true } });
    return 1;
  };

  const onProgress = progressLogLabel
    ? logProgressEvery(progressLogLabel, 20, `${capitalise(noun)} detail progress`)
    : undefined;
  await createPool(concurrency, summaryKey, async (item) => {
    try {
      return await upsertOne(item);
    } catch (err) {
      if (!tolerateErrors) throw err;
      failed += 1;
      logger.warn({ ...logContext(item), err: err.message }, `Failed to process ${noun} detail`);
      return 0;
    } finally {
      progress.incItem(summaryKey, 1);
    }
  }, onProgress)(items);

  await upserter.flush();
  recordUpserterResult(ctx, summaryKey, upserter, `${summaryKey} details`);
  if (failed > 0) {
    logger.warn({ [`${summaryKey}DetailFailed`]: failed }, `Some ${noun} detail fetches failed`);
    ctx.emitLog('warn', `Some ${noun} detail fetches failed`, { [`${summaryKey}DetailFailed`]: failed });
  }
}

/**
 * Detail phase for a parent entity (customer, supplier, project) whose codes
 * come straight from its list. Without Mongo there is nothing to write, so the
 * progress bar is simply marked complete.
 */
async function syncParentDetails(ctx, { mongoEnabled, keys, skippedTotal = keys.length, ...opts }) {
  const { summaryKey } = opts;
  if (!mongoEnabled || keys.length === 0) {
    progress.setItemTotal(summaryKey, skippedTotal);
    progress.setItemDone(summaryKey, skippedTotal);
    return;
  }
  ctx.setStage(`${summaryKey}:details`);
  await upsertDetails(ctx, { ...opts, items: keys });
}

/**
 * Phase 1 of a document pipeline: list the documents under each parent
 * (customer or supplier) and collect the { id, number } pairs to fetch.
 */
async function listPerParent(ctx, { summaryKey, parent, parentCodes, parentsTotal, listFn }) {
  const concurrency = config.concurrency || 4;
  ctx.setStage(`${summaryKey}:per-${parent}`);
  progress.setItemTotal(summaryKey, parentsTotal);
  progress.setItemDone(summaryKey, 0);
  const message = `Starting per-${parent} ${summaryKey} list fetch`;
  logger.info({ [`${parent}s`]: parentCodes.length, concurrency }, message);
  ctx.emitLog('info', message, { [`${parent}s`]: parentCodes.length, concurrency });

  let skippedMissingId = 0;
  const entries = [];
  const perParent = await createPool(concurrency, summaryKey, async (code) => {
    const list = await listFn(code);
    for (const item of list || []) {
      const id = pickId(item);
      if (id == null) { skippedMissingId += 1; continue; }
      const number = pickNumber(item);
      if (number != null) entries.push({ id, number });
    }
    progress.incItem(summaryKey, 1);
    return list?.length || 0;
  }, logProgressEvery(summaryKey, 10, `Per-${parent} list progress`))(parentCodes);

  const total = perParent.reduce((a, b) => a + (Number(b) || 0), 0);
  return { total, entries, skippedMissingId };
}

/**
 * A document pipeline (invoices, quotes, purchases): list per parent, then
 * fetch and upsert each document's detail.
 *
 * @returns {Promise<number>} documents listed
 */
async function syncDocuments(ctx, {
  mongoEnabled, model, summaryKey, collectionName, noun,
  parent, parentCodes, parentsTotal, listFn, getFn, prepare, onListed,
}) {
  const listed = await listPerParent(ctx, { summaryKey, parent, parentCodes, parentsTotal, listFn });
  if (onListed) onListed(listed);
  const { total, entries, skippedMissingId } = listed;

  if (mongoEnabled && entries.length > 0) {
    const detailConcurrency = config.detailConcurrency || 8;
    ctx.setStage(`${summaryKey}:details`);
    logger.info({ count: entries.length, concurrency: detailConcurrency }, `Starting ${noun} detail fanout`);
    ctx.emitLog('info', `Starting ${noun} detail fanout`, { count: entries.length, concurrency: detailConcurrency });
    await upsertDetails(ctx, {
      model, summaryKey, collectionName, noun,
      items: entries,
      concurrency: detailConcurrency,
      fetchDetail: ({ number }) => getFn(number),
      resolveKey: (_full, { id }) => ({ keyField: 'Id', keyValue: id }),
      prepare,
      stampDetailSyncedAt: true,
      logContext: ({ id, number }) => ({ [`${noun}Number`]: number, [`${noun}Id`]: id }),
      progressLogLabel: `${noun}Details`,
    });
  }
  if (skippedMissingId > 0) logger.warn({ skippedMissingId }, `Skipped ${noun} upserts with missing Id`);
  logger.info({ [`${summaryKey}Count`]: total }, `Fetched ${summaryKey} (per ${parent})`);
  return total;
}

/**
 * Purchases need two things the other document pipelines don't: a check for
 * detail responses with no LineItems, and a SupplierId backfill.
 */
async function syncPurchases(ctx, kf, { mongoEnabled, suppliers, supplierCodes }) {
  // KashFlow stopped returning SupplierId on purchase details (~May 2026;
  // SupplierCode remains). Backfill it from the suppliers list so
  // downstream consumers (CIS dashboard, returns) can keep joining on it.
  const supplierIdByCode = new Map();
  for (const s of suppliers || []) {
    const sid = pickId(s);
    const scode = pickCode(s);
    if (sid != null && scode) supplierIdByCode.set(String(scode).trim().toUpperCase(), sid);
  }
  let supplierIdBackfilled = 0;
  let noLineItems = 0;
  let listedWithNumber = 0;

  const total = await syncDocuments(ctx, {
    mongoEnabled, model: Purchase, summaryKey: 'purchases', collectionName: 'purchases', noun: 'purchase',
    parent: 'supplier', parentCodes: supplierCodes, parentsTotal: (suppliers || []).length,
    listFn: (code) => kf.purchases.listAll({ perpage: 200, supplierCode: code }),
    getFn: (number) => kf.purchases.get(number),
    onListed: ({ total: listed, entries, skippedMissingId }) => {
      listedWithNumber = entries.length;
      logger.info({ purchasesListTotal: listed, purchasesWithNumber: entries.length, purchasesSkippedMissingId: skippedMissingId, purchasesMissingNumber: listed - entries.length - skippedMissingId }, 'Purchase Phase 1 summary');
      ctx.emitLog('info', 'Purchase Phase 1 summary', { listed, withNumber: entries.length, missingId: skippedMissingId });
    },
    prepare: (full, { id, number }) => {
      if (!Array.isArray(full.LineItems) || full.LineItems.length === 0) {
        noLineItems += 1;
        const paymentLinesCount = Array.isArray(full.PaymentLines) ? full.PaymentLines.length : 0;
        logger.warn({ purchaseNumber: number, purchaseId: id, paymentLinesCount }, 'Purchase detail returned 0 LineItems');
      }
      if ((full.SupplierId == null || full.SupplierId === '') && full.SupplierCode) {
        const sid = supplierIdByCode.get(String(full.SupplierCode).trim().toUpperCase());
        if (sid != null) { full.SupplierId = sid; supplierIdBackfilled += 1; }
      }
    },
  });

  if (supplierIdBackfilled > 0) {
    logger.info({ purchasesSupplierIdBackfilled: supplierIdBackfilled }, 'Backfilled SupplierId from SupplierCode on purchase details');
    ctx.emitLog('info', 'Backfilled SupplierId from SupplierCode', { purchasesSupplierIdBackfilled: supplierIdBackfilled });
  }
  if (noLineItems > 0) {
    logger.warn({ purchasesDetailNoLineItems: noLineItems, total: listedWithNumber }, 'Some purchase detail responses had 0 LineItems');
    ctx.emitLog('warn', 'Some purchase detail responses had 0 LineItems', { purchasesDetailNoLineItems: noLineItems });
  }
  return total;
}

/**
 * All six detail pipelines, run concurrently. Within each document pipeline,
 * phase 1 (list per parent) runs first and feeds phase 2 (details).
 *
 * @returns {Promise<{invoicesTotal: number, quotesTotal: number, purchasesTotal: number}>}
 */
async function runDetailPhases(ctx, kf, { mongoEnabled, lists, customerCodes, supplierCodes }) {
  const { customers, suppliers, projects } = lists;
  const concurrency = config.concurrency || 4;
  const detailConcurrency = config.detailConcurrency || 8;
  const projectNumbers = (projects || []).map(pickNumber).filter((x) => x != null);

  const [, , , invoicesTotal, quotesTotal, purchasesTotal] = await Promise.all([
    syncParentDetails(ctx, {
      mongoEnabled, keys: customerCodes, model: Customer, summaryKey: 'customers', collectionName: 'customers', noun: 'customer',
      concurrency, tolerateErrors: false, logContext: (code) => ({ customerCode: code }),
      fetchDetail: (code) => kf.customers.get(code),
      resolveKey: (full) => { const id = pickId(full); return id == null ? null : { keyField: 'Id', keyValue: id }; },
    }),
    syncParentDetails(ctx, {
      mongoEnabled, keys: supplierCodes, model: Supplier, summaryKey: 'suppliers', collectionName: 'suppliers', noun: 'supplier',
      concurrency, tolerateErrors: false, logContext: (code) => ({ supplierCode: code }),
      fetchDetail: (code) => kf.suppliers.get(code),
      resolveKey: (full) => { const id = pickId(full); return id == null ? null : { keyField: 'Id', keyValue: id }; },
    }),
    syncParentDetails(ctx, {
      mongoEnabled, keys: projectNumbers, skippedTotal: (projects || []).length,
      model: Project, summaryKey: 'projects', collectionName: 'projects', noun: 'project',
      concurrency: detailConcurrency, logContext: (number) => ({ projectNumber: number }),
      fetchDetail: (number) => kf.projects.get(number),
      resolveKey: (full, number) => {
        const id = pickId(full);
        return id != null ? { keyField: 'Id', keyValue: id } : { keyField: 'Number', keyValue: number };
      },
    }).then(() => logger.info({ projectsCount: projects?.length || 0 }, 'Fetched projects')),
    syncDocuments(ctx, {
      mongoEnabled, model: Invoice, summaryKey: 'invoices', collectionName: 'invoices', noun: 'invoice',
      parent: 'customer', parentCodes: customerCodes, parentsTotal: (customers || []).length,
      listFn: (code) => kf.invoices.listAll({ perpage: 200, customerCode: code }),
      getFn: (number) => kf.invoices.get(number),
    }),
    syncDocuments(ctx, {
      mongoEnabled, model: Quote, summaryKey: 'quotes', collectionName: 'quotes', noun: 'quote',
      parent: 'customer', parentCodes: customerCodes, parentsTotal: (customers || []).length,
      listFn: (code) => kf.quotes.listAll({ perpage: 200, customerCode: code }),
      getFn: (number) => kf.quotes.get(number),
    }),
    syncPurchases(ctx, kf, { mongoEnabled, suppliers, supplierCodes }),
  ]);
  return { invoicesTotal, quotesTotal, purchasesTotal };
}

// ── Run ──────────────────────────────────────────────────────────────────────

/** Authenticate and prove KashFlow connectivity by fetching one customer. */
async function connectKashflow(ctx) {
  ctx.setStage('kashflow:auth');
  const kf = await createClient();
  logger.info('Starting KashFlow admin sync (Node.js)');
  ctx.emitLog('info', 'Starting KashFlow admin sync');

  ctx.setStage('kashflow:probe');
  try {
    await kf.customers.list({ perpage: 1 });
    logger.info('KashFlow connectivity check ok');
    ctx.emitLog('info', 'KashFlow connectivity check ok');
  } catch (probeErr) {
    logger.error({ status: probeErr.response?.status, message: probeErr.message, data: probeErr.response?.data }, 'KashFlow connectivity probe failed');
    ctx.emitLog('error', 'KashFlow connectivity probe failed', { status: probeErr?.response?.status || null, message: probeErr?.message || null });
    throw probeErr;
  }
  return kf;
}

/**
 * Connect the optional MongoDB sink. Without it the run is fetch-only.
 * @returns {Promise<boolean>} whether Mongo is enabled for this run
 */
async function connectMongoSink(ctx) {
  if (!isMongooseEnabled()) {
    logger.warn('MongoDB not configured; running in fetch-only mode (no upserts)');
    ctx.emitLog('warn', 'Mongo not configured; running in fetch-only mode');
    return false;
  }
  ctx.setStage('mongo:connect');
  await connectMongoose();
  await ensureKashflowIndexes(mongoose.connection.db);
  ctx.auditCol = mongoose.connection.db.collection('audit_log');
  ctx.emitLog('info', 'Mongo connected');
  return true;
}

/**
 * `counts.bankTransactions` must be what is STORED, not what was fetched.
 *
 * Every other entry in `counts` is a fetch tally and that is harmless, because
 * those fetches are all-or-nothing for the run. Bank transactions are fetched
 * per account and a single account is allowed to fail, so the fetch tally drops
 * by that account's whole ledger while the collection is untouched. Downstream,
 * `summariseRunChanges` diffs consecutive runs' counts, so on 2026-08-16 a
 * 611594 timeout published "bankTransactions 13955 → 5522 (-8433)" on an
 * emerald *Completed* embed, then "+8433" an hour later when the next fetch
 * succeeded — two alerts describing mass deletion and recovery, neither of
 * which happened. The stored count is stable across a partial fetch, which is
 * exactly the property the alert needs.
 *
 * @returns {Promise<number|null>} null when it could not be counted
 */
async function countStoredBankTransactions(mongoEnabled) {
  if (!mongoEnabled || !BankTransaction) return null;
  try {
    return await BankTransaction.countDocuments({ deletedAt: null });
  } catch (e) {
    // The caller falls back to the fetch tally rather than losing the field.
    logger.warn({ err: e.message }, 'Failed to count stored bank transactions');
    return null;
  }
}

function buildCounts(lists, { bank, bankTransactionsStored, bankReconciliationsTotal, invoicesTotal, quotesTotal, purchasesTotal }) {
  const n = (key) => lists[key]?.length || 0;
  return {
    customers: n('customers'),
    suppliers: n('suppliers'),
    projects: n('projects'),
    nominals: n('nominals'),
    vatRates: n('vatRates'),
    bankAccounts: n('bankAccounts'),
    bankTransactions: bankTransactionsStored ?? bank.fetched,
    bankTransactionsFetched: bank.fetched,
    bankTransactionsSoftDeleted: bank.softDeleted,
    bankReconciliations: bankReconciliationsTotal,
    journals: n('journals'),
    products: n('products'),
    purchaseOrders: n('purchaseOrders'),
    quoteCategories: n('quoteCategories'),
    purchaseOrderCategories: n('purchaseOrderCategories'),
    currencies: n('currencies'),
    countries: n('countries'),
    accountingPeriods: n('accountingPeriods'),
    vatReturns: n('vatReturns'),
    invoices: invoicesTotal,
    quotes: quotesTotal,
    purchases: purchasesTotal,
  };
}

async function run(options = {}) {
  const runId = options?.runId ? String(options.runId) : null;
  const recordLog = typeof options?.recordLog === 'function' ? options.recordLog : null;
  const start = Date.now();
  const ctx = createRunContext({ runId, recordLog });

  const heartbeat = setInterval(() => {
    logger.info({ stage: ctx.stage, uptimeMs: Date.now() - start }, 'Sync heartbeat');
  }, 5000);
  // Don’t keep the process alive just for the heartbeat timer.
  try { heartbeat.unref?.(); } catch {}

  try {
    const kf = await connectKashflow(ctx);
    const mongoEnabled = await connectMongoSink(ctx);

    ctx.setStage('fetch:lists');
    // Collects the count-keys whose KashFlow list fetch failed this run. A failed
    // fetch is caught and turned into an empty array so the run continues, but
    // empty-from-failure is NOT the same as genuinely-empty: without this set
    // the two are indistinguishable downstream, and a transient failure reads as a
    // collection dropping to zero — a phantom "-40" data-loss delta on Discord.
    // The client already retries KashFlow's SQL timeout for every request; this
    // covers whatever transient failure survives that (network blips, 5xx, an
    // exhausted retry). The count carry-forward keyed off this set (see
    // carryForwardFailedCounts) is what keeps such a run from reporting a delta.
    const failedFetches = new Set();
    const lists = await fetchLists(kf, failedFetches);

    // Bank transactions and reconciliations are fetched per bank account, and
    // both phases are gated on a non-empty bankAccounts list. So when the
    // bankAccounts fetch fails, those two never run and their counts read as 0
    // for reasons that have nothing to do with KashFlow's actual data — the same
    // phantom-delta trap. Mark them failed too so their counts are carried
    // forward rather than reported as a drop.
    if (failedFetches.has('bankAccounts')) {
      failedFetches.add('bankTransactions');
      failedFetches.add('bankReconciliations');
    }

    const customerCodes = (lists.customers || []).map(pickCode).filter((x) => !isMissingKey(x));
    const supplierCodes = (lists.suppliers || []).map(pickCode).filter((x) => !isMissingKey(x));
    ctx.emitLog('info', 'Fetched KashFlow lists', Object.fromEntries(
      Object.entries(lists).map(([key, rows]) => [key, rows?.length || 0]),
    ));

    if (mongoEnabled) await upsertListPhase(ctx, lists);

    const hasBankAccounts = mongoEnabled && lists.bankAccounts?.length > 0;
    const bank = hasBankAccounts
      ? await syncBankTransactions(ctx, kf, lists.bankAccounts)
      : { fetched: 0, softDeleted: 0, failures: [] };
    // BankReconciliation is null when built against hcs-schemas < 2.1.0 — the
    // dependency is a branch tip, so that is a real possibility rather than a
    // theoretical one. Skipping leaves every other entity syncing normally.
    const bankReconciliationsTotal = hasBankAccounts && BankReconciliation
      ? await syncBankReconciliations(ctx, kf, lists.bankAccounts)
      : 0;

    const { invoicesTotal, quotesTotal, purchasesTotal } = await runDetailPhases(ctx, kf, {
      mongoEnabled, lists, customerCodes, supplierCodes,
    });
    const bankTransactionsStored = await countStoredBankTransactions(mongoEnabled);

    progress.setItemTotal('nominals', (lists.nominals || []).length);
    progress.setItemDone('nominals', (lists.nominals || []).length);
    logger.info({ nominalsCount: lists.nominals?.length || 0 }, 'Fetched nominals');
    ctx.emitLog('info', 'Fetched transactional items', { invoices: invoicesTotal ?? 0, quotes: quotesTotal ?? 0, purchases: purchasesTotal ?? 0 });
    const counts = buildCounts(lists, {
      bank, bankTransactionsStored, bankReconciliationsTotal, invoicesTotal, quotesTotal, purchasesTotal,
    });
    ctx.setStage('finalising');
    logger.info({ counts, durationMs: Date.now() - start }, 'KashFlow admin sync (Node.js) finished');
    ctx.emitLog('success', 'Sync finished', { counts, durationMs: Date.now() - start });
    return {
      counts,
      // Placeholder for persisted previous counts; the caller falls back to its own.
      previousCounts: null,
      mongo: mongoEnabled ? ctx.mongoSummary : null,
      mongoUpserts: mongoEnabled ? ctx.mongoDetails : null,
      // Accounts the run could not read. The run still resolves — one bad
      // account must not abort the other twenty entities — but the caller needs
      // this to alert, otherwise a partial run is indistinguishable from a
      // clean one at every level above the log.
      partial: { bankTransactions: bank.failures },
      // Count-keys whose list fetch failed this run (empty result came from an
      // error, not from KashFlow genuinely holding nothing). The caller carries
      // their previous counts forward so a transient failure is not reported as a
      // drop to zero. Includes bankTransactions/bankReconciliations when the
      // bankAccounts fetch they depend on failed.
      failedFetches: [...failedFetches],
    };
  } catch (err) {
    ctx.emitLog('error', 'Sync runner failed', { message: err?.message || null, status: err?.response?.status || null });
    throw err;
  } finally {
    try { clearInterval(heartbeat); } catch {}
  }
}

if (process.argv[1] && process.argv[1].endsWith('run.js')) {
  run().catch((err) => {
    logger.error({ err }, 'Sync failed');
    process.exitCode = 1;
  });
}

export default run;

// Named exports for unit testing of internal helpers
export {
  createPool,
  buildUpsertUpdate,
  createBulkUpserter,
  pickCode,
  pickNumber,
  pickId,
  isMissingKey,
  toDate,
  computeCisTaxPeriod,
  preparePurchaseForUpsert,
  createSkipCounter,
  addMongoStats,
  carryForwardFailedCounts,
  SUPPLIER_PROTECTED_FIELDS,
};