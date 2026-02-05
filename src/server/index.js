import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../util/logger.js';
import runSync from '../sync/run.js';
import progress from './progress.js';
import runStore from './runStore.js';
import { getMongoDb, isMongoEnabled } from '../db/mongo.js';
import config from '../config.js';
import { getCronHealth, startCron } from './cron.js';

const app = express();
const port = Number(process.env.PORT || 3000);

let lastRun = null;
let isRunning = false;
let lastCounts = null;
let lastError = null;
const logs = [];
let currentRunId = null;

async function triggerSync({ requestedBy }) {
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
  logs.unshift({ time: Date.now(), level: 'info', message: `Sync started (${requestedBy})`, meta: { runId } });

  const promise = runSync({ runId })
    .then((result) => {
      lastRun = Date.now();
      isRunning = false;
      lastCounts = result && result.counts ? result.counts : lastCounts;
      lastError = null;
      progress.finish(lastCounts);

      // Record count deltas vs previous counts as informational changes
      try {
        const prev = result?.previousCounts ?? countsBeforeRun;
        const curr = lastCounts || {};
        const resources = ['customers','suppliers','projects','nominals','invoices','quotes','purchases'];
        resources.forEach((name) => {
          const before = prev ? prev[name] ?? null : null;
          const after = curr[name] ?? null;
          if (before === null && after === null) return;
          if (before === after) return;
          runStore.recordChange(runId, {
            entityType: 'metric',
            entityId: name,
            action: 'info',
            reason: 'Resource count changed after sync',
            source: 'system',
            before,
            after,
            diff: [{ path: name, before, after }],
          });
        });
      } catch {}

      runStore.finishRun(runId, {
        counts: lastCounts,
        mongo: result?.mongo || null,
        mongoUpserts: result?.mongoUpserts || null,
        error: null,
      });

      logs.unshift({ time: Date.now(), level: 'success', message: 'Sync completed successfully', meta: { counts: lastCounts, runId } });
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
      logs.unshift({ time: Date.now(), level: 'error', message: 'Sync failed', meta: { error: err?.message, runId } });
      throw err;
    });

  return { started: true, reason: null, runId, promise };
}

// EJS setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
// Serve static assets with no-store to avoid stale caching in admin dashboard
app.use('/static', express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  cacheControl: true,
  maxAge: 0,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store');
  },
}));
// Serve Flowbite JS from node_modules
app.use('/static/vendor/flowbite', express.static(path.join(__dirname, '../../node_modules/flowbite/dist')));

app.get('/health', (_req, res) => {
  const cron = getCronHealth({
    enabled: config.cronEnabled,
    schedule: config.cronSchedule,
    timezone: config.cronTimezone,
    staleMs: config.cronHealthStaleMs,
  });
  res.json({ status: 'ok', isRunning, lastRun, cron });
});

app.get('/cron/health', (_req, res) => {
  const cron = getCronHealth({
    enabled: config.cronEnabled,
    schedule: config.cronSchedule,
    timezone: config.cronTimezone,
    staleMs: config.cronHealthStaleMs,
  });

  const isOk = cron.status === 'ok' || cron.status === 'disabled';
  res.status(isOk ? 200 : 503).json(cron);
});
// Simple logs stub (extend later)
app.get('/logs', (_req, res) => {
  res.render('layout', { title: 'HCS Sync Logs', content: 'pages/logs', logs, isRunning, lastRun, counts: lastCounts, lastError });
});
app.get('/logs.json', (_req, res) => {
  res.json({ logs });
});
// Runtime status for dashboard polling
app.get('/status', (_req, res) => {
  res.json(progress.getState());
});

app.get('/', (_req, res) => {
  res.render('layout', { title: 'HCS Sync', content: 'pages/index', isRunning, lastRun, counts: lastCounts, lastError });
});

app.post('/run', async (_req, res) => {
  if (config.cronEnabled) {
    return res.status(409).send('Manual runs are disabled when CRON is enabled.');
  }

  try {
    const out = await triggerSync({ requestedBy: 'dashboard' });
    if (!out.started) return res.status(409).send('Sync already running');
    // Don’t await completion for the dashboard.
    out.promise.catch(() => {});
    return res.redirect('/');
  } catch (err) {
    const msg = err?.message || 'Failed to start run';
    return res.status(500).send(msg);
  }
});

// History pages
app.get('/history', (_req, res) => {
  runStore
    .listRuns()
    .then((runs) => {
      res.render('layout', { title: 'Sync History', content: 'pages/history', runs, isRunning, lastRun, counts: lastCounts, lastError });
    })
    .catch((err) => {
      const msg = err?.message || 'Failed to load history';
      res.status(500).send(msg);
    });
});
app.get('/history/:id', (req, res) => {
  runStore
    .getRun(req.params.id)
    .then(async (run) => {
      if (!run) return res.status(404).send('Run not found');

      const mongoCollection = String(req.query?.mongoCollection || '');
      const mongoType = String(req.query?.mongoType || '');
      let mongoDocs = null;
      let mongoDocsError = null;
      let mongoDocsSource = null;
      const mongoUpsertedCount = Number(run?.summary?.mongo?.[mongoCollection]?.upserted ?? 0);

      if (mongoCollection && mongoType === 'upserted') {
        const upserts = run?.summary?.mongoUpserts?.[mongoCollection] || null;
        const filters = upserts?.filters || [];

        const fallbackByRunId = async () => {
          if (!isMongoEnabled()) {
            mongoDocsError = 'MongoDB is not configured on the server (cannot load docs).';
            return;
          }
          try {
            const db = await getMongoDb();
            mongoDocs = await db
              .collection(mongoCollection)
              .find({ createdByRunId: run.id }, { limit: 200 })
              .toArray();
            mongoDocsSource = 'createdByRunId';
          } catch (err) {
            mongoDocsError = err?.message || 'Failed to load Mongo documents.';
          }
        };

        if (filters.length) {
          if (!isMongoEnabled()) {
            mongoDocsError = 'MongoDB is not configured on the server (cannot load docs).';
          } else {
            try {
              const db = await getMongoDb();
              mongoDocs = await db
                .collection(mongoCollection)
                .find({ $or: filters }, { limit: 200 })
                .toArray();
              mongoDocsSource = 'filters';
            } catch (err) {
              mongoDocsError = err?.message || 'Failed to load Mongo documents.';
            }
          }
        } else {
          // Fallback for Mongo-compatible servers that don't return upsertedIds
          // for bulkWrite: we tag inserted docs with createdByRunId.
          await fallbackByRunId();
        }

        if (!mongoDocsError && Array.isArray(mongoDocs) && mongoDocs.length === 0 && mongoUpsertedCount > 0) {
          mongoDocsError =
            'This run reports inserted documents, but the server could not locate them for drilldown. ' +
            'If this run was created before insert tagging was added, re-run a sync to enable drilldown.';
        }
      }

      res.render('layout', {
        title: 'Run Details',
        content: 'pages/run',
        run,
        isRunning,
        lastRun,
        counts: lastCounts,
        lastError,
        mongoCollection,
        mongoType,
        mongoDocs,
        mongoDocsError,
        mongoDocsSource,
        mongoUpsertedCount,
      });
    })
    .catch((err) => {
      const msg = err?.message || 'Failed to load run';
      res.status(500).send(msg);
    });
});
// Revert and manual pull endpoints (no DB writes yet)
app.post('/history/:id/revert/:changeId', (req, res) => {
  const note = req.body?.note || '';
  runStore
    .revertChange(req.params.id, req.params.changeId, note)
    .then((out) => {
      if (!out.ok) return res.status(400).send(out.message || 'Revert failed');
      res.redirect(`/history/${req.params.id}`);
    })
    .catch((err) => {
      const msg = err?.message || 'Revert failed';
      res.status(500).send(msg);
    });
});
app.post('/pull', (req, res) => {
  const { entityType, entityId } = req.body || {};
  const out = runStore.requestPull(entityType, entityId);
  if (!out.ok) return res.status(400).send('Pull request failed');
  res.json(out);
});

app.listen(port, () => {
  logger.info({ port }, 'Server listening');

  try {
    startCron({
      enabled: config.cronEnabled,
      schedule: config.cronSchedule,
      timezone: config.cronTimezone,
      staleMs: config.cronHealthStaleMs,
      triggerSync,
    });
  } catch (err) {
    logger.error({ err: { message: err?.message } }, 'Failed to start cron scheduler');
  }
});
