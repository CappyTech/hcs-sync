# Changelog

All notable changes to hcs-sync will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

## [0.10.3] - 2026-08-05

Fixes a second login-page failure with the same shape as 0.10.2's — something the layout loads unconditionally breaking the page it loads on — and stops the run summary and Discord alert under-reporting what a sync changed.

### Fixed
- **`POST /login` failed with "Invalid CSRF token" on a fresh session.** The CSRF secret is minted by any request that arrives without the cookie, and `/static` was mounted *behind* that middleware. A browser fetches `<link rel="manifest">` **without credentials** unless it carries `crossorigin="use-credentials"`, which `layout.ejs` does not set. So `GET /login` minted secret A and rendered the form with `token(A)`; the manifest fetch that followed arrived with no cookie, minted secret B, and its `Set-Cookie` overwrote A; the submitted form still held `token(A)` and failed verification against B. The message was *Invalid* rather than *Missing* precisely because both halves were present — they were just from different generations. This hit any login where the cookie was absent or expired, i.e. every fresh one. `/static` is now mounted **ahead** of the CSRF middleware, so an asset fetch can never mint or overwrite the secret; only responses that can actually carry a token issue one. The verify middleware already skips `GET`/`HEAD`/`OPTIONS`, so static loses no protection.
- **The run summary and Discord alert reported one changed collection when six had changed.** The list of collections to report was hardcoded — and duplicated in both places — as `['customers','suppliers','projects','nominals','vatRates','invoices','quotes','purchases']`, while `sync/run.js` returns **21**. `bankTransactions`, `bankAccounts`, `bankReconciliations`, `journals`, `countries`, `vatReturns`, `accountingPeriods`, `currencies` and the two category collections could never be reported whatever happened to them. Run `40d1f72a` added 17 bank transactions (13,849 → 13,866) and it was structurally invisible.
- **In-place modifications never counted as a change at all.** The test was `if (before === after) return;`, so a collection whose document count is unchanged reported nothing however many documents were rewritten. That silenced 8,690 modified bank transactions in that one run, plus modifications to `suppliers`, `vatReturns`, `bankAccounts` and `projects`. Count deltas and Mongo write stats are now both consulted; either alone under-reports.
- **`meta` was dropped twice over** — absent from `ChangeSchema` *and* from `recordChange`'s explicit field whitelist — so per-collection upserted/modified counts would have been silently discarded on the way to the database.

### Changed
- One `summariseRunChanges()` helper now backs both the run summary and the Discord alert, deriving collections from what the sync actually returns rather than a hardcoded subset. `bankTransactionsSoftDeleted` is excluded — it is a sub-tally of `bankTransactions`, not a collection in its own right. Results sort by write volume so Discord's 25-field cap keeps the significant ones, with a `+N more` overflow field and a `Totals` field. No-op runs stay silent, so a frequent cron does not become noisy.

### Added
- `tests/server.test.js` — `/static/*` must return no `Set-Cookie` (fails against the unfixed middleware order), and six cases on `summariseRunChanges` built from the real counts of run `40d1f72a`: collections outside the old hardcoded list are reported, modifications are reported when the count did not change, unchanged collections are omitted, the soft-delete tally is omitted, ordering is by write volume, and a genuine no-op stays silent.

### Known issues
- **~421 bank transactions are written twice per run and flip-flop between two representations.** An inter-account transfer appears in *both* accounts' feeds under the same transaction `Id`, presented from each account's own side, and `sync/run.js` upserts with `keyFields: ['Id']` — so the two views collide on one document and whichever account is fetched last wins. The two writes are exact inverses: `PaidIn`/`PaidOut` swap, `Balance` is the other account's running balance, and `Type` names the other account. Consequences: `/bank` sees an arbitrary side of every inter-account transfer, and this accounts for ~549,000 of the 702,797 rows in `audit_log`. The fix is a composite key mirroring the `ReconKey` (`"<AccountId>:<Id>"`) that `bankReconciliations` already uses for exactly this reason, but it is a keying and data migration affecting `bankmatches` and the `LIVE_BANK_LINE` filter, so it is deliberately **not** in this release.
- Not a defect, for the avoidance of doubt: a run that adds backdated transactions rewrites the running `Balance` of every later transaction, which is why one run showed 8,269 documents modified with `Balance` as the only changed field. Now that reporting is fixed this is visible as a normal event.

## [0.10.2] - 2026-08-05

Fixes a reload loop that made the login page impossible to use — a regression introduced by 0.10.1's own fix.

### Fixed
- **The login page reloaded itself ~6 times a second and could not be typed into.** 0.10.1 taught the dashboard poller to stop on a `401` from `/status` and `window.location.reload()` once, so an expired session lands the user on the login page. But `layout.ejs` loads `/static/app.js` on *every* page, including `/login` — and on the login page a `401` from `/status` is not an expired session, it is the normal resting state. So the poller fired immediately on load, got its `401`, and reloaded; the fresh page re-ran `app.js`, which polled, got `401`, and reloaded again. The `stopped` flag guards one page's timer but does not survive the reload it triggers, so nothing broke the cycle. Because `poll()` runs at load rather than after `POLL_MS`, each iteration took ~170ms rather than a second. Observed in production: 333 full login-page loads in 90 seconds from one browser, and not a single `POST /login` — the reload discarded the form before anyone could submit it.
- **`poll()` now starts only when the dashboard is actually on the page**, gated on `#status-badge`, the element `renderStatus` writes to. The 401-reload branch is correct behaviour for a dashboard whose session expired and wrong everywhere else; the gate is what makes the distinction. Everything 0.10.1 fixed still holds — this narrows where the poller runs, it does not revert the backoff, the `Accept: application/json` header or `redirect: 'manual'`.

### Added
- `tests/server.test.js` — both halves of that gate, since it is a load-bearing invariant split across a template and a script that cannot see each other: the login page must carry `/static/app.js` but **not** `status-badge`, and the dashboard must carry `status-badge`. Without the second test the gate could be silently disabled everywhere, and the status panel would just stop updating with nothing logged.

## [0.10.1] - 2026-08-04

Stops an open dashboard tab hammering the server once a second, forever, after its session expires.

### Fixed
- **The dashboard poller re-requested the login page every second, indefinitely.** `poll()` fetches `/status` on a 1s timer. When the SSO cookie expires the auth guard 302s that request to `/login?next=/status` — and `fetch()` follows redirects by default, so the poller received the login *page*: HTTP 200, `r.ok` true, HTML body. `r.json()` then threw, the throw landed in an empty `catch {}`, and the next poll was scheduled 1000ms later. Nothing in that loop could ever break it, so a tab left open on an expired session kept up a sustained 1 req/s against the server until someone closed it. Observed in production: ~3,300 requests in a single overnight stretch from one browser tab, all of them serving a full login page to a caller that wanted JSON.
- **The auth guard now answers JSON callers with `401` instead of redirecting them.** A redirect to an HTML page is unusable to a `fetch()` caller — it cannot tell the login page apart from a real response without parsing the body. `/status`, `/logs.json` and `/dedup/status` always get JSON, as does any request that sets `X-Requested-With: XMLHttpRequest` or asks for `application/json` without `text/html`. Browser navigations are unaffected and still redirect: they send `Accept: text/html,…,*/*`, and an expired session must land the user on the login page, not on raw JSON.
- **The poller no longer retries at a fixed 1s after a failure.** A failed or non-OK poll now backs off, doubling to a 30s ceiling and resetting on the next success, so an unreachable server does not get a steady 1/s stream from every open tab.

### Changed
- The poller sends `Accept: application/json` and `redirect: 'manual'`, and stops on `401`/`opaqueredirect` — reloading once so the user gets the login page instead of a tab that silently stops updating. `redirect: 'manual'` means the client stops looping even against a server that still redirects.

### Added
- `tests/server.test.js` — six cases on the auth guard: `/status`, `/logs.json` and `/dedup/status` unauthenticated return 401 JSON carrying the login path, an explicit JSON `Accept` and an `XMLHttpRequest` header both return 401, and a browser-style `Accept` still returns a 302 to `/login`. Five fail against the unfixed guard.

## [0.10.0] - 2026-08-04

Groundwork for bank reconciliation in hcs-app. Everything here is read-only
against KashFlow.

### Fixed
- **`syncConfig.transform` was never applied.** It was declared per model but only ever invoked by one hand-written line in the purchase detail fanout, so declaring a transform on any other model silently did nothing. It now runs inside `buildUpsertUpdate`, the single choke point every upsert passes through, and the redundant explicit call is gone. This is load-bearing rather than tidy-up: upserts go out through the native driver with every value wrapped in `$literal`, so Mongoose casting never runs and a `Date` field declaration alone stores whatever string KashFlow sent. A throwing transform is logged and the raw payload written, so one malformed row cannot abort a batch.
- **`bankTransaction.Date` was stored as a string.** The schema had declared it a `Date` since the collection existed while all 13,429 rows on disk held `"2022-03-31 12:00:00"`, which no date-range query can serve — `$gte` against a `Date` matches none of them. Now coerced via `prepareBankTransactionForUpsert`. Invoice header and payment-line dates get the same treatment (`prepareInvoiceForUpsert`), mirroring what purchases already had.
- **`mongoDetails` was overwritten once per account** in `upsertSimpleList`. The bank fan-outs call it per account, so a plain assignment left only the last account's captured filters. Reporting only.
- **Compound index creation was not idempotent.** Supplying explicit index names collided with the ones Mongoose `autoIndex` had already created under the driver's defaults, logging a conflict on every run. The names are now derived, and options match what the schema declares.

### Added
- **Bank reconciliations synced** (`bankreconciliations`), read-only, via a per-account fan-out alongside the existing bank-transaction loop. KashFlow's own reconciliation state is the only way to compare our reconciliation against theirs, and its `StartBalance`/`EndBalance` give free anchors for period sign-off. Fetched with `excludetransactions=true`: the per-reconciliation transaction array duplicates `banktransactions`, and pulling it hourly would be a lot of I/O for data already held. Note there is exactly **one** reconciliation in the live account — KashFlow's own reconciliation feature has effectively never been used here.
- **Soft-delete for bank transactions KashFlow no longer returns.** The mirror kept them forever; two such rows exist in the live data, last synced 9–10 July, sitting beside 13,427 that update normally on the same active account. Not cosmetic for reconciliation — a phantom line appears on hcs-app's worklist looking perfectly reconcilable and can be matched against a document it never paid for. The guards matter more than the feature: the sweep sits inside the same `try` as the fetch so a throw skips it, and the existing `if (!txs?.length) continue` rules out an empty response. Sweeping after a failed or empty fetch would mark an entire account's history deleted. Reappearance self-heals, because `buildUpsertUpdate` already writes `deletedAt: null` on every upsert. Accounts KashFlow does not return are never swept.
- **GET-only `bankReconciliations` client resource.** Deliberately no wrapper for the reconciliation create/update/delete endpoints, nor for `PUT /bankaccounts/{id}/transactionlist` or `POST /bankaccounts/assign-transaction-to-new-entity` — the last two **delete the source bank transaction** on success. hcs-app reconciles locally and never writes back; their absence from the client is the enforcement mechanism.
- Shape capture for reconciliations, resolving an account that actually has some (most have none, and an empty sample shapes nothing).
- Compound indexes for the reconciliation query paths on `banktransactions`, `invoices`, `purchases` and `bankreconciliations`.

### Notes
- Requires `@cappytech/hcs-schemas` ≥ 2.1.0 for the `bankReconciliation` entity. That dependency is a **branch tip**, not a version range, so a push to its `main` changes what the next image build installs here.
- Verified against a copy of the live database: 13,427 of 13,429 bank dates coerced (the two exceptions being the rows KashFlow had deleted), all 1,670 invoice payment-line dates converted, collection counts otherwise unchanged, and both reconciliation query paths index-served.

## [0.9.0] - 2026-07-23

### Changed
- **Repo is now 100% ESM.** The application source was already `"type": "module"`; the last remaining CommonJS file, `tailwind.config.js`, now uses `import`/`export default`. Verified with `npm run build:css` and the full vitest suite. Ready for `@cappytech/hcs-schemas` 2.0.0 (ESM) — the existing default import keeps working unchanged.

## [0.8.0] - 2026-07-23

### Added
- **Discord alerts for sync runs.** When `DISCORD_WEBHOOK_URL` is set, a run posts a colour-coded Discord embed on **failure** (always) and on **success that changed data** — per-entity count deltas (e.g. `invoices 10 → 13 (+3)`) and/or Mongo upserts. No-op successful runs stay silent, so a frequent cron doesn't spam the channel. The sender (`src/util/discord.js`) mirrors the host backup-alert scripts: emerald/red embeds, host in the footer, a custom `User-Agent` (Discord 403s some defaults), and one retry on HTTP 429 honouring `Retry-After`. It never throws or blocks a run — a Discord hiccup can't fail or delay a sync. Point it at a dedicated #sync-alerts webhook, separate from the backup webhook; leave `DISCORD_WEBHOOK_URL` unset to disable.

## [0.7.2] - 2026-07-10

### Fixed
- **`SupplierId` backfilled on purchase details.** KashFlow stopped including `SupplierId` in purchase responses (~May 2026; `SupplierCode` remains), leaving every purchase synced since without it — hcs-app's CIS dashboard and returns join purchases to suppliers on that field. The purchase detail phase now resolves `SupplierCode` → supplier `Id` via the suppliers list and fills the missing field; the run summary logs how many were backfilled. Existing documents heal on their next detail sync.

## [0.7.1] - 2026-07-10

### Fixed
- **Unpaid purchases were stamped with a CIS tax period from their issue date.** `preparePurchaseForUpsert` fell back to `IssuedDate` when no payment date existed, so unpaid invoices carried a `TaxYear`/`TaxMonth` stamp and were treated as paid by hcs-app's CIS dashboard (e.g. ~74 of tax month 3's 213 stamped purchases had no payment in the period). The stamp is now derived from payments only — earliest `PaymentLines` date, then `PaidDate` — and is written as explicit `null` when the purchase is unpaid, so stale issue-date stamps are cleared on the next sync run. CIS reports payments in the month they were made; an issue date must never place an invoice in a return.
- **Tax-period stamping picked the first payment line in array order and ignored `Date`-only lines.** It now selects the earliest payment across all lines and falls back to a line's `Date` when `PayDate` is missing (previously such lines fell through to the issue date).

## [0.7.0] - 2026-07-09

### Added
- **Ten new KashFlow entities are now synced**, extending 1-1 API parity (requires `@cappytech/hcs-schemas` 1.1.0):
  - **List-phase entities** (`upsert:lists`, best-effort — a failed fetch logs a warning and never breaks the run): `journals`, `products`, `purchaseorders`, `quotecategories`, `purchaseordercategories`, `currencies`, `countries`, `accountingperiods`, `vatreturns`.
  - **Bank transactions** (`banktransactions`): fetched per bank account via `GET /bankaccounts/{accountId}/transactions` in a new `banktransactions:fetch` stage after the list phase; a failing account is skipped with a warning.
  - New KashFlow client namespaces: `bankTransactions`, `journals`, `products`, `purchaseOrders`, `quoteCategories`, `purchaseOrderCategories`, `currencies`, `countries`, `accountingPeriods`, `vatReturns` (full CRUD where the API supports it).
  - Managed indexes for all new collections (unique `Id` — or `Number` for the two category collections — plus secondary `Number`/`Code` where applicable).
  - Manual **Pull & Sync / Debug** now also supports `journal`, `product`, `purchaseorder`, and `vatreturn` entity types.
  - All new entity counts included in the fetched-lists log and the final run summary.
  - New generic `upsertSimpleList` helper in `run.js` replaces the copy-pasted per-entity upsert blocks for the new entities.

## [0.6.0] - 2026-07-08

### Added
- **Bank accounts are now synced from KashFlow.** New `bankaccounts` collection populated in the `upsert:lists` phase alongside nominals and VAT rates, from `GET /bankaccounts` (archived accounts included so historical `PaymentLines.AccountId` values always resolve). New `BankAccount` model built from `@cappytech/hcs-schemas` 1.0.2, managed indexes (unique `Id`, secondary `Code`), and fetch counts in the run summary. Consumed by hcs-app's subcontractor draft page for a named payment-account selector.
- **KashFlow response-shape capture — because KashFlow's Swagger is incomplete.** New "Response Shapes" section on the Debug page (`POST /debug/shape`, admin + rate-limited): pick an entity, sample the live list + detail responses, and get an inferred field table (dotted/`[]` paths, type unions like `integer|null`, optional-field detection from sample presence, date-time string detection, truncated examples) in the same style as hcs-app's `apiDocsConfig.js` fields, with a Copy JSON button. The same capture runs headless via `npm run shapes` (writes `shapes/*.json`, gitignored; per-entity filter: `npm run shapes -- purchases bankAccounts`). Purchases sampling prefers a paid purchase so `PaymentLines` appears in the shape. Core in `src/sync/shapes.js` + `src/util/shape.js`.

## [0.5.5] - 2026-07-03

### Fixed
- **Stale PascalCase `DeletedAt` values persisted after records became active again.** The KashFlow API only includes `DeletedAt` in its response when a record is genuinely voided/deleted; for active records the field is simply absent. Because the upsert pipeline only wrote fields present in the KashFlow payload, a stale `DeletedAt` stored in MongoDB from an earlier deletion was never cleared when the record became active again. `DeletedAt: null` is now placed **before** the payload spread in `buildUpsertUpdate` so it acts as a default for active records (where KashFlow omits the field), while a genuinely-deleted record's `DeletedAt` from the KashFlow payload still overrides it via the spread.

## [0.5.4] - 2026-07-03

### Fixed
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
