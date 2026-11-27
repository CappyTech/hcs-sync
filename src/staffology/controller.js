import config from '../config.js';
import logger from '../util/logger.js';

/**
 * Staffology sync lifecycle, kept apart from the KashFlow run in
 * syncController: its own running flag, last run and error, so a Staffology
 * problem never marks a KashFlow run failed and vice versa.
 *
 * The run module is imported lazily so loading the dashboard does not pull in
 * the Staffology database connection.
 */
export const state = {
  isRunning: false,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
};

export const isStaffologyConfigured = () => Boolean(config.staffologyApiKey);

export async function triggerStaffologySync({ requestedBy = 'system', run } = {}) {
  if (!isStaffologyConfigured()) return { started: false, reason: 'not-configured' };
  if (state.isRunning) return { started: false, reason: 'already-running' };

  state.isRunning = true;
  const promise = (async () => {
    try {
      const runFn = run || (await import('./run.js')).runStaffologySync;
      const result = await runFn();
      state.lastResult = result;
      state.lastError = result.errors.length ? `${result.errors.length} step(s) failed: ${result.errors[0].message}` : null;
      logger.info({ requestedBy, employees: result.employees, payRuns: result.payRuns, entries: result.entries, errors: result.errors.length }, 'Staffology sync finished');
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
