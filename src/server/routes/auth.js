import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import logger from '../../util/logger.js';
import {
  IS_PROD, SKIP_TURNSTILE, SSO_JWT_SECRET, SSO_COOKIE_NAME, ssoCookieOptions, sanitiseNext, verifySsoCookie,
} from '../middleware/auth.js';

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false, message: 'Too many login attempts, please try again later.' });

const router = express.Router();

// ── Login routes (unauthenticated) ────────────────────────────────────────────

router.get('/login', (req, res) => {
  // If already authenticated, redirect to next or dashboard.
  const user = verifySsoCookie(req);
  if (user) {
    const safeNext = sanitiseNext(req.query.next);
    return res.redirect(safeNext);
  }
  const next = sanitiseNext(req.query.next);
  const error = typeof req.query.error === 'string' ? req.query.error : null;
  const skipTurnstile = SKIP_TURNSTILE;
  const siteKey = String(process.env.TURNSTILE_SITE_KEY || '');
  res.render('layout', { title: 'Log In', content: 'login', next, error, skipTurnstile, siteKey, isAuthenticated: false });
});

router.post('/login', loginLimiter, async (req, res) => {
  const next = sanitiseNext(req.body?.next);
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

  const appBase = String(process.env.HCS_APP_BASE_URL || 'https://app.heroncs.co.uk').replace(/\/$/, '');
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
  res.clearCookie(SSO_COOKIE_NAME, ssoCookieOptions());
  return res.redirect('/login');
});

export default router;
