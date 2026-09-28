/**
 * Sync lifecycle state shared by the dashboard, the cron scheduler and the
 * routes: whether a run is in flight, the last run's counts and error, the
 * in-memory log buffer, the effective cron config, and dedup state.
 *
 * State is exported as live bindings (read-only to importers) and changed
 * only through the functions here.
 */
import logger from '../util/logger.js';
import runSync, { carryForwardFailedCounts } from '../sync/run.js';
import progress from './progress.js';
import runStore from './runStore.js';
import { getMongoDb } from '../db/mongo.js';
import config from '../config.js';
import { getCronHealth, startCron, stopCron } from './cron.js';
import settingsStore from './settingsStore.js';
import { isMongooseEnabled } from '../db/mongoose.js';
import { runDedup } from '../db/dedup.js';
import cronParser from 'cron-parser';
import { summariseRunChanges, notifyRunCompleted, notifyRunFailed } from './notify.js';

export let lastRun = null;
export let isRunning = false;
export let lastCounts = null;
export let lastError = null;
export const logs = [];
const LOGS_CAP = 500;

export function pushLog(entry) {
  logs.unshift(entry);
  if (logs.length > LOGS_CAP) logs.length = LOGS_CAP;
}

let currentRunId = null;

let cachedSettings = null;
let cronConfig = {
  enabled: config.cronEnabled,
  schedule: config.cronSchedule,
  timezone: config.cronTimezone,
  healthStaleMs: config.cronHealthStaleMs,
  source: 'env',
};

export async function loadSettingsIntoCache() {
  if (!isMongooseEnabled()) {
    cachedSettings = null;
    cronConfig = { ...cronConfig, source: 'env' };
    return;
  }

  try {
    cachedSettings = await settingsStore.getSettings();
  } catch {
    cachedSettings = null;
  }

  const cronFromDb = cachedSettings?.cron || null;
  if (cronFromDb) {
    cronConfig = {
      enabled: Boolean(cronFromDb.enabled),
      schedule: String(cronFromDb.schedule || config.cronSchedule || '0 * * * *'),
      timezone: String(cronFromDb.timezone || '').trim() || config.cronTimezone || 'Europe/London',
      healthStaleMs: Number(cronFromDb.healthStaleMs || 0),
      source: 'db',
    };
  } else {
    cronConfig = {
      enabled: config.cronEnabled,
      schedule: config.cronSchedule,
      timezone: config.cronTimezone,
      healthStaleMs: config.cronHealthStaleMs,
      source: 'env',
    };
  }
}

export function getEffectiveCronConfig() {
  return { ...cronConfig };
}

export function currentCronHealth(eff = getEffectiveCronConfig()) {
  return getCronHealth({
    enabled: eff.enabled,
    schedule: eff.schedule,
    timezone: eff.timezone,
    staleMs: eff.healthStaleMs,
  });
}

export function applyCronConfig() {
  const eff = getEffectiveCronConfig();
  stopCron();
  if (!eff.enabled) return;
  startCron({
    enabled: true,
    schedule: eff.schedule,
    timezone: eff.timezone,
    staleMs: eff.healthStaleMs,
    triggerSync,
  });
}

export function computeNextCronRunAtMs({ enabled, schedule, timezone }) {
  if (!enabled) return null;
  if (!schedule) return null;

  try {
    const parseExpression = cronParser?.parseExpression;
    if (typeof parseExpression !== 'function') return null;
    const expr = parseExpression(schedule, timezone ? { tz: timezone } : undefined);
    const next = expr.next();
    const nextDate = next?.toDate?.() || next;
    const nextMs = nextDate instanceof Date ? nextDate.getTime() : null;
    return Number.isFinite(nextMs) ? nextMs : null;
  } catch {
    return null;
  }
}

export async function triggerSync({ requestedBy }) {
  if (isRunning) {
    return { started: false, reason: 'already-running', runId: null, promise: Promise.resolve(null) };
  }

  // Capture “before” counts at the moment the run starts so history diffs
  // don’t show `before: null` on every run.
  let countsBeforeRun = lastCounts ? { ...lastCounts } : null;
  if (!countsBeforeRun) {
    try {
      const runs = await runStore.listRuns({ limit: 50 });
      const prevFinished = runs.find((r) => r?.status === 'finished' && r?.summary?.counts);
      countsBeforeRun = prevFinished?.summary?.counts ? { ...prevFinished.summary.counts } : null;
    } catch {
      countsBeforeRun = null;
    }
  }

  isRunning = true;
  lastError = null;
  progress.start();

  try {
    currentRunId = await runStore.beginRun({ requestedBy });
  } catch (err) {
    isRunning = false;
    lastError = err?.message || 'Failed to start run';
    progress.fail(lastError);
    throw err;
  }

  const runId = currentRunId;

  const recordRunLog = (level, message, meta) => {
    pushLog({ time: Date.now(), level, message, meta: { ...(meta || {}), runId } });
    Promise.resolve(
      runStore.recordLog(runId, {
        level,
        message,
        meta,
      })
    ).catch(() => {});
  };

  recordRunLog('info', `Sync started (${requestedBy})`, { requestedBy });

  const promise = runSync({
    runId,
    recordLog: (entry) => {
      const level = String(entry?.level || 'info');
      const message = String(entry?.message || '');
      const stage = entry?.stage ? String(entry.stage) : null;
      const meta = typeof entry?.meta === 'undefined' ? null : (entry?.meta ?? null);
      return runStore.recordLog(runId, { level, message, stage, meta });
    },
  })
    .then((result) => {
      lastRun = Date.now();
      isRunning = false;
      // Carry prior counts forward for any collection whose KashFlow fetch failed
      // this run, before lastCounts feeds change recording, Discord and history.
      // Otherwise a transient fetch failure reads as a drop to zero (and its
      // recovery as a spurious jump back) — see carryForwardFailedCounts.
      const prevCounts = result?.previousCounts ?? countsBeforeRun ?? lastCounts;
      lastCounts = result && result.counts
        ? carryForwardFailedCounts(prevCounts, result.counts, result.failedFetches || [])
        : lastCounts;
      lastError = null;
      progress.finish(lastCounts);

      // Record what changed (count deltas and in-place modifications) as
      // informational changes.
      try {
        const prev = result?.previousCounts ?? countsBeforeRun;
        const curr = lastCounts || {};
        summariseRunChanges(prev, curr, result?.mongo).forEach((c) => {
          const reasons = [];
          if (c.countChanged) reasons.push('count changed');
          if (c.modified) reasons.push(`${c.modified} modified`);
          runStore.recordChange(runId, {
            entityType: 'metric',
            entityId: c.name,
            action: 'info',
            reason: `Resource ${reasons.join(', ')} after sync`,
            source: 'system',
            before: c.before,
            after: c.after,
            diff: [{ path: c.name, before: c.before, after: c.after }],
            meta: { upserted: c.upserted, modified: c.modified },
          });
        });
      } catch {}

      runStore.finishRun(runId, {
        counts: lastCounts,
        mongo: result?.mongo || null,
        mongoUpserts: result?.mongoUpserts || null,
        error: null,
      });

      if (result?.partial?.bankTransactions?.length) {
        recordRunLog('warn', 'Sync completed with warnings', {
          counts: lastCounts,
          bankAccountsNotFetched: result.partial.bankTransactions.map((f) => f.accountId),
        });
      } else {
        recordRunLog('success', 'Sync completed successfully', { counts: lastCounts });
      }

      notifyRunCompleted({ result, prevCounts: result?.previousCounts ?? countsBeforeRun, counts: lastCounts, requestedBy });

      return result;
    })
    .catch((err) => {
      logger.error({ status: err.response?.status, message: err.message, data: err.response?.data }, 'Sync failed via scheduler');
      isRunning = false;
      const apiError = err?.response?.data?.Error || '';
      const apiMessage = err?.response?.data?.Message || '';
      if (apiError === 'PasswordExpired') {
        lastError = `${apiMessage || 'KashFlow auth failed'} (Error: PasswordExpired). Try setting SESSION_TOKEN/KASHFLOW_SESSION_TOKEN to a valid token to bypass password login, or reset the KashFlow password for this user.`;
      } else {
        lastError = apiMessage || err?.message || 'Sync failed';
      }
      progress.fail(lastError);
      runStore.finishRun(runId, { error: lastError });
      recordRunLog('error', 'Sync failed', { error: lastError });

      notifyRunFailed({ error: lastError, requestedBy });

      throw err;
    });

  return { started: true, reason: null, runId, promise };
}

// Deduplication + uuid backfill
export let dedupRunning = false;
export let lastDedupResult = null;

/**
 * Run dedup + uuid backfill against the live database, recording the result
 * for the dashboard banner and /dedup/status. The caller checks preconditions.
 */
export async function runDashboardDedup() {
  dedupRunning = true;
  try {
    const db = await getMongoDb();
    const logLines = [];
    const result = await runDedup(db, {
      dryRun: false,
      log: (msg) => logLines.push(msg),
    });
    lastDedupResult = { ...result, logLines, ranAt: new Date().toISOString() };

    // Log structured summary
    const { actions, ...summary } = result;
    logger.info({ dedup: summary }, 'Dedup completed from dashboard');

    // Log every individual action for audit trail
    if (actions && actions.length) {
      for (const action of actions) {
        logger.info({ dedupAction: action }, `dedup: ${action.type} ${action.collection} _id=${action.documentId}`);
      }
    }
  } finally {
    dedupRunning = false;
  }
}
