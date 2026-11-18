/**
 * Customers deleted from KashFlow, and the documents they leave behind.
 *
 * The per-customer sweeps only visit customers KashFlow still lists, so project
 * 41301 "Test Job" (customer TEST01, deleted with it) was never checked.
 * sweepDeletedCustomers sweeps the customers collection against the full
 * customers list, then the quotes, invoices and projects of any code no longer
 * listed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/util/logger.js', () => {
  const noop = vi.fn();
  return { default: { info: noop, warn: noop, error: noop, debug: noop, trace: noop, child: () => ({ info: noop, warn: noop, error: noop, debug: noop }) } };
});
vi.mock('../src/kashflow/client.js', () => ({ default: vi.fn() }));
vi.mock('../src/server/progress.js', () => ({
  default: { setStage: vi.fn(), setItemTotal: vi.fn(), setItemDone: vi.fn(), incItem: vi.fn() },
}));
vi.mock('../src/db/mongoose.js', () => ({ isMongooseEnabled: vi.fn(() => true), connectMongoose: vi.fn() }));
vi.mock('../src/db/mongo.js', () => ({ ensureKashflowIndexes: vi.fn() }));
vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));

import { Customer, Quote, Invoice, Project } from '../src/server/models/kashflow.js';
import { sweepDeletedCustomers } from '../src/sync/run.js';
import { sweepMissing } from '../src/sync/upsert.js';

const ctx = { setStage: vi.fn(), emitLog: vi.fn() };
let updates;

function stubModels(distinctByModel = {}) {
  updates = [];
  for (const [name, model] of Object.entries({ Customer, Quote, Invoice, Project })) {
    vi.spyOn(model, 'updateMany').mockImplementation(async (filter, update) => {
      updates.push({ model: name, filter, update });
      return { modifiedCount: 0 };
    });
    vi.spyOn(model, 'distinct').mockResolvedValue(distinctByModel[name] || []);
  }
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('sweepDeletedCustomers()', () => {
  it('sweeps customers KashFlow no longer lists, and their projects', async () => {
    stubModels({ Project: ['PLUS01', 'TEST01'], Quote: ['plus01 '] });
    await sweepDeletedCustomers(ctx, { customers: [{ Code: 'PLUS01' }, { Code: 'KNOW01' }] });

    expect(updates.filter((u) => u.model === 'Customer').map((u) => u.filter)).toContainEqual({
      Code: { $nin: ['PLUS01', 'KNOW01', ''], $ne: null }, deletedAt: null, missingSince: null,
    });
    const projects = updates.filter((u) => u.model === 'Project').map((u) => u.filter);
    expect(projects).toContainEqual({ CustomerCode: 'TEST01', Number: { $nin: [], $ne: null }, deletedAt: null, missingSince: null });
    expect(projects.some((f) => f.CustomerCode === 'PLUS01')).toBe(false);
    // A padded, lower-cased code is still PLUS01, not an orphan.
    expect(updates.some((u) => u.model === 'Quote')).toBe(false);
  });

  it('does nothing when the customers list has no codes', async () => {
    stubModels({ Project: ['TEST01'] });
    await sweepDeletedCustomers(ctx, { customers: [] });
    await sweepDeletedCustomers(ctx, { customers: [{ Code: '' }, {}] });
    expect(updates).toEqual([]);
  });

  it('stands down on orphans when too many codes are unknown at once', async () => {
    stubModels({ Invoice: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'] });
    await sweepDeletedCustomers(ctx, { customers: [{ Code: 'PLUS01' }] });
    expect(updates.some((u) => u.model === 'Invoice')).toBe(false);
    // The customer sweep itself still ran.
    expect(updates.some((u) => u.model === 'Customer')).toBe(true);
  });
});

describe('sweepMissing({ wholeCollection })', () => {
  const model = () => ({ updateMany: vi.fn(async () => ({ modifiedCount: 0 })) });

  it('sweeps without a scope', async () => {
    const m = model();
    await sweepMissing({ model: m, keyField: 'Code', seen: ['A'], now: new Date(), wholeCollection: true });
    expect(m.updateMany.mock.calls[1][0]).toEqual({ Code: { $nin: ['A'], $ne: null }, deletedAt: null, missingSince: null });
  });

  it('refuses an empty listing whatever allowEmpty says', async () => {
    const m = model();
    const res = await sweepMissing({ model: m, keyField: 'Code', seen: [], now: new Date(), wholeCollection: true, allowEmpty: true });
    expect(res).toEqual({ pending: 0, softDeleted: 0 });
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a scope alongside wholeCollection', async () => {
    await expect(sweepMissing({ model: model(), scope: { A: 1 }, seen: ['x'], now: new Date(), wholeCollection: true }))
      .rejects.toThrow(/takes no scope/);
  });
});
