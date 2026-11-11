import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import logger from '../../util/logger.js';

export const IS_PROD = process.env.NODE_ENV === 'production';

// Default to secure cookies; set COOKIE_SECURE=false only for local HTTP dev.
export const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'true').toLowerCase() !== 'false';
export const SSO_COOKIE_NAME = 'hcs_sso';

export function ssoCookieOptions(overrides = {}) {
  return { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/', ...overrides };
}

// Turnstile CAPTCHA is skipped outside production (local dev has no Cloudflare
// keys) or when explicitly bypassed via SKIP_TURNSTILE=true.
export const SKIP_TURNSTILE = process.env.SKIP_TURNSTILE === 'true' || !IS_PROD;

// SSO cookie signing secret. In production this MUST be the shared secret from
// hcs-app (HCS_SSO_JWT_SECRET). Outside production, fall back to an ephemeral
// per-process secret so the dev login bypass can sign its own sessions
// (sessions die with the process — fine for local dev).
export const SSO_JWT_SECRET = process.env.HCS_SSO_JWT_SECRET || (!IS_PROD ? crypto.randomBytes(32).toString('hex') : '');

const DEFAULT_APP_URL = 'https://app.heroncs.co.uk';

// Where hcs-sync calls hcs-app server to server (POST /api/sso/token). In a
// compose stack this is often the internal service address (http://hcs-app:5000).
export function appBaseUrl() {
  return String(process.env.HCS_APP_BASE_URL || DEFAULT_APP_URL).replace(/\/$/, '');
}

// Where the browser is sent: the login handoff, "sign out of HCS" links, and
// the parent domain the SSO cookie lives on. Must be hcs-app's public address,
// so an internal HCS_APP_BASE_URL (a bare service name with no dot in its
// host, like hcs-app) is not used here. HCS_APP_PUBLIC_URL sets it outright.
export function appPublicUrl() {
  const explicit = String(process.env.HCS_APP_PUBLIC_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const base = appBaseUrl();
  try {
    if (new URL(base).hostname.includes('.')) return base;
  } catch {
    // fall through to the default
  }
  return DEFAULT_APP_URL;
}

// How GET /login signs people in.
//   'redirect' (default) — hand off to hcs-app's GET /sso/hcs-sync, which signs
//     the user in there (or reuses their session) and sets the hcs_sso cookie
//     on the shared parent domain before sending them back.
//   'form' — hcs-sync's own form, which posts credentials to hcs-app's
//     POST /api/sso/token. Opt in with HCS_SYNC_LOGIN_MODE=form; also used
//     automatically for local dev without hcs-app (no HCS_SYNC_API_KEY outside
//     production), where the form's dev bypass signs a local session.
// Read per request so tests (and a restart with new env) can switch it.
export function loginMode() {
  const explicit = String(process.env.HCS_SYNC_LOGIN_MODE || '').trim().toLowerCase();
  if (explicit === 'form' || explicit === 'redirect') return explicit;
  if (!IS_PROD && !String(process.env.HCS_SYNC_API_KEY || '').trim()) return 'form';
  return 'redirect';
}

// The domain hcs-app puts the hcs_sso cookie on during the redirect handoff.
// hcs-app uses HCS_SSO_COOKIE_DOMAIN when set, otherwise the parent domain its
// host and ours share (app.example.co.uk + sync.example.co.uk → .example.co.uk).
// Logout has to clear the cookie on that same domain, or it survives.
export function ssoCookieDomain(req) {
  const explicit = String(process.env.HCS_SSO_COOKIE_DOMAIN || '').trim();
  if (explicit) return explicit;
  try {
    const appParts = new URL(appPublicUrl()).hostname.toLowerCase().split('.');
    const ourParts = String(req.hostname || '').toLowerCase().split('.');
    const common = [];
    while (appParts.length && ourParts.length && appParts[appParts.length - 1] === ourParts[ourParts.length - 1]) {
      common.unshift(appParts.pop());
      ourParts.pop();
    }
    // Same host on both sides: hcs-app sets a host-only cookie.
    if (!appParts.length && !ourParts.length) return '';
    return common.length >= 2 ? `.${common.join('.')}` : '';
  } catch {
    return '';
  }
}

export function buildLoginRedirect(req) {
  const returnTo = req.originalUrl || req.url || '/';
  if (returnTo === '/') return '/login';
  return `/login?next=${encodeURIComponent(returnTo)}`;
}

// Endpoints that answer with JSON. Redirecting one of these to the login *page*
// hands a fetch() caller a 200 full of HTML, which it cannot distinguish from a
// real response without parsing it — the dashboard poller followed exactly that
// redirect and hammered /login once a second for as long as the tab stayed open.
// They get a 401 instead, which a caller can act on.
const JSON_ENDPOINTS = new Set(['/status', '/logs.json', '/dedup/status']);

export function wantsJson(req) {
  if (JSON_ENDPOINTS.has(req.path)) return true;
  if (String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest') return true;
  // Only when JSON is preferred outright; browsers send */* on navigation.
  const accept = String(req.get('accept') || '');
  return accept.includes('application/json') && !accept.includes('text/html');
}

// Only allow relative paths for the post-login redirect to prevent open redirects.
export function sanitiseNext(raw) {
  const v = String(raw || '/').trim();
  if (v.startsWith('/') && !v.startsWith('//')) return v;
  return '/';
}

export function verifySsoCookie(req) {
  const token = req.cookies?.[SSO_COOKIE_NAME];
  if (!token) return null;
  const secret = SSO_JWT_SECRET;
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

// Auth guard: require valid SSO cookie for all non-health/login endpoints.
export function ssoGuard(req, res, next) {
  const p = req.path || '';
  if (p === '/health' || p === '/cron/health') return next();
  if (p === '/favicon.ico' || p === '/robots.txt') return next();
  if (p === '/static' || p.startsWith('/static/')) return next();
  if (p === '/login' || p === '/logout') return next();
  // Machine-to-machine API endpoints authenticate via X-Sync-Api-Key, not the SSO cookie.
  if (p === '/api/pull') return next();

  const user = verifySsoCookie(req);
  if (!user) {
    if (wantsJson(req)) {
      return res.status(401).json({ ok: false, error: 'Not authenticated', login: buildLoginRedirect(req) });
    }
    return res.redirect(buildLoginRedirect(req));
  }

  req.user = user;
  res.locals.user = user;
  res.locals.isAuthenticated = true;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).send('Forbidden: admin access required');
  }
  next();
}

// Timing-safe comparison for the shared machine-to-machine API key.
function safeKeyEqual(a, b) {
  const ha = crypto.createHmac('sha256', 'hcs-sync-api').update(String(a)).digest();
  const hb = crypto.createHmac('sha256', 'hcs-sync-api').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Auth guard for machine-to-machine API endpoints (e.g. hcs-app triggering a
// per-item re-sync). Uses the same shared secret as the SSO token handshake.
export function requireSyncApiKey(req, res, next) {
  const expected = String(process.env.HCS_SYNC_API_KEY || '').trim();
  if (!expected) {
    logger.error('[api] HCS_SYNC_API_KEY not configured — machine API is disabled');
    return res.status(503).json({ ok: false, message: 'API not configured' });
  }
  const provided = String(req.headers['x-sync-api-key'] || '');
  if (!provided || !safeKeyEqual(expected, provided)) {
    logger.warn('[api] machine API: invalid or missing X-Sync-Api-Key');
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  next();
}
