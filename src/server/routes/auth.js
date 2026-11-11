import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import logger from '../../util/logger.js';
import {
  IS_PROD, SKIP_TURNSTILE, SSO_JWT_SECRET, SSO_COOKIE_NAME, ssoCookieOptions, sanitiseNext, verifySsoCookie,
  appBaseUrl, appPublicUrl, loginMode, ssoCookieDomain,
} from '../middleware/auth.js';

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false, message: 'Too many login attempts, please try again later.' });

const router = express.Router();

// Marks the trip back from hcs-app's handoff, so a cookie that didn't take
// shows an error instead of bouncing between the two apps forever.
const SSO_RETURN_PARAM = 'sso_return';

// Where hcs-app should send the browser back to: our own /login, carrying the
// original next path and the return marker. Uses HCS_SYNC_PUBLIC_URL when set,
// otherwise the request's own origin (trust proxy is on, so behind Caddy this
// is the public https origin).
function handoffUrl(req, next) {
  const ourBase = String(process.env.HCS_SYNC_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const back = `${ourBase}/login?next=${encodeURIComponent(next)}&${SSO_RETURN_PARAM}=1`;
  return `${appPublicUrl()}/sso/hcs-sync?return_to=${encodeURIComponent(back)}`;
}

function renderStatus(res, status, locals) {
  return res.status(status).render('layout', { title: locals.heading, content: 'signin-status', isAuthenticated: false, appBase: appPublicUrl(), ...locals });
}

// ── Login routes (unauthenticated) ────────────────────────────────────────────

router.get('/login', (req, res) => {
  // If already authenticated, redirect to next or dashboard.
  const user = verifySsoCookie(req);
  if (user) {
    const safeNext = sanitiseNext(req.query.next);
    return res.redirect(safeNext);
  }
  const next = sanitiseNext(req.query.next);

  if (loginMode() === 'redirect') {
    if (req.query[SSO_RETURN_PARAM]) {
      // hcs-app said yes and sent us back, but there's no cookie we can verify:
      // it was set on a domain we don't receive, or HCS_SSO_JWT_SECRET differs.
      logger.warn('[login] returned from hcs-app handoff without a valid %s cookie (check HCS_SSO_COOKIE_DOMAIN and HCS_SSO_JWT_SECRET on both apps)', SSO_COOKIE_NAME);
      return renderStatus(res, 500, {
        heading: 'Sign-in did not complete',
        icon: 'bi-exclamation-triangle',
        message: 'You signed in to HCS, but the sync dashboard could not read the sign-in. This is a configuration problem rather than your password; please let an administrator know.',
        retryHref: `/login?next=${encodeURIComponent(next)}`,
      });
    }
    return res.redirect(handoffUrl(req, next));
  }

  const error = typeof req.query.error === 'string' ? req.query.error : null;
  const skipTurnstile = SKIP_TURNSTILE;
  const siteKey = String(process.env.TURNSTILE_SITE_KEY || '');
  res.render('layout', { title: 'Log In', content: 'login', next, error, skipTurnstile, siteKey, isAuthenticated: false });
});

router.post('/login', loginLimiter, async (req, res) => {
  const next = sanitiseNext(req.body?.next);
  // In redirect mode passwords are typed into hcs-app only; don't accept them here.
  if (loginMode() === 'redirect') {
    return res.redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const totp = String(req.body?.totp || '').trim();
  const skipTurnstile = SKIP_TURNSTILE;

  // Turnstile verification
  if (!skipTurnstile) {
    const tsToken = String(req.body?.['cf-turnstile-response'] || '');
    const tsSecret = String(process.env.TURNSTILE_SECRET_KEY || '');
    if (!tsToken || !tsSecret) {
      return res.redirect(`/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent('CAPTCHA token missing.')}`);
    }
    try {
      const ip = req.headers['x-forwarded-for']
        ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
        : req.socket?.remoteAddress || '';
      const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: tsSecret, response: tsToken, remoteip: ip }),
        signal: AbortSignal.timeout(10_000),
      });
      const tsData = await tsRes.json();
      if (!tsData.success) {
        logger.info('[login] CAPTCHA verification failed');
        return res.redirect(`/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent('CAPTCHA verification failed.')}`);
      }
    } catch (err) {
      logger.error('[login] Turnstile check error: %s', err.message);
      return res.redirect(`/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent('CAPTCHA check failed. Please try again.')}`);
    }
  } else {
    logger.info('[login] CAPTCHA bypass active (%s)', process.env.SKIP_TURNSTILE === 'true' ? 'SKIP_TURNSTILE=true' : `NODE_ENV=${process.env.NODE_ENV || 'undefined'}`);
  }

  if (!username || !password) {
    return res.redirect(`/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent('Username and password are required.')}`);
  }

  const appBase = appBaseUrl();
  const apiKey = String(process.env.HCS_SYNC_API_KEY || '');
  if (!apiKey) {
    if (!IS_PROD) {
      // Dev bypass: no hcs-app to validate against — sign a local admin session
      // with the ephemeral secret. Any username/password is accepted.
      logger.warn('[login] DEV login bypass — HCS_SYNC_API_KEY not set and NODE_ENV != production; issuing local admin session for "%s"', username);
      const devToken = jwt.sign(
        { username, name: username, role: 'admin', dev: true },
        SSO_JWT_SECRET,
        { algorithm: 'HS256', audience: 'hcs-sync', issuer: 'hcs-app', expiresIn: '8h' },
      );
      res.cookie(SSO_COOKIE_NAME, devToken, ssoCookieOptions({
        secure: false, // local dev runs on plain http
        maxAge: 8 * 60 * 60 * 1000,
      }));
      return res.redirect(next);
    }
    logger.error('[login] HCS_SYNC_API_KEY is not set — cannot validate credentials');
    return res.redirect(`/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent('Login service is not configured.')}`);
  }

  let tokenData;
  try {
    const response = await fetch(`${appBase}/api/sso/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Api-Key': apiKey,
      },
      body: JSON.stringify({ username, password, ...(totp ? { totp } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });

    // 401/403 carry a structured error from hcs-app (invalid credentials,
    // account locked, 2FA required/invalid, role not permitted).
    if (response.status === 401 || response.status === 403) {
      let message = 'Invalid username or password.';
      try {
        const body = await response.json();
        if (body && typeof body.error === 'string' && body.error) message = body.error;
      } catch {
        // keep default message
      }
      return res.redirect(`/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent(message)}`);
    }
    if (!response.ok) {
      logger.warn('[login] Unexpected status %d from hcs-app token endpoint', response.status);
      return res.redirect(`/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent('Login service unavailable. Please try again.')}`);
    }

    tokenData = await response.json();
  } catch (err) {
    logger.error('[login] Failed to reach hcs-app token endpoint: %s', err.message);
    return res.redirect(`/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent('Could not reach login service. Please try again.')}`);
  }

  const ttlSec = Number(tokenData.expiresIn || 60 * 60 * 8);
  res.cookie(SSO_COOKIE_NAME, tokenData.token, ssoCookieOptions({ maxAge: ttlSec * 1000 }));

  return res.redirect(next);
});

router.get('/logout', (req, res) => {
  // The form login sets a host-only cookie; hcs-app's handoff sets it on the
  // shared parent domain. A cookie is only cleared with the domain it was set
  // with, so clear both.
  res.clearCookie(SSO_COOKIE_NAME, ssoCookieOptions());
  const domain = ssoCookieDomain(req);
  if (domain) res.clearCookie(SSO_COOKIE_NAME, ssoCookieOptions({ domain }));

  // Not a redirect to /login: in redirect mode that would go straight back
  // through hcs-app and, with its session still open, sign the user in again.
  return renderStatus(res, 200, {
    heading: 'Signed out',
    icon: 'bi-box-arrow-right',
    message: loginMode() === 'redirect'
      ? 'You are signed out of the sync dashboard. You are still signed in to HCS; sign out there too if you are on a shared computer.'
      : 'You are signed out of the sync dashboard.',
    retryHref: '/login',
    retryLabel: 'Sign in again',
    showAppLogout: loginMode() === 'redirect',
  });
});

export default router;
