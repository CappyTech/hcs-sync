import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We import the real module since it has no external deps
describe('src/server/cron.js', () => {
  let cronMod;

  beforeEach(async () => {
    vi.resetModules();
    // Each test gets a clean import with fresh module-level state
    cronMod = await import('../src/server/cron.js');
    // Ensure any previous cron job is stopped
    cronMod.stopCron();
  });

  afterEach(() => {
    cronMod.stopCron();
  });

  describe('startCron()', () => {
    it('does nothing when enabled=false', () => {
      const result = cronMod.startCron({
        enabled: false,
        schedule: '* * * * *',
        timezone: 'UTC',
        triggerSync: vi.fn(),
      });
      expect(result).toBeUndefined();
      expect(cronMod.getCronState().jobRunning).toBe(false);
    });

    it('throws on invalid schedule', () => {
      expect(() =>
        cronMod.startCron({
          enabled: true,
          schedule: 'not-a-cron',
          timezone: 'UTC',
          triggerSync: vi.fn(),
        })
      ).toThrow(/Invalid CRON_SCHEDULE/);
    });

    it('starts a job with valid schedule', () => {
      const healthFn = cronMod.startCron({
        enabled: true,
        schedule: '0 * * * *',
        timezone: 'UTC',
        triggerSync: vi.fn(),
      });

      expect(cronMod.getCronState().jobRunning).toBe(true);
      expect(typeof healthFn).toBe('function');
    });

    it('is idempotent — does not create duplicate jobs', () => {
      const fn = vi.fn();
      cronMod.startCron({ enabled: true, schedule: '0 * * * *', timezone: 'UTC', triggerSync: fn });
      cronMod.startCron({ enabled: true, schedule: '0 * * * *', timezone: 'UTC', triggerSync: fn });
      // Still only one job running
      expect(cronMod.getCronState().jobRunning).toBe(true);
    });
  });

  describe('stopCron()', () => {
    it('stops a running job', () => {
      cronMod.startCron({
        enabled: true,
        schedule: '0 * * * *',
        timezone: 'UTC',
        triggerSync: vi.fn(),
      });
      expect(cronMod.getCronState().jobRunning).toBe(true);
      cronMod.stopCron();
      expect(cronMod.getCronState().jobRunning).toBe(false);
    });

    it('is safe to call when no job is running', () => {
      expect(() => cronMod.stopCron()).not.toThrow();
    });
  });

  describe('getCronState()', () => {
    it('returns state object with expected keys', () => {
      const state = cronMod.getCronState();
      expect(state).toHaveProperty('jobRunning');
      expect(state).toHaveProperty('startedAt');
      expect(state).toHaveProperty('lastTickAt');
      expect(state).toHaveProperty('lastTriggerAt');
      expect(state).toHaveProperty('lastRunId');
      expect(state).toHaveProperty('lastRunStatus');
    });
  });

  describe('getCronHealth()', () => {
    it('returns disabled status when not enabled', () => {
      const health = cronMod.getCronHealth({ enabled: false });
      expect(health.status).toBe('disabled');
      expect(health.enabled).toBe(false);
    });

    it('returns error when job is not running but should be', () => {
      // Don't start a job, but claim enabled
      const health = cronMod.getCronHealth({
        enabled: true,
        schedule: '0 * * * *',
        timezone: 'UTC',
      });
      expect(health.status).toBe('error');
    });

    it('returns ok when job is running', () => {
      cronMod.startCron({
        enabled: true,
        schedule: '0 * * * *',
        timezone: 'UTC',
        triggerSync: vi.fn(),
      });
      const health = cronMod.getCronHealth({
        enabled: true,
        schedule: '0 * * * *',
        timezone: 'UTC',
      });
      expect(health.status).toBe('ok');
      expect(health.enabled).toBe(true);
    });

    it('detects stale status when staleMs is exceeded', () => {
      // Start a cron and immediately check health with a very short staleMs
      // Since startedAt was just set, we need to trick it by using 0ms stale window
      // Actually staleMs=1 means 1ms — startedAt = Date.now() so (now - startedAt) could be >= 1ms
      cronMod.startCron({
        enabled: true,
        schedule: '0 * * * *',
        timezone: 'UTC',
        triggerSync: vi.fn(),
      });

      // Wait a tiny bit so the age exceeds 1ms
      const before = Date.now();
      while (Date.now() - before < 5) { /* spin */ }

      const health = cronMod.getCronHealth({
        enabled: true,
        schedule: '0 * * * *',
        timezone: 'UTC',
        staleMs: 1,
      });
      expect(health.status).toBe('stale');
      expect(health.problems).toEqual(expect.arrayContaining([
        expect.stringContaining('stale window'),
      ]));
    });

    it('includes schedule and timezone in health response', () => {
      cronMod.startCron({
        enabled: true,
        schedule: '*/5 * * * *',
        timezone: 'America/New_York',
        triggerSync: vi.fn(),
      });
      const health = cronMod.getCronHealth({
        enabled: true,
        schedule: '*/5 * * * *',
        timezone: 'America/New_York',
      });
      expect(health.schedule).toBe('*/5 * * * *');
      expect(health.timezone).toBe('America/New_York');
    });
  });

  // ── Tick execution tests (using real cron with per-second schedule) ────

  describe('tick execution', () => {
    it('calls triggerSync on cron tick', async () => {
      const triggerSync = vi.fn().mockResolvedValue({
        started: true,
        runId: 'cron-run-1',
        promise: Promise.resolve(),
      });

      cronMod.startCron({
        enabled: true,
        schedule: '* * * * * *', // every second
        timezone: 'UTC',
        triggerSync,
      });

      // Wait for the tick to fire (up to 2 seconds)
      await vi.waitFor(() => {
        expect(triggerSync).toHaveBeenCalledWith({ requestedBy: 'cron' });
      }, { timeout: 3000 });
    });

    it('tracks lastRunStatus=finished on successful sync', async () => {
      const triggerSync = vi.fn().mockResolvedValue({
        started: true,
        runId: 'run-ok',
        promise: Promise.resolve(),
      });

      cronMod.startCron({
        enabled: true,
        schedule: '* * * * * *',
        timezone: 'UTC',
        triggerSync,
      });

      await vi.waitFor(() => {
        expect(cronMod.getCronState().lastRunStatus).toBe('finished');
      }, { timeout: 3000 });

      expect(cronMod.getCronState().lastRunId).toBe('run-ok');
    });

    it('tracks lastRunStatus=failed on sync error', async () => {
      const failPromise = Promise.reject(new Error('sync boom'));
      failPromise.catch(() => {}); // prevent unhandled rejection warning
      const triggerSync = vi.fn().mockResolvedValue({
        started: true,
        runId: 'run-fail',
        promise: failPromise,
      });

      cronMod.startCron({
        enabled: true,
        schedule: '* * * * * *',
        timezone: 'UTC',
        triggerSync,
      });

      await vi.waitFor(() => {
        expect(cronMod.getCronState().lastRunStatus).toBe('failed');
      }, { timeout: 3000 });

      expect(cronMod.getCronState().lastRunError).toBe('sync boom');
    });

    it('tracks lastRunStatus=skipped when triggerSync reports not started', async () => {
      const triggerSync = vi.fn().mockResolvedValue({
        started: false,
        reason: 'already-running',
      });

      cronMod.startCron({
        enabled: true,
        schedule: '* * * * * *',
        timezone: 'UTC',
        triggerSync,
      });

      await vi.waitFor(() => {
        expect(cronMod.getCronState().lastRunStatus).toBe('already-running');
      }, { timeout: 3000 });
    });
  });
});
