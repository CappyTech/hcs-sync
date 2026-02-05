# Copilot instructions (hcs-sync)

## Big picture
- Node.js 20 + ESM project (`"type": "module"`): use `import`/`export` and include `.js` in relative imports.
- Express “admin dashboard” + sync runner:
  - Server entrypoint: `src/server/index.js` (Express + EJS views + static assets).
  - Sync runner: `src/sync/run.js` (fetches KashFlow resources and reports progress).
  - KashFlow API layer: `src/kashflow/client.js` (Axios wrappers) + `src/kashflow/auth.js` (session token acquisition).

## Repo map (where things live)
- Server routes + HTML rendering: `src/server/index.js`
- EJS templates:
  - Layout + partials: `src/server/views/layout.ejs`, `src/server/views/partials/*`
  - Pages: `src/server/views/pages/*`
- Browser-side dashboard logic (polling, toasts, theme): `src/server/public/app.js`
- Tailwind input/output:
  - Input CSS: `src/server/styles/input.css`
  - Built CSS (checked in): `src/server/public/styles.css`
- Run history store (JSON file): `data/runs.json` (written by `src/server/changeLog.js`)

## Data flow & persistence
- Runtime progress is in-memory only via `src/server/progress.js`.
  - Browser polls `GET /status` every second (see `src/server/public/app.js`).
- Run history is persisted as JSON at `data/runs.json` via `src/server/changeLog.js`.
  - `beginRun()` creates a run record, `recordChange()` appends entries, `finishRun()` finalizes status/summary.

## Dashboard routes (current)
- `GET /` dashboard
- `POST /run` starts a sync (409 if already running)
- `GET /status` returns progress JSON
- `GET /history`, `GET /history/:id` run history pages
- `POST /history/:id/revert/:changeId` marks a change as reverted (no external side-effects)
- `POST /pull` returns a “plan” response only (no queue/execution yet)

## Auth & API conventions
- Config/env is centralized in `src/config.js`:
  - Base URL: `BASE_URL` or `KASHFLOW_BASE_URL` (default `https://api.kashflow.com/v2`).
  - Token: `SESSION_TOKEN` or `KASHFLOW_SESSION_TOKEN`.
  - HTTP: `HTTP_TIMEOUT_MS` (default 30000), `CONCURRENCY` (default 4).
- Token acquisition (`src/kashflow/auth.js`):
  - If no token env var is provided, uses `USERNAME`/`PASSWORD` (+ optional `MEMORABLE_WORD`) to obtain one.
  - Handles KashFlow “account locked” by backing off for ~10 minutes (in-memory lock).
- Header conventions (`src/kashflow/client.js`):
  - Supports tokens prefixed `KF_` and GUID tokens; sets both `Authorization` and `X-SessionToken`.
- Pagination: prefer `listAll()` helpers (follows `MetaData.NextPageUrl` / `NextPageURL`, supports absolute next links).
- Error handling: Axios interceptor retries once on `401` after clearing cached token.

## Logging & secrets
- Logging is `pino` (`src/util/logger.js`) with redaction enabled.
  - Do not add logs that print tokens, passwords, or memorable word characters.
  - Be careful with logging full Axios error objects; redaction is configured but avoid dumping large request bodies.
- Pretty logs locally: set `PINO_PRETTY=1`.

## Dev workflows
- Install: `npm install`
- Dev server: `npm run dev`
  - Uses nodemon; dev script ignores `data/runs.json` changes to avoid restart loops.
  - Default port is `3000` (set `PORT` if it’s already in use).
- Prod-like run: `npm start`
- CSS build: `npm run build:css` (Tailwind input `src/server/styles/input.css` → output `src/server/public/styles.css`)
- Docker: `docker compose up -d --build`
  - Exposes the app on `http://localhost:8080` (container listens on `3000`).
- Tests: none yet (`npm test` is a placeholder).

## UI conventions (keep consistent)
- EJS renders `layout.ejs` and includes a page via `content: 'pages/...'`.
- Uses Tailwind + Flowbite (Flowbite JS served from `node_modules` at `/static/vendor/flowbite`).
- Tailwind config: see `tailwind.config.js` (includes a safelist for dynamic toast/progress classes).

## When changing sync behavior
- Implement sync traversal/counting in `src/sync/run.js`.
  - Update progress via `progress.setStage()` / `setItemTotal()` / `setItemDone()` / `incItem()`.
  - Current pattern: fetch “list” endpoints, then do per-code fanout with a small concurrency pool.
- Add/adjust KashFlow resources in `src/kashflow/client.js`.
  - Keep wrappers small and consistent: `list`, `listAll`, `get`, `create`, `update`.
  - If you add a new resource, also consider updating `src/server/progress.js` default item keys + dashboard bars.
