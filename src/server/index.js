import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../util/logger.js';
import runSync from '../sync/run.js';
import progress from './progress.js';
import changeLog from './changeLog.js';
import config from '../config.js';
import cookieParser from 'cookie-parser';
import { optionalSso, ensureSsoAuthenticated } from './sso.js';
import { clearCachedSessionToken } from '../kashflow/auth.js';
import mongo from '../db/mongo.js';

const app = express();
const port = Number(process.env.PORT || 3000);

let lastRun = null;
let isRunning = false;
let lastCounts = null;
let lastError = null;
const logs = [];
let currentRunId = null;

// EJS setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(optionalSso);
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
  res.json({ status: 'ok', isRunning, lastRun });
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

// Debug auth summary (no secrets exposed)
app.get('/debug/auth', (_req, res) => {
  const tokenPresent = Boolean(config.token);
  const t = String(config.token || '');
  const isKF = t.startsWith('KF_');
  const isGuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(t);
  res.json({
    baseUrl: config.baseUrl,
    usingEnvToken: tokenPresent,
    tokenType: tokenPresent ? (isKF ? 'kf-bearer' : (isGuid ? 'kf-guid' : 'unknown')) : null,
    hasUsername: Boolean(process.env.USERNAME),
    hasPassword: Boolean(process.env.PASSWORD),
    hasMemorableWord: Boolean(process.env.MEMORABLE_WORD),
    timeoutMs: config.timeoutMs,
    mongoEnabled: Boolean(config.mongoUri && config.mongoDbName),
  });
});

app.get('/', ensureSsoAuthenticated, (_req, res) => {
  res.render('layout', { title: 'HCS Sync', content: 'pages/index', isRunning, lastRun, counts: lastCounts, lastError });
});


app.get('/logout', (_req, res) => {
  try {
    clearCachedSessionToken();
    logs.unshift({ time: Date.now(), level: 'info', message: 'Logout: cleared cached session token; redirecting to hcs-app' });
  } catch {}
  res.redirect('https://app.heroncs.co.uk/logout');
});

// Alias route: clear token then redirect to app.heroncs.co.uk /user/logout
app.get('/user/logout', (_req, res) => {
  try {
    clearCachedSessionToken();
    logs.unshift({ time: Date.now(), level: 'info', message: 'User Logout: cleared cached session token; redirecting to hcs-app /user/logout' });
  } catch {}
  res.redirect('https://app.heroncs.co.uk/user/logout');
});

app.post('/run', ensureSsoAuthenticated, async (_req, res) => {
  if (isRunning) {
    return res.status(409).send('Sync already running');
  }
  isRunning = true;
  lastError = null;
  progress.start();
  currentRunId = changeLog.beginRun({ requestedBy: 'dashboard' });
  logs.unshift({ time: Date.now(), level: 'info', message: 'Sync started' });
  runSync()
    .then((result) => {
      lastRun = Date.now();
      isRunning = false;
      lastCounts = result && result.counts ? result.counts : lastCounts;
      lastError = null;
      progress.finish(lastCounts);
      // Record count deltas vs previous counts as informational changes
      try {
        const prev = result?.previousCounts || null;
        const curr = lastCounts || {};
        const resources = ['customers','suppliers','projects','nominals','invoices','quotes','purchases'];
        resources.forEach((name) => {
          const before = prev ? prev[name] ?? null : null;
          const after = curr[name] ?? null;
          if (before === null && after === null) return;
          if (before === after) return;
          changeLog.recordChange(currentRunId, {
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
      changeLog.finishRun(currentRunId, { counts: lastCounts, error: null });
      logs.unshift({ time: Date.now(), level: 'success', message: 'Sync completed successfully', meta: { counts: lastCounts } });
    })
    .catch((err) => {
      logger.error({ status: err.response?.status, message: err.message, data: err.response?.data }, 'Sync failed via dashboard');
      isRunning = false;
      lastError = err?.response?.data?.Message || err?.message || 'Sync failed';
      progress.fail(lastError);
      changeLog.finishRun(currentRunId, { error: lastError });
      logs.unshift({ time: Date.now(), level: 'error', message: 'Sync failed', meta: { error: err?.message } });
    });
  res.redirect('/');
});

// History pages
app.get('/history', (_req, res) => {
  const runs = changeLog.listRuns();
  res.render('layout', { title: 'Sync History', content: 'pages/history', runs, isRunning, lastRun, counts: lastCounts, lastError });
});
app.get('/history/:id', (req, res) => {
  const run = changeLog.getRun(req.params.id);
  if (!run) return res.status(404).send('Run not found');
  res.render('layout', { title: 'Run Details', content: 'pages/run', run, isRunning, lastRun, counts: lastCounts, lastError });
});
// Revert and manual pull endpoints (no DB writes yet)
app.post('/history/:id/revert/:changeId', (req, res) => {
  const note = req.body?.note || '';
  const out = changeLog.revertChange(req.params.id, req.params.changeId, note);
  if (!out.ok) return res.status(400).send(out.message || 'Revert failed');
  res.redirect(`/history/${req.params.id}`);
});
app.post('/pull', (req, res) => {
  const { entityType, entityId } = req.body || {};
  const out = changeLog.requestPull(entityType, entityId);
  if (!out.ok) return res.status(400).send('Pull request failed');
  res.json(out);
});

app.listen(port, () => {
  logger.info({ port }, 'Server listening');

  // Trigger Mongo connection once at startup so logs show which DB is in use.
  // Do not block startup; if Mongo is down we still want the UI/routes.
  if (mongo.isDbEnabled()) {
    mongo.getDb().catch((e) => {
      logger.warn({ err: e?.message }, 'MongoDB connect on startup failed');
    });
  }
});
