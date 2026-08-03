/**
 * Tests for the bank-reconciliation groundwork:
 *   - the date-coercion transforms for invoices and bank transactions
 *   - the ReconKey composite for bank reconciliations
 *   - buildUpsertUpdate applying syncConfig.transform centrally
 *
 * The last one is the load-bearing behaviour. `transform` was previously
 * declared in syncConfig but only ever invoked by hand in the purchase detail
 * fanout, so declaring one on any other model silently did nothing. Everything
 * here depends on it firing for every model that declares one.
 */
import { describe, it, expect, vi } from 'vitest';

// Same mock preamble as syncHelpers.test.js — lets run.js load without
// touching the network, Mongo, or the real logger.
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
vi.mock('../src/db/mongo.js', () => ({ ensureKashflowIndexes: vi.fn() }));
vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));

import { buildUpsertUpdate } from '../src/sync/run.js';
import {
  prepareInvoiceForUpsert,
  prepareBankTransactionForUpsert,
  prepareBankReconciliationForUpsert,
} from '../src/server/models/kashflow.js';

/** Pull the plain value a pipeline $set wrote for `field`. */
function setValue(pipeline, field) {
  const set = pipeline[0].$set;
  const entry = set[field];
  return entry && typeof entry === 'object' && '$literal' in entry ? entry.$literal : entry;
}

describe('prepareBankTransactionForUpsert()', () => {
  it('converts KashFlow date strings to real Dates', () => {
    const item = { Id: 1, Date: '2022-03-31 12:00:00' };
    prepareBankTransactionForUpsert(item);
    expect(item.Date).toBeInstanceOf(Date);
    expect(item.Date.getUTCFullYear()).toBe(2022);
    expect(item.Date.getUTCMonth()).toBe(2); // March
  });

  it('is idempotent — a Date survives a second pass unchanged', () => {
    const item = { Id: 1, Date: '2022-03-31 12:00:00' };
    prepareBankTransactionForUpsert(item);
    const first = item.Date;
    prepareBankTransactionForUpsert(item);
    expect(item.Date).toBeInstanceOf(Date);
    expect(item.Date.getTime()).toBe(first.getTime());
  });

  it('nulls unparseable and empty dates rather than storing Invalid Date', () => {
    for (const bad of ['', null, undefined, 'not a date']) {
      const item = { Id: 1, Date: bad };
      prepareBankTransactionForUpsert(item);
      expect(item.Date).toBeNull();
    }
  });
});

describe('prepareInvoiceForUpsert()', () => {
  it('converts top-level and payment-line dates', () => {
    const item = {
      Id: 5,
      IssuedDate: '2025-09-01 12:00:00',
      DueDate: '2025-10-01 12:00:00',
      PaidDate: '2025-09-05 12:00:00',
      PaymentLines: [
        { Id: 1, Date: '2025-09-05 12:00:00', Amount: 4260 },
        { Id: 2, Date: '2025-09-06 12:00:00', Amount: 100 },
      ],
    };
    prepareInvoiceForUpsert(item);

    expect(item.IssuedDate).toBeInstanceOf(Date);
    expect(item.DueDate).toBeInstanceOf(Date);
    expect(item.PaidDate).toBeInstanceOf(Date);
    for (const pl of item.PaymentLines) {
      expect(pl.Date).toBeInstanceOf(Date);
    }
    // Amounts are untouched.
    expect(item.PaymentLines[0].Amount).toBe(4260);
  });

  it('does not stamp TaxYear/TaxMonth — that is purchase-side only', () => {
    const item = { Id: 5, PaymentLines: [{ Date: '2025-09-05 12:00:00' }] };
    prepareInvoiceForUpsert(item);
    expect(item.TaxYear).toBeUndefined();
    expect(item.TaxMonth).toBeUndefined();
  });

  it('tolerates a missing or non-array PaymentLines', () => {
    for (const pl of [undefined, null, 'nonsense']) {
      const item = { Id: 5, IssuedDate: '2025-09-01 12:00:00', PaymentLines: pl };
      expect(() => prepareInvoiceForUpsert(item)).not.toThrow();
      expect(item.IssuedDate).toBeInstanceOf(Date);
    }
  });
});

describe('prepareBankReconciliationForUpsert()', () => {
  it('builds the ReconKey composite from AccountId and Id', () => {
    const item = { Id: 42, AccountId: 611594 };
    prepareBankReconciliationForUpsert(item);
    expect(item.ReconKey).toBe('611594:42');
  });

  it('leaves ReconKey null when AccountId was never injected', () => {
    // KashFlow never returns AccountId — it is only in the request URL. A row
    // that reaches here without one cannot be attributed to an account, and its
    // Id may collide with another account's, so it must not be written.
    const item = { Id: 42 };
    prepareBankReconciliationForUpsert(item);
    expect(item.ReconKey).toBeNull();
  });

  it('coerces header and nested transaction dates', () => {
    const item = {
      Id: 42,
      AccountId: 1,
      StartDate: '2025-01-01 12:00:00',
      EndDate: '2025-01-31 12:00:00',
      Transactions: [{ Id: 9, Date: '2025-01-15 12:00:00' }],
    };
    prepareBankReconciliationForUpsert(item);
    expect(item.StartDate).toBeInstanceOf(Date);
    expect(item.EndDate).toBeInstanceOf(Date);
    expect(item.Transactions[0].Date).toBeInstanceOf(Date);
  });
});

describe('buildUpsertUpdate() applies syncConfig.transform', () => {
  it('coerces dates via the model transform before flattening', () => {
    const model = { syncConfig: { transform: prepareBankTransactionForUpsert } };
    const pipeline = buildUpsertUpdate({
      keyField: 'Id',
      keyValue: 7,
      payload: { Id: 7, Date: '2022-03-31 12:00:00', PaidOut: 10 },
      syncedAt: new Date(),
      model,
    });

    // The whole point: a Date lands on disk, not the original string. The
    // pipeline wraps values in $literal and the write goes out through the
    // native driver, so Mongoose casting never gets a chance to do this.
    expect(setValue(pipeline, 'Date')).toBeInstanceOf(Date);
    expect(setValue(pipeline, 'PaidOut')).toBe(10);
  });

  it('is a no-op for models that declare no transform', () => {
    const pipeline = buildUpsertUpdate({
      keyField: 'Id',
      keyValue: 7,
      payload: { Id: 7, Date: '2022-03-31 12:00:00' },
      syncedAt: new Date(),
      model: { syncConfig: {} },
    });
    expect(setValue(pipeline, 'Date')).toBe('2022-03-31 12:00:00');
  });

  it('survives a throwing transform and still writes the raw payload', () => {
    const model = {
      syncConfig: { transform: () => { throw new Error('boom'); } },
    };
    let pipeline;
    expect(() => {
      pipeline = buildUpsertUpdate({
        keyField: 'Id',
        keyValue: 7,
        payload: { Id: 7, PaidOut: 10 },
        syncedAt: new Date(),
        model,
      });
    }).not.toThrow();
    expect(setValue(pipeline, 'PaidOut')).toBe(10);
  });

  it('changes the content hash when the transform changes a value', () => {
    // _kfHash is computed after the transform, so a coerced date must be what
    // gets hashed — otherwise every run would look unchanged while the stored
    // representation differed.
    const withTransform = buildUpsertUpdate({
      keyField: 'Id', keyValue: 7,
      payload: { Id: 7, Date: '2022-03-31 12:00:00' },
      syncedAt: new Date(),
      model: { syncConfig: { transform: prepareBankTransactionForUpsert } },
    });
    const without = buildUpsertUpdate({
      keyField: 'Id', keyValue: 7,
      payload: { Id: 7, Date: '2022-03-31 12:00:00' },
      syncedAt: new Date(),
      model: { syncConfig: {} },
    });
    expect(setValue(withTransform, '_kfHash')).not.toBe(setValue(without, '_kfHash'));
  });
});
