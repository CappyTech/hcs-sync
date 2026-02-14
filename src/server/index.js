import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import CsrfTokens from 'csrf';
import logger from '../util/logger.js';
import runSync from '../sync/run.js';
import progress from './progress.js';
import runStore from './runStore.js';
import { getMongoDb, isMongoEnabled } from '../db/mongo.js';
import config from '../config.js';
import { getCronHealth, startCron, stopCron } from './cron.js';
import settingsStore from './settingsStore.js';
import { isMongooseEnabled } from '../db/mongoose.js';
import cron from 'node-cron';
import cronParser from 'cron-parser';
import cronstrue from 'cronstrue';

const app = express();
const port = Number(process.env.PORT || 3000);

const __serverFilename = fileURLToPath(import.meta.url);
const __serverDirname = path.dirname(__serverFilename);

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    try {
      const hasPkg = fs.existsSync(path.join(dir, 'package.json'));
      const hasGit = fs.existsSync(path.join(dir, '.git'));
      if (hasPkg || hasGit) return dir;
    } catch {
      // ignore
    }

    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }

  return startDir;
}

const REPO_ROOT = findRepoRoot(__serverDirname);

const APP_BUILD = (() => {
  const envCommit = (
    process.env.GIT_COMMIT ||
    process.env.GIT_SHA ||
    process.env.SOURCE_VERSION ||
    process.env.COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA
  );
  const envBranch = process.env.GIT_BRANCH || process.env.VERCEL_GIT_COMMIT_REF;

  let version = null;
  try {
    const envPkgVersion = typeof process.env.npm_package_version === 'string' ? process.env.npm_package_version.trim() : '';
    if (envPkgVersion) {
      version = envPkgVersion;
    } else {
      const pkgPath = path.join(REPO_ROOT, 'package.json');
      const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(pkgRaw);
      version = String(pkg?.version || '').trim() || null;
    }
  } catch {
  }

  let commit = typeof envCommit === 'string' ? envCommit.trim() : '';
  if (commit) commit = commit.slice(0, 12);
  if (!commit) {
    try {
      commit = String(execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }))
        .trim()
        .slice(0, 12);
    } catch {
      commit = '';
    }
  }

  let branch = typeof envBranch === 'string' ? envBranch.trim() : '';
  if (!branch) {
    try {
      branch = String(execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    } catch {
      branch = '';
    }
  }
  if (branch === 'HEAD') branch = '';

  return {
    version,
    commit: commit || null,
    branch: branch || null,
  };
})();

// Behind reverse proxies (Caddy/FRP): trust loopback and private IPv4 ranges
// so req.secure works correctly.
app.set('trust proxy', ['loopback', '127.0.0.1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);

let lastRun = null;
let isRunning = false;
let lastCounts = null;
let lastError = null;
const logs = [];
let currentRunId = null;

let cachedSettings = null;
let cronConfig = {
  enabled: config.cronEnabled,
  schedule: config.cronSchedule,
  timezone: config.cronTimezone,
  healthStaleMs: config.cronHealthStaleMs,
  source: 'env',
};

async function loadSettingsIntoCache() {
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

function getEffectiveCronConfig() {
  return { ...cronConfig };
}

function applyCronConfig() {
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

function computeNextCronRunAtMs({ enabled, schedule, timezone }) {
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

function isLikelyRunningInDocker() {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

function warnIfMongoPointsToLocalhost() {
  if (!isMongooseEnabled()) return;

  const host = String(config.mongoHost || '').trim().toLowerCase();
  const uri = String(config.mongoUri || '').trim();

  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const isLocalUri =
    !!uri &&
    /mongodb(\+srv)?:\/\/(?:[^@/]+@)?(localhost|127\.0\.0\.1|\[::1\]|::1)(?::\d+)?\//i.test(uri);

  if ((isLocalHost || isLocalUri) && isLikelyRunningInDocker()) {
    logger.warn(
      {
        mongoHost: config.mongoHost || null,
        mongoUriProvided: Boolean(config.mongoUri),
      },
      'MongoDB is configured to connect to localhost from inside Docker; this usually fails. Use a container hostname (e.g. hcs-mongo) on a shared network, or set MONGO_URI.'
    );
  }
}

// Make cron config available to templates.
app.use((req, res, next) => {
  res.locals.cronConfig = getEffectiveCronConfig();
  res.locals.query = req.query || {};
  res.locals.appBuild = APP_BUILD;
  res.locals.appVersion = APP_BUILD?.version || null;
  res.locals.appCommit = APP_BUILD?.commit || null;
  res.locals.appBranch = APP_BUILD?.branch || null;

  res.locals.formatCronHuman = (schedule) => {
    const expr = String(schedule || '').trim();
    if (!expr) return '—';
    try {
      const toString = typeof cronstrue?.toString === 'function' ? cronstrue.toString : null;
      if (!toString) return expr;
      return toString(expr, {
        use24HourTimeFormat: true,
        verbose: true,
      });
    } catch {
      return expr;
    }
  };

  const dtf = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const df = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  res.locals.formatDateTimeUK = (value) => {
    if (value === null || typeof value === 'undefined') return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return dtf.format(date);
  };

  res.locals.formatDateUK = (value) => {
    if (value === null || typeof value === 'undefined') return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return df.format(date);
  };

  next();
});

app.use(helmet({
  // Default Helmet policy is fine here; HSTS is assumed to be handled at the edge (Caddy/Cloudflare).
  contentSecurityPolicy: false,
}));

app.use(cookieParser());

function makeRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

// Log every request/response (GET/POST/etc) including dashboard routes like /pull.
// Keep logs low-risk: do not log headers/cookies/body.
app.use((req, res, next) => {
  const startNs = process.hrtime.bigint();
  const requestId = String(req.headers['x-request-id'] || '').trim() || makeRequestId();

  req.requestId = requestId;
  try {
    res.setHeader('x-request-id', requestId);
  } catch {
    // ignore
  }

  const logFinished = () => {
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    const statusCode = Number(res.statusCode || 0);
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';

    const ip = req.ip || req.socket?.remoteAddress || null;
    const ua = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 256) : null;

    const meta = {
      http: {
        id: requestId,
        method: String(req.method || '').toUpperCase(),
        path: req.originalUrl || req.url || '/',
        statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
      },
      client: {
        ip,
        ua,
      },
    };

    // Attach a small, non-sensitive user hint when present.
    if (req.user && typeof req.user === 'object') {
      const userId = req.user.sub || req.user.id || req.user.userId || req.user.email || null;
      if (userId) meta.user = { id: String(userId) };
    }

    logger[level](meta, 'HTTP request');
  };

  res.on('finish', logFinished);

  // If the client disconnects before the response finishes, `finish` may not fire.
  res.on('close', () => {
    if (res.writableEnded) return;
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    logger.warn(
      {
        http: {
          id: requestId,
          method: String(req.method || '').toUpperCase(),
          path: req.originalUrl || req.url || '/',
          statusCode: Number(res.statusCode || 0),
          durationMs: Math.round(durationMs * 10) / 10,
          aborted: true,
        },
      },
      'HTTP request aborted'
    );
  });

  next();
});

function getFullUrl(req) {
  const proto = req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : req.protocol;
  const host = req.headers['x-forwarded-host'] ? String(req.headers['x-forwarded-host']).split(',')[0].trim() : req.get('host');
  return `${proto}://${host}${req.originalUrl || req.url || '/'}`;
}

function buildSsoRedirect(req) {
  const base = String(process.env.HCS_APP_BASE_URL || 'https://app.heroncs.co.uk').replace(/\/$/, '');
  const returnTo = getFullUrl(req);
  return `${base}/sso/hcs-sync?return_to=${encodeURIComponent(returnTo)}`;
}

function verifySsoCookie(req) {
  const token = req.cookies?.hcs_sso;
  if (!token) return null;
  const secret = process.env.HCS_SSO_JWT_SECRET;
  if (!secret) return null;

  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: 'hcs-sync',
      issuer: 'hcs-app',
    });
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

// Auth guard: require valid SSO cookie for all non-health endpoints.
app.use((req, res, next) => {
  const p = req.path || '';
  if (p === '/health' || p === '/cron/health') return next();
  if (p === '/favicon.ico' || p === '/robots.txt') return next();
  if (p === '/static' || p.startsWith('/static/')) return next();

  const user = verifySsoCookie(req);
  if (!user) {
    return res.redirect(buildSsoRedirect(req));
  }

  req.user = user;
  res.locals.user = user;
  next();
});

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

  const recordRunLog = (level, message, meta) => {
    logs.unshift({ time: Date.now(), level, message, meta: { ...(meta || {}), runId } });
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

      recordRunLog('success', 'Sync completed successfully', { counts: lastCounts });
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
      throw err;
    });

  return { started: true, reason: null, runId, promise };
}

// EJS setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CSRF protection (double-submit style) using a per-client secret stored in an HttpOnly cookie.
// This avoids server-side sessions while still protecting POST routes.
const csrfTokens = new CsrfTokens();
const csrfCookieName = 'hcs_sync_csrf_secret';
const csrfCookieSecure = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';

app.use((req, res, next) => {
  // Ensure a stable secret per client.
  let secret = req.cookies?.[csrfCookieName];
  if (!secret) {
    secret = csrfTokens.secretSync();
    res.cookie(csrfCookieName, secret, {
      httpOnly: true,
      sameSite: 'lax',
      secure: csrfCookieSecure,
      path: '/',
    });
  }

  try {
    res.locals.csrfToken = csrfTokens.create(secret);
  } catch {
    res.locals.csrfToken = null;
  }

  next();
});

app.use((req, res, next) => {
  const method = (req.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  const secret = req.cookies?.[csrfCookieName];
  const headerToken = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'] || req.headers['csrf-token'] || req.headers['xsrf-token'];
  const token = (req.body && req.body._csrf) || headerToken;

  if (!secret || !token || typeof token !== 'string') {
    return res.status(403).send('Missing CSRF token');
  }

  const ok = csrfTokens.verify(secret, token);
  if (!ok) return res.status(403).send('Invalid CSRF token');
  return next();
});
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
  const eff = getEffectiveCronConfig();
  const cronHealth = getCronHealth({
    enabled: eff.enabled,
    schedule: eff.schedule,
    timezone: eff.timezone,
    staleMs: eff.healthStaleMs,
  });
  res.json({ status: 'ok', isRunning, lastRun, cron: cronHealth });
});

app.get('/cron/health', (_req, res) => {
  const eff = getEffectiveCronConfig();
  const cronHealth = getCronHealth({
    enabled: eff.enabled,
    schedule: eff.schedule,
    timezone: eff.timezone,
    staleMs: eff.healthStaleMs,
  });

  const isOk = cronHealth.status === 'ok' || cronHealth.status === 'disabled';
  res.status(isOk ? 200 : 503).json(cronHealth);
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
  const eff = getEffectiveCronConfig();
  const cronHealth = getCronHealth({
    enabled: eff.enabled,
    schedule: eff.schedule,
    timezone: eff.timezone,
    staleMs: eff.healthStaleMs,
  });
  const cronNextRunAt = computeNextCronRunAtMs(eff);

  res.render('layout', {
    title: 'HCS Sync',
    content: 'pages/index',
    isRunning,
    lastRun,
    counts: lastCounts,
    lastError,
    cronHealth,
    cronNextRunAt,
  });
});

app.get('/settings', async (req, res) => {
  const eff = getEffectiveCronConfig();
  const cronHealth = getCronHealth({
    enabled: eff.enabled,
    schedule: eff.schedule,
    timezone: eff.timezone,
    staleMs: eff.healthStaleMs,
  });
  res.render('layout', {
    title: 'Settings',
    content: 'pages/settings',
    isRunning,
    lastRun,
    counts: lastCounts,
    lastError,
    cronConfig: eff,
    cronHealth,
    settingsEditable: isMongooseEnabled(),
    query: req.query || {},
  });
});

app.post('/settings/cron', async (req, res) => {
  if (!isMongooseEnabled()) {
    return res.redirect('/settings?error=' + encodeURIComponent('MongoDB is not configured; cannot save settings.'));
  }

  const enabled = req.body?.enabled === '1' || req.body?.enabled === 'on' || req.body?.enabled === 'true';
  const schedule = String(req.body?.schedule || '').trim() || '0 * * * *';
  const timezone = String(req.body?.timezone || '').trim();
  const healthStaleMs = Number(req.body?.healthStaleMs || 0);

  if (!cron.validate(schedule)) {
    return res.redirect('/settings?error=' + encodeURIComponent(`Invalid schedule: ${schedule}`));
  }
  if (healthStaleMs < 0 || Number.isNaN(healthStaleMs)) {
    return res.redirect('/settings?error=' + encodeURIComponent('Health stale window must be a non-negative number.'));
  }

  try {
    await settingsStore.upsertCronSettings({ enabled, schedule, timezone, healthStaleMs });
    await loadSettingsIntoCache();
    applyCronConfig();
    return res.redirect('/settings?ok=1');
  } catch (err) {
    return res.redirect('/settings?error=' + encodeURIComponent(err?.message || 'Failed to save settings'));
  }
});

app.post('/run', async (_req, res) => {
  if (getEffectiveCronConfig().enabled) {
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

// Final error handler (logs uncaught route errors)
app.use((err, req, res, next) => {
  logger.error(
    {
      http: {
        id: req.requestId || null,
        method: String(req.method || '').toUpperCase(),
        path: req.originalUrl || req.url || '/',
      },
      err: {
        message: err?.message || String(err),
        name: err?.name || undefined,
        stack: err?.stack || undefined,
      },
    },
    'Unhandled route error'
  );

  if (res.headersSent) return next(err);
  return res.status(500).send('Internal Server Error');
});


app.listen(port, () => {
  logger.info({ port }, 'Server listening');
  warnIfMongoPointsToLocalhost();

  // Load settings and apply cron config after the server is up.
  (async () => {
    try {
      await loadSettingsIntoCache();
      applyCronConfig();
      logger.info({ cron: getEffectiveCronConfig() }, 'Effective cron config loaded');
    } catch (err) {
      logger.error({ err: { message: err?.message } }, 'Failed to load settings / start cron scheduler');
    }
  })();
});
