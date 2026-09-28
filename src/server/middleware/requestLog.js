import crypto from 'crypto';
import logger from '../../util/logger.js';

function makeRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

// Log every request/response (GET/POST/etc) including dashboard routes like /pull.
// Keep logs low-risk: do not log headers/cookies/body.
// Skip noisy polling endpoints.
const QUIET_PATHS = new Set(['/status', '/health', '/cron/health']);
export function requestLog(req, res, next) {
  const startNs = process.hrtime.bigint();
  // Sanitise the inbound request ID to prevent log injection via crafted headers.
  const rawRequestId = String(req.headers['x-request-id'] || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  const requestId = rawRequestId || makeRequestId();

  req.requestId = requestId;
  try {
    res.setHeader('x-request-id', requestId);
  } catch {
    // ignore
  }

  if (QUIET_PATHS.has(req.path)) return next();

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
}
