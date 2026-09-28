import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../util/logger.js';
import { pullSingleEntity, debugEntity, ENTITY_CONFIG } from '../../sync/pull.js';
import { SHAPE_ENDPOINTS, captureShape } from '../../sync/shapes.js';
import { requireAdmin, requireSyncApiKey } from '../middleware/auth.js';
import { pushLog } from '../syncController.js';

// JSON body: /debug and /pull are fetch()ed by the debug page, which parses JSON responses.
const pullLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many pull/debug requests, please slow down.' } });

const router = express.Router();

router.get('/debug', requireAdmin, (req, res) => {
  const entityTypes = Object.entries(ENTITY_CONFIG).map(([type, cfg]) => ({
    type,
    label: type.charAt(0).toUpperCase() + type.slice(1),
    lookupField: cfg.lookupField,
  }));
  res.render('layout', {
    title: 'Debug',
    content: 'pages/debug',
    entityTypes,
    shapeEntities: Object.keys(SHAPE_ENDPOINTS),
    query: req.query || {},
  });
});
// Capture live KashFlow response shapes (Swagger is incomplete) — feeds
// hcs-app's apiDocsConfig.js. Same capture as `npm run shapes`.
router.post('/debug/shape', requireAdmin, pullLimiter, async (req, res) => {
  const entity = String(req.body?.entity || '').trim();
  if (!SHAPE_ENDPOINTS[entity]) {
    return res.status(400).json({ ok: false, message: `entity must be one of: ${Object.keys(SHAPE_ENDPOINTS).join(', ')}` });
  }
  try {
    const result = await captureShape(entity);
    res.json({ ok: true, ...result });
  } catch (err) {
    // Surface which KashFlow call failed and what it said — a bare "Request
    // failed with status code 400" is useless for diagnosing an unverified
    // endpoint. axios errors carry the request config and the response body.
    const resp = err.response;
    const cfg = err.config || {};
    const where = resp ? ` (${(cfg.method || 'get').toUpperCase()} ${cfg.url} → ${resp.status})` : '';
    const body = resp?.data;
    const bodyStr = body
      ? (typeof body === 'object' ? JSON.stringify(body) : String(body)).slice(0, 400)
      : '';
    const message = `${err.message}${where}${bodyStr ? `: ${bodyStr}` : ''}`;
    logger.error({ entity, url: cfg.url, status: resp?.status, body }, 'Shape capture failed');
    res.status(500).json({ ok: false, message });
  }
});
router.post('/debug', requireAdmin, pullLimiter, async (req, res) => {
  const { entityType, entityId } = req.body || {};
  if (!entityType || entityId == null) {
    return res.status(400).json({ ok: false, message: 'entityType and entityId are required' });
  }
  try {
    const report = await debugEntity(entityType, entityId);
    res.json(report);
  } catch (err) {
    logger.error({ entityType, entityId, err: err.message }, 'Debug failed');
    res.status(500).json({ ok: false, message: err.message || 'Debug failed' });
  }
});
// Shared by the dashboard's "Pull & Sync" button and the machine API below.
function makePullHandler({ label, logMeta = {}, includeDebug = false }) {
  return async (req, res) => {
    const { entityType, entityId } = req.body || {};
    if (!entityType || entityId == null) {
      return res.status(400).json({ ok: false, message: 'entityType and entityId are required' });
    }
    pushLog({ time: Date.now(), level: 'info', message: `${label} pull started: ${entityType} ${entityId}`, meta: { entityType, entityId, ...logMeta } });
    try {
      const result = await pullSingleEntity(entityType, entityId);
      pushLog({ time: Date.now(), level: 'success', message: `${label} pull complete: ${entityType} ${entityId} — ${result.action}`, meta: { entityType, entityId, action: result.action, ...(includeDebug ? { debug: result.debug } : {}), ...logMeta } });
      res.json(result);
    } catch (err) {
      logger.error({ entityType, entityId, err: err.message }, `${label} pull failed`);
      pushLog({ time: Date.now(), level: 'error', message: `${label} pull failed: ${entityType} ${entityId} — ${err.message}`, meta: { entityType, entityId, error: err.message, ...logMeta } });
      res.status(500).json({ ok: false, message: err.message || 'Pull failed' });
    }
  };
}

router.post('/pull', requireAdmin, pullLimiter, makePullHandler({ label: 'Manual', includeDebug: true }));

// ── Machine-to-machine API ───────────────────────────────────────────────
// Key-authenticated equivalent of the dashboard's "Pull & Sync" button, so
// hcs-app can refresh a single entity from KashFlow on demand (e.g. after
// marking a project Complete via the KashFlow API).
router.post('/api/pull', requireSyncApiKey, pullLimiter, makePullHandler({ label: 'API', logMeta: { via: 'api' } }));

export default router;
