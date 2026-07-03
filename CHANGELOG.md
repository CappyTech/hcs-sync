# Changelog

All notable changes to hcs-sync will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

## [0.5.4] - 2026-07-03

### Fixed
- **Run Sync button stayed disabled after sync completed.** After triggering a manual run the dashboard reloaded with `isRunning=true`, disabling the button. When the sync finished the status poll updated the badge to "Idle" but the button remained greyed out because its disabled state is set at render time. The poll now reloads the page 1.2 s after detecting a `running → idle` or `running → failed` transition, so the button correctly re-enables.
- **Run Sync / Dedup buttons did nothing when clicked — CSP violation.** The dashboard buttons used inline `onclick` attributes (`onclick="openModal(…)"`) which are blocked by the `script-src-attr: 'none'` CSP directive. All inline event handlers across `index.ejs` and `run.ejs` have been replaced with `data-modal-open`, `data-modal-close`, `data-auto-submit`, and `data-pull-entity-type/id` attributes. The `data-modal-open/close` handler in `ui-helpers.js` now delegates to `window.openModal`/`window.closeModal` (defined in `app.js`) so the full backdrop/aria behaviour is preserved. The `data-auto-submit` handler submits the enclosing form on `change`. Manual Pull buttons on the run-details page use `data-pull-entity-*` attributes handled by `app.js` event delegation.
- **16,753 soft-deleted records invisible to hcs-app.** Legacy sync runs had set a `deletedAt` timestamp on purchase, invoice, supplier, project, and quote documents. Because `deletedAt` was in Project's `protectedFields` (and not explicitly cleared for other models) the regular sync never restored these records — hcs-app filters on `deletedAt: null` and treated them as deleted. The upsert pipeline in `buildUpsertUpdate` now unconditionally sets `deletedAt: null` for every entity fetched from KashFlow, and `deletedAt` has been removed from Project's `protectedFields`. The first sync after this change will restore all affected records.

## [0.5.3] - 2026-07-03

### Changed
- **Local dev login without hcs-app.** Login previously always required the hcs-app SSO backend (`HCS_SYNC_API_KEY` + `HCS_SSO_JWT_SECRET`), so local dev failed with "Login service is not configured". Outside production, when `HCS_SYNC_API_KEY` is unset, POST /login now signs a local admin session itself (any username/password), using an ephemeral per-process JWT secret when `HCS_SSO_JWT_SECRET` is absent — sessions die with the process. Production is unchanged: with `NODE_ENV=production` the bypass never activates and a missing API key still errors.
- **Turnstile CAPTCHA is skipped automatically outside production.** Local dev has no Cloudflare keys, so every login failed with "CAPTCHA token missing" unless `SKIP_TURNSTILE=true` was set manually. The bypass now also activates when `NODE_ENV !== 'production'`; production behaviour is unchanged (the Docker image sets `NODE_ENV=production`), and the login-page banner states which condition triggered the bypass.

### Fixed
- **Footer commit SHA was blank in deployed images.** The footer and `APP_BUILD` already support showing `branch@commit`, but the Docker image has no `.git` to fall back on and neither the Dockerfile nor CI supplied the commit — the same gap hcs-app fixed in 6.6.10. The Dockerfile now takes `GIT_COMMIT`/`GIT_BRANCH` build args (exported as env) and CI passes `SHORT_SHA` and the branch name. For parity with hcs-app, the footer's `branch@commit` is now a link to the commit on GitHub (repo URL overridable via `GIT_REPO_URL`).

## [0.5.2] - 2026-07-03

### Added
- **Debug page "All fields" now shows full key/value pairs.** The collapsed expander listed only field names, hiding the values needed to diagnose issues (e.g. whether `deletedAt` is set). It now renders every field with its value — objects/arrays as truncated JSON, HTML-escaped — in a scrollable table, for both the MongoDB and KashFlow cards.
- **Debug page now surfaces the soft-delete flag.** The MongoDB card shows `deletedAt` (previously only its name appeared in the collapsed field list, hiding whether it was set), and the diagnosis reports `SOFT_DELETED` when the flag is set plus `SOFT_DELETE_MISMATCH` when the entity simultaneously exists in KashFlow. Legacy `deletedAt` values (from the removed unseen-document soft-delete feature) are invisible to the dashboard but cause downstream apps like hcs-app — which filter on `deletedAt: null` — to treat live purchases as deleted (e.g. false "Stale KashFlow Links" on the hcs-app documents overview).

### Fixed
- **Pull & Sync now clears `deletedAt`.** KashFlow returning the entity is proof it exists, but the upsert never touched the legacy soft-delete flag, so a stuck `deletedAt` survived every re-sync and could not be cleared by any current code path.

## [0.5.1] - 2026-06-25

### Changed
- **Rewrote `README.md`** into a full project overview, replacing the stale Basic-Auth/`METRICS_AUTH` documentation that no longer matches the code. Added Tech Stack, App Structure, application lifecycle, a 10-feature walkthrough (Dev / User / Business Owner perspectives), a current route table (SSO cookie auth, Turnstile, CSRF, `POST /api/pull` machine API), and split Development vs Production deployment instructions.

## [0.5.0] - 2026-06-25

### Added
- **Machine-to-machine `POST /api/pull`**: key-authenticated equivalent of the dashboard's "Pull & Sync" button, so other services (hcs-app) can refresh a single KashFlow entity into the shared REST namespace on demand. Auth is the shared `HCS_SYNC_API_KEY` sent as the `X-Sync-Api-Key` header (the same secret as the SSO token handshake). Body is `{ entityType, entityId }`. The endpoint is exempted from the SSO-cookie guard and CSRF (it is protected by the API key instead) and rate-limited via the existing `pullLimiter`.

## [0.4.7] - 2026-06-22

### Changed
- **.env.example**: documented all previously undocumented environment variables found in application code. Added a Tailscale section (`TS_AUTHKEY`, `TS_HOSTNAME`), logging variables (`LOG_LEVEL`, `PINO_PRETTY`, `RUN_LOG_MAX_ENTRIES`), and `DETAIL_CONCURRENCY`.

## [0.4.6] - 2026-06-22

### Added
- **Tailscale integration**: `tailscaled` (userspace networking) is now baked into the production image via `docker-entrypoint.sh`. If `TS_AUTHKEY` is set, the container authenticates to the tailnet on startup and accepts routes. If absent the entrypoint is a no-op.
- **docker-compose.yml**: added a `tailscale` sidecar service (`tailscale/tailscale:latest`, userspace networking). The `hcs-sync` container joins the sidecar's network namespace via `network_mode: service:tailscale`, routing all outbound traffic through Tailscale. The `tailscale_state` volume persists authentication state across restarts. Note: Caddyfile upstream must reference `tailscale:3000` rather than `hcs-sync:3000`.
- **CI (`.github/workflows/ci.yml`)**: added optional `tailscale` workflow dispatch input (boolean, default `false`). When enabled, the runner joins the tailnet via the `tailscale/github-action@v3` step using OAuth credentials (`TS_OAUTH_CLIENT_ID`, `TS_OAUTH_CLIENT_SECRET`) tagged `tag:ci-hcs-sync`, allowing builds to reach internal services.

## [0.4.5] - 2026-06-22

### Fixed
- **Dockerfile**: removed `# syntax=docker/dockerfile:1` directive. BuildKit on current GitHub Actions runners bundles a sufficiently recent frontend, so the directive was adding an unnecessary Docker Hub auth dependency that caused build failures when Docker Hub's token endpoint was unavailable (transient 520 errors).

## [0.4.4] - 2026-06-22

### Fixed
- **Layout**: removed stray `<br>` tag between `<main>` and the footer/nav block, eliminating a spurious scrollbar on the login page caused by the extra line of height in the page flow.
- **Layout**: theme toggle icon changed from `text-base` (Tailwind) to `fs-5` (Bootstrap Icons sizing utility), matching hcs-app and rendering at the correct 1.25rem size.

## [0.4.3] - 2026-06-22

### Fixed
- **Layout**: reduced `main` top padding from `pt-20` to `pt-16`, matching hcs-app. The extra 4 units was making the login card sit lower than its hcs-app equivalent and the bottom nav appear disproportionately large.

## [0.4.2] - 2026-06-22

### Changed
- **Login page**: Turnstile script now loads unconditionally (matches hcs-app). Inline error block removed — errors now surface through the shared `errorAlert` partial.
- **`errorAlert.ejs`**: extended to catch the `error` local variable (query-string errors on the login page) in addition to flash messages, without requiring server-side sessions.

## [0.4.1] - 2026-06-22

### Changed
- **Login page redesign**: login view now renders through the shared layout, gaining the footer and bottom nav (Theme toggle) consistent with all other pages. Card matches hcs-app's login style — rounded card, accent bar, same field/button layout — keeping blue colouring.

## [0.4.0] - 2026-06-11

### Security
- Admin-only access enforced on all state-changing and sensitive routes: `POST /run`, `POST /dedup`, `GET /dedup/status`, `POST /pull`, `GET/POST /debug`, `GET /settings`, `POST /settings/cron`, `GET /logs`, `GET /logs.json`. Previously any authenticated SSO user could trigger syncs, run dedup (which deletes documents), or change cron settings.

### Added
- Login form: optional two-factor code field, forwarded to hcs-app's token endpoint — required for 2FA-enrolled accounts (hcs-app ≥ 6.3.0).
- Login: structured error messages from hcs-app (account locked, 2FA required/invalid, role not permitted) are now shown instead of a generic "invalid credentials".

## [0.3.3] - 2026-06-10

### Added
- `src/server/public/manifest.json` — hcs-sync now has its own PWA manifest (name: "HCS Sync") served at `/static/manifest.json`.

### Fixed
- CSP: restored `manifest-src 'self'` directive; removed cross-origin reference to hcs-app's manifest.
- Layout: `<link rel="manifest">` now points to `/static/manifest.json` (local) instead of `app.heroncs.co.uk`.

## [0.3.2] - 2026-06-10

### Fixed
- CSP: added `https://app.heroncs.co.uk` to `imgSrc` and `manifestSrc` — fixes blocked favicon, logo image, and manifest load from hcs-app.
- CSP: added `'unsafe-inline'` to `styleSrc` — fixes blocked inline `style=` attribute on progress bars (nonces do not apply to style attributes).

## [0.3.1] - 2026-06-10

### Changed
- Footer: added HCS logo image (sourced from `app.heroncs.co.uk`) alongside the company name.

## [0.3.0] - 2026-06-10

### Changed
- Footer: aligned with hcs-app structure — added VAT number, copyright year range (2024–present), Privacy/Cookies/Terms links (pointing to `app.heroncs.co.uk/legal/...`). Blue link colour retained.

## [0.2.9] - 2026-06-10

### Fixed
- Increased `<main>` top padding from `pt-16` (64px) to `pt-20` (80px) so the fixed navbar no longer overlaps page content.

## [0.2.8] - 2026-06-10

### Fixed
- Added missing `GET /logout` route — clears the `hcs_sso` cookie and redirects to `/login`.

## [0.2.7] - 2026-06-10

### Changed
- Layout: replaced `user` check with `isAuthenticated` in `layout.ejs` (top nav + footer conditions) — matches hcs-app pattern.
- Server: `res.locals.isAuthenticated = true` now set in the auth middleware alongside `res.locals.user`.

### Removed
- Deleted legacy view tree (`src/server/views/history.ejs`, `index.ejs`, `layout.ejs`, `login.ejs`, `logs.ejs`, `run.ejs`, `pages/`, `partials/`) — the views engine has pointed to `views/tailwindcss/` for all routes; these files were unreachable dead code.

## [0.2.6] - 2026-06-10

### Changed
- CI: added `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` env — opts into Node.js 24 for all actions ahead of the June 16th deadline.
- CI: added `timeout-minutes: 40` to prevent runaway jobs.
- CI: renamed job from `build-and-push` to `build`.
- CI: added `npm audit --omit=dev --audit-level=high` step (3-min timeout).
- CI: removed `setup-qemu-action` and dropped `linux/arm64` platform — amd64 only, matching hcs-app and halving Docker build time.

## [0.2.5] - 2026-06-10

### Removed
- Flowbite dependency — the active tailwindcss layout never used Flowbite JS (modals already handled by custom `openModal`/`closeModal` in `app.js`). Removed from `package.json`, `tailwind.config.js` content/plugins, the static route in `index.js`, and the `<script>` tag in `layout.ejs`.

## [0.2.4] - 2026-06-10

### Fixed
- `pullSingleEntity`: fixed "Cannot convert undefined or null to object" crash on Pull & Sync — `update.$set` was undefined because `buildUpsertUpdate` returns an aggregation pipeline array; corrected to `update[0].$set`.

## [0.2.3] - 2026-06-10

Initial changelog entry. Version reflects the state of the codebase at this point.
