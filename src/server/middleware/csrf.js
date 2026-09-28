import CsrfTokens from 'csrf';
import { COOKIE_SECURE } from './auth.js';

// CSRF protection (double-submit style) using a per-client secret stored in an HttpOnly cookie.
// This avoids server-side sessions while still protecting POST routes.
const csrfTokens = new CsrfTokens();
export const csrfCookieName = 'hcs_sync_csrf_secret';

/** Mint the per-client secret if missing and expose a token to templates. */
export function csrfToken(req, res, next) {
  // Ensure a stable secret per client.
  let secret = req.cookies?.[csrfCookieName];
  if (!secret) {
    secret = csrfTokens.secretSync();
    res.cookie(csrfCookieName, secret, {
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIE_SECURE,
      path: '/',
    });
  }

  try {
    res.locals.csrfToken = csrfTokens.create(secret);
  } catch {
    res.locals.csrfToken = null;
  }

  next();
}

/** Reject state-changing requests without a valid token. */
export function csrfProtect(req, res, next) {
  const method = (req.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  // Machine-to-machine API endpoints are protected by X-Sync-Api-Key instead of CSRF.
  if (req.path === '/api/pull') return next();

  const secret = req.cookies?.[csrfCookieName];
  const headerToken = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'] || req.headers['csrf-token'] || req.headers['xsrf-token'];
  const token = (req.body && req.body._csrf) || headerToken;

  if (!secret || !token || typeof token !== 'string') {
    return res.status(403).send('Missing CSRF token');
  }

  const ok = csrfTokens.verify(secret, token);
  if (!ok) return res.status(403).send('Invalid CSRF token');
  return next();
}
