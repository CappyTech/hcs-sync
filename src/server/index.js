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

const RUN_TOKEN = process.env.HCS_SYNC_RUN_TOKEN || '';

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
app.use(express.json());
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

function ensureRunAuthorized(req, res, next) {
  if (RUN_TOKEN) {
    const headerToken = req.get('x-run-token');
    const auth = req.get('authorization');
    const bearerToken = auth && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '') : null;
    const provided = headerToken || bearerToken;

    if (provided && provided === RUN_TOKEN) {
      req.user = { id: 'run-token', username: 'run-token', role: 'system', sso: false };
      return next();
    }
  }
  return ensureSsoAuthenticated(req, res, next);
}


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

app.post('/run', ensureRunAuthorized, async (_req, res) => {
  if (isRunning) {
    return res.status(409).send('Sync already running');
  }
  isRunning = true;
  lastError = null;
  progress.start();
  try {
    currentRunId = await changeLog.beginRun({ requestedBy: 'dashboard' });
  } catch {
    currentRunId = null;
  }
  logs.unshift({ time: Date.now(), level: 'info', message: 'Sync started' });
  runSync()
    .then(async (result) => {
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
          if (!currentRunId) return;
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
      if (currentRunId) {
        try { await changeLog.finishRun(currentRunId, { counts: lastCounts, error: null }); } catch {}
      }
      logs.unshift({ time: Date.now(), level: 'success', message: 'Sync completed successfully', meta: { counts: lastCounts } });
    })
    .catch(async (err) => {
      logger.error({ status: err.response?.status, message: err.message, data: err.response?.data }, 'Sync failed via dashboard');
      isRunning = false;
      lastError = err?.response?.data?.Message || err?.message || 'Sync failed';
      progress.fail(lastError);
      if (currentRunId) {
        try { await changeLog.finishRun(currentRunId, { error: lastError }); } catch {}
      }
      logs.unshift({ time: Date.now(), level: 'error', message: 'Sync failed', meta: { error: err?.message } });
    });
  res.redirect('/');
});

// History pages
app.get('/history', (_req, res) => {
  Promise.resolve(changeLog.listRuns())
    .then((runs) => {
      res.render('layout', { title: 'Sync History', content: 'pages/history', runs, isRunning, lastRun, counts: lastCounts, lastError });
    })
    .catch(() => res.status(500).send('Failed to load history'));
});
app.get('/history/:id', (req, res) => {
  Promise.resolve(changeLog.getRun(req.params.id))
    .then((run) => {
      if (!run) return res.status(404).send('Run not found');
      res.render('layout', { title: 'Run Details', content: 'pages/run', run, isRunning, lastRun, counts: lastCounts, lastError });
    })
    .catch(() => res.status(500).send('Failed to load run'));
});
// Revert and manual pull endpoints (no DB writes yet)
app.post('/history/:id/revert/:changeId', (req, res) => {
  const note = req.body?.note || '';
  Promise.resolve(changeLog.revertChange(req.params.id, req.params.changeId, note))
    .then((out) => {
      if (!out.ok) return res.status(400).send(out.message || 'Revert failed');
      res.redirect(`/history/${req.params.id}`);
    })
    .catch(() => res.status(500).send('Revert failed'));
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
