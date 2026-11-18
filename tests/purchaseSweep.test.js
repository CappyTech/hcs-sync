/**
 * run() soft-deletes purchases KashFlow no longer lists for their supplier, and
 * suppliers KashFlow no longer lists at all (with their purchases).
 *
 * Mirrors quoteSweep.test.js and deletedCustomers.test.js. Purchases key on Id
 * but are swept on Number, which every list row carries (the detail fetch
 * needs it). The sweep's own behaviour (missingSince, grace window,
 * reappearance) is covered in syncHelpers.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

vi.mock('../src/util/logger.js', () => {
  const noop = vi.fn();
  return { default: { info: noop, warn: noop, error: noop, debug: noop, trace: noop, child: () => ({ info: noop, warn: noop, error: noop, debug: noop }) } };
});
vi.mock('../src/kashflow/client.js', () => ({ default: vi.fn() }));
vi.mock('../src/server/progress.js', () => ({
  default: { setStage: vi.fn(), setItemTotal: vi.fn(), setItemDone: vi.fn(), incItem: vi.fn() },
}));
vi.mock('../src/db/mongoose.js', () => ({
  isMongooseEnabled: vi.fn(() => true),
  connectMongoose: vi.fn(),
}));
vi.mock('../src/db/mongo.js', () => ({ ensureKashflowIndexes: vi.fn() }));
vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));

import createClient from '../src/kashflow/client.js';
import { isMongooseEnabled } from '../src/db/mongoose.js';
import models, { Purchase, Supplier, Customer } from '../src/server/models/kashflow.js';
import run, { sweepDeletedSuppliers } from '../src/sync/run.js';

const empty = async () => [];

function fakeKashflow(purchasesBySupplier, suppliers = [{ Code: 'S1', Id: 1 }, { Code: 'S2', Id: 2 }, { Code: 'S3', Id: 3 }]) {
  return {
    customers: {
      list: async () => [{ Code: 'C1' }],
      listAll: async () => [{ Code: 'C1', Id: 1 }],
      get: async (code) => ({ Id: 1, Code: code }),
    },
    suppliers: {
      listAll: async () => structuredClone(suppliers),
      get: async (code) => ({ Id: Number(code.slice(1)), Code: code }),
    },
    projects: { listAll: empty, listAllForCustomer: empty, get: async () => null },
    nominals: { list: empty },
    vatRates: { list: empty },
    bankAccounts: { list: empty },
    journals: { listAll: empty },
    products: { listAll: empty },
    purchaseOrders: { listAll: empty },
    quoteCategories: { list: empty },
    purchaseOrderCategories: { list: empty },
    currencies: { list: empty },
    countries: { list: empty },
    accountingPeriods: { list: empty },
    vatReturns: { list: empty },
    invoices: { listAll: empty, get: async () => null },
    quotes: { listAll: empty, get: async () => null },
    purchases: {
      listAll: async ({ supplierCode }) => {
        const v = purchasesBySupplier[supplierCode];
        if (v instanceof Error) throw v;
        return structuredClone(v || []);
      },
      get: async (number) => ({ Id: 400 + number, Number: number, SupplierCode: 'S1', LineItems: [{}] }),
    },
  };
}

let purchaseUpdates;
let supplierUpdates;

beforeEach(() => {
  vi.restoreAllMocks();
  isMongooseEnabled.mockReturnValue(true);
  purchaseUpdates = [];
  supplierUpdates = [];
  for (const model of Object.values(models)) {
    if (!model) continue;
    vi.spyOn(model.collection, 'bulkWrite').mockImplementation(async (ops) => ({
      upsertedCount: ops.length, matchedCount: 0, modifiedCount: 0,
      upsertedIds: Object.fromEntries(ops.map((_, i) => [String(i), `oid-${i}`])),
    }));
    vi.spyOn(model, 'find').mockReturnValue({ lean: async () => [] });
    vi.spyOn(model, 'updateMany').mockResolvedValue({ modifiedCount: 0 });
    vi.spyOn(model, 'countDocuments').mockResolvedValue(0);
    vi.spyOn(model, 'distinct').mockResolvedValue([]);
  }
  // Pretend each confirmation pass soft-deletes one row, so the tallies are visible.
  Purchase.updateMany.mockImplementation(async (filter, update) => {
    purchaseUpdates.push({ filter, update });
    return { modifiedCount: 'deletedAt' in update.$set ? 1 : 0 };
  });
  Supplier.updateMany.mockImplementation(async (filter, update) => {
    supplierUpdates.push({ filter, update });
    return { modifiedCount: 'deletedAt' in update.$set ? 1 : 0 };
  });
  mongoose.connection.db = { collection: () => ({ insertMany: async () => {} }) };
});

const scopesSwept = () => [...new Set(purchaseUpdates.map((u) => u.filter.SupplierCode))].sort();

describe('run() purchase sweep', () => {
  it('sweeps each supplier whose listing succeeded, scoped to that supplier, on Number', async () => {
    createClient.mockResolvedValue(fakeKashflow({
      S1: [{ Id: 401, Number: 1 }],
      S2: [], // the supplier's only purchase was deleted: a genuine empty listing
      S3: [{ Id: 402, Number: 2 }, { Id: 403 }], // a row without a Number: presence unknowable
    }));
    const result = await run({ runId: 'p1' });

    // S3 is skipped: its unkeyed row could be any purchase of theirs.
    expect(scopesSwept()).toEqual(['S1', 'S2']);
    const s1 = purchaseUpdates.filter((u) => u.filter.SupplierCode === 'S1');
    expect(s1.map((u) => u.filter)).toEqual([
      { SupplierCode: 'S1', Number: { $in: [1] }, missingSince: { $ne: null } },
      { SupplierCode: 'S1', Number: { $nin: [1], $ne: null }, deletedAt: null, missingSince: null },
      { SupplierCode: 'S1', Number: { $nin: [1], $ne: null }, deletedAt: null, missingSince: { $ne: null, $lte: expect.any(Date) } },
    ]);

    // Purchases are financial records: the default grace window is 24h.
    expect(s1[1].update.$set.missingSince.getTime() - s1[2].filter.missingSince.$lte.getTime())
      .toBe(24 * 60 * 60 * 1000);

    expect(result.counts.purchasesSoftDeleted).toBe(2);
    // The supplier sweep ran too, over every listed code; the stub tallies one.
    expect(supplierUpdates.map((u) => u.filter)).toContainEqual({
      Code: { $nin: ['S1', 'S2', 'S3', ''], $ne: null }, deletedAt: null, missingSince: null,
    });
    expect(result.counts.suppliersSoftDeleted).toBe(1);
    // The customer sweep is not affected by any of this.
    expect(Customer.updateMany.mock.calls.every(([f]) => !('SupplierCode' in f))).toBe(true);
  });

  it('a failed supplier listing sweeps nothing', async () => {
    createClient.mockResolvedValue(fakeKashflow({
      S1: [{ Id: 401, Number: 1 }],
      S2: new Error('KashFlow 500'),
    }));
    await expect(run({ runId: 'p2' })).rejects.toThrow('KashFlow 500');
    expect(purchaseUpdates).toEqual([]);
    expect(supplierUpdates).toEqual([]);
  });

  it('does not sweep purchases when every supplier listed none', async () => {
    createClient.mockResolvedValue(fakeKashflow({}));
    const result = await run({ runId: 'p3' });
    expect(purchaseUpdates).toEqual([]);
    expect(result.counts.purchasesSoftDeleted).toBe(0);
  });

  it('never sweeps when Mongo is disabled', async () => {
    isMongooseEnabled.mockReturnValue(false);
    createClient.mockResolvedValue(fakeKashflow({ S1: [{ Id: 401, Number: 1 }] }));
    const result = await run({ runId: 'p4' });
    expect(Purchase.updateMany).not.toHaveBeenCalled();
    expect(Supplier.updateMany).not.toHaveBeenCalled();
    expect(result.counts.purchasesSoftDeleted).toBe(0);
    expect(result.counts.suppliersSoftDeleted).toBe(0);
  });
});

describe('sweepDeletedSuppliers()', () => {
  const ctx = { setStage: vi.fn(), emitLog: vi.fn() };

  it('sweeps suppliers KashFlow no longer lists, and their purchases', async () => {
    Purchase.distinct.mockResolvedValue(['S1', 's2 ', 'GONE01']);
    const res = await sweepDeletedSuppliers(ctx, { suppliers: [{ Code: 'S1' }, { Code: 'S2' }] });

    expect(Purchase.distinct).toHaveBeenCalledWith('SupplierCode', { deletedAt: null });
    expect(supplierUpdates.map((u) => u.filter)).toContainEqual({
      Code: { $nin: ['S1', 'S2', ''], $ne: null }, deletedAt: null, missingSince: null,
    });
    // Only GONE01 is orphaned: a padded, lower-cased code is still S2.
    expect(scopesSwept()).toEqual(['GONE01']);
    expect(purchaseUpdates.map((u) => u.filter)).toContainEqual({
      SupplierCode: 'GONE01', Number: { $nin: [], $ne: null }, deletedAt: null, missingSince: null,
    });
    expect(res).toEqual({ suppliersSoftDeleted: 1, orphansSoftDeleted: { purchases: 1 } });
  });

  it('does nothing when the suppliers list has no codes', async () => {
    Purchase.distinct.mockResolvedValue(['GONE01']);
    await sweepDeletedSuppliers(ctx, { suppliers: [] });
    await sweepDeletedSuppliers(ctx, { suppliers: [{ Code: '' }, {}] });
    expect(supplierUpdates).toEqual([]);
    expect(purchaseUpdates).toEqual([]);
  });

  it('stands down on orphaned purchases when too many codes are unknown at once', async () => {
    Purchase.distinct.mockResolvedValue(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
    await sweepDeletedSuppliers(ctx, { suppliers: [{ Code: 'S1' }] });
    expect(purchaseUpdates).toEqual([]);
    // The supplier sweep itself still ran.
    expect(supplierUpdates.length).toBeGreaterThan(0);
  });
});
