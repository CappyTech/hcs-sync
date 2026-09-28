/**
 * Tests for the single-entity pull (src/sync/pull.js) — the dashboard's
 * "Pull & Sync" button and hcs-app's /api/pull.
 *
 * A pull must build its write exactly as the full sync does (same transform,
 * same protected fields, same soft-delete clearing), except that it always
 * stamps detailSyncedAt: it is an explicit refresh.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));
vi.mock('../src/util/logger.js', () => {
  const noop = vi.fn();
  return { default: { info: noop, warn: noop, error: noop, debug: noop, child: () => ({ info: noop, warn: noop, error: noop }) } };
});
vi.mock('../src/kashflow/client.js', () => ({ default: vi.fn() }));
vi.mock('../src/db/mongoose.js', () => ({ isMongooseEnabled: vi.fn(() => true), connectMongoose: vi.fn() }));
vi.mock('../src/db/mongo.js', () => ({ ensureKashflowIndexes: vi.fn() }));

import createClient from '../src/kashflow/client.js';
import { isMongooseEnabled } from '../src/db/mongoose.js';
import { Purchase, Supplier } from '../src/server/models/kashflow.js';
import { pullSingleEntity, ENTITY_CONFIG } from '../src/sync/pull.js';
import { buildUpsertUpdate, applyDetailSyncedAt } from '../src/sync/upsert.js';

/** Stub KashFlow and Mongo for one pull; returns the captured write. */
function stubPull(type, payload, { existing = null } = {}) {
  const { model, getMethod } = ENTITY_CONFIG[type];
  const writes = [];
  vi.spyOn(model, 'findOne').mockReturnValue({ lean: async () => existing });
  vi.spyOn(model.collection, 'updateOne').mockImplementation(async (filter, update, opts) => {
    writes.push({ filter, update, opts });
    return { matchedCount: existing ? 1 : 0, modifiedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 };
  });
  const get = vi.fn(async () => structuredClone(payload));
  createClient.mockResolvedValue({ [getMethod]: { get } });
  return { get, writes };
}

beforeEach(() => {
  vi.restoreAllMocks();
  isMongooseEnabled.mockReturnValue(true);
});

describe('pullSingleEntity', () => {
  it('fetches by the given number and upserts keyed on Id', async () => {
    const { get, writes } = stubPull('invoice', { Id: 201, Number: 5 });
    const result = await pullSingleEntity('invoice', 5);

    expect(get).toHaveBeenCalledWith(5);
    expect(writes).toHaveLength(1);
    expect(writes[0].filter).toEqual({ Id: 201 });
    expect(writes[0].opts).toEqual({ upsert: true });
    expect(result).toMatchObject({ ok: true, action: 'created', entityType: 'invoice', entityId: 5, Id: 201, Number: 5 });
  });

  it('reports an existing document as updated', async () => {
    stubPull('quote', { Id: 301, Number: 1 }, { existing: { Id: 301 } });
    expect((await pullSingleEntity('quote', 1)).action).toBe('updated');
  });

  it('always stamps detailSyncedAt, even when content is unchanged', async () => {
    const { writes } = stubPull('quote', { Id: 301, Number: 1 }, { existing: { Id: 301 } });
    const result = await pullSingleEntity('quote', 1);

    const stamp = writes[0].update[0].$set.detailSyncedAt;
    expect(stamp).toEqual({ $literal: expect.any(Date) });
    expect(result.detailSyncedAt).toBe(stamp.$literal.toISOString());
  });

  it('clears the legacy deletedAt flag but keeps KashFlow\'s own DeletedAt', async () => {
    const { writes } = stubPull('quote', { Id: 301, Number: 1, DeletedAt: '2026-03-01 00:00:00' });
    await pullSingleEntity('quote', 1);

    const set = writes[0].update[0].$set;
    expect(set.deletedAt).toEqual({ $literal: null });
    expect(set.DeletedAt).toEqual({ $literal: '2026-03-01 00:00:00' });
  });

  it('runs the model transform exactly once', async () => {
    const original = Purchase.syncConfig.transform;
    const transform = vi.fn(original);
    Purchase.syncConfig.transform = transform;
    try {
      const { writes } = stubPull('purchase', { Id: 401, Number: 7, IssuedDate: '2026-01-05 00:00:00', LineItems: [] });
      await pullSingleEntity('purchase', 7);

      expect(transform).toHaveBeenCalledTimes(1);
      expect(writes[0].update[0].$set.IssuedDate.$literal).toBeInstanceOf(Date);
    } finally {
      Purchase.syncConfig.transform = original;
    }
  });

  it('never overwrites protected fields', async () => {
    const { writes } = stubPull('supplier', { Id: 11, Code: 'S1', Subcontractor: true, CISRate: 20, Name: 'Sup' });
    await pullSingleEntity('supplier', 'S1');

    const set = writes[0].update[0].$set;
    for (const field of Supplier.syncConfig.protectedFields) expect(set).not.toHaveProperty(field);
    expect(set.Name).toEqual({ $literal: 'Sup' });
  });

  it('writes what the full sync would write, apart from the detailSyncedAt stamp', async () => {
    const payload = { Id: 401, Number: 7, SupplierCode: 'S1', IssuedDate: '2026-01-05 00:00:00', LineItems: [{ Rate: 1 }] };
    const { writes } = stubPull('purchase', payload);
    await pullSingleEntity('purchase', 7);

    const expected = buildUpsertUpdate({ keyField: 'Id', keyValue: 401, payload: structuredClone(payload), model: Purchase });
    const strip = (set) => {
      const { uuid: _u, detailSyncedAt: _d, ...rest } = set;
      return rest;
    };
    expect(strip(writes[0].update[0].$set)).toEqual(strip(expected[0].$set));
    expect(writes[0].update.slice(1)).toEqual(expected.slice(1));
  });

  it('rejects unknown types, empty responses and responses without a key', async () => {
    await expect(pullSingleEntity('nope', 1)).rejects.toThrow('Unsupported entity type "nope"');

    createClient.mockResolvedValue({ quotes: { get: async () => null } });
    await expect(pullSingleEntity('quote', 1)).rejects.toThrow('KashFlow returned no data for quote 1');

    createClient.mockResolvedValue({ quotes: { get: async () => ({ Number: 1 }) } });
    await expect(pullSingleEntity('quote', 1)).rejects.toThrow('Response missing key field "Id"');
  });

  it('refuses to run without MongoDB', async () => {
    isMongooseEnabled.mockReturnValue(false);
    await expect(pullSingleEntity('quote', 1)).rejects.toThrow('MongoDB is not configured');
  });
});

describe('applyDetailSyncedAt', () => {
  const build = () => buildUpsertUpdate({ keyField: 'Id', keyValue: 1, payload: { Id: 1, A: 1 }, model: { syncConfig: {} } });
  const now = new Date('2026-09-28T00:00:00Z');

  it('moves only when the content hash changes by default (full sync)', () => {
    const update = build();
    applyDetailSyncedAt(update, now);
    expect(update[0].$set.detailSyncedAt.$cond.if).toEqual({ $ne: ['$_kfHash', update[0].$set._kfHash] });
    expect(update._rawSet.detailSyncedAt).toBe(now);
  });

  it('stamps unconditionally when asked (manual pull)', () => {
    const update = build();
    applyDetailSyncedAt(update, now, { onlyIfChanged: false });
    expect(update[0].$set.detailSyncedAt).toEqual({ $literal: now });
    expect(update._rawSet.detailSyncedAt).toBe(now);
  });
});
