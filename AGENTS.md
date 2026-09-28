# hcs-sync — KashFlow Data Adapter

hcs-sync is a dedicated **KashFlow accounting data sync service** for **Heron Constructive Solutions LTD**. It is one possible data provider for the REST MongoDB namespace that [hcs-app](https://github.com/cappytech/hcs-app) consumes.

**hcs-sync is KashFlow-specific.** It owns the KashFlow API integration — authentication, pagination, normalisation, and upsert to MongoDB. It does not know about hcs-app's internals, users, or business logic. It writes to the **REST** namespace and nothing else.

**hcs-sync is replaceable.** If the accounting provider changes (e.g. to Xero or QuickBooks), a new sync adapter would be built to write to the same REST schema contract. hcs-app would not need to change.

---

## Repository Guidelines

- Use Node.js 24.
- Install dependencies with `npm install`.
- Run `npm run lint` (ESLint) and `npm test` (Vitest) before committing.
- Ensure `git status` reports a clean working tree before you finish.
- Entry point is `src/server/index.js`; it only starts the app built by `createApp()` in `src/server/app.js`. Routes live in `src/server/routes/`, middleware in `src/server/middleware/`, and sync run state in `src/server/syncController.js`.
- All KashFlow API logic lives in `src/kashflow/`.
- Sync orchestration lives in `src/sync/run.js`.
- Models are in `src/server/models/kashflow.js` — these must conform to the REST namespace schema contract that hcs-app reads.
- When adding a new synced entity: define schema, add client methods, add fetch + upsert logic, and set `syncConfig` with `summaryKey`, `keyField` and `protectedFields` (plus `fallbackKeyFields`, `listOnly` or `lookupField` where they apply). `syncConfig` is the single source of an entity's sync metadata: the sync phases, the manual pull and the history page all derive from it via `src/sync/entities.js` — do not keep a separate list. The contract is documented at the top of `src/server/models/kashflow.js`.
