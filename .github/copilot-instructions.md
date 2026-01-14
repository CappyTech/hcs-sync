# Copilot Instructions — hcs-sync

These instructions make AI agents productive immediately in this repo. Focus on the real, implemented patterns.

## Quick Start
- Run: `npm start` (production) or `npm run dev` (nodemon + Tailwind build).
- Server entry: `src/server/index.js` on port `3000`.
- CSS build: `npm run build:css` compiles `src/server/styles/input.css` → `src/server/public/styles.css`.
- Health: GET `/health`. Trigger a sync: POST `/run`.

## Environment & Secrets
- Config source: `src/config.js` (`dotenv` loaded). Key vars:
  - `KASHFLOW_BASE_URL` (or `BASE_URL`) — default `https://api.kashflow.com/v2`.
  - `KASHFLOW_SESSION_TOKEN` (or `SESSION_TOKEN`) — bearer or GUID-like token.
  - `USERNAME`/`PASSWORD`/`MEMORABLE_WORD` — used by `src/kashflow/auth.js` to obtain a session token.
  - `HTTP_TIMEOUT_MS`, `CONCURRENCY`, `LOG_LEVEL`, `PINO_PRETTY`.
- Logging: `src/util/logger.js` uses `pino` with aggressive redaction of secrets.

## Architecture & Data Flow
- Web UI/API: `src/server/index.js` (Express + EJS) provides:
  - `/` dashboard, `/status` JSON runtime state, `/logs` HTML + `/logs.json`.
  - `/run` triggers `src/sync/run.js` (async job) with progress via `src/server/progress.js`.
  - History: `/history`, `/history/:id`, revert stub `/history/:id/revert/:changeId`.
  - Simple pull stub: POST `/pull` (no DB yet).
- Change history: `src/server/changeLog.js` persists to `data/runs.json` (no relational DB). Optional Mongo upserts for fetched data if configured.
- Views: `src/server/views/**` (EJS). Static assets: `/static` from `src/server/public` (Flowbite served from node_modules).

## KashFlow Client Patterns
- Client factory: `src/kashflow/client.js` builds an Axios instance with auth from `src/kashflow/auth.js`.
- Auth headers: `Authorization` set to `Bearer KF_...` or `KfToken <guid>`; also sends `X-SessionToken`.
- Pagination helpers:
  - `list(path, params)` — single-page, normalizes arrays and `Data`.
  - `listAll(path, params)` — follows `MetaData.NextPageUrl/NextPageURL` until exhausted.
- Resources provided: `customers`, `suppliers`, `projects`, `nominals`, `invoices`, `quotes`, `purchases`, `notes` with `list/listAll/get/create/update` as applicable.
- 401 retry: response interceptor clears cached token and retries once via `auth.getSessionToken()`.

## Sync Job (`src/sync/run.js`)
- Stages: `starting` → `fetch:lists` → per-entity loops → `finalising` in `progress`.
- Concurrency: limited worker pool (`config.concurrency`, default 4) for per-code fetches.
- Counters: aggregates total items for invoices/quotes/purchases; sets progress per entity.
- Optional DB writes: when `MONGO_URI` and `MONGO_DB_NAME` are set, performs collection upserts for `customers`, `suppliers`, `projects`, `nominals`, and per-code `invoices`, `quotes`, `purchases` via `src/db/mongo.js`.
- Returns `{ counts, previousCounts }` for dashboard and history delta tracking.

## UI & Styling
- Tailwind + Flowbite: edit `src/server/styles/input.css`, run `npm run build:css`.
- EJS layout: `src/server/views/layout.ejs`; pages in `src/server/views/pages/**`.

## Docker
- Simple app container (`Dockerfile`) runs `node src/server/index.js` on port `3000`.
- `docker-compose.yml` builds the app, loads `.env`, exposes healthcheck on `/health`.

## Conventions & Examples
- Prefer `listAll` when traversing REST pages (e.g., `kf.invoices.listAll({ perpage: 200, customerCode })`).
- Always log progress via `progress.*` when extending `src/sync/run.js`.
- Record informational deltas with `changeLog.recordChange(runId, { entityType: 'metric', ... })` after sync completion.
- Keep secrets out of logs — rely on `logger` redaction, and avoid logging full request configs.

## Optional Mongo Upserts
- Config: set `MONGO_URI` (e.g., `mongodb://localhost:27017`) and `MONGO_DB_NAME` to enable upserts.
- Helper: `src/db/mongo.js` exposes `isDbEnabled()` and `upsertMany(collection, docs)`; `_id` is derived from common fields (`Code`, `Number`, `ProjectNumber`, `NominalCode`).
- Integration points: top-level list fetches and per-code loops upsert documents if enabled.

## Gotchas
- Auth flow differs by deployment: KF bearer vs GUID; `auth.js` handles both and may require `MEMORABLE_WORD` positions.
- `listAll()` supports absolute `NextPageUrl`; if relative, Axios `baseURL` applies.
- History and revert endpoints are stubs — no DB writes yet.

## When Implementing Changes
- Touch `src/sync/run.js` for new traversal or upsert logic; encapsulate API calls in `src/kashflow/client.js`.
- Update counters and `progress` consistently; surface results via `/status` and dashboard.
- If adding resources, mirror existing client/resource method shapes and pagination semantics.
