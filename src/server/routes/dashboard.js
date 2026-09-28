import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../util/logger.js';
import progress from '../progress.js';
import { isMongoEnabled } from '../../db/mongo.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  isRunning, lastRun, lastCounts, lastError, logs, dedupRunning, lastDedupResult,
  getEffectiveCronConfig, currentCronHealth, computeNextCronRunAtMs, triggerSync, runDashboardDedup,
} from '../syncController.js';

const syncLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false, message: 'Too many requests, please slow down.' });
const dedupLimiter = rateLimit({ windowMs: 300_000, max: 3, standardHeaders: true, legacyHeaders: false, message: 'Too many dedup requests, please slow down.' });

const router = express.Router();

router.get('/health', (_req, res) => {
  const cronHealth = currentCronHealth();
  res.json({ status: 'ok', isRunning, lastRun, cron: cronHealth });
});

router.get('/cron/health', (_req, res) => {
  const cronHealth = currentCronHealth();

  const isOk = cronHealth.status === 'ok' || cronHealth.status === 'disabled';
  res.status(isOk ? 200 : 503).json(cronHealth);
});
// Simple logs stub (extend later) — admin only: log lines can contain
// supplier/customer details from sync runs.
router.get('/logs', requireAdmin, (_req, res) => {
  res.render('layout', { title: 'Logs', content: 'pages/logs', logs, isRunning, lastRun, counts: lastCounts, lastError });
});
router.get('/logs.json', requireAdmin, (_req, res) => {
  res.json({ logs });
});
// Runtime status for dashboard polling
router.get('/status', (_req, res) => {
  res.json(progress.getState());
});

router.get('/', (req, res) => {
  const eff = getEffectiveCronConfig();
  const cronHealth = currentCronHealth(eff);
  const cronNextRunAt = computeNextCronRunAtMs(eff);

  // Show dedup result banner when redirected back from POST /dedup
  const dedupResult = req.query?.dedup === 'done' ? lastDedupResult : null;

  res.render('layout', {
    title: 'HCS Sync Dashboard',
    content: 'pages/index',
    isRunning,
    lastRun,
    counts: lastCounts,
    lastError,
    cronHealth,
    cronNextRunAt,
    dedupResult,
  });
});

router.post('/run', requireAdmin, syncLimiter, async (_req, res) => {
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

router.post('/dedup', requireAdmin, dedupLimiter, async (_req, res) => {
  if (!isMongoEnabled()) {
    return res.status(400).send('MongoDB is not configured.');
  }
  if (isRunning) {
    return res.status(409).send('Cannot run dedup while sync is in progress.');
  }
  if (dedupRunning) {
    return res.status(409).send('Dedup is already running.');
  }

  try {
    await runDashboardDedup();
    return res.redirect('/?dedup=done');
  } catch (err) {
    logger.error({ err }, 'Dedup failed');
    return res.status(500).send(err?.message || 'Dedup failed');
  }
});

router.get('/dedup/status', requireAdmin, (_req, res) => {
  res.json({ running: dedupRunning, lastResult: lastDedupResult });
});

export default router;
