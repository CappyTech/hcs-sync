import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// changeLog reads/writes to data/runs.json — we'll mock fs to avoid real I/O
vi.mock('fs');

describe('src/server/changeLog.js', () => {
  let changeLog;
  let runsData;

  beforeEach(async () => {
    runsData = { runs: [] };

    // Mock fs methods
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockImplementation(() => JSON.stringify(runsData));
    fs.writeFileSync.mockImplementation((_path, content) => {
      runsData = JSON.parse(content);
    });
    fs.mkdirSync.mockImplementation(() => {});

    // Mock crypto.randomUUID
    let uuidCounter = 0;
    vi.stubGlobal('crypto', {
      randomUUID: () => `uuid-${++uuidCounter}`,
    });

    changeLog = await import('../src/server/changeLog.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('beginRun()', () => {
    it('creates a new run with unique id', () => {
      const id = changeLog.beginRun({ requestedBy: 'test' });
      expect(id).toBeTruthy();
      expect(runsData.runs).toHaveLength(1);
      expect(runsData.runs[0].status).toBe('running');
      expect(runsData.runs[0].metadata).toEqual({ requestedBy: 'test' });
    });

    it('prepends new runs (most recent first)', () => {
      const id1 = changeLog.beginRun();
      const id2 = changeLog.beginRun();
      expect(runsData.runs[0].id).toBe(id2);
      expect(runsData.runs[1].id).toBe(id1);
    });
  });

  describe('recordChange()', () => {
    it('appends a change to an existing run', () => {
      const runId = changeLog.beginRun();
      const changeId = changeLog.recordChange(runId, {
        entityType: 'customer',
        entityId: 'C001',
        action: 'update',
        reason: 'Name changed',
      });

      expect(changeId).toBeTruthy();
      const run = runsData.runs.find(r => r.id === runId);
      expect(run.changes).toHaveLength(1);
      expect(run.changes[0].entityType).toBe('customer');
      expect(run.changes[0].action).toBe('update');
      expect(run.changes[0].reverted).toBe(false);
    });

    it('returns false for non-existent run', () => {
      const result = changeLog.recordChange('nonexistent', {
        entityType: 'customer',
        entityId: 'C001',
        action: 'create',
      });
      expect(result).toBe(false);
    });
  });

  describe('finishRun()', () => {
    it('marks run as finished with summary', () => {
      const runId = changeLog.beginRun();
      const result = changeLog.finishRun(runId, { counts: { customers: 10 } });

      expect(result).toBe(true);
      const run = runsData.runs.find(r => r.id === runId);
      expect(run.status).toBe('finished');
      expect(run.finishedAt).toBeTypeOf('number');
      expect(run.summary.counts).toEqual({ customers: 10 });
    });

    it('marks run as failed when summary contains error', () => {
      const runId = changeLog.beginRun();
      changeLog.finishRun(runId, { error: 'boom' });

      const run = runsData.runs.find(r => r.id === runId);
      expect(run.status).toBe('failed');
    });

    it('returns false for non-existent run', () => {
      expect(changeLog.finishRun('nonexistent')).toBe(false);
    });
  });

  describe('listRuns()', () => {
    it('returns all runs', () => {
      changeLog.beginRun();
      changeLog.beginRun();
      const runs = changeLog.listRuns();
      expect(runs).toHaveLength(2);
    });
  });

  describe('getRun()', () => {
    it('returns a specific run by id', () => {
      const id = changeLog.beginRun({ tag: 'findme' });
      const run = changeLog.getRun(id);
      expect(run).toBeTruthy();
      expect(run.metadata.tag).toBe('findme');
    });

    it('returns null for unknown id', () => {
      expect(changeLog.getRun('nope')).toBeNull();
    });
  });

  describe('revertChange()', () => {
    it('marks a change as reverted', () => {
      const runId = changeLog.beginRun();
      const changeId = changeLog.recordChange(runId, {
        entityType: 'customer',
        entityId: 'C001',
        action: 'update',
      });
      const result = changeLog.revertChange(runId, changeId, 'Undo');
      expect(result.ok).toBe(true);

      const run = runsData.runs.find(r => r.id === runId);
      const change = run.changes.find(c => c.id === changeId);
      expect(change.reverted).toBe(true);
      expect(change.revertNote).toBe('Undo');
    });

    it('returns error for unknown run', () => {
      const result = changeLog.revertChange('bad-run', 'bad-change');
      expect(result.ok).toBe(false);
    });

    it('returns error for unknown change', () => {
      const runId = changeLog.beginRun();
      const result = changeLog.revertChange(runId, 'bad-change');
      expect(result.ok).toBe(false);
    });
  });

  describe('requestPull()', () => {
    it('returns a plan response', () => {
      const result = changeLog.requestPull('customer', 'C001');
      expect(result.ok).toBe(true);
      expect(result.plan.action).toBe('pull');
      expect(result.plan.entityType).toBe('customer');
      expect(result.plan.entityId).toBe('C001');
    });
  });
});
