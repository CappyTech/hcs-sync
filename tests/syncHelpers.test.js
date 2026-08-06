/**
 * Tests for helper functions exported from src/sync/run.js.
 *
 * These tests now import the real implementations instead of duplicating logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock heavy dependencies so the module loads without side-effects
vi.mock('../src/util/logger.js', () => {
  const noop = vi.fn();
  return { default: { info: noop, warn: noop, error: noop, debug: noop, trace: noop, child: () => ({ info: noop, warn: noop, error: noop, debug: noop }) } };
});
vi.mock('../src/kashflow/client.js', () => ({ default: vi.fn() }));
vi.mock('../src/server/progress.js', () => ({
  default: { setStage: vi.fn(), setItemTotal: vi.fn(), setItemDone: vi.fn(), incItem: vi.fn() },
}));
vi.mock('../src/db/mongoose.js', () => ({
  isMongooseEnabled: vi.fn(() => false),
  connectMongoose: vi.fn(),
}));
vi.mock('../src/db/mongo.js', () => ({
  ensureKashflowIndexes: vi.fn(),
}));
vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));

import {
  pickCode,
  pickNumber,
  pickId,
  isMissingKey,
  toDate,
  computeCisTaxPeriod,
  buildUpsertUpdate,
  createPool,
  createBulkUpserter,
  preparePurchaseForUpsert,
  createSkipCounter,
  addMongoStats,
  sweepMissingBankTransactions,
  SUPPLIER_PROTECTED_FIELDS,
} from '../src/sync/run.js';

// ── pickCode ──

describe('pickCode()', () => {
  it('picks Code (PascalCase)', () => expect(pickCode({ Code: 'ABC' })).toBe('ABC'));
  it('picks code (camelCase)', () => expect(pickCode({ code: 'abc' })).toBe('abc'));
  it('picks CustomerCode', () => expect(pickCode({ CustomerCode: 'CC1' })).toBe('CC1'));
  it('picks SupplierCode', () => expect(pickCode({ SupplierCode: 'SC1' })).toBe('SC1'));
  it('returns null when absent', () => expect(pickCode({ Name: 'X' })).toBeNull());
  it('returns null for null/undefined', () => {
    expect(pickCode(null)).toBeNull();
    expect(pickCode(undefined)).toBeNull();
  });
});

// ── pickNumber ──

describe('pickNumber()', () => {
  it('picks Number (PascalCase)', () => expect(pickNumber({ Number: 42 })).toBe(42));
  it('picks number (camelCase)', () => expect(pickNumber({ number: 7 })).toBe(7));
  it('returns null when absent', () => expect(pickNumber({})).toBeNull());
});

// ── pickId ──

describe('pickId()', () => {
  it('picks Id (PascalCase)', () => expect(pickId({ Id: 123 })).toBe(123));
  it('picks id (camelCase)', () => expect(pickId({ id: 456 })).toBe(456));
  it('returns null when absent', () => expect(pickId({})).toBeNull());
});

// ── isMissingKey ──

describe('isMissingKey()', () => {
  it('null is missing', () => expect(isMissingKey(null)).toBe(true));
  it('undefined is missing', () => expect(isMissingKey(undefined)).toBe(true));
  it('empty string is missing', () => expect(isMissingKey('')).toBe(true));
  it('whitespace-only is missing', () => expect(isMissingKey('  ')).toBe(true));
  it('zero is NOT missing', () => expect(isMissingKey(0)).toBe(false));
  it('non-empty string is NOT missing', () => expect(isMissingKey('abc')).toBe(false));
});

// ── toDate ──

describe('toDate()', () => {
  it('returns null for null/undefined/empty', () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate('')).toBeNull();
  });
  it('parses a KashFlow date string', () => {
    const d = toDate('2025-12-10 12:00:00');
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2025);
  });
  it('passes through a valid Date', () => {
    const orig = new Date(2025, 5, 15);
    expect(toDate(orig)).toBe(orig);
  });
  it('returns null for an invalid Date object', () => {
    expect(toDate(new Date('invalid'))).toBeNull();
  });
  it('returns null for unparseable strings', () => {
    expect(toDate('not-a-date')).toBeNull();
  });
});

// ── computeCisTaxPeriod ──

describe('computeCisTaxPeriod()', () => {
  it('returns null for invalid dates', () => {
    expect(computeCisTaxPeriod(null)).toBeNull();
    expect(computeCisTaxPeriod('bad')).toBeNull();
  });
  it('6 April starts tax month 1', () => {
    expect(computeCisTaxPeriod(new Date(2025, 3, 6))).toEqual({ TaxYear: 2025, TaxMonth: 1 });
  });
  it('5 April belongs to previous tax year, month 12', () => {
    expect(computeCisTaxPeriod(new Date(2025, 3, 5))).toEqual({ TaxYear: 2024, TaxMonth: 12 });
  });
  it('1 January is tax month 9', () => {
    expect(computeCisTaxPeriod(new Date(2026, 0, 1))).toEqual({ TaxYear: 2025, TaxMonth: 9 });
  });
  it('6 May is tax month 2', () => {
    expect(computeCisTaxPeriod(new Date(2025, 4, 6))).toEqual({ TaxYear: 2025, TaxMonth: 2 });
  });
  it('5 May is still tax month 1', () => {
    expect(computeCisTaxPeriod(new Date(2025, 4, 5))).toEqual({ TaxYear: 2025, TaxMonth: 1 });
  });
  it('6 March is tax month 12', () => {
    expect(computeCisTaxPeriod(new Date(2026, 2, 6))).toEqual({ TaxYear: 2025, TaxMonth: 12 });
  });
  it('accepts date strings', () => {
    const result = computeCisTaxPeriod('2025-07-15');
    expect(result.TaxYear).toBe(2025);
    expect(result.TaxMonth).toBe(4);
  });

  // BST edge-cases: KashFlow sends UK local dates as UTC strings.
  // 6 Apr 2026 00:00 BST = 2026-04-05T23:00:00Z — must land in tax year 2026.
  it('BST: 6 Apr midnight BST (stored as 5 Apr 23:00 UTC) → TaxYear 2026, TaxMonth 1', () => {
    expect(computeCisTaxPeriod(new Date('2026-04-05T23:00:00Z'))).toEqual({ TaxYear: 2026, TaxMonth: 1 });
  });
  // 6 Sep 2025 00:00 BST = 2025-09-05T23:00:00Z — must be tax month 6, not 5.
  it('BST: 6 Sep midnight BST (stored as 5 Sep 23:00 UTC) → TaxYear 2025, TaxMonth 6', () => {
    expect(computeCisTaxPeriod(new Date('2025-09-05T23:00:00Z'))).toEqual({ TaxYear: 2025, TaxMonth: 6 });
  });
  // GMT (winter): 6 Jan 2026 00:00 GMT = 2026-01-06T00:00:00Z — no offset, still correct.
  it('GMT: 6 Jan midnight GMT (no BST offset) → TaxYear 2025, TaxMonth 10', () => {
    expect(computeCisTaxPeriod(new Date('2026-01-06T00:00:00Z'))).toEqual({ TaxYear: 2025, TaxMonth: 10 });
  });
});

// ── buildUpsertUpdate ──
// buildUpsertUpdate now returns a MongoDB aggregation pipeline array:
//   [0] = { $set: { ...fields wrapped in $literal, conditional timestamp expressions } }
//   [1] = { $unset: 'data' }  (legacy envelope cleanup)
// pipeline._rawSet  = plain JS object with raw payload values (for audit diffing)
// Timestamps use $ifNull (insert-only) or $cond on _kfHash (changed-only).

describe('buildUpsertUpdate()', () => {
  it('returns a pipeline array and exposes _rawSet', () => {
    const result = buildUpsertUpdate({
      keyField: 'Code', keyValue: 'C001',
      payload: { Name: 'Test', Email: 'a@b.com' }, syncedAt: new Date(),
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toHaveProperty('$set');
    expect(result._rawSet).toBeDefined();
  });

  it('flattens payload into pipeline $set as $literal values', () => {
    const result = buildUpsertUpdate({
      keyField: 'Code', keyValue: 'C001',
      payload: { Name: 'Test', Email: 'a@b.com' }, syncedAt: new Date(),
    });
    const $set = result[0].$set;
    expect($set.Name).toEqual({ $literal: 'Test' });
    expect($set.Email).toEqual({ $literal: 'a@b.com' });
    expect($set.Code).toEqual({ $literal: 'C001' });
  });

  it('exposes raw values on _rawSet for audit diffing', () => {
    const result = buildUpsertUpdate({
      keyField: 'Code', keyValue: 'C001',
      payload: { Name: 'Test', Email: 'a@b.com' }, syncedAt: new Date(),
    });
    expect(result._rawSet.Name).toBe('Test');
    expect(result._rawSet.Code).toBe('C001');
  });

  it('excludes reserved keys (_id, data, uuid, syncedAt, createdAt) from payload flattening', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1,
      payload: { _id: 'x', data: {}, uuid: 'x', syncedAt: 'x', createdAt: 'x', Name: 'yes' },
      syncedAt: new Date(),
    });
    const $set = result[0].$set;
    expect($set).not.toHaveProperty('_id');
    // syncedAt is managed by the pipeline (insert-only $ifNull)
    expect($set.syncedAt).toEqual({ $ifNull: ['$syncedAt', '$$NOW'] });
    // data is removed via the $unset stage, not present in $set
    expect($set).not.toHaveProperty('data');
    // uuid is managed by the pipeline (insert-only $ifNull)
    expect($set.uuid).toBeDefined();
    expect($set.Name).toEqual({ $literal: 'yes' });
  });

  it('excludes keys starting with $', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1,
      payload: { $set: 'bad', Name: 'ok' }, syncedAt: new Date(),
    });
    const $set = result[0].$set;
    expect($set).not.toHaveProperty('$set');
    expect($set.Name).toEqual({ $literal: 'ok' });
  });

  it('excludes keys with dots or null bytes', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1,
      payload: { 'a.b': 1, 'c\0d': 2, Name: 'ok' }, syncedAt: new Date(),
    });
    const $set = result[0].$set;
    expect($set).not.toHaveProperty('a.b');
    expect($set).not.toHaveProperty('c\0d');
  });

  it('respects protectedFields', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1,
      payload: { Name: 'Test', CISRate: 0.2, Subcontractor: true },
      syncedAt: new Date(), protectedFields: ['CISRate', 'Subcontractor'],
    });
    const $set = result[0].$set;
    expect($set.Name).toEqual({ $literal: 'Test' });
    expect($set).not.toHaveProperty('CISRate');
    expect($set).not.toHaveProperty('Subcontractor');
  });

  it('includes createdByRunId as insert-only $ifNull when runId provided', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: {}, syncedAt: new Date(), runId: 'run-123',
    });
    expect(result[0].$set.createdByRunId).toEqual({
      $ifNull: ['$createdByRunId', { $literal: 'run-123' }],
    });
  });

  it('does not include createdByRunId when runId is absent', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: {}, syncedAt: new Date(),
    });
    expect(result[0].$set).not.toHaveProperty('createdByRunId');
  });

  it('second pipeline stage removes legacy data field', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: {}, syncedAt: new Date(),
    });
    expect(result[1]).toEqual({ $unset: 'data' });
  });

  it('uuid is insert-only via $ifNull', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: {}, syncedAt: new Date(),
    });
    const uuidExpr = result[0].$set.uuid;
    expect(uuidExpr).toHaveProperty('$ifNull');
    expect(uuidExpr.$ifNull[0]).toBe('$uuid');
    expect(typeof uuidExpr.$ifNull[1].$literal).toBe('string');
  });

  it('syncedAt is insert-only via $ifNull', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: {}, syncedAt: new Date(),
    });
    expect(result[0].$set.syncedAt).toEqual({ $ifNull: ['$syncedAt', '$$NOW'] });
  });

  it('updatedAt uses $cond based on _kfHash change', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: { Name: 'X' }, syncedAt: new Date(),
    });
    const updatedAt = result[0].$set.updatedAt;
    expect(updatedAt).toHaveProperty('$cond');
    expect(updatedAt.$cond.if).toHaveProperty('$ne');
    expect(updatedAt.$cond.then).toBe('$$NOW');
  });

  it('_kfHash is a 16-char hex string', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: { Name: 'X' }, syncedAt: new Date(),
    });
    const hash = result[0].$set._kfHash?.$literal;
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(16);
  });

  it('handles non-object payload gracefully', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: null, syncedAt: new Date(),
    });
    expect(result[0].$set.Id).toEqual({ $literal: 1 });
  });

  it('handles array payload gracefully', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: [1, 2, 3], syncedAt: new Date(),
    });
    expect(result[0].$set.Id).toEqual({ $literal: 1 });
  });
});

// ── volatileFields ──
// A volatile field is one KashFlow recomputes per request and can return
// differently for unchanged data (bankTransaction.Balance). Both halves matter
// and are pinned separately: excluded from the hash, AND written only when the
// hash moves. Keeping only the first still rewrites the document every run,
// because modifiedCount counts the write and not the hash.

describe('buildUpsertUpdate() volatileFields', () => {
  const model = { syncConfig: { keyField: 'Id', volatileFields: ['Balance'] } };
  const build = (payload) => buildUpsertUpdate({
    keyField: 'Id', keyValue: 1, payload, syncedAt: new Date(), model,
  });

  it('excludes volatile fields from the content hash', () => {
    const a = build({ Name: 'X', Balance: 100 });
    const b = build({ Name: 'X', Balance: 999 });
    expect(a[0].$set._kfHash).toEqual(b[0].$set._kfHash);
  });

  it('still lets non-volatile fields change the hash', () => {
    const a = build({ Name: 'X', Balance: 100 });
    const b = build({ Name: 'Y', Balance: 100 });
    expect(a[0].$set._kfHash).not.toEqual(b[0].$set._kfHash);
  });

  it('writes a volatile field only when the hash changes, keeping the stored value otherwise', () => {
    const result = build({ Name: 'X', Balance: 100 });
    const expr = result[0].$set.Balance;
    expect(expr).toHaveProperty('$cond');
    expect(expr.$cond.if).toEqual({ $ne: ['$_kfHash', result[0].$set._kfHash] });
    expect(expr.$cond.then).toEqual({ $literal: 100 });
    // On insert there is nothing stored, so the else branch must still supply
    // the value rather than leaving the field off the new document.
    expect(expr.$cond.else).toEqual({ $ifNull: ['$Balance', { $literal: 100 }] });
  });

  it('names volatile fields on _rawVolatile and keeps them out of _rawSet', () => {
    const result = build({ Name: 'X', Balance: 100 });
    expect(result._rawVolatile).toEqual(['Balance']);
    expect(result._rawSet).not.toHaveProperty('Balance');
    expect(result._rawSet.Name).toBe('X');
  });

  it('omits _rawVolatile entirely when the model declares none', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: { Name: 'X', Balance: 100 }, syncedAt: new Date(),
    });
    expect(result._rawVolatile).toBeUndefined();
    expect(result[0].$set.Balance).toEqual({ $literal: 100 });
  });
});

// ── audit diffing of volatile fields ──
// The second half of the volatileFields mechanism. deepDiff walks the union of
// the stored document's keys and the incoming _rawSet, so a volatile field
// simply left out of _rawSet reports as 'removed' on every run — the audit noise
// this feature exists to remove, in a new form. _rawVolatile is what stops it.

describe('createBulkUpserter() audit diffing', () => {
  const auditRun = async (update, existing) => {
    const inserted = [];
    const collection = {
      find: () => ({ lean: async () => [existing] }),
      collection: {
        bulkWrite: vi.fn().mockResolvedValue({ upsertedCount: 0, modifiedCount: 1, matchedCount: 1 }),
      },
    };
    const upserter = createBulkUpserter(collection, {
      batchSize: 1,
      audit: {
        collectionName: 'banktransactions',
        runId: 'run-1',
        auditCollection: { insertMany: async (docs) => { inserted.push(...docs); } },
      },
    });
    await upserter.push({ updateOne: { filter: { Id: 1 }, update, upsert: true } });
    await upserter.flush();
    return inserted;
  };

  it('records no change when only a volatile field differs', async () => {
    const update = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: { Name: 'X', Balance: 999 }, syncedAt: new Date(),
      model: { syncConfig: { keyField: 'Id', volatileFields: ['Balance'] } },
    });
    const entries = await auditRun(update, { Id: 1, Name: 'X', Balance: 100, deletedAt: null, DeletedAt: null });
    expect(entries).toHaveLength(0);
  });

  it('still records changes to real fields alongside a volatile one', async () => {
    const update = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: { Name: 'Y', Balance: 999 }, syncedAt: new Date(),
      model: { syncConfig: { keyField: 'Id', volatileFields: ['Balance'] } },
    });
    const entries = await auditRun(update, { Id: 1, Name: 'X', Balance: 100, deletedAt: null, DeletedAt: null });
    expect(entries).toHaveLength(1);
    expect(entries[0].changes.map(c => c.path)).toEqual(['Name']);
  });

  it('records a volatile field normally when the model declares none', async () => {
    const update = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: { Name: 'X', Balance: 999 }, syncedAt: new Date(),
    });
    const entries = await auditRun(update, { Id: 1, Name: 'X', Balance: 100, deletedAt: null, DeletedAt: null });
    expect(entries).toHaveLength(1);
    expect(entries[0].changes.map(c => c.path)).toEqual(['Balance']);
  });
});

// ── sweepMissingBankTransactions ──
// The regression this guards: KashFlow paginates the largest account over ~40
// requests and has dropped rows between pages. A single absence is a missed
// page as often as a deletion, and acting on it hides live ledger lines from
// /bank. Absence must therefore be corroborated across the grace window.

/**
 * Minimal in-memory stand-in for a Mongoose model, supporting only the query
 * operators this sweep uses. Real enough that the tests exercise the filters
 * rather than just asserting they were called.
 */
function fakeModel(docs) {
  const matches = (doc, filter) => Object.entries(filter).every(([k, cond]) => {
    const v = doc[k] ?? null;
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === '$in') return arg.includes(v);
        if (op === '$nin') return !arg.includes(v);
        if (op === '$ne') return v !== arg;
        if (op === '$lte') return v !== null && v <= arg;
        throw new Error(`unsupported operator ${op}`);
      });
    }
    return v === cond;
  });
  return {
    docs,
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const doc of docs) {
        if (!matches(doc, filter)) continue;
        let changed = false;
        for (const [k, v] of Object.entries(update.$set)) {
          if (doc[k] !== v) { doc[k] = v; changed = true; }
        }
        if (changed) modifiedCount++;
      }
      return { modifiedCount };
    },
  };
}

describe('sweepMissingBankTransactions()', () => {
  const t0 = new Date('2026-08-06T10:00:00Z');
  const t1 = new Date('2026-08-06T11:00:00Z');
  const t3 = new Date('2026-08-06T13:00:00Z');
  const GRACE = 2 * 60 * 60 * 1000;
  const row = (Id, extra = {}) => ({ Id, AccountId: 611594, deletedAt: null, missingSince: null, ...extra });

  it('does not soft-delete a row missing from a single fetch', async () => {
    const model = fakeModel([row(1), row(2)]);
    const res = await sweepMissingBankTransactions({
      model, accountId: 611594, seen: [1], now: t0, graceMs: GRACE,
    });
    expect(res).toEqual({ pending: 1, softDeleted: 0 });
    expect(model.docs[1].deletedAt).toBeNull();
    expect(model.docs[1].missingSince).toEqual(t0);
  });

  it('soft-deletes once the row is still missing after the grace window', async () => {
    const model = fakeModel([row(1), row(2)]);
    await sweepMissingBankTransactions({ model, accountId: 611594, seen: [1], now: t0, graceMs: GRACE });
    const res = await sweepMissingBankTransactions({
      model, accountId: 611594, seen: [1], now: t3, graceMs: GRACE,
    });
    expect(res.softDeleted).toBe(1);
    expect(model.docs[1].deletedAt).toEqual(t3);
  });

  it('a row that reappears within the window is never deleted and its timer resets', async () => {
    // The exact 2026-08-06 incident: absent at 10:00, back at 11:00.
    const model = fakeModel([row(1), row(2)]);
    await sweepMissingBankTransactions({ model, accountId: 611594, seen: [1], now: t0, graceMs: GRACE });
    await sweepMissingBankTransactions({ model, accountId: 611594, seen: [1, 2], now: t1, graceMs: GRACE });
    expect(model.docs[1].missingSince).toBeNull();
    expect(model.docs[1].deletedAt).toBeNull();

    // ...and the reset means a later single absence still gets a full window,
    // rather than the stale timer making it an instant deletion.
    const res = await sweepMissingBankTransactions({
      model, accountId: 611594, seen: [1], now: t3, graceMs: GRACE,
    });
    expect(res).toEqual({ pending: 1, softDeleted: 0 });
    expect(model.docs[1].deletedAt).toBeNull();
  });

  it('clears a stale timer on rows that are back but already soft-deleted', async () => {
    const model = fakeModel([row(1), row(2, { deletedAt: t0, missingSince: t0 })]);
    await sweepMissingBankTransactions({ model, accountId: 611594, seen: [1, 2], now: t3, graceMs: GRACE });
    expect(model.docs[1].missingSince).toBeNull();
  });

  it('graceMs of 0 soft-deletes on first absence (the pre-0.11.2 behaviour)', async () => {
    const model = fakeModel([row(1), row(2)]);
    const res = await sweepMissingBankTransactions({
      model, accountId: 611594, seen: [1], now: t0, graceMs: 0,
    });
    expect(res.softDeleted).toBe(1);
    expect(model.docs[1].deletedAt).toEqual(t0);
  });

  it('does nothing when the fetch returned no ids', async () => {
    const model = fakeModel([row(1), row(2)]);
    const res = await sweepMissingBankTransactions({
      model, accountId: 611594, seen: [], now: t0, graceMs: GRACE,
    });
    expect(res).toEqual({ pending: 0, softDeleted: 0 });
    expect(model.docs.every(d => d.deletedAt === null)).toBe(true);
  });

  it('never touches another account', async () => {
    const model = fakeModel([row(1), { ...row(9), AccountId: 572402 }]);
    await sweepMissingBankTransactions({ model, accountId: 611594, seen: [1], now: t0, graceMs: 0 });
    expect(model.docs[1].deletedAt).toBeNull();
  });
});

// ── SUPPLIER_PROTECTED_FIELDS ──

describe('SUPPLIER_PROTECTED_FIELDS', () => {
  it('contains CIS-related field names', () => {
    expect(SUPPLIER_PROTECTED_FIELDS).toContain('Subcontractor');
    expect(SUPPLIER_PROTECTED_FIELDS).toContain('CISRate');
    expect(SUPPLIER_PROTECTED_FIELDS).toContain('CISNumber');
    expect(SUPPLIER_PROTECTED_FIELDS).toContain('IsSubcontractor');
  });
});

// ── createPool ──

describe('createPool()', () => {
  it('processes all items with the given handler', async () => {
    const handler = vi.fn(async (item) => item * 2);
    const pool = createPool(2, 'test', handler);
    const results = await pool([1, 2, 3, 4]);
    expect(results).toEqual([2, 4, 6, 8]);
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('respects concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const handler = vi.fn(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
    });
    const pool = createPool(2, 'test', handler);
    await pool([1, 2, 3, 4, 5]);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('calls onProgress for each completed item', async () => {
    const progress = vi.fn();
    const handler = vi.fn(async (item) => item);
    const pool = createPool(2, 'my-label', handler, progress);
    await pool([1, 2, 3]);
    expect(progress).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ label: 'my-label', total: 3 }));
  });

  it('handles empty items array', async () => {
    const handler = vi.fn();
    const pool = createPool(2, 'test', handler);
    const results = await pool([]);
    expect(results).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('still reports progress even when handler throws', async () => {
    const progress = vi.fn();
    const handler = vi.fn(async () => { throw new Error('fail'); });
    const pool = createPool(1, 'test', handler, progress);
    await expect(pool([1])).rejects.toThrow('fail');
    expect(progress).toHaveBeenCalledTimes(1);
  });
});

// ── createBulkUpserter ──

describe('createBulkUpserter()', () => {
  let mockCollection;

  beforeEach(() => {
    mockCollection = {
      collection: {
        bulkWrite: vi.fn().mockResolvedValue({
          upsertedCount: 1,
          modifiedCount: 0,
          matchedCount: 0,
        }),
      },
    };
  });

  it('batches writes by batchSize', async () => {
    const upserter = createBulkUpserter(mockCollection, 2);
    await upserter.push({ updateOne: { filter: { Id: 1 }, update: {}, upsert: true } });
    expect(mockCollection.collection.bulkWrite).not.toHaveBeenCalled();
    await upserter.push({ updateOne: { filter: { Id: 2 }, update: {}, upsert: true } });
    expect(mockCollection.collection.bulkWrite).toHaveBeenCalledTimes(1);
  });

  it('flush writes remaining ops', async () => {
    const upserter = createBulkUpserter(mockCollection, 100);
    await upserter.push({ updateOne: { filter: { Id: 1 }, update: {}, upsert: true } });
    expect(mockCollection.collection.bulkWrite).not.toHaveBeenCalled();
    await upserter.flush();
    expect(mockCollection.collection.bulkWrite).toHaveBeenCalledTimes(1);
  });

  it('getStats returns accumulated statistics', async () => {
    mockCollection.collection.bulkWrite.mockResolvedValue({
      upsertedCount: 2,
      modifiedCount: 1,
      matchedCount: 3,
    });
    const upserter = createBulkUpserter(mockCollection, 1);
    await upserter.push({ updateOne: { filter: { Id: 1 }, update: {}, upsert: true } });
    const stats = upserter.getStats();
    expect(stats.attemptedOps).toBe(1);
    expect(stats.upserted).toBe(2);
    expect(stats.modified).toBe(1);
    expect(stats.matched).toBe(3);
    expect(stats.affected).toBe(2 + 3);
  });

  it('accepts options object with batchSize', async () => {
    const upserter = createBulkUpserter(mockCollection, { batchSize: 1 });
    await upserter.push({ updateOne: { filter: { Id: 1 }, update: {}, upsert: true } });
    expect(mockCollection.collection.bulkWrite).toHaveBeenCalledTimes(1);
  });

  it('captures upserted filters when captureUpserts is true', async () => {
    mockCollection.collection.bulkWrite.mockResolvedValue({
      upsertedCount: 1,
      modifiedCount: 0,
      matchedCount: 0,
      upsertedIds: { '0': 'abc' },
    });
    const upserter = createBulkUpserter(mockCollection, { batchSize: 1, captureUpserts: true });
    await upserter.push({ updateOne: { filter: { Id: 99 }, update: {}, upsert: true } });
    const { filters, truncated } = upserter.getUpsertedFilters();
    expect(filters).toEqual([{ Id: 99 }]);
    expect(truncated).toBe(false);
  });

  it('truncates upserted filters at maxCapturedUpserts', async () => {
    let callIndex = 0;
    mockCollection.collection.bulkWrite.mockImplementation(async () => {
      callIndex++;
      return {
        upsertedCount: 1,
        modifiedCount: 0,
        matchedCount: 0,
        upsertedIds: { '0': `id-${callIndex}` },
      };
    });
    const upserter = createBulkUpserter(mockCollection, { batchSize: 1, captureUpserts: true, maxCapturedUpserts: 2 });
    await upserter.push({ updateOne: { filter: { Id: 1 }, update: {}, upsert: true } });
    await upserter.push({ updateOne: { filter: { Id: 2 }, update: {}, upsert: true } });
    await upserter.push({ updateOne: { filter: { Id: 3 }, update: {}, upsert: true } });
    const { filters, truncated } = upserter.getUpsertedFilters();
    expect(filters).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('flush on empty does not call bulkWrite', async () => {
    const upserter = createBulkUpserter(mockCollection, 100);
    await upserter.flush();
    expect(mockCollection.collection.bulkWrite).not.toHaveBeenCalled();
  });
});

// ── preparePurchaseForUpsert ──

describe('preparePurchaseForUpsert()', () => {
  it('converts date string fields to Date objects', () => {
    const item = {
      PaidDate: '2025-06-01',
      IssuedDate: '2025-05-15',
      DueDate: '2025-07-01',
    };
    preparePurchaseForUpsert(item);
    expect(item.PaidDate).toBeInstanceOf(Date);
    expect(item.IssuedDate).toBeInstanceOf(Date);
    expect(item.DueDate).toBeInstanceOf(Date);
  });

  it('nullifies invalid date fields', () => {
    const item = {
      PaidDate: 'not-a-date',
      IssuedDate: null,
      DueDate: '',
    };
    preparePurchaseForUpsert(item);
    expect(item.PaidDate).toBeNull();
    expect(item.IssuedDate).toBeNull();
    expect(item.DueDate).toBeNull();
  });

  it('converts PaymentLines date fields', () => {
    const item = {
      PaidDate: null,
      IssuedDate: null,
      DueDate: null,
      PaymentLines: [
        { PayDate: '2025-06-15', Date: '2025-06-14' },
      ],
    };
    preparePurchaseForUpsert(item);
    expect(item.PaymentLines[0].PayDate).toBeInstanceOf(Date);
    expect(item.PaymentLines[0].Date).toBeInstanceOf(Date);
  });

  it('computes TaxYear and TaxMonth from PaymentLines PayDate', () => {
    const item = {
      PaidDate: null,
      IssuedDate: '2025-01-01',
      DueDate: null,
      PaymentLines: [
        { PayDate: '2025-07-15', Date: null },
      ],
    };
    preparePurchaseForUpsert(item);
    expect(item.TaxYear).toBe(2025);
    expect(item.TaxMonth).toBe(4);
  });

  it('falls back to PaidDate when no PaymentLines', () => {
    const item = {
      PaidDate: '2025-04-06',
      IssuedDate: null,
      DueDate: null,
    };
    preparePurchaseForUpsert(item);
    expect(item.TaxYear).toBe(2025);
    expect(item.TaxMonth).toBe(1);
  });

  it('does not stamp from IssuedDate: unpaid purchases carry no tax period', () => {
    const item = {
      PaidDate: null,
      IssuedDate: '2025-12-15',
      DueDate: null,
    };
    preparePurchaseForUpsert(item);
    expect(item.TaxYear).toBeNull();
    expect(item.TaxMonth).toBeNull();
  });

  it('clears a stale stamp when no payment date is available', () => {
    const item = {
      PaidDate: null,
      IssuedDate: null,
      DueDate: null,
      TaxYear: 2025,
      TaxMonth: 9,
    };
    preparePurchaseForUpsert(item);
    expect(item.TaxYear).toBeNull();
    expect(item.TaxMonth).toBeNull();
  });

  it('uses the earliest payment line, not the first in array order', () => {
    const item = {
      PaidDate: null,
      IssuedDate: null,
      DueDate: null,
      PaymentLines: [
        { PayDate: '2025-07-15', Date: null },
        { PayDate: '2025-06-10', Date: null },
      ],
    };
    preparePurchaseForUpsert(item);
    expect(item.TaxYear).toBe(2025);
    expect(item.TaxMonth).toBe(3);
  });

  it('falls back to a payment line Date when PayDate is missing', () => {
    const item = {
      PaidDate: null,
      IssuedDate: null,
      DueDate: null,
      PaymentLines: [
        { PayDate: null, Date: '2025-08-20' },
      ],
    };
    preparePurchaseForUpsert(item);
    expect(item.TaxYear).toBe(2025);
    expect(item.TaxMonth).toBe(5);
  });

  it('returns the mutated item', () => {
    const item = { PaidDate: null, IssuedDate: null, DueDate: null };
    const result = preparePurchaseForUpsert(item);
    expect(result).toBe(item);
  });
});

// ── createSkipCounter ──

describe('createSkipCounter()', () => {
  it('starts at zero', () => {
    const counter = createSkipCounter();
    expect(counter.getMissingKey()).toBe(0);
  });

  it('increments count', () => {
    const counter = createSkipCounter();
    counter.incMissingKey();
    counter.incMissingKey();
    expect(counter.getMissingKey()).toBe(2);
  });
});

// ── addMongoStats ──

describe('addMongoStats()', () => {
  it('creates a fresh target when null', () => {
    const result = addMongoStats(null, { attemptedOps: 5, affected: 3, upserted: 2, matched: 1, modified: 0 });
    expect(result).toEqual({ attemptedOps: 5, affected: 3, upserted: 2, matched: 1, modified: 0 });
  });

  it('accumulates into existing target', () => {
    const target = { attemptedOps: 10, affected: 5, upserted: 3, matched: 2, modified: 1 };
    addMongoStats(target, { attemptedOps: 5, affected: 3, upserted: 2, matched: 1, modified: 0 });
    expect(target).toEqual({ attemptedOps: 15, affected: 8, upserted: 5, matched: 3, modified: 1 });
  });

  it('returns target unchanged when stats is null', () => {
    const target = { attemptedOps: 1, affected: 1, upserted: 0, matched: 1, modified: 0 };
    const result = addMongoStats(target, null);
    expect(result).toBe(target);
  });

  it('handles missing fields in stats gracefully', () => {
    const result = addMongoStats(null, {});
    expect(result).toEqual({ attemptedOps: 0, affected: 0, upserted: 0, matched: 0, modified: 0 });
  });
});
