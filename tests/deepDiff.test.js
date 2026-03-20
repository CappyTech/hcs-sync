/**
 * Tests for src/util/deepDiff.js
 */
import { describe, it, expect } from 'vitest';
import deepDiff, { ARRAY_KEYS, SKIP_FIELDS, stableStringify } from '../src/util/deepDiff.js';

// ── Scalar changes ──────────────────────────────────────────────────────

describe('deepDiff – scalars', () => {
  it('detects a string change', () => {
    const result = deepDiff({ Name: 'Acme Ltd' }, { Name: 'Acme Limited' });
    expect(result).toEqual([{ path: 'Name', before: 'Acme Ltd', after: 'Acme Limited', type: 'changed' }]);
  });

  it('detects a number change', () => {
    const result = deepDiff({ NetAmount: 100 }, { NetAmount: 200 });
    expect(result).toEqual([{ path: 'NetAmount', before: 100, after: 200, type: 'changed' }]);
  });

  it('detects a boolean change', () => {
    const result = deepDiff({ IsArchived: false }, { IsArchived: true });
    expect(result).toEqual([{ path: 'IsArchived', before: false, after: true, type: 'changed' }]);
  });

  it('detects a field added (was null)', () => {
    const result = deepDiff({ PaidDate: null }, { PaidDate: '2026-03-20' });
    expect(result).toEqual([{ path: 'PaidDate', before: null, after: '2026-03-20', type: 'added' }]);
  });

  it('detects a field removed (set to null)', () => {
    const result = deepDiff({ Note: 'hello' }, { Note: null });
    expect(result).toEqual([{ path: 'Note', before: 'hello', after: null, type: 'removed' }]);
  });

  it('returns empty array when values are identical', () => {
    const result = deepDiff({ Name: 'Same', Id: 42 }, { Name: 'Same', Id: 42 });
    expect(result).toEqual([]);
  });

  it('only diffs fields present in after (incoming payload)', () => {
    const before = { Name: 'Old', InternalField: 'keep' };
    const after = { Name: 'New' };
    const result = deepDiff(before, after);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('Name');
  });
});

// ── Skip fields ─────────────────────────────────────────────────────────

describe('deepDiff – skip fields', () => {
  it('skips syncedAt, uuid, _id, __v, createdAt, updatedAt, createdByRunId', () => {
    const before = { _id: 'a', uuid: 'u1', syncedAt: new Date('2025-01-01'), Name: 'Old' };
    const after = { _id: 'b', uuid: 'u2', syncedAt: new Date('2026-03-20'), Name: 'New', createdAt: new Date(), updatedAt: new Date(), __v: 2, createdByRunId: 'r2' };
    const result = deepDiff(before, after);
    expect(result).toEqual([{ path: 'Name', before: 'Old', after: 'New', type: 'changed' }]);
  });
});

// ── Date comparison ─────────────────────────────────────────────────────

describe('deepDiff – dates', () => {
  it('detects date change between Date objects', () => {
    const d1 = new Date('2025-06-01');
    const d2 = new Date('2026-03-20');
    const result = deepDiff({ DueDate: d1 }, { DueDate: d2 });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('changed');
  });

  it('treats identical dates as no change', () => {
    const d = new Date('2025-06-01T00:00:00Z');
    const result = deepDiff({ DueDate: d }, { DueDate: new Date('2025-06-01T00:00:00Z') });
    expect(result).toEqual([]);
  });

  it('compares date string vs Date object', () => {
    const result = deepDiff(
      { IssuedDate: new Date('2025-01-15T00:00:00Z') },
      { IssuedDate: '2025-01-15T00:00:00.000Z' }
    );
    expect(result).toEqual([]);
  });
});

// ── Nested objects ──────────────────────────────────────────────────────

describe('deepDiff – nested objects', () => {
  it('diffs into a nested object', () => {
    const before = { Currency: { Code: 'GBP', ExchangeRate: 1 } };
    const after = { Currency: { Code: 'USD', ExchangeRate: 1.27 } };
    const result = deepDiff(before, after);
    expect(result).toContainEqual({ path: 'Currency.Code', before: 'GBP', after: 'USD', type: 'changed' });
    expect(result).toContainEqual({ path: 'Currency.ExchangeRate', before: 1, after: 1.27, type: 'changed' });
  });

  it('detects added nested object', () => {
    const result = deepDiff({ Address: null }, { Address: { PostCode: 'SW1' } });
    expect(result).toEqual([{ path: 'Address', before: null, after: { PostCode: 'SW1' }, type: 'added' }]);
  });

  it('respects max depth', () => {
    const deep = { a: { b: { c: { d: { e: 'old' } } } } };
    const after = { a: { b: { c: { d: { e: 'new' } } } } };
    // maxDepth=3: depth count starts at 0 for top-level keys, so a.b.c.d hits depth 3 and is compared as JSON
    const result = deepDiff(deep, after, { maxDepth: 3 });
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('a.b.c.d');
    expect(result[0].type).toBe('changed');
  });
});

// ── Arrays (key-based) ──────────────────────────────────────────────────

describe('deepDiff – arrays (key-based)', () => {
  it('detects added array item by key', () => {
    const before = { LineItems: [{ Id: 1, Quantity: 5 }] };
    const after = { LineItems: [{ Id: 1, Quantity: 5 }, { Id: 2, Quantity: 3 }] };
    const result = deepDiff(before, after);
    const added = result.find((r) => r.type === 'added');
    expect(added).toBeDefined();
    expect(added.path).toBe('LineItems[Id=2]');
  });

  it('detects removed array item by key', () => {
    const before = { LineItems: [{ Id: 1, Quantity: 5 }, { Id: 2, Quantity: 3 }] };
    const after = { LineItems: [{ Id: 1, Quantity: 5 }] };
    const result = deepDiff(before, after);
    const removed = result.find((r) => r.type === 'removed');
    expect(removed).toBeDefined();
    expect(removed.path).toBe('LineItems[Id=2]');
  });

  it('detects field change within array item by key', () => {
    const before = { LineItems: [{ Id: 1, Quantity: 5, NetAmount: 50 }] };
    const after = { LineItems: [{ Id: 1, Quantity: 10, NetAmount: 100 }] };
    const result = deepDiff(before, after);
    expect(result).toContainEqual({ path: 'LineItems[Id=1].Quantity', before: 5, after: 10, type: 'changed' });
    expect(result).toContainEqual({ path: 'LineItems[Id=1].NetAmount', before: 50, after: 100, type: 'changed' });
  });

  it('handles PaymentLines with Id key', () => {
    const before = { PaymentLines: [] };
    const after = { PaymentLines: [{ Id: 99, Amount: 750, Method: 1 }] };
    const result = deepDiff(before, after);
    const added = result.find((r) => r.type === 'added');
    expect(added).toBeDefined();
    expect(added.path).toBe('PaymentLines[Id=99]');
  });
});

// ── Arrays (index-based) ────────────────────────────────────────────────

describe('deepDiff – arrays (index-based)', () => {
  it('falls back to index-based for arrays without configured key', () => {
    const before = { WHTReferences: ['ref1', 'ref2'] };
    const after = { WHTReferences: ['ref1', 'ref3'] };
    const result = deepDiff(before, after);
    expect(result).toContainEqual({ path: 'WHTReferences[1]', before: 'ref2', after: 'ref3', type: 'changed' });
  });

  it('detects added item at end (index-based)', () => {
    const before = { CustomCheckBoxes: [true] };
    const after = { CustomCheckBoxes: [true, false] };
    const result = deepDiff(before, after);
    expect(result).toContainEqual({ path: 'CustomCheckBoxes[1]', before: null, after: false, type: 'added' });
  });
});

// ── Max changes cap ─────────────────────────────────────────────────────

describe('deepDiff – max changes', () => {
  it('caps output to maxChanges', () => {
    const before = {};
    const after = {};
    for (let i = 0; i < 300; i++) {
      before[`field${i}`] = 'old';
      after[`field${i}`] = 'new';
    }
    const result = deepDiff(before, after, { maxChanges: 50 });
    expect(result.length).toBeLessThanOrEqual(50);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────

describe('deepDiff – edge cases', () => {
  it('returns empty when both are null', () => {
    expect(deepDiff(null, null)).toEqual([]);
  });

  it('returns empty when both are empty objects', () => {
    expect(deepDiff({}, {})).toEqual([]);
  });

  it('handles type change from scalar to object', () => {
    const result = deepDiff({ Status: 'Active' }, { Status: { Code: 1, Label: 'Active' } });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('changed');
  });

  it('handles type change from array to scalar', () => {
    const result = deepDiff({ Tags: ['a', 'b'] }, { Tags: 'merged' });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('changed');
  });
});

// ── stableStringify ─────────────────────────────────────────────────────

describe('stableStringify', () => {
  it('sorts object keys deterministically', () => {
    const a = stableStringify({ b: 2, a: 1 });
    const b = stableStringify({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('handles nested objects', () => {
    const s = stableStringify({ z: { b: 2, a: 1 }, a: [3, 1] });
    expect(s).toContain('"a":1');
    expect(s).toContain('"b":2');
  });

  it('handles null and undefined', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('undefined');
  });
});
