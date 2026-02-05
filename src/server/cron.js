import cron from 'node-cron';
import logger from '../util/logger.js';

let job = null;
let startedAt = null;
let lastTickAt = null;
let lastTriggerAt = null;
let lastRunId = null;
let lastRunStartedAt = null;
let lastRunFinishedAt = null;
let lastRunStatus = null;
let lastRunError = null;

export function startCron({ enabled, schedule, timezone, triggerSync, staleMs = 0 }) {
  if (!enabled) {
    logger.info('Cron disabled');
    return;
  }

  if (!cron.validate(schedule)) {
    throw new Error(`Invalid CRON_SCHEDULE: ${schedule}`);
  }

  if (job) return;
  startedAt = Date.now();

  const opts = {};
  if (timezone) opts.timezone = timezone;

  job = cron.schedule(
    schedule,
    async () => {
      lastTickAt = Date.now();
      lastTriggerAt = lastTickAt;
      try {
        const out = await triggerSync({ requestedBy: 'cron' });
        lastRunId = out?.runId || null;
        if (!out?.started) {
          lastRunStatus = out?.reason || 'skipped';
          return;
        }
        lastRunStartedAt = Date.now();
        lastRunStatus = 'running';
        await out.promise;
        lastRunFinishedAt = Date.now();
        lastRunStatus = 'finished';
        lastRunError = null;
      } catch (err) {
        lastRunFinishedAt = Date.now();
        lastRunStatus = 'failed';
        lastRunError = err?.message || String(err);
        logger.error({ err: { message: err?.message, name: err?.name } }, 'Cron-triggered sync failed');
      }
    },
    { ...opts, scheduled: true }
  );

  logger.info({ schedule, timezone: timezone || undefined }, 'Cron enabled');

  // Return a function for health evaluation.
  return () => getCronHealth({ enabled: true, schedule, timezone, staleMs });
}

export function stopCron() {
  try {
    job?.stop();
  } finally {
    job = null;
  }
}

export function getCronState() {
  return {
    jobRunning: Boolean(job),
    startedAt,
    lastTickAt,
    lastTriggerAt,
    lastRunId,
    lastRunStartedAt,
    lastRunFinishedAt,
    lastRunStatus,
    lastRunError,
  };
}

export function getCronHealth({ enabled, schedule, timezone, staleMs = 0 } = {}) {
  if (!enabled) {
    return { status: 'disabled', enabled: false };
  }

  const state = getCronState();
  const now = Date.now();
  const ageMs = state.startedAt ? now - state.startedAt : null;
  const lastRunAgeMs = state.lastRunFinishedAt ? now - state.lastRunFinishedAt : null;

  let status = 'ok';
  const problems = [];

  if (!state.jobRunning) {
    status = 'error';
    problems.push('cron job is not running');
  }

  if (staleMs > 0) {
    // If we expect cron to have triggered by now but it hasn't, mark unhealthy.
    const lastMeaningful = state.lastRunFinishedAt || state.lastTriggerAt || state.startedAt;
    if (lastMeaningful && now - lastMeaningful > staleMs) {
      status = 'stale';
      problems.push(`no cron activity within stale window (${staleMs}ms)`);
    }
  }

  return {
    status,
    enabled: true,
    schedule,
    timezone: timezone || null,
    problems,
    state: {
      ...state,
      ageMs,
      lastRunAgeMs,
    },
  };
}
