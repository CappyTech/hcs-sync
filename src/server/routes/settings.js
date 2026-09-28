import express from 'express';
import cron from 'node-cron';
import settingsStore from '../settingsStore.js';
import { isMongooseEnabled } from '../../db/mongoose.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  isRunning, lastRun, lastCounts, lastError,
  getEffectiveCronConfig, currentCronHealth, loadSettingsIntoCache, applyCronConfig,
} from '../syncController.js';

const router = express.Router();

router.get('/settings', requireAdmin, async (req, res) => {
  const eff = getEffectiveCronConfig();
  const cronHealth = currentCronHealth(eff);
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

router.post('/settings/cron', requireAdmin, async (req, res) => {
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

export default router;
