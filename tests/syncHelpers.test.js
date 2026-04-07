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

describe('buildUpsertUpdate()', () => {
  it('flattens payload into $set', () => {
    const now = new Date();
    const result = buildUpsertUpdate({
      keyField: 'Code', keyValue: 'C001',
      payload: { Name: 'Test', Email: 'a@b.com' }, syncedAt: now,
    });
    expect(result.$set.Name).toBe('Test');
    expect(result.$set.Email).toBe('a@b.com');
    expect(result.$set.Code).toBe('C001');
    expect(result.$set.syncedAt).toBe(now);
  });

  it('excludes reserved keys (_id, data, uuid, syncedAt, createdAt)', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1,
      payload: { _id: 'x', data: {}, uuid: 'x', syncedAt: 'x', createdAt: 'x', Name: 'yes' },
      syncedAt: new Date(),
    });
    expect(result.$set).not.toHaveProperty('_id');
    expect(result.$set).not.toHaveProperty('data');
    expect(result.$set).not.toHaveProperty('uuid');
    expect(result.$set.syncedAt).toBeInstanceOf(Date);
    expect(result.$set.Name).toBe('yes');
  });

  it('excludes keys starting with $', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1,
      payload: { $set: 'bad', Name: 'ok' }, syncedAt: new Date(),
    });
    expect(result.$set).not.toHaveProperty('$set');
    expect(result.$set.Name).toBe('ok');
  });

  it('excludes keys with dots or null bytes', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1,
      payload: { 'a.b': 1, 'c\0d': 2, Name: 'ok' }, syncedAt: new Date(),
    });
    expect(result.$set).not.toHaveProperty('a.b');
    expect(result.$set).not.toHaveProperty('c\0d');
  });

  it('respects protectedFields', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1,
      payload: { Name: 'Test', CISRate: 0.2, Subcontractor: true },
      syncedAt: new Date(), protectedFields: ['CISRate', 'Subcontractor'],
    });
    expect(result.$set.Name).toBe('Test');
    expect(result.$set).not.toHaveProperty('CISRate');
    expect(result.$set).not.toHaveProperty('Subcontractor');
  });

  it('includes createdByRunId in $setOnInsert when runId provided', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: {}, syncedAt: new Date(), runId: 'run-123',
    });
    expect(result.$setOnInsert.createdByRunId).toBe('run-123');
  });

  it('does not include createdByRunId when runId is absent', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: {}, syncedAt: new Date(),
    });
    expect(result.$setOnInsert).not.toHaveProperty('createdByRunId');
  });

  it('$unset removes legacy data field', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: {}, syncedAt: new Date(),
    });
    expect(result.$unset).toEqual({ data: '' });
  });

  it('$setOnInsert includes uuid (createdAt handled by Mongoose timestamps)', () => {
    const now = new Date();
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: {}, syncedAt: now,
    });
    expect(result.$setOnInsert.uuid).toBeDefined();
    expect(typeof result.$setOnInsert.uuid).toBe('string');
    expect(result.$setOnInsert.createdAt).toBeUndefined();
  });

  it('handles non-object payload gracefully', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: null, syncedAt: new Date(),
    });
    expect(result.$set.Id).toBe(1);
  });

  it('handles array payload gracefully', () => {
    const result = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: [1, 2, 3], syncedAt: new Date(),
    });
    expect(result.$set.Id).toBe(1);
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

  it('falls back to IssuedDate when PaidDate is also null', () => {
    const item = {
      PaidDate: null,
      IssuedDate: '2025-12-15',
      DueDate: null,
    };
    preparePurchaseForUpsert(item);
    expect(item.TaxYear).toBe(2025);
    expect(item.TaxMonth).toBe(9);
  });

  it('does not set TaxYear/TaxMonth when no date is available', () => {
    const item = {
      PaidDate: null,
      IssuedDate: null,
      DueDate: null,
    };
    preparePurchaseForUpsert(item);
    expect(item.TaxYear).toBeUndefined();
    expect(item.TaxMonth).toBeUndefined();
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
