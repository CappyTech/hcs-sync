import logger from '../util/logger.js';
import { resolveStaffologySettings, staffologyMayBeConfigured } from './settings.js';

/**
 * Staffology sync lifecycle, kept apart from the KashFlow run in
 * syncController: its own running flag, last run and error, so a Staffology
 * problem never marks a KashFlow run failed and vice versa.
 *
 * Settings (the API key) are resolved fresh before every run, from hcs-sync's
 * env or from hcs-app (src/staffology/settings.js), and never stored.
 *
 * The run module is imported lazily so loading the dashboard does not pull in
 * the Staffology database connection.
 */
export const state = {
  isRunning: false,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  /** 'env' | 'hcs-app' | null — where the last run's key came from */
  settingsSource: null,
  /** true when the last check found no key anywhere */
  notConfigured: false,
};

/** Cheap check for the dashboard: is there anywhere a key could come from? */
export const isStaffologyConfigured = () => staffologyMayBeConfigured();

export async function triggerStaffologySync({ requestedBy = 'system', run, resolveSettings = resolveStaffologySettings } = {}) {
  if (!staffologyMayBeConfigured()) return { started: false, reason: 'not-configured' };
  if (state.isRunning) return { started: false, reason: 'already-running' };

  state.isRunning = true;
  let settings;
  try {
    settings = await resolveSettings();
  } catch (err) {
    state.lastError = err?.message || 'Could not read the Staffology settings';
    state.lastRunAt = Date.now();
    state.isRunning = false;
    logger.warn({ requestedBy, err: state.lastError }, 'Staffology sync skipped');
    return { started: false, reason: 'settings-unavailable', promise: Promise.resolve(null) };
  }
  if (!settings) {
    state.notConfigured = true;
    state.isRunning = false;
    return { started: false, reason: 'not-configured' };
  }
  state.notConfigured = false;
  state.settingsSource = settings.source;

  const promise = (async () => {
    try {
      const runFn = run || (await import('./run.js')).runStaffologySync;
      const result = await runFn({ settings });
      state.lastResult = result;
      state.lastError = result.errors.length ? `${result.errors.length} step(s) failed: ${result.errors[0].message}` : null;
      logger.info({ requestedBy, source: settings.source, employees: result.employees, payRuns: result.payRuns, entries: result.entries, errors: result.errors.length }, 'Staffology sync finished');
      return result;
    } catch (err) {
      state.lastError = err?.message || 'Staffology sync failed';
      logger.error({ requestedBy, err: state.lastError }, 'Staffology sync failed');
      return null;
    } finally {
      state.lastRunAt = Date.now();
      state.isRunning = false;
    }
  })();
  return { started: true, reason: null, promise };
}
