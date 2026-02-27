import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import CsrfTokens from 'csrf';

// ---------------------------------------------------------------------------
// Environment – must be set before any application modules are imported
// ---------------------------------------------------------------------------

process.env.PORT = '0';               // random port so tests don't clash
process.env.HCS_SSO_JWT_SECRET = 'test-server-jwt-secret';

// ---------------------------------------------------------------------------
// Mocks – hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));

vi.mock('../src/util/logger.js', () => {
  const noop = vi.fn();
  const child = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  return {
    default: { ...child, child: () => child },
  };
});

vi.mock('../src/sync/run.js', () => ({
  default: vi.fn().mockResolvedValue({ counts: { customers: 5 } }),
}));

vi.mock('../src/db/mongoose.js', () => ({
  isMongooseEnabled: vi.fn(() => false),
  connectMongoose: vi.fn(),
}));

vi.mock('../src/db/mongo.js', () => ({
  isMongoEnabled: vi.fn(() => false),
  getMongoDb: vi.fn(),
}));

vi.mock('../src/db/dedup.js', () => ({
  runDedup: vi.fn(),
}));

vi.mock('../src/server/cron.js', () => ({
  startCron: vi.fn(),
  stopCron:  vi.fn(),
  getCronHealth: vi.fn(() => ({ status: 'disabled' })),
  getCronState:  vi.fn(),
}));

vi.mock('../src/server/settingsStore.js', () => ({
  default: {
    getSettings:        vi.fn().mockResolvedValue(null),
    upsertCronSettings: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../src/server/runStore.js', () => ({
  default: {
    beginRun:     vi.fn().mockResolvedValue('test-run-id'),
    recordChange: vi.fn().mockResolvedValue('change-id'),
    recordLog:    vi.fn().mockResolvedValue('log-id'),
    finishRun:    vi.fn().mockResolvedValue(true),
    listRuns:     vi.fn().mockResolvedValue([]),
    getRun:       vi.fn().mockResolvedValue(null),
    revertChange: vi.fn().mockResolvedValue({ ok: true }),
    requestPull:  vi.fn((type, id) => ({
      ok: true,
      plan: {
        action: 'pull',
        entityType: type,
        entityId: id,
        note: 'Manual single-entity pull requested (no execution yet)',
      },
    })),
  },
}));

// ---------------------------------------------------------------------------
// App import (triggers app.listen on PORT=0)
// ---------------------------------------------------------------------------

let app;
let server;

beforeAll(async () => {
  const mod = await import('../src/server/index.js');
  app = mod.app;
  server = mod.server;
  // Give the listen callback a tick to settle
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(() => {
  // Close the server that was opened at import time
  if (server && typeof server.close === 'function') {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Auth & CSRF helpers
// ---------------------------------------------------------------------------

const JWT_SECRET = 'test-server-jwt-secret';

function makeSsoToken(payload = {}) {
  return jwt.sign(
    { sub: 'test-user', email: 'test@example.com', ...payload },
    JWT_SECRET,
    { audience: 'hcs-sync', issuer: 'hcs-app', expiresIn: '1h' }
  );
}

const csrfLib = new CsrfTokens();

function makeCsrf() {
  const secret = csrfLib.secretSync();
  const token  = csrfLib.create(secret);
  return { secret, token };
}

/** Return a cookie string with SSO + CSRF cookies. */
function authCookies(csrf) {
  const sso = makeSsoToken();
  return [`hcs_sso=${sso}`, `hcs_sync_csrf_secret=${csrf.secret}`].join('; ');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Express server routes', () => {

  // ── Public endpoints (no auth required) ────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with status JSON', async () => {
      const res = await supertest(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body).toHaveProperty('isRunning');
      expect(res.body).toHaveProperty('cron');
    });
  });

  describe('GET /cron/health', () => {
    it('returns 200 when cron is disabled', async () => {
      const res = await supertest(app).get('/cron/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('disabled');
    });
  });

  // ── Auth redirect behaviour ────────────────────────────────────────────

  describe('SSO auth guard', () => {
    it('redirects unauthenticated requests to SSO login', async () => {
      const res = await supertest(app).get('/');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/sso\/hcs-sync/);
    });

    it('allows access with a valid SSO cookie', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/status')
        .set('Cookie', `hcs_sso=${sso}`);
      expect(res.status).toBe(200);
    });
  });

  // ── Authenticated JSON endpoints ───────────────────────────────────────

  describe('GET /status', () => {
    it('returns progress state JSON', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/status')
        .set('Cookie', `hcs_sso=${sso}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('isRunning');
    });
  });

  describe('GET /logs.json', () => {
    it('returns logs array', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/logs.json')
        .set('Cookie', `hcs_sso=${sso}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('logs');
      expect(Array.isArray(res.body.logs)).toBe(true);
    });
  });

  // ── Authenticated HTML pages ───────────────────────────────────────────

  describe('GET / (dashboard)', () => {
    it('renders the dashboard page', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/')
        .set('Cookie', `hcs_sso=${sso}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('Synchronisation');
    });
  });

  describe('GET /history', () => {
    it('renders the history page', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/history')
        .set('Cookie', `hcs_sso=${sso}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('History');
    });
  });

  describe('GET /logs', () => {
    it('renders the logs page', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/logs')
        .set('Cookie', `hcs_sso=${sso}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('Log');
    });
  });

  describe('GET /settings', () => {
    it('renders the settings page', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/settings')
        .set('Cookie', `hcs_sso=${sso}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('Settings');
    });
  });

  // ── CSRF protection ────────────────────────────────────────────────────

  describe('CSRF enforcement', () => {
    it('blocks POST without CSRF token', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .post('/pull')
        .set('Cookie', `hcs_sso=${sso}`)
        .send({ entityType: 'customers', entityId: 'C001' });

      expect(res.status).toBe(403);
    });

    it('allows POST with valid CSRF token', async () => {
      const csrf = makeCsrf();
      const res = await supertest(app)
        .post('/pull')
        .set('Cookie', authCookies(csrf))
        .set('x-csrf-token', csrf.token)
        .send({ entityType: 'customers', entityId: 'C001' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ── POST /run ──────────────────────────────────────────────────────────

  describe('POST /run', () => {
    it('starts a sync and redirects to dashboard', async () => {
      const csrf = makeCsrf();
      const res = await supertest(app)
        .post('/run')
        .set('Cookie', authCookies(csrf))
        .set('x-csrf-token', csrf.token);

      // Should redirect to / after starting
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
    });
  });

  // ── POST /pull ─────────────────────────────────────────────────────────

  describe('POST /pull', () => {
    it('returns a plan JSON object', async () => {
      const csrf = makeCsrf();
      const res = await supertest(app)
        .post('/pull')
        .set('Cookie', authCookies(csrf))
        .set('x-csrf-token', csrf.token)
        .send({ entityType: 'invoices', entityId: 'INV-1' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.plan.entityType).toBe('invoices');
      expect(res.body.plan.entityId).toBe('INV-1');
    });
  });

  // ── GET /history/:id ───────────────────────────────────────────────────

  describe('GET /history/:id', () => {
    it('returns 404 when run is not found', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/history/nonexistent-id')
        .set('Cookie', `hcs_sso=${sso}`);

      expect(res.status).toBe(404);
    });
  });

  // ── POST /dedup ────────────────────────────────────────────────────────

  describe('POST /dedup', () => {
    it('returns 400 when MongoDB is not configured', async () => {
      const csrf = makeCsrf();
      const res = await supertest(app)
        .post('/dedup')
        .set('Cookie', authCookies(csrf))
        .set('x-csrf-token', csrf.token);

      expect(res.status).toBe(400);
      expect(res.text).toMatch(/MongoDB is not configured/);
    });
  });

  // ── GET /dedup/status ──────────────────────────────────────────────────

  describe('GET /dedup/status', () => {
    it('returns dedup status JSON', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/dedup/status')
        .set('Cookie', `hcs_sso=${sso}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('running');
      expect(res.body).toHaveProperty('lastResult');
    });
  });

  // ── POST /settings/cron ────────────────────────────────────────────────

  describe('POST /settings/cron', () => {
    it('redirects with error when Mongoose is disabled', async () => {
      // isMongooseEnabled is already mocked to return false
      const csrf = makeCsrf();
      const res = await supertest(app)
        .post('/settings/cron')
        .set('Cookie', authCookies(csrf))
        .set('x-csrf-token', csrf.token)
        .send({ enabled: '1', schedule: '0 * * * *' });

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=');
      expect(res.headers.location).toContain('MongoDB');
    });
  });

  // ── POST /history/:id/revert/:changeId ─────────────────────────────────

  describe('POST /history/:id/revert/:changeId', () => {
    it('redirects to run history on successful revert', async () => {
      const runStoreMock = (await import('../src/server/runStore.js')).default;
      runStoreMock.revertChange.mockResolvedValueOnce({ ok: true });

      const csrf = makeCsrf();
      const res = await supertest(app)
        .post('/history/run-1/revert/change-1')
        .set('Cookie', authCookies(csrf))
        .set('x-csrf-token', csrf.token)
        .send({ note: 'reverting' });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/history/run-1');
    });

    it('returns 400 when revert fails', async () => {
      const runStoreMock = (await import('../src/server/runStore.js')).default;
      runStoreMock.revertChange.mockResolvedValueOnce({ ok: false, message: 'Cannot revert' });

      const csrf = makeCsrf();
      const res = await supertest(app)
        .post('/history/run-1/revert/change-bad')
        .set('Cookie', authCookies(csrf))
        .set('x-csrf-token', csrf.token);

      expect(res.status).toBe(400);
    });
  });

  // ── GET /history/:id (existing run) ────────────────────────────────────

  describe('GET /history/:id (existing run)', () => {
    it('renders run details when run exists', async () => {
      const runStoreMock = (await import('../src/server/runStore.js')).default;
      runStoreMock.getRun.mockResolvedValueOnce({
        id: 'run-123',
        status: 'completed',
        startedAt: new Date().toISOString(),
        changes: [],
        logs: [],
        summary: {},
      });

      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/history/run-123')
        .set('Cookie', `hcs_sso=${sso}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('Run Details');
    });
  });

  // ── POST /dedup success (Mongo enabled) ────────────────────────────────

  describe('POST /dedup success', () => {
    it('runs dedup and redirects when Mongo is enabled', async () => {
      const { isMongoEnabled, getMongoDb } = await import('../src/db/mongo.js');
      const { runDedup } = await import('../src/db/dedup.js');

      isMongoEnabled.mockReturnValue(true);
      getMongoDb.mockResolvedValue({});
      runDedup.mockResolvedValue({ actions: [], duplicatesFound: 0 });

      const csrf = makeCsrf();
      const res = await supertest(app)
        .post('/dedup')
        .set('Cookie', authCookies(csrf))
        .set('x-csrf-token', csrf.token);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/?dedup=done');

      // Reset mocks
      isMongoEnabled.mockReturnValue(false);
    });
  });

  // ── Expired JWT ────────────────────────────────────────────────────────

  describe('expired/tampered JWT', () => {
    it('redirects when SSO token is expired', async () => {
      const expired = jwt.sign(
        { sub: 'test-user' },
        JWT_SECRET,
        { audience: 'hcs-sync', issuer: 'hcs-app', expiresIn: '-1s' }
      );
      const res = await supertest(app)
        .get('/')
        .set('Cookie', `hcs_sso=${expired}`);

      expect(res.status).toBe(302);
    });

    it('redirects when SSO token is signed with wrong secret', async () => {
      const bad = jwt.sign(
        { sub: 'test-user' },
        'wrong-secret',
        { audience: 'hcs-sync', issuer: 'hcs-app', expiresIn: '1h' }
      );
      const res = await supertest(app)
        .get('/')
        .set('Cookie', `hcs_sso=${bad}`);

      expect(res.status).toBe(302);
    });
  });
});
