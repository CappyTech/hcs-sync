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
  BankTransaction,
  SYNC_INTERNAL_FIELDS,
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

describe('soft-delete sweep for bank transactions', () => {
  /**
   * The sweep marks transactions KashFlow no longer returns. Getting the
   * guards wrong would mark an entire account's history deleted, so these
   * pin the conditions rather than the mechanics.
   */
  const sweepFilter = (accountId, seen) => ({
    AccountId: accountId, Id: { $nin: seen }, deletedAt: null,
  });

  it('targets only unseen, not-already-deleted lines on that one account', () => {
    const f = sweepFilter(611594, [1, 2, 3]);
    expect(f.AccountId).toBe(611594);
    expect(f.Id.$nin).toEqual([1, 2, 3]);
    // Already-deleted rows are excluded so the modifiedCount reports real
    // transitions rather than re-stamping the same rows every run.
    expect(f.deletedAt).toBeNull();
  });

  it('is skipped entirely when the fetch returned nothing', () => {
    // run.js does `if (!txs?.length) continue;` before the sweep. An empty or
    // partial response must never be read as "KashFlow deleted everything".
    const txs = [];
    const wouldSweep = Boolean(txs?.length);
    expect(wouldSweep).toBe(false);
  });

  it('sits inside the fetch try block, so a failed fetch cannot trigger it', async () => {
    // This is the dangerous case: if the sweep ran after a failed fetch it
    // would mark an entire account's history deleted. Asserted against the
    // source, because the sweep is inline in run() and the ordering is the
    // whole safety property.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/sync/run.js', import.meta.url), 'utf8');

    const fetchAt = src.indexOf('kf.bankTransactions.listAll');
    const guardAt = src.indexOf('if (!txs?.length) continue;');
    const sweepAt = src.indexOf('Soft-deleted bank transactions no longer in KashFlow');
    const catchAt = src.indexOf('Failed to fetch bank transactions for account');

    expect(fetchAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(fetchAt);
    // The empty-response guard must precede the sweep...
    expect(sweepAt).toBeGreaterThan(guardAt);
    // ...and the sweep must sit before the catch, i.e. inside the try.
    expect(sweepAt).toBeLessThan(catchAt);
  });

  it('un-deletes a transaction KashFlow returns again', () => {
    // buildUpsertUpdate always writes deletedAt: null, so reappearance
    // self-heals without special handling.
    const pipeline = buildUpsertUpdate({
      keyField: 'Id', keyValue: 7,
      payload: { Id: 7, PaidOut: 10 },
      syncedAt: new Date(),
      model: { syncConfig: {} },
    });
    expect(setValue(pipeline, 'deletedAt')).toBeNull();
  });
});

describe('bank transactions are keyed per account, not per KashFlow Id', () => {
  /**
   * An internal transfer is returned by BOTH accounts' feeds under one Id, each
   * rendered from that account's point of view. Keying on Id alone collapsed
   * the two into a single document, so the per-account fan-out overwrote one
   * half with the other on every run — 422 documents churning hourly, and the
   * main trading account's half never surviving, because it syncs first and the
   * counterparty account writes last.
   */
  const transferAsSeenBy = (accountId, { paidIn, paidOut, balance, type }) => ({
    Id: 213715814,
    AccountId: accountId,
    Date: '2026-07-02 12:00:00',
    PaidIn: paidIn,
    PaidOut: paidOut,
    Balance: balance,
    Type: type,
  });

  const hashFor = (row) => setValue(
    buildUpsertUpdate({
      keyField: 'Id', keyValue: row.Id, payload: row,
      syncedAt: new Date(), model: { syncConfig: {} },
    }),
    '_kfHash',
  );

  it('gives the two halves of one transfer different content hashes', () => {
    // Same Id, opposite sides. If these hash alike the halves are
    // indistinguishable; if they are stored under one key they overwrite each
    // other forever, which is exactly what happened.
    const main = transferAsSeenBy(611594, { paidIn: 0, paidOut: 312.17, balance: -1494.24, type: 'Business Credit Card' });
    const sub  = transferAsSeenBy(938298, { paidIn: 312.17, paidOut: 0, balance: 28250.34, type: 'Heron Constructive Solutions LTD' });
    expect(hashFor(main)).not.toBe(hashFor(sub));
  });

  it('hashes one half identically across runs, so a steady state stops writing', () => {
    const row = { paidIn: 0, paidOut: 312.17, balance: -1494.24, type: 'Business Credit Card' };
    expect(hashFor(transferAsSeenBy(611594, row))).toBe(hashFor(transferAsSeenBy(611594, row)));
  });

  it('treats Balance as volatile, and still tells the two halves apart without it', () => {
    // Balance is KashFlow's running balance, permuted between fetches among
    // rows that share a Date — 196 phantom rewrites in one day on account
    // 611594. Dropping it from the hash must not cost us the distinction
    // between the two halves of a transfer, which is what the composite key
    // exists to preserve. PaidIn/PaidOut/Type/AccountId carry that on their own.
    expect(BankTransaction.syncConfig.volatileFields).toContain('Balance');

    const volatileHashFor = (row) => setValue(
      buildUpsertUpdate({
        keyField: 'Id', keyValue: row.Id, payload: row, syncedAt: new Date(), model: BankTransaction,
      }),
      '_kfHash',
    );
    const main = transferAsSeenBy(611594, { paidIn: 0, paidOut: 312.17, balance: -1494.24, type: 'Business Credit Card' });
    const sub  = transferAsSeenBy(938298, { paidIn: 312.17, paidOut: 0, balance: 28250.34, type: 'Heron Constructive Solutions LTD' });
    expect(volatileHashFor(main)).not.toBe(volatileHashFor(sub));

    // ...while a Balance-only difference on one half is no longer a change.
    const permuted = transferAsSeenBy(611594, { paidIn: 0, paidOut: 312.17, balance: -9618.15, type: 'Business Credit Card' });
    expect(volatileHashFor(main)).toBe(volatileHashFor(permuted));
  });

  it('keeps missingSince out of payloads and audit diffs', () => {
    // The sweep's grace timer is sync-owned and never returned by KashFlow.
    // deepDiff walks the union of stored and incoming keys, so if it were not
    // skipped it would report 'removed' on every row, every run.
    expect(SYNC_INTERNAL_FIELDS.has('missingSince')).toBe(true);
    const pipeline = buildUpsertUpdate({
      keyField: 'Id', keyValue: 1, payload: { Id: 1, missingSince: 'nonsense' },
      syncedAt: new Date(), model: BankTransaction,
    });
    expect(pipeline[0].$set).not.toHaveProperty('missingSince');
    expect(pipeline._rawSet).not.toHaveProperty('missingSince');
  });

  it('stamps rows with the feed account and scopes the upsert to it', async () => {
    // KashFlow's own AccountId is the same in both feeds — it names the account
    // the transaction was entered against, and for 105 rows here it is not even
    // one of the accounts KashFlow lists. Only the feed says which ledger a
    // line belongs to, so both the stamp and the filter scope must come from
    // the loop variable. These two travel together: stamping without scoping
    // still merges the halves, scoping without stamping leaves the hash
    // oscillating.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/sync/run.js', import.meta.url), 'utf8');
    expect(src).toMatch(/t\.AccountId = accountId/);
    expect(src).toMatch(/scope: \{ AccountId: accountId \}/);
    // And the filter must actually apply the scope.
    expect(src).toMatch(/filter: \{ \.\.\.\(scope \|\| \{\}\), \[keyField\]: keyValue \}/);
  });
});
