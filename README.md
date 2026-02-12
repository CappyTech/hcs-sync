# hcs-sync (Node.js)

Backend-only KashFlow admin sync rewritten in Node.js using updated REST endpoints.

## Setup
- Create `.env` with:
  - `KASHFLOW_BASE_URL=https://api.kashflow.com/v2`
  - `KASHFLOW_SESSION_TOKEN=KF_...`
  - `LOG_LEVEL=info`
  - `PINO_PRETTY=1` (optional for human-readable logs)
  - `MONGO_MIGRATE_ENVELOPES=1` (optional one-time migration to flatten legacy `{ data: { ... } }` documents)

## Install
```powershell
npm install
```

## Run
```powershell
npm start
```

For live development:
```powershell
npm run dev
```

## SSO (hcs-app)
This app supports SSO via the `hcs-app` provider.

- Login redirect: unauthenticated requests are redirected to `https://app.heroncs.co.uk/sso/hcs-sync?return_to={currentUrl}`.
- Cookie: `hcs-app` issues an `hcs_sso` JWT cookie for the `hcs-sync` audience.
- Protected routes: `/` and `/run` require a valid SSO cookie.

Environment variables:
- `HCS_SSO_JWT_SECRET` — shared HS256 secret used to verify the JWT.
- `HCS_SSO_COOKIE_NAME` — cookie name (default `hcs_sso`).
- `HCS_SSO_ISSUER` — expected issuer (default `hcs-app`).
- `HCS_SSO_AUDIENCE` — expected audience (default `hcs-sync`).
- `HCS_SSO_LOGIN_URL` — SSO handoff URL (default `https://app.heroncs.co.uk/sso/hcs-sync`).

Logout:
- `GET /user/logout` clears the local KashFlow token cache and redirects to `https://app.heroncs.co.uk/user/logout`.

## Notes
- Uses Axios client covering Customers, Suppliers, Invoices, Purchases, Projects, Quotes, Nominals, and Notes endpoints as per Swagger.
- Extend `src/sync/run.js` with your upsert logic.
- Mongo legacy envelope migration: see `docs/mongo-envelope-migration.md`.

## Dashboard & Routes

All routes require Basic Auth if METRICS_AUTH_* are set.

- / — HTML dashboard (status, history, live logs, trigger buttons)
- /health — unauthenticated health check (“ok”)
- /sync-summary — latest sync summary (HTML or JSON with ?format=json)
- /summaries — recent summaries (HTML or JSON)
- /summary/:id — one summary document (HTML or JSON)
- /logs — tail of logs (HTML or JSON)
- /logs/stream — live logs via Server-Sent Events
- /upserts — recent upsert logs (HTML or JSON; filter with entity, key, since, limit)
- /trigger-sync — trigger a sync (POST preferred; GET allowed)
  - Add ?full=1 to force a one-shot full traversal on the next run

Access control for /trigger-sync:

- Allowed from localhost and LAN IPs by default (10/172.16–31/192.168/169.254, plus IPv6 link-local/ULA)
- Set METRICS_ALLOW_REMOTE_TRIGGER=true to allow any remote IP
- If behind a proxy/load balancer, set METRICS_TRUST_PROXY=true to honor X-Forwarded-For in IP checks and logs

## Sync behavior

- Incremental entities (e.g., quotes, purchases) stop early when they reach the previously synced maximum unless running a full refresh.
- A full refresh (no early stop) runs automatically every FULL_REFRESH_HOURS and can be forced once via /trigger-sync?full=1.
- After a full refresh, if INCREMENTAL_SOFT_DELETE=true, documents not seen in the refresh are soft-deleted.
- Suppliers fetching traverses all pages reliably and enriches list items with detail fetched by code/id to capture fields only present in detail.

## Docker — run app only

Connect to an external MongoDB, either directly or via SSH tunnel.

Example (direct DB mode):

```
docker run -d \
  -e DIRECT_DB=true \
  -e MONGO_HOST=mongodb.internal \
  -e MONGO_PORT=27017 \
  -e MONGO_DB_NAME=kashflow \
  -e KASHFLOW_USERNAME=your_user \
  -e KASHFLOW_PASSWORD=your_pass \
  -e KASHFLOW_MEMORABLE_WORD=word \
  -e METRICS_AUTH_USER=admin \
  -e METRICS_AUTH_PASS=secret \
  -p 3000:3000 \
  kashflow-cron
```

To use an SSH tunnel, set DIRECT_DB=false (default) and pass SSH_HOST/SSH_USERNAME/SSH_PASSWORD, and optional SSH_* ports/hosts.

## docker-compose — app + Mongo

Bring up Mongo and the app (direct DB mode shown):

```
docker compose up -d --build
```

Put secrets in compose.env and reference it from the service:

compose.env:

```
KASHFLOW_USERNAME=your_user
KASHFLOW_PASSWORD=your_pass
KASHFLOW_MEMORABLE_WORD=word
METRICS_AUTH_USER=admin
METRICS_AUTH_PASS=secret
DIRECT_DB=true
MONGO_HOST=mongodb
MONGO_PORT=27017
MONGO_DB_NAME=kashflow
```

docker-compose.yml (snippet):

```
services:
  app:
    env_file:
      - compose.env
```

Logs:

```
docker compose logs -f app
```

Backfill UUIDs (if needed):

```
docker compose exec app node dist/scripts/backfill-uuids.js
```

## Pre-built image (GHCR)

If available, you can pull a published image instead of building locally.

1) Authenticate to GHCR if private:

```
echo <TOKEN> | docker login ghcr.io -u <USER> --password-stdin
```

2) In docker-compose.yml, use image (comment out build):

```
# image: ghcr.io/cappytech/kashflowapi-cron-ts:latest
# build: .
```

3) Pull & start:

```
docker compose pull app
docker compose up -d
```

Tagging suggestions:

- :sha-<gitsha> immutable
- :latest moving pointer
- :vX.Y.Z semver releases
