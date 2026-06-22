# Changelog

All notable changes to hcs-sync will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

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
