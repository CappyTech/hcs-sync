/**
 * End-to-end tests for run(): a fake KashFlow client feeds the real sync engine,
 * and every Mongo write is captured instead of sent.
 *
 * These pin the observable contract of a run — which documents are written,
 * under which filter, with which payload, and what the run reports back — so
 * the orchestration can be restructured without silently changing it.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
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
import models from '../src/server/models/kashflow.js';
import run from '../src/sync/run.js';

// ── Fake KashFlow ────────────────────────────────────────────────────────────

const byKey = (map) => async (key) => {
  const v = map[key];
  if (v instanceof Error) throw v;
  return v === undefined ? null : structuredClone(v);
};
const list = (rows) => async () => structuredClone(rows);
const fail = (message) => async () => { throw new Error(message); };

function fakeKashflow() {
  return {
    customers: {
      list: list([{ Code: 'C1' }]),
      listAll: list([{ Code: 'C1', Id: 1 }, { Code: 'C2', Id: 2 }, { Code: '', Id: 3 }]),
      get: byKey({ C1: { Id: 1, Code: 'C1', Name: 'One' }, C2: { Id: 2, Code: 'C2', Name: 'Two' } }),
    },
    suppliers: {
      listAll: list([{ Code: 'S1', Id: 11 }]),
      get: byKey({ S1: { Id: 11, Code: 'S1', Name: 'Sup' } }),
    },
    projects: {
      listAll: list([{ Number: 100 }, { Number: 101 }, { Number: 102 }]),
      // 101 has no Id (keyed on Number); 102 comes back empty.
      get: byKey({ 100: { Id: 500, Number: 100 }, 101: { Number: 101, Name: 'No Id' } }),
    },
    nominals: { list: list([{ Id: 7, Code: '4000' }, { Code: '5000' }, { Name: 'no key' }]) },
    vatRates: { list: list([{ VATId: 1, VATRate: '20' }, { VATId: 2, VATRate: 'abc' }, { VATRate: '5' }]) },
    bankAccounts: { list: list([{ Id: 1001 }, { Id: 1002 }, { Id: 1003 }]) },
    bankTransactions: {
      listAll: byKey({
        // Id 9 is an internal transfer: returned by both feeds.
        1001: [{ Id: 9, AccountId: 1, PaidIn: 10 }, { Id: 10, PaidOut: 3 }],
        1002: [{ Id: 9, AccountId: 1, PaidOut: 10 }],
        1003: new Error('timeout'),
      }),
    },
    bankReconciliations: {
      listAll: byKey({ 1001: [{ Id: 1, EndBalance: 5 }, { Id: null }], 1002: [], 1003: new Error('timeout') }),
    },
    journals: { listAll: list([{ Id: 1, Number: 1 }]) },
    products: { listAll: list([{ Code: 'P1' }]) },
    purchaseOrders: { listAll: list([{ Number: 5 }]) },
    quoteCategories: { list: list([{ Number: 1 }]) },
    purchaseOrderCategories: { list: list([{ Number: 2 }]) },
    currencies: { list: fail('currencies down') },
    countries: { list: list([{ Code: 'GB' }]) },
    accountingPeriods: { list: list([{ Id: 1 }]) },
    vatReturns: { list: list([{ Id: 3 }]) },
    invoices: {
      listAll: async ({ customerCode }) => structuredClone({
        C1: [{ Id: 201, Number: 1 }, { Id: 202, Number: 2 }, { Number: 3 }],
        C2: [{ Id: 203 }],
      }[customerCode] || []),
      get: byKey({ 1: { Id: 201, Number: 1, LineItems: [] }, 2: new Error('detail failed') }),
    },
    quotes: {
      listAll: async ({ customerCode }) => (customerCode === 'C1' ? [{ Id: 301, Number: 1 }] : []),
      get: byKey({ 1: { Id: 301, Number: 1 } }),
    },
    purchases: {
      listAll: async ({ supplierCode }) => (supplierCode === 'S1' ? [{ Id: 401, Number: 1 }, { Id: 402, Number: 2 }] : []),
      get: byKey({
        1: { Id: 401, Number: 1, SupplierCode: 's1', LineItems: [{ Description: 'x' }] },
        2: { Id: 402, Number: 2, SupplierId: null, SupplierCode: 'S1', LineItems: [] },
      }),
    },
  };
}

// ── Captured Mongo ───────────────────────────────────────────────────────────

const writes = [];
const auditEntries = [];

function captureWrites() {
  for (const [name, model] of Object.entries(models)) {
    if (!model) continue;
    vi.spyOn(model.collection, 'bulkWrite').mockImplementation(async (ops) => {
      for (const op of ops) {
        const { filter, update } = op.updateOne;
        writes.push({
          model: name,
          filter,
          rawSet: { ...update._rawSet, ...(update._rawSet.detailSyncedAt ? { detailSyncedAt: 'DATE' } : {}) },
          detailSyncedAt: Boolean(update[0].$set.detailSyncedAt),
        });
      }
      return {
        upsertedCount: ops.length, matchedCount: 0, modifiedCount: 0,
        upsertedIds: Object.fromEntries(ops.map((_, i) => [String(i), `oid-${i}`])),
      };
    });
    vi.spyOn(model, 'find').mockReturnValue({ lean: async () => [] });
    vi.spyOn(model, 'updateMany').mockResolvedValue({ modifiedCount: 0 });
    vi.spyOn(model, 'countDocuments').mockResolvedValue(3);
  }
  mongoose.connection.db = {
    collection: () => ({ insertMany: async (docs) => { auditEntries.push(...docs); } }),
  };
}

const sortKey = (w) => `${w.model}|${JSON.stringify(w.filter)}`;
const writesFor = (model) => writes.filter((w) => w.model === model).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

let result;
beforeAll(async () => {
  captureWrites();
  createClient.mockResolvedValue(fakeKashflow());
  result = await run({ runId: 'run-1' });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('run() end to end', () => {
  it('reports counts, carrying the stored bank-transaction count', () => {
    expect(result.counts).toEqual({
      customers: 3, suppliers: 1, projects: 3, nominals: 3, vatRates: 3, bankAccounts: 3,
      bankTransactions: 3, bankTransactionsFetched: 3, bankTransactionsSoftDeleted: 0,
      bankReconciliations: 1,
      journals: 1, products: 1, purchaseOrders: 1, quoteCategories: 1, purchaseOrderCategories: 1,
      currencies: 0, countries: 1, accountingPeriods: 1, vatReturns: 1,
      invoices: 4, quotes: 1, purchases: 2,
    });
  });

  it('records the failed optional list and the unreadable bank account', () => {
    expect(result.failedFetches).toEqual(['currencies']);
    expect(result.partial.bankTransactions).toEqual([{ accountId: 1003, message: 'timeout' }]);
  });

  it('writes customer and supplier details keyed on Id, skipping blank codes', () => {
    expect(writesFor('Customer').map((w) => w.filter)).toEqual([{ Id: 1 }, { Id: 2 }]);
    expect(writesFor('Customer')[0].rawSet).toMatchObject({ Id: 1, Code: 'C1', Name: 'One' });
    expect(writesFor('Supplier').map((w) => w.filter)).toEqual([{ Id: 11 }]);
  });

  it('keys projects on Id, falling back to Number, and skips empty details', () => {
    expect(writesFor('Project').map((w) => w.filter)).toEqual([{ Id: 500 }, { Number: 101 }]);
  });

  it('writes list-only entities with the first key present', () => {
    expect(writesFor('Journal').map((w) => w.filter)).toEqual([{ Id: 1 }]);
    expect(writesFor('Product').map((w) => w.filter)).toEqual([{ Code: 'P1' }]);
    expect(writesFor('PurchaseOrder').map((w) => w.filter)).toEqual([{ Number: 5 }]);
    expect(writesFor('Country').map((w) => w.filter)).toEqual([{ Code: 'GB' }]);
    expect(writesFor('Currency')).toEqual([]);
  });

  it('keys nominals on Id or Code and skips rows with neither', () => {
    expect(writesFor('Nominal').map((w) => w.filter)).toEqual([{ Code: '5000' }, { Id: 7 }]);
  });

  it('normalises VAT rates and skips rows without a VATId', () => {
    const rates = writesFor('VATRate');
    expect(rates.map((w) => w.filter)).toEqual([{ VATId: 1 }, { VATId: 2 }]);
    expect(rates[0].rawSet).toMatchObject({ VATRate: 20, Rate: 20, CountryCode: 'GB' });
    expect(rates[1].rawSet).toMatchObject({ VATRate: null, Rate: null });
  });

  it('keeps both halves of an internal transfer, scoped to the feed account', () => {
    const txs = writesFor('BankTransaction');
    expect(txs.map((w) => w.filter)).toEqual([
      { AccountId: 1001, Id: 10 },
      { AccountId: 1001, Id: 9 },
      { AccountId: 1002, Id: 9 },
    ]);
    expect(txs.every((w) => w.rawSet.AccountId === w.filter.AccountId)).toBe(true);
  });

  it('keys reconciliations on the account-scoped ReconKey', () => {
    const recons = writesFor('BankReconciliation');
    expect(recons.map((w) => w.filter)).toEqual([{ ReconKey: '1001:1' }]);
    expect(recons[0].rawSet).toMatchObject({ AccountId: 1001, EndBalance: 5 });
  });

  it('fetches document details by Number, keys them on Id and stamps detailSyncedAt', () => {
    // Invoice 202's detail fetch failed and 203 has no Number: neither is written.
    expect(writesFor('Invoice').map((w) => w.filter)).toEqual([{ Id: 201 }]);
    expect(writesFor('Quote').map((w) => w.filter)).toEqual([{ Id: 301 }]);
    for (const model of ['Invoice', 'Quote', 'Purchase']) {
      for (const w of writesFor(model)) {
        expect(w.detailSyncedAt).toBe(true);
        expect(w.rawSet.detailSyncedAt).toBe('DATE');
      }
    }
    for (const model of ['Customer', 'Supplier', 'Project', 'Journal', 'BankTransaction']) {
      expect(writesFor(model).some((w) => w.detailSyncedAt)).toBe(false);
    }
  });

  it('backfills a missing purchase SupplierId from the suppliers list', () => {
    const purchases = writesFor('Purchase');
    expect(purchases.map((w) => w.filter)).toEqual([{ Id: 401 }, { Id: 402 }]);
    expect(purchases[1].rawSet.SupplierId).toBe(11);
  });

  it('summarises Mongo writes per collection and captures upsert filters', () => {
    expect(Object.keys(result.mongo).sort()).toEqual([
      'accountingPeriods', 'bankAccounts', 'bankReconciliations', 'bankTransactions', 'countries',
      'customers', 'invoices', 'journals', 'nominals', 'products', 'projects', 'purchaseOrderCategories',
      'purchaseOrders', 'purchases', 'quoteCategories', 'quotes', 'suppliers', 'vatRates', 'vatReturns',
    ]);
    expect(result.mongo.bankTransactions.upserted).toBe(3);
    // Accumulated across both accounts, not overwritten by the last one.
    expect(result.mongoUpserts.bankTransactions.filters).toHaveLength(3);
  });

  it('audits every write as a create under this run', () => {
    expect(auditEntries).toHaveLength(writes.length);
    expect(auditEntries.every((e) => e.action === 'create' && e.runId === 'run-1')).toBe(true);
  });
});
