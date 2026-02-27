import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDedup } from '../src/db/dedup.js';

// ---------------------------------------------------------------------------
// Mock helpers – build fake MongoDB collection & db objects
// ---------------------------------------------------------------------------

/** Create a mock MongoDB collection supporting aggregate, deleteMany, countDocuments, find, bulkWrite. */
function createMockCollection({ aggregateResult = [], countResult = 0, findDocs = [] } = {}) {
  return {
    aggregate: vi.fn(() => ({
      toArray: vi.fn().mockResolvedValue(aggregateResult),
    })),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: aggregateResult.length > 0 ? 1 : 0 }),
    countDocuments: vi.fn().mockResolvedValue(countResult),
    find: vi.fn(() => ({
      // Async iterable for cursor-based iteration (used by backfillUuids)
      [Symbol.asyncIterator]: async function* () {
        for (const d of findDocs) yield d;
      },
      projection: vi.fn().mockReturnThis(),
    })),
    bulkWrite: vi.fn().mockResolvedValue({}),
  };
}

/** Create a mock db with per-collection configuration. */
function createMockDb(collectionConfigs = {}) {
  const collections = {};
  return {
    collection: vi.fn((name) => {
      if (!collections[name]) {
        collections[name] = createMockCollection(collectionConfigs[name] || {});
      }
      return collections[name];
    }),
    _getCol: (name) => collections[name],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('src/db/dedup.js – runDedup()', () => {
  const noop = () => {};

  it('returns zero totals when no duplicates exist', async () => {
    const db = createMockDb();
    const result = await runDedup(db, { dryRun: false, log: noop });

    expect(result.totalGroups).toBe(0);
    expect(result.totalDeleted).toBe(0);
    expect(result.totalBackfilled).toBe(0);
    expect(result.actions).toEqual([]);
    expect(result.collections).toHaveLength(7); // 7 known collections
    result.collections.forEach((c) => {
      expect(c.duplicateGroups).toBe(0);
      expect(c.deleted).toBe(0);
    });
  });

  it('deletes the non-uuid doc when one copy has a uuid', async () => {
    const aggregateResult = [
      {
        _id: 100, // KashFlow Id value
        count: 2,
        docs: [
          { _id: 'doc1', uuid: 'uuid-1', syncedAt: '2025-01-01T00:00:00Z' },
          { _id: 'doc2', uuid: null, syncedAt: '2025-01-02T00:00:00Z' },
        ],
      },
    ];

    const db = createMockDb({
      customers: { aggregateResult },
    });

    const result = await runDedup(db, { dryRun: false, log: noop });

    // Should have deleted 1 document from 'customers'
    const customerCol = db._getCol('customers');
    expect(customerCol.deleteMany).toHaveBeenCalledTimes(1);
    const deleteFilter = customerCol.deleteMany.mock.calls[0][0];
    expect(deleteFilter._id.$in).toContain('doc2');
    expect(deleteFilter._id.$in).not.toContain('doc1');

    // Actions should record the deletion
    const deletions = result.actions.filter((a) => a.type === 'deleted');
    expect(deletions).toHaveLength(1);
    expect(deletions[0].documentId).toBe('doc2');
    expect(deletions[0].keptDocumentId).toBe('doc1');
  });

  it('keeps the oldest uuid doc when multiple have uuids', async () => {
    const aggregateResult = [
      {
        _id: 200,
        count: 3,
        docs: [
          { _id: 'doc-a', uuid: 'u-old', syncedAt: '2024-06-01T00:00:00Z' },
          { _id: 'doc-b', uuid: 'u-new', syncedAt: '2025-06-01T00:00:00Z' },
          { _id: 'doc-c', uuid: null,    syncedAt: '2024-01-01T00:00:00Z' },
        ],
      },
    ];

    const db = createMockDb({
      suppliers: { aggregateResult },
    });

    const result = await runDedup(db, { dryRun: false, log: noop });

    const supplierCol = db._getCol('suppliers');
    const deleteFilter = supplierCol.deleteMany.mock.calls[0][0];
    // Should delete doc-c (no uuid) and doc-b (newer uuid)
    expect(deleteFilter._id.$in).toContain('doc-c');
    expect(deleteFilter._id.$in).toContain('doc-b');
    expect(deleteFilter._id.$in).not.toContain('doc-a');

    // Kept doc should be doc-a (oldest with uuid)
    const kept = result.actions.find((a) => a.keptDocumentId === 'doc-a');
    expect(kept).toBeTruthy();
  });

  it('keeps oldest doc when none have uuids', async () => {
    const aggregateResult = [
      {
        _id: 300,
        count: 2,
        docs: [
          { _id: 'old', uuid: null, syncedAt: '2024-01-01T00:00:00Z' },
          { _id: 'new', uuid: null, syncedAt: '2025-01-01T00:00:00Z' },
        ],
      },
    ];

    const db = createMockDb({
      invoices: { aggregateResult },
    });

    const result = await runDedup(db, { dryRun: false, log: noop });

    const invoiceCol = db._getCol('invoices');
    const deleteFilter = invoiceCol.deleteMany.mock.calls[0][0];
    expect(deleteFilter._id.$in).toContain('new');
    expect(deleteFilter._id.$in).not.toContain('old');
  });

  it('records "would-delete" actions in dry-run mode', async () => {
    const aggregateResult = [
      {
        _id: 400,
        count: 2,
        docs: [
          { _id: 'd1', uuid: 'u1', syncedAt: '2024-01-01T00:00:00Z' },
          { _id: 'd2', uuid: null, syncedAt: '2025-01-01T00:00:00Z' },
        ],
      },
    ];

    const db = createMockDb({
      purchases: { aggregateResult },
    });

    const result = await runDedup(db, { dryRun: true, log: noop });

    // Should NOT actually delete
    const purchaseCol = db._getCol('purchases');
    expect(purchaseCol.deleteMany).not.toHaveBeenCalled();

    // Actions should use 'would-delete'
    expect(result.actions.every((a) => a.type === 'would-delete')).toBe(true);
    expect(result.totalDeleted).toBe(1); // count of what would be deleted
  });

  it('backfills uuids on docs missing them (apply mode)', async () => {
    const docsWithoutUuid = [
      { _id: 'x1', Id: 1 },
      { _id: 'x2', Id: 2 },
    ];

    const db = createMockDb({
      customers: { countResult: 2, findDocs: docsWithoutUuid },
    });

    const result = await runDedup(db, { dryRun: false, log: noop });

    const customerCol = db._getCol('customers');
    expect(customerCol.bulkWrite).toHaveBeenCalled();
    const ops = customerCol.bulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(2);
    ops.forEach((op) => {
      expect(op.updateOne.update.$set.uuid).toBeTypeOf('string');
    });

    // Actions should include uuid-backfill entries
    const backfills = result.actions.filter((a) => a.type === 'uuid-backfill');
    expect(backfills).toHaveLength(2);
    expect(result.totalBackfilled).toBe(2);
  });

  it('reports "would-uuid-backfill" in dry-run mode', async () => {
    const docsWithoutUuid = [
      { _id: 'x1', Id: 1 },
    ];

    const db = createMockDb({
      suppliers: { countResult: 1, findDocs: docsWithoutUuid },
    });

    const result = await runDedup(db, { dryRun: true, log: noop });

    const supplierCol = db._getCol('suppliers');
    expect(supplierCol.bulkWrite).not.toHaveBeenCalled();

    const backfills = result.actions.filter((a) => a.type === 'would-uuid-backfill');
    expect(backfills).toHaveLength(1);
    expect(backfills[0].assignedUuid).toBeNull(); // not assigned in dry-run
    expect(result.totalBackfilled).toBe(1);
  });

  it('processes all 7 collections', async () => {
    const db = createMockDb();
    const result = await runDedup(db, { dryRun: false, log: noop });

    expect(result.collections.map((c) => c.collection)).toEqual([
      'customers', 'suppliers', 'invoices', 'quotes', 'purchases', 'projects', 'nominals',
    ]);
    // Each collection should have been accessed
    expect(db.collection).toHaveBeenCalledTimes(14); // 7 dedup + 7 backfill
  });

  it('collects log output when a log function is provided', async () => {
    const db = createMockDb();
    const logLines = [];
    await runDedup(db, { dryRun: false, log: (msg) => logLines.push(msg) });

    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.some((l) => /Summary/i.test(l))).toBe(true);
  });
});
