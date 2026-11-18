/**
 * run() soft-deletes quotes KashFlow no longer lists for their customer.
 *
 * KashFlow deletes a quote when it is converted to an invoice, so a quote that
 * disappears from its customer's listing must eventually be flagged deletedAt
 * in the mirror. These tests pin which customers the run sweeps, and — more
 * importantly — when it must not sweep at all. The sweep's own behaviour
 * (missingSince, grace window, reappearance) is covered in syncHelpers.test.js.
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
import models, { Quote, BankTransaction } from '../src/server/models/kashflow.js';
import run from '../src/sync/run.js';

const empty = async () => [];

function fakeKashflow(quotesByCustomer) {
  return {
    customers: {
      list: async () => [{ Code: 'C1' }],
      listAll: async () => [{ Code: 'C1', Id: 1 }, { Code: 'C2', Id: 2 }, { Code: 'C3', Id: 3 }],
      get: async (code) => ({ Id: Number(code.slice(1)), Code: code }),
    },
    suppliers: { listAll: empty, get: async () => null },
    projects: { listAll: empty, get: async () => null },
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
    purchases: { listAll: empty, get: async () => null },
    quotes: {
      listAll: async ({ customerCode }) => {
        const v = quotesByCustomer[customerCode];
        if (v instanceof Error) throw v;
        return structuredClone(v || []);
      },
      get: async (number) => ({ Id: 300 + number, Number: number }),
    },
  };
}

let quoteUpdates;

beforeEach(() => {
  vi.restoreAllMocks();
  isMongooseEnabled.mockReturnValue(true);
  quoteUpdates = [];
  for (const model of Object.values(models)) {
    if (!model) continue;
    vi.spyOn(model.collection, 'bulkWrite').mockImplementation(async (ops) => ({
      upsertedCount: ops.length, matchedCount: 0, modifiedCount: 0,
      upsertedIds: Object.fromEntries(ops.map((_, i) => [String(i), `oid-${i}`])),
    }));
    vi.spyOn(model, 'find').mockReturnValue({ lean: async () => [] });
    vi.spyOn(model, 'updateMany').mockResolvedValue({ modifiedCount: 0 });
    vi.spyOn(model, 'countDocuments').mockResolvedValue(0);
  }
  // Pretend each confirmation pass soft-deletes one quote, so the tally is visible.
  Quote.updateMany.mockImplementation(async (filter, update) => {
    quoteUpdates.push({ filter, update });
    return { modifiedCount: 'deletedAt' in update.$set ? 1 : 0 };
  });
  mongoose.connection.db = { collection: () => ({ insertMany: async () => {} }) };
});

const scopesSwept = () => [...new Set(quoteUpdates.map((u) => u.filter.CustomerCode))].sort();

describe('run() quote sweep', () => {
  it('sweeps each customer whose listing succeeded, scoped to that customer', async () => {
    createClient.mockResolvedValue(fakeKashflow({
      C1: [{ Id: 301, Number: 1 }],
      C2: [], // the customer's only quote was converted: a genuine empty listing
      C3: [{ Id: 302, Number: 2 }, { Number: 3 }], // a row without an Id: presence unknowable
    }));
    const result = await run({ runId: 'r1' });

    // C3 is skipped: its unkeyed row could be any quote of theirs.
    expect(scopesSwept()).toEqual(['C1', 'C2']);

    const c1 = quoteUpdates.filter((u) => u.filter.CustomerCode === 'C1');
    expect(c1.map((u) => u.filter)).toEqual([
      { CustomerCode: 'C1', Id: { $in: [301] }, missingSince: { $ne: null } },
      { CustomerCode: 'C1', Id: { $nin: [301] }, deletedAt: null, missingSince: null },
      { CustomerCode: 'C1', Id: { $nin: [301] }, deletedAt: null, missingSince: { $ne: null, $lte: expect.any(Date) } },
    ]);
    // An empty listing has nothing to reset, only absences to record.
    const c2 = quoteUpdates.filter((u) => u.filter.CustomerCode === 'C2');
    expect(c2.map((u) => u.filter.Id)).toEqual([{ $nin: [] }, { $nin: [] }]);

    // The default grace window is 2h.
    const confirm = c1[2];
    const firstAbsence = c1[1];
    expect(firstAbsence.update.$set.missingSince.getTime() - confirm.filter.missingSince.$lte.getTime())
      .toBe(2 * 60 * 60 * 1000);

    expect(result.counts.quotesSoftDeleted).toBe(2);
    // The bank sweep is not involved.
    expect(BankTransaction.updateMany).not.toHaveBeenCalled();
  });

  it('a failed customer listing sweeps nothing', async () => {
    createClient.mockResolvedValue(fakeKashflow({
      C1: [{ Id: 301, Number: 1 }],
      C2: new Error('KashFlow 500'),
    }));
    await expect(run({ runId: 'r2' })).rejects.toThrow('KashFlow 500');
    expect(quoteUpdates).toEqual([]);
  });

  it('does not sweep when every customer listed no quotes', async () => {
    createClient.mockResolvedValue(fakeKashflow({}));
    const result = await run({ runId: 'r3' });
    expect(quoteUpdates).toEqual([]);
    expect(result.counts.quotesSoftDeleted).toBe(0);
  });

  it('never sweeps when Mongo is disabled', async () => {
    isMongooseEnabled.mockReturnValue(false);
    createClient.mockResolvedValue(fakeKashflow({ C1: [{ Id: 301, Number: 1 }] }));
    const result = await run({ runId: 'r4' });
    expect(Quote.updateMany).not.toHaveBeenCalled();
    expect(result.counts.quotesSoftDeleted).toBe(0);
  });
});
