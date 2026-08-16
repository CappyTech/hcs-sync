import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import CsrfTokens from 'csrf';

// ---------------------------------------------------------------------------
// Environment – must be set before any application modules are imported
// ---------------------------------------------------------------------------

process.env.PORT = '0';               // random port so tests don't clash
process.env.HCS_SSO_JWT_SECRET = 'test-server-jwt-secret';
process.env.SKIP_TURNSTILE = 'true';  // disable CAPTCHA in tests
process.env.HCS_SYNC_API_KEY = 'test-sync-api-key'; // machine-to-machine API key

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

vi.mock('../src/sync/pull.js', () => ({
  pullSingleEntity: vi.fn().mockResolvedValue({
    ok: true,
    action: 'updated',
    entityType: 'invoice',
    entityId: 'INV-1',
    Id: 123,
    detailSyncedAt: new Date().toISOString(),
  }),
  debugEntity: vi.fn().mockResolvedValue({
    entityType: 'invoice',
    entityId: 'INV-1',
    mongo: null,
    kashflow: null,
    diagnosis: ['NOT_IN_MONGO: Document not found in MongoDB.'],
  }),
  ENTITY_CONFIG: {
    purchase: { lookupField: 'Number' },
    invoice:  { lookupField: 'Number' },
    quote:    { lookupField: 'Number' },
    customer: { lookupField: 'Code' },
    supplier: { lookupField: 'Code' },
    project:  { lookupField: 'Number' },
  },
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
let summariseRunChanges;
let formatRunChange;

beforeAll(async () => {
  const mod = await import('../src/server/index.js');
  app = mod.app;
  server = mod.server;
  summariseRunChanges = mod.summariseRunChanges;
  formatRunChange = mod.formatRunChange;
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
    { sub: 'test-user', email: 'test@example.com', role: 'admin', ...payload },
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
    it('redirects unauthenticated requests to /login', async () => {
      const res = await supertest(app).get('/');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^\/login/);
    });

    it('allows access with a valid SSO cookie', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/status')
        .set('Cookie', `hcs_sso=${sso}`);
      expect(res.status).toBe(200);
    });

    // A JSON endpoint must not be answered with a redirect to the login *page*:
    // fetch() follows redirects by default, so the caller receives a 200 full of
    // HTML that it cannot distinguish from a real response. The dashboard poller
    // did exactly that and re-requested /login once a second indefinitely.
    it('answers an unauthenticated /status with 401 JSON, not a redirect', async () => {
      const res = await supertest(app).get('/status');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false });
      expect(res.body.login).toMatch(/^\/login/);
    });

    it('answers an unauthenticated /logs.json with 401 JSON', async () => {
      const res = await supertest(app).get('/logs.json');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false });
    });

    it('answers an unauthenticated /dedup/status with 401 JSON', async () => {
      const res = await supertest(app).get('/dedup/status');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false });
    });

    it('answers 401 when the caller asks for JSON outright', async () => {
      const res = await supertest(app).get('/history').set('Accept', 'application/json');
      expect(res.status).toBe(401);
    });

    it('answers 401 for an XMLHttpRequest', async () => {
      const res = await supertest(app).get('/history').set('X-Requested-With', 'XMLHttpRequest');
      expect(res.status).toBe(401);
    });

    // Browsers send Accept: text/html,...,*/* when navigating. Those must keep
    // redirecting, or an expired session lands the user on raw JSON.
    it('still redirects a browser navigation to /login', async () => {
      const res = await supertest(app)
        .get('/history')
        .set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^\/login/);
    });
  });

  describe('GET /login', () => {
    it('renders the login page when unauthenticated', async () => {
      const res = await supertest(app).get('/login');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Log in');
    });

    it('redirects to next when already authenticated', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/login?next=/')
        .set('Cookie', `hcs_sso=${sso}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
    });

    // layout.ejs loads /static/app.js on every page, so the dashboard poller
    // runs on the login page too. There, /status answering 401 is the normal
    // resting state rather than an expired session, and the poller's 401
    // branch reloads — which re-runs app.js and reloads again, a loop no one
    // can type through. app.js therefore only starts polling when #status-badge
    // is present. That gate is only correct while the login page has no such
    // element; this pins it.
    it('does not carry the dashboard poller sentinel', async () => {
      const res = await supertest(app).get('/login');
      expect(res.status).toBe(200);
      expect(res.text).toContain('/static/app.js');
      expect(res.text).not.toContain('status-badge');
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
      expect(res.text).toContain('Dashboard');
    });

    // The other half of the app.js poller gate: it starts only when
    // #status-badge is on the page, so the dashboard must keep carrying it or
    // the status panel silently stops updating with nothing logged anywhere.
    it('carries the poller sentinel the dashboard updates', async () => {
      const sso = makeSsoToken();
      const res = await supertest(app)
        .get('/')
        .set('Cookie', `hcs_sso=${sso}`);

      expect(res.text).toContain('status-badge');
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

    it('returns 403 for authenticated non-admin users', async () => {
      const sso = makeSsoToken({ role: 'viewer' });
      const res = await supertest(app)
        .get('/history')
        .set('Cookie', `hcs_sso=${sso}`);

      expect(res.status).toBe(403);
      expect(res.text).toContain('admin access required');
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

    // The secret cookie is minted by any request that arrives without one, and a
    // browser fetches `<link rel="manifest">` without credentials. When /static
    // sat behind this middleware, loading /login minted secret A into the form and
    // the manifest fetch that followed minted secret B over the top, so the POST
    // that came next failed with "Invalid CSRF token" — nobody could log in.
    // Static assets must never mint a secret; only pages that can carry a token.
    it('does not mint a CSRF secret for uncredentialed static asset requests', async () => {
      for (const asset of ['/static/manifest.json', '/static/app.js']) {
        const res = await supertest(app).get(asset);
        expect(res.status).toBe(200);
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    });

  });

  // ── Run change summary ─────────────────────────────────────────────────

  // Modelled on run 40d1f72a (05/08/2026 13:00). That run reported "Changes: 1"
  // and a Discord alert naming only `purchases`, because the reporting list was
  // hardcoded to 8 resources and keyed on count deltas alone — so 17 new bank
  // transactions and 8,690 modified ones were both invisible.
  describe('summariseRunChanges', () => {
    const prev = { purchases: 14356, bankTransactions: 13849, suppliers: 950, journals: 400 };
    const curr = {
      purchases: 14359, bankTransactions: 13866, suppliers: 950, journals: 400,
      bankTransactionsSoftDeleted: 2,
    };
    const mongo = {
      purchases: { upserted: 3, modified: 14 },
      bankTransactions: { upserted: 17, modified: 8690 },
      suppliers: { upserted: 0, modified: 5 },
      journals: { upserted: 0, modified: 0 },
    };

    it('reports collections outside the old hardcoded list', () => {
      const names = summariseRunChanges(prev, curr, mongo).map((c) => c.name);
      expect(names).toContain('bankTransactions');
      expect(names).toContain('purchases');
    });

    it('reports in-place modifications when the count did not change', () => {
      const suppliers = summariseRunChanges(prev, curr, mongo).find((c) => c.name === 'suppliers');
      expect(suppliers).toBeDefined();
      expect(suppliers.countChanged).toBe(false);
      expect(suppliers.modified).toBe(5);
      expect(formatRunChange(suppliers)).toContain('5 modified');
    });

    it('omits collections that neither changed count nor were modified', () => {
      const names = summariseRunChanges(prev, curr, mongo).map((c) => c.name);
      expect(names).not.toContain('journals');
    });

    it('omits the soft-delete tally, which is not a collection', () => {
      const names = summariseRunChanges(prev, curr, mongo).map((c) => c.name);
      expect(names).not.toContain('bankTransactionsSoftDeleted');
    });

    it('orders by write volume so the Discord field cap keeps the biggest', () => {
      expect(summariseRunChanges(prev, curr, mongo)[0].name).toBe('bankTransactions');
    });

    it('formats a count delta alongside the modified tally', () => {
      const bt = summariseRunChanges(prev, curr, mongo).find((c) => c.name === 'bankTransactions');
      expect(formatRunChange(bt)).toBe('13849 → 13866 (+17) · 8690 modified');
    });

    it('stays silent on a genuine no-op run', () => {
      expect(summariseRunChanges(prev, prev, { purchases: { upserted: 0, modified: 0 } })).toEqual([]);
    });

    // `bankTransactionsFetched` is the per-run fetch tally kept alongside the
    // stored count. It is a diagnostic, not a collection, and it swings by a
    // whole account whenever one fails — exactly the phantom delta that made
    // 2026-08-16 01:08 read as "-8433". It must never reach the alert.
    it('omits the fetch tally, which is not a collection', () => {
      const names = summariseRunChanges(
        { ...prev, bankTransactionsFetched: 13955 },
        { ...curr, bankTransactionsFetched: 5522 },
        mongo,
      ).map((c) => c.name);
      expect(names).not.toContain('bankTransactionsFetched');
    });

    // The whole point of counting stored rows instead of fetched ones: when an
    // account times out, the collection is untouched, so there is no delta to
    // report and the only thing worth saying is that an account was skipped.
    it('reports no bankTransactions count delta when an account was skipped', () => {
      const skipped = summariseRunChanges(
        { bankTransactions: 13955, bankTransactionsFetched: 13955 },
        { bankTransactions: 13955, bankTransactionsFetched: 5522 },
        null,
      );
      expect(skipped).toEqual([]);
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
    it('returns pull result JSON', async () => {
      const csrf = makeCsrf();
      const res = await supertest(app)
        .post('/pull')
        .set('Cookie', authCookies(csrf))
        .set('x-csrf-token', csrf.token)
        .send({ entityType: 'invoice', entityId: 'INV-1' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.entityType).toBe('invoice');
    });
  });

  // ── POST /api/pull (machine-to-machine) ────────────────────────────────

  describe('POST /api/pull', () => {
    it('rejects requests without an API key (401)', async () => {
      const res = await supertest(app)
        .post('/api/pull')
        .send({ entityType: 'invoice', entityId: 'INV-1' });

      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
    });

    it('rejects requests with a wrong API key (401)', async () => {
      const res = await supertest(app)
        .post('/api/pull')
        .set('X-Sync-Api-Key', 'not-the-key')
        .send({ entityType: 'invoice', entityId: 'INV-1' });

      expect(res.status).toBe(401);
    });

    it('returns pull result with a valid API key — no cookie or CSRF needed', async () => {
      const res = await supertest(app)
        .post('/api/pull')
        .set('X-Sync-Api-Key', 'test-sync-api-key')
        .send({ entityType: 'invoice', entityId: 'INV-1' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.entityType).toBe('invoice');
    });

    it('returns 400 when entityType or entityId is missing', async () => {
      const res = await supertest(app)
        .post('/api/pull')
        .set('X-Sync-Api-Key', 'test-sync-api-key')
        .send({ entityType: 'invoice' });

      expect(res.status).toBe(400);
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
