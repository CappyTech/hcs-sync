# hcs-sync — KashFlow Data Adapter

hcs-sync is a dedicated **KashFlow accounting data sync service** for **Heron Constructive Solutions LTD**. It is one possible data provider for the REST MongoDB namespace that [hcs-app](https://github.com/cappytech/hcs-app) consumes.

**hcs-sync is KashFlow-specific.** It owns the KashFlow API integration — authentication, pagination, normalisation, and upsert to MongoDB. It does not know about hcs-app's internals, users, or business logic. It writes to the **REST** namespace and nothing else.

**hcs-sync is replaceable.** If the accounting provider changes (e.g. to Xero or QuickBooks), a new sync adapter would be built to write to the same REST schema contract. hcs-app would not need to change.

---

## Repository Guidelines

- Use Node.js 20.
- Install dependencies with `npm install`.
- Run the tests with `npm test` (Vitest) before committing.
- Ensure `git status` reports a clean working tree before you finish.
- Entry point is `src/server/index.js`.
- All KashFlow API logic lives in `src/kashflow/`.
- Sync orchestration lives in `src/sync/run.js`.
- Models are in `src/server/models/kashflow.js` — these must conform to the REST namespace schema contract that hcs-app reads.
- When adding a new synced entity: define schema, add client methods, add fetch + upsert logic, set `syncConfig` with `keyField` and `protectedFields`.
