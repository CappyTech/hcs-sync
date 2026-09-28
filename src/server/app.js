import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import logger from '../util/logger.js';
import { templateLocals, cspNonce } from './middleware/locals.js';
import { requestLog } from './middleware/requestLog.js';
import { ssoGuard } from './middleware/auth.js';
import { csrfToken, csrfProtect } from './middleware/csrf.js';
import dashboardRoutes from './routes/dashboard.js';
import settingsRoutes from './routes/settings.js';
import authRoutes from './routes/auth.js';
import historyRoutes from './routes/history.js';
import debugRoutes from './routes/debug.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the Express app: middleware in the order it must run, then routes.
 * Does not listen — see index.js.
 *
 * The order is load-bearing: templates need locals and the CSP nonce before
 * anything renders; the SSO guard runs before body parsing; static assets are
 * served before the CSRF middleware (see below); CSRF verification precedes
 * every route.
 */
export function createApp() {
  const app = express();

  // Behind reverse proxies (Caddy/FRP): trust loopback and Docker bridge range only.
  // Avoid trusting the full private-IP space to prevent X-Forwarded-For spoofing
  // from arbitrary hosts on 10.x / 192.168.x networks.
  app.set('trust proxy', ['loopback', '172.16.0.0/12']);

  app.use(templateLocals);
  app.use(cspNonce);
  app.use(helmet({
    // HSTS is handled at the edge (Caddy); CSP is enforced here.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`, 'https://challenges.cloudflare.com'],
        styleSrc: ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`, 'https://cdn.jsdelivr.net'],
        imgSrc: ["'self'", 'data:', 'https://app.heroncs.co.uk'],
        fontSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        manifestSrc: ["'self'"],
        frameAncestors: ["'none'"],
        frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cookieParser());
  app.use(requestLog);
  app.use(ssoGuard);

  // EJS setup
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views/tailwindcss'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Static assets are mounted ahead of the CSRF middleware on purpose. The secret
  // cookie is minted by any request that arrives without one, and a browser fetches
  // `<link rel="manifest">` *without* credentials unless it is marked
  // crossorigin="use-credentials". So loading a page minted secret A into the form,
  // then the manifest fetch that followed minted secret B over the top of it, and the
  // POST failed with "Invalid CSRF token". Only responses that can carry a token
  // should mint one.
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

  app.use(csrfToken);
  app.use(csrfProtect);

  app.use(dashboardRoutes);
  app.use(settingsRoutes);
  app.use(authRoutes);
  app.use(historyRoutes);
  app.use(debugRoutes);

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

  return app;
}
