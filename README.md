# hcs-sync

**KashFlow ↔ MongoDB sync adapter for Heron Constructive Solutions LTD.** A dedicated, backend-focused service (with an admin dashboard) that owns the entire KashFlow REST API integration and mirrors accounting data into a shared MongoDB **REST namespace**. The main business app, [hcs-app](https://github.com/CappyTech/hcs-app), reads that namespace and knows nothing about KashFlow internals.

It runs at `sync.heroncs.co.uk` and is deliberately **KashFlow-specific and replaceable** — swapping accounting providers means rewriting this service, not hcs-app.

> For deeper architecture and module notes see [AGENTS.md](AGENTS.md). For the design rationale of each capability, see the walkthrough below.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [App Structure](#app-structure)
- [Application Lifecycle](#application-lifecycle)
- [Feature Walkthrough](#feature-walkthrough)
- [Routes](#routes)
- [Development Deployment](#development-deployment)
- [Production Deployment](#production-deployment)
- [Testing](#testing)
- [License](#license)

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 20+ **ESM** (built & run on Node 24 in Docker) |
| Web framework | Express 4 |
| Views | EJS + Tailwind CSS 3 (built locally to `src/server/public/styles.css`) |
| Database | MongoDB — accessed via both the native `mongodb` driver and Mongoose 8 (writes to the shared **REST namespace**) |
| Accounting API | KashFlow REST v2 via Axios (`src/kashflow/`) |
| Scheduling | `node-cron` + `cron-parser` + `cronstrue` (human-readable schedules) |
| Auth & security | SSO JWT cookie issued by hcs-app (`jsonwebtoken`), shared-secret machine API key, Cloudflare Turnstile, Helmet/CSP with per-request nonce, double-submit CSRF (`csrf`), `express-rate-limit` |
| Logging | Pino (+ `pino-pretty` for dev) |
| Tests | Vitest + Supertest |
| Delivery | Docker (multi-stage) · Caddy (auto-HTTPS, at the edge) · Tailscale (private networking) · GitHub Container Registry |

Shared Mongoose schemas come from [`@cappytech/hcs-schemas`](https://github.com/CappyTech/hcs-schemas), keeping the REST-namespace contract identical to what hcs-app expects.

---

## App Structure

```
src/
  config.js                 # All env config, centralised
  server/
    index.js                # Express app: middleware, auth, routes, cron bootstrap (entry point)
    cron.js                 # Cron scheduler start/stop + health
    runStore.js             # Persisted run history, logs, change records, revert
    settingsStore.js        # DB-backed runtime settings (cron schedule, etc.)
    progress.js             # Live run progress state (for dashboard polling)
    changeLog.js            # Change/audit record helpers
    models/
      kashflow.js           # Mongoose models for the REST namespace (schema contract)
      Run.js                # Sync run history schema
      Settings.js           # Runtime settings schema
    views/tailwindcss/      # EJS templates (dashboard, history, settings, login, logs, debug)
    styles/input.css        # Tailwind source
    public/                 # Built styles.css, client JS (theme toggle, UI helpers)
  kashflow/
    client.js               # Axios wrappers for KashFlow REST endpoints
    auth.js                 # Token acquisition (session token or username/password)
    sessionService.js       # KashFlow session handling
  sync/
    run.js                  # Full sync orchestration (fetch → diff → upsert)
    pull.js                 # Single-entity pull/debug (dashboard + machine API)
  db/
    mongo.js                # Native driver connection + index management
    mongoose.js             # Mongoose connection
    dedup.js                # Deduplication + UUID backfill
  util/
    logger.js               # Pino logger
    deepDiff.js             # Stable stringify + deep diff for change detection

Dockerfile                  # Multi-stage build (CSS builder → production image)
docker-compose.yml          # Production stack (Tailscale sidecar + hcs-sync)
.env.example                # Documented environment template
```

---

## Application Lifecycle

[`src/server/index.js`](src/server/index.js) is the entry point. On boot it:

1. Computes build identity (version/commit/branch) for the footer.
2. Registers middleware: template locals, CSP nonce + Helmet, request logging (Pino, with abort detection), cookie parsing, the **SSO auth guard**, EJS, body parsing, **CSRF** double-submit protection, and `no-store` static asset serving.
3. Defines routes (dashboard, history, settings, sync/dedup triggers, pull/debug, machine API).
4. Starts listening, then loads runtime settings from MongoDB (falling back to env) and **applies the cron schedule**.

Sync runs are single-flight (`isRunning` guard) and tracked in `runStore`, with live progress exposed for dashboard polling.

---

## Feature Walkthrough

Each capability from three angles: **Dev** (how it's built), **User** (what an admin experiences), **Business Owner** (why it matters).

### 1 — KashFlow → MongoDB Sync
- **Dev.** [`sync/run.js`](src/sync/run.js) fetches each entity from KashFlow via the Axios client, computes a stable content hash, and upserts into MongoDB with an aggregation-pipeline update that only bumps `updatedAt` when data actually changes. Concurrency pools (`CONCURRENCY`/`DETAIL_CONCURRENCY`) parallelise list + detail fetches. Entities: **Customers, Suppliers, Invoices, Quotes, Purchases, Projects, Nominals, VAT rates**.
- **User.** One service keeps the business app's accounting data current without anyone touching KashFlow directly.
- **Business Owner.** Live, queryable accounting data feeding CIS, finance, and project dashboards — without paying for or being locked into KashFlow's own reporting, and isolated so a provider change doesn't ripple through the whole platform.

### 2 — Incremental vs Full Refresh
- **Dev.** Incremental entities stop early once they reach the previously synced maximum; a full traversal runs automatically every `FULL_REFRESH_HOURS` and can be forced once. After a full refresh, unseen documents are soft-deleted when enabled. Suppliers traverse all pages and enrich list items with detail fetches to capture detail-only fields.
- **User.** Routine syncs are fast (only new/changed records); periodic full refreshes catch deletions and back-fill.
- **Business Owner.** Fresh data with low API load and cost, plus a safety-net full reconciliation so the mirror doesn't silently drift from KashFlow.

### 3 — Scheduled (Cron) Syncs
- **Dev.** [`cron.js`](src/server/cron.js) uses `node-cron`; the effective schedule comes from DB settings (preferred) or env. `cron-parser` computes the next run, `cronstrue` renders it in plain English. When cron is enabled, manual dashboard runs are blocked (409) to avoid overlap.
- **User.** Set "every hour at :00" in the Settings page and forget it; the dashboard shows the next scheduled run and cron health.
- **Business Owner.** Hands-off, reliable data freshness with a visible health signal — no one has to remember to press a button.

### 4 — Admin Dashboard & Live Progress
- **Dev.** EJS dashboard at `/` renders status, last counts, cron health/next-run, and last error. `progress.js` exposes live state polled via `/status`; logs are streamed in-memory (capped at 500) and persisted per run.
- **User.** A single screen to see what synced, when, how many records, and whether anything failed — plus live progress while a run is in flight.
- **Business Owner.** Operational transparency — you can confirm the books are syncing and spot failures immediately, rather than discovering stale data downstream.

### 5 — Sync History, Change Audit & Revert
- **Dev.** [`runStore.js`](src/server/runStore.js) persists each run, its logs, and per-entity change records (with before/after diffs and count deltas). `/history` and `/history/:id` drill into a run, including the actual Mongo documents inserted (tagged with `createdByRunId`) and an `audit_log` trail. `/history/:id/revert/:changeId` supports reverting a recorded change.
- **User.** Inspect exactly what changed in any past run, drill into the affected records, and roll back a specific change if needed.
- **Business Owner.** A defensible audit trail of every automated write to the accounting mirror — important for financial data integrity and troubleshooting disputes.

### 6 — Single-Entity Pull & Debug
- **Dev.** [`sync/pull.js`](src/sync/pull.js) fetches and upserts one KashFlow entity by Number/Code. Exposed via `/pull` (dashboard) and `/debug` (fetch + report without committing assumptions), covering purchases, invoices, quotes, customers, suppliers, projects.
- **User.** When one record looks wrong, refresh just that record instead of waiting for a full sync.
- **Business Owner.** Fast, surgical correction of a single invoice/supplier without the cost or delay of a full re-sync.

### 7 — Machine-to-Machine API (`POST /api/pull`)
- **Dev.** Key-authenticated (`X-Sync-Api-Key`, timing-safe compared) equivalent of the "Pull & Sync" button. Exempt from the SSO cookie guard and CSRF (protected by the API key instead), rate-limited. Body: `{ entityType, entityId }`.
- **User.** Invisible — it's how hcs-app triggers a re-pull (e.g. right after marking a project Complete in KashFlow) so the dashboards stay consistent.
- **Business Owner.** The two internal systems stay in lock-step automatically; an action in the main app is reflected in the synced data within seconds.

### 8 — Deduplication & UUID Backfill
- **Dev.** [`db/dedup.js`](src/db/dedup.js) (run via `POST /dedup`, rate-limited, blocked during a sync) removes duplicate documents and backfills UUIDs, with a full per-action audit log and a result banner on return.
- **User.** A one-click maintenance tool to clean up duplicate records.
- **Business Owner.** Keeps the accounting mirror clean and uniquely keyed, preventing double-counting in downstream finance reports.

### 9 — Authentication & Security
- **Dev.** UI is gated by an SSO JWT cookie (`hcs_sso`) **issued by hcs-app** and verified here (HS256, audience `hcs-sync`, issuer `hcs-app`). The login form proxies credentials to hcs-app's `/api/sso/token` using the shared `HCS_SYNC_API_KEY`, so hcs-sync never handles password hashes or 2FA itself. Cloudflare Turnstile guards the login form; admin-only routes check `role === 'admin'`. Layered defences: Helmet CSP with per-request nonce, double-submit CSRF, `trust proxy` limited to loopback + Docker bridge, request-ID sanitisation against log injection, and tiered rate limiters (login/sync/pull/dedup).
- **User.** Log in with the same credentials and 2FA as the main app — one identity, no separate account.
- **Business Owner.** Centralised identity and strong defence-in-depth around a system that can read and rewrite accounting data, lowering breach and tampering risk.

### 10 — Fetch-Only / Degraded Modes
- **Dev.** If MongoDB isn't configured, sync runs in fetch-only mode and settings fall back to env. The service warns if Mongo points at `localhost` from inside Docker, and `/cron/health` returns 503 when the schedule is stale/unhealthy.
- **User.** The service still starts and is diagnosable even when partially misconfigured.
- **Business Owner.** Resilient operations and clear health signals reduce downtime and speed up fixing config mistakes.

---

## Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /` | SSO | Dashboard (status, counts, cron health, last error) |
| `GET /login`, `POST /login` | public | SSO login (via hcs-app) + Turnstile, rate-limited |
| `GET /logout` | SSO | Clear SSO cookie |
| `GET /health` | public | Liveness + cron health JSON |
| `GET /cron/health` | public | Cron health (503 if unhealthy) — container healthcheck |
| `GET /status` | SSO | Live run progress (dashboard polling) |
| `GET /logs`, `GET /logs.json` | admin | Recent in-memory logs |
| `GET /settings`, `POST /settings/cron` | admin | View / edit cron schedule (DB-backed) |
| `POST /run` | admin | Trigger a manual sync (blocked when cron enabled), rate-limited |
| `POST /dedup`, `GET /dedup/status` | admin | Dedup + UUID backfill, rate-limited |
| `GET /history`, `GET /history/:id` | admin | Run history + drilldown (Mongo docs, audit trail) |
| `POST /history/:id/revert/:changeId` | admin | Revert a recorded change |
| `GET /debug`, `POST /debug` | admin | Fetch + report a single entity, rate-limited |
| `POST /pull` | admin | Pull & upsert a single entity, rate-limited |
| `POST /api/pull` | **API key** | Machine-to-machine single-entity pull (`X-Sync-Api-Key`) |
| `GET /static/*` | public | Static assets (`no-store`) |

---

## Development Deployment

Requires **Node.js 20+**. MongoDB is optional (without it, sync runs fetch-only).

```bash
cp .env.example .env        # configure KashFlow creds, Mongo, SSO, Turnstile
npm install
npm run dev                 # builds CSS, then runs the server under nodemon
```

The server listens on `PORT` (default `3000`). Useful local toggles:

- `SKIP_TURNSTILE=true` — bypass the login CAPTCHA in dev.
- `COOKIE_SECURE=false` — allow the SSO/CSRF cookies over plain HTTP.
- `PINO_PRETTY=1` and `LOG_LEVEL=debug` — human-readable, verbose logs.
- Leave `MONGO_*` unset to run in fetch-only mode.

KashFlow auth accepts either a session token (`SESSION_TOKEN`/`KASHFLOW_SESSION_TOKEN`) or `USERNAME`/`PASSWORD` (+ `MEMORABLE_WORD`). A session token bypasses password login and avoids `PasswordExpired` failures.

After changing Tailwind classes, rebuild CSS:

```bash
npm run build:css
```

---

## Production Deployment

Production runs the published GHCR image behind Caddy, with all traffic routed through a Tailscale sidecar ([`docker-compose.yml`](docker-compose.yml)).

```bash
cp .env.example .env         # set KashFlow, Mongo, SSO secret, API key, Turnstile, TS_AUTHKEY
docker network create hcs-net   # external network (one-time, shared with the rest of the stack)
docker compose up -d
```

Key details:

- **Image:** `ghcr.io/cappytech/hcs-sync:latest` with `pull_policy: always`.
- **Networking:** the app shares the **Tailscale** container's network namespace, so the edge **Caddy** must proxy to `tailscale:3000` (not `hcs-sync:3000`). Caddy terminates HTTPS automatically; HSTS is handled at the edge while CSP is enforced in-app.
- **Health:** Docker healthcheck hits `GET /cron/health`.
- **Auth wiring:** set `HCS_APP_BASE_URL`, `HCS_SSO_JWT_SECRET` (must match hcs-app), and `HCS_SYNC_API_KEY` (shared secret for both the login handshake and `POST /api/pull`). In production set `HCS_SSO_COOKIE_DOMAIN=.heroncs.co.uk`.
- **State:** the `tailscale_state` volume persists tailnet auth across restarts.

The container is built from a multi-stage [`Dockerfile`](Dockerfile): stage 1 compiles Tailwind CSS; stage 2 produces a slim `node:24-alpine` image (`npm ci --omit=dev`, `dumb-init` as PID 1, `tailscaled` baked in, `NODE_ENV=production`, listening on port `3000`).

---

## Testing

```bash
npm test            # Vitest (unit + Supertest HTTP tests)
npm run test:watch  # watch mode
```

---

## License

**MIT** — see [`package.json`](package.json). © Heron Constructive Solutions LTD.
</content>
