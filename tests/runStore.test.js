import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks – hoisted before any imports
// ---------------------------------------------------------------------------

vi.mock('../src/db/mongoose.js', () => ({
  isMongooseEnabled: vi.fn(() => true),
  connectMongoose: vi.fn(),
}));

vi.mock('../src/server/models/Run.js', () => ({
  default: {
    create: vi.fn(),
    updateOne: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    exists: vi.fn(),
    init: vi.fn(),
  },
}));

// Prevent dotenv from reading .env
vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));

// ---------------------------------------------------------------------------
// Imports (receive mocked modules)
// ---------------------------------------------------------------------------

import { isMongooseEnabled, connectMongoose } from '../src/db/mongoose.js';
import Run from '../src/server/models/Run.js';
import * as runStore from '../src/server/runStore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a chainable Mongoose query mock that resolves to `value`. */
function chainQuery(value) {
  return {
    select: vi.fn().mockReturnThis(),
    sort:   vi.fn().mockReturnThis(),
    limit:  vi.fn().mockReturnThis(),
    lean:   vi.fn().mockReturnThis(),
    exec:   vi.fn().mockResolvedValue(value),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('src/server/runStore.js', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-establish default happy-path mocks after reset
    isMongooseEnabled.mockReturnValue(true);
    connectMongoose.mockResolvedValue(undefined);
    Run.init.mockResolvedValue(undefined);
  });

  // ── requestPull (pure, no DB) ──────────────────────────────────────────

  describe('requestPull()', () => {
    it('returns a plan object with ok: true', () => {
      const result = runStore.requestPull('customers', 'C001');
      expect(result.ok).toBe(true);
      expect(result.plan.action).toBe('pull');
      expect(result.plan.entityType).toBe('customers');
      expect(result.plan.entityId).toBe('C001');
    });

    it('includes a note about no execution', () => {
      const { plan } = runStore.requestPull('invoices', 'INV-42');
      expect(plan.note).toMatch(/no execution/i);
    });
  });

  // ── beginRun ───────────────────────────────────────────────────────────

  describe('beginRun()', () => {
    it('creates a run record and returns an id', async () => {
      Run.create.mockResolvedValue({});
      const id = await runStore.beginRun({ requestedBy: 'test' });

      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(Run.create).toHaveBeenCalledTimes(1);

      const arg = Run.create.mock.calls[0][0];
      expect(arg.status).toBe('running');
      expect(arg.metadata).toEqual({ requestedBy: 'test' });
      expect(arg.changes).toEqual([]);
      expect(arg.logs).toEqual([]);
      expect(arg.finishedAt).toBeNull();
    });

    it('defaults metadata to empty object', async () => {
      Run.create.mockResolvedValue({});
      await runStore.beginRun();
      expect(Run.create.mock.calls[0][0].metadata).toEqual({});
    });

    it('throws when Mongo is not configured', async () => {
      isMongooseEnabled.mockReturnValue(false);
      await expect(runStore.beginRun()).rejects.toThrow(/MongoDB is not configured/);
    });
  });

  // ── recordLog ──────────────────────────────────────────────────────────

  describe('recordLog()', () => {
    it('pushes a log entry and returns its id', async () => {
      Run.updateOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      });

      const logId = await runStore.recordLog('run-1', {
        level: 'info',
        message: 'Test log',
        stage: 'fetch',
      });

      expect(typeof logId).toBe('string');
      expect(Run.updateOne).toHaveBeenCalledWith(
        { id: 'run-1' },
        expect.objectContaining({ $push: expect.any(Object) })
      );
    });

    it('returns false if run not found', async () => {
      Run.updateOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ matchedCount: 0 }),
      });
      const result = await runStore.recordLog('missing', { message: 'test' });
      expect(result).toBe(false);
    });

    it('defaults level to info and message to empty string', async () => {
      Run.updateOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      });

      await runStore.recordLog('run-1', {});

      const pushArg = Run.updateOne.mock.calls[0][1].$push;
      const entry = pushArg.logs.$each[0];
      expect(entry.level).toBe('info');
      expect(entry.message).toBe('');
    });
  });

  // ── recordChange ───────────────────────────────────────────────────────

  describe('recordChange()', () => {
    it('pushes a change entry and returns its id', async () => {
      Run.updateOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      });

      const changeId = await runStore.recordChange('run-1', {
        entityType: 'customers',
        entityId: 'C001',
        action: 'upsert',
        reason: 'New customer',
      });

      expect(typeof changeId).toBe('string');
      const pushArg = Run.updateOne.mock.calls[0][1].$push;
      const entry = pushArg.changes;
      expect(entry.entityType).toBe('customers');
      expect(entry.entityId).toBe('C001');
      expect(entry.action).toBe('upsert');
      expect(entry.reverted).toBe(false);
    });

    it('returns false if run not found', async () => {
      Run.updateOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ matchedCount: 0 }),
      });
      const result = await runStore.recordChange('missing', {
        entityType: 'x', entityId: 'y', action: 'z',
      });
      expect(result).toBe(false);
    });
  });

  // ── finishRun ──────────────────────────────────────────────────────────

  describe('finishRun()', () => {
    it('sets status to "finished" for successful runs', async () => {
      Run.updateOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      });
      const ok = await runStore.finishRun('run-1', { counts: { customers: 10 } });

      expect(ok).toBe(true);
      const setArg = Run.updateOne.mock.calls[0][1].$set;
      expect(setArg.status).toBe('finished');
      expect(setArg.summary).toEqual({ counts: { customers: 10 } });
      expect(setArg.finishedAt).toBeTypeOf('number');
    });

    it('sets status to "failed" when summary has error', async () => {
      Run.updateOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      });
      await runStore.finishRun('run-1', { error: 'something broke' });

      const setArg = Run.updateOne.mock.calls[0][1].$set;
      expect(setArg.status).toBe('failed');
    });

    it('returns false if run not found', async () => {
      Run.updateOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ matchedCount: 0 }),
      });
      expect(await runStore.finishRun('missing')).toBe(false);
    });
  });

  // ── listRuns ───────────────────────────────────────────────────────────

  describe('listRuns()', () => {
    it('returns runs sorted by startedAt desc with default limit', async () => {
      const runs = [{ id: 'r2' }, { id: 'r1' }];
      const chain = chainQuery(runs);
      Run.find.mockReturnValue(chain);

      const result = await runStore.listRuns();
      expect(result).toEqual(runs);
      expect(chain.sort).toHaveBeenCalledWith({ startedAt: -1 });
      expect(chain.limit).toHaveBeenCalledWith(200);
    });

    it('excludes heavy fields via select projection', async () => {
      const chain = chainQuery([]);
      Run.find.mockReturnValue(chain);

      await runStore.listRuns();
      expect(chain.select).toHaveBeenCalledWith(expect.objectContaining({
        logs: 0,
        'changes.before': 0,
        'changes.after': 0,
        'changes.diff': 0,
      }));
    });

    it('respects a custom limit', async () => {
      const chain = chainQuery([]);
      Run.find.mockReturnValue(chain);

      await runStore.listRuns({ limit: 5 });
      expect(chain.limit).toHaveBeenCalledWith(5);
    });
  });

  // ── getRun ─────────────────────────────────────────────────────────────

  describe('getRun()', () => {
    it('returns a run by id', async () => {
      const run = { id: 'run-1', status: 'finished' };
      Run.findOne.mockReturnValue({
        lean: () => ({ exec: vi.fn().mockResolvedValue(run) }),
      });

      const result = await runStore.getRun('run-1');
      expect(result).toEqual(run);
      expect(Run.findOne).toHaveBeenCalledWith({ id: 'run-1' });
    });

    it('returns null for unknown id', async () => {
      Run.findOne.mockReturnValue({
        lean: () => ({ exec: vi.fn().mockResolvedValue(null) }),
      });
      expect(await runStore.getRun('nope')).toBeNull();
    });
  });

  // ── revertChange ───────────────────────────────────────────────────────

  describe('revertChange()', () => {
    it('marks a change as reverted', async () => {
      Run.exists.mockResolvedValue(true);
      Run.updateOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      });

      const result = await runStore.revertChange('run-1', 'change-1', 'test note');
      expect(result).toEqual({ ok: true });
    });

    it('returns error when run not found', async () => {
      Run.exists.mockResolvedValue(false);
      const result = await runStore.revertChange('missing', 'change-1');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Run not found/);
    });

    it('returns error when change not found (modifiedCount 0)', async () => {
      Run.exists.mockResolvedValue(true);
      Run.updateOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      });
      const result = await runStore.revertChange('run-1', 'bad-change');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Change not found/);
    });

    it('uses default revert note when none supplied', async () => {
      Run.exists.mockResolvedValue(true);
      Run.updateOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      });

      await runStore.revertChange('run-1', 'change-1');

      const setArg = Run.updateOne.mock.calls[0][1].$set;
      expect(setArg['changes.$[c].revertNote']).toMatch(/no DB write/i);
    });
  });
});
