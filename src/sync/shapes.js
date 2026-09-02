/**
 * Live KashFlow response-shape capture.
 *
 * KashFlow's Swagger is incomplete, so we sample real API responses and infer
 * the shapes ourselves (see util/shape.js). Used by the debug page
 * (POST /debug/shape) and the CLI dumper (src/tools/dumpShapes.js); the
 * output feeds hcs-app's apiDocsConfig.js.
 */
import createClient from '../kashflow/client.js';
import { buildShapeReport } from '../util/shape.js';

function firstKey(items, key) {
  const it = (items || []).find((x) => x && x[key] != null);
  return it ? it[key] : undefined;
}

// Each entry: list fetch, and optionally a detail fetch keyed off the list.
export const SHAPE_ENDPOINTS = {
  customers: {
    list: (kf) => kf.customers.list({ perpage: 50 }),
    detail: (kf, items) => firstKey(items, 'Code') && kf.customers.get(firstKey(items, 'Code')),
    detailPath: '/customers/{code}',
    listPath: '/customers',
  },
  suppliers: {
    list: (kf) => kf.suppliers.list({ perpage: 50 }),
    detail: (kf, items) => firstKey(items, 'Code') && kf.suppliers.get(firstKey(items, 'Code')),
    detailPath: '/suppliers/{code}',
    listPath: '/suppliers',
  },
  invoices: {
    list: (kf) => kf.invoices.list({ perpage: 50 }),
    detail: (kf, items) => firstKey(items, 'Number') && kf.invoices.get(firstKey(items, 'Number')),
    detailPath: '/invoices/{number}',
    listPath: '/invoices',
  },
  quotes: {
    list: (kf) => kf.quotes.list({ perpage: 50 }),
    detail: (kf, items) => firstKey(items, 'Number') && kf.quotes.get(firstKey(items, 'Number')),
    detailPath: '/quotes/{number}',
    listPath: '/quotes',
  },
  purchases: {
    list: (kf) => kf.purchases.list({ perpage: 50 }),
    // Prefer a purchase that actually has payments so PaymentLines gets shaped
    detail: async (kf, items) => {
      const paid = (items || []).find((p) => (p?.TotalPaidAmount ?? 0) > 0) || items?.[0];
      return paid?.Number != null ? kf.purchases.get(paid.Number) : undefined;
    },
    detailPath: '/purchases/{number}',
    listPath: '/purchases',
  },
  projects: {
    list: (kf) => kf.projects.list({ perpage: 50 }),
    detail: (kf, items) => firstKey(items, 'Number') && kf.projects.get(firstKey(items, 'Number')),
    detailPath: '/projects/{number}',
    listPath: '/projects',
  },
  nominals: {
    list: (kf) => kf.nominals.list(),
    detail: (kf, items) => firstKey(items, 'Code') && kf.nominals.getByCode(firstKey(items, 'Code')),
    detailPath: '/nominals/{code}',
    listPath: '/nominals',
  },
  vatRates: {
    list: (kf) => kf.vatRates.list(),
    listPath: '/vat/settings/vatrates',
  },
  bankAccounts: {
    list: (kf) => kf.bankAccounts.list(),
    detail: (kf, items) => firstKey(items, 'Id') && kf.bankAccounts.get(firstKey(items, 'Id')),
    detailPath: '/bankaccounts/{id}',
    listPath: '/bankaccounts',
  },
  // Transactions are scoped under an account (like reconciliations below), so
  // the list resolves the first account that actually has rows.
  bankTransactions: {
    list: async (kf) => {
      const accounts = await kf.bankAccounts.list();
      for (const account of accounts || []) {
        if (account?.Id == null) continue;
        const rows = await kf.bankTransactions.list(account.Id, { perpage: 50 });
        if (rows?.length) return rows;
      }
      return [];
    },
    detail: async (kf, items) => {
      const first = (items || []).find((r) => r?.Id != null);
      if (!first) return undefined;
      // AccountId is not in the payload; recover it the same way the list did.
      const accounts = await kf.bankAccounts.list();
      for (const account of accounts || []) {
        if (account?.Id == null) continue;
        const rows = await kf.bankTransactions.list(account.Id, { perpage: 50 });
        if ((rows || []).some((r) => r?.Id === first.Id)) {
          return kf.bankTransactions.get(account.Id, first.Id);
        }
      }
      return undefined;
    },
    detailPath: '/bankaccounts/{bankaccountId}/transactions/{transactionId}',
    listPath: '/bankaccounts/{bankaccountId}/transactions',
  },
  // Reconciliations are scoped under an account, so the list resolves an
  // account first. Preference goes to an account that actually has
  // reconciliations — most here have none, and an empty sample shapes nothing.
  bankReconciliations: {
    list: async (kf) => {
      const accounts = await kf.bankAccounts.list();
      for (const account of accounts || []) {
        if (account?.Id == null) continue;
        const rows = await kf.bankReconciliations.list(account.Id, { perpage: 50 });
        if (rows?.length) return rows;
      }
      return [];
    },
    detail: async (kf, items) => {
      const first = (items || []).find((r) => r?.Id != null);
      if (!first) return undefined;
      // AccountId is not in the payload; recover it the same way the list did.
      const accounts = await kf.bankAccounts.list();
      for (const account of accounts || []) {
        if (account?.Id == null) continue;
        const rows = await kf.bankReconciliations.list(account.Id, { perpage: 50 });
        if ((rows || []).some((r) => r?.Id === first.Id)) {
          return kf.bankReconciliations.get(account.Id, first.Id);
        }
      }
      return undefined;
    },
    detailPath: '/bankaccounts/{bankaccountId}/reconciliations/{reconciliationId}',
    listPath: '/bankaccounts/{bankaccountId}/reconciliations',
  },
  journals: {
    list: (kf) => kf.journals.list({ perpage: 50 }),
    detail: (kf, items) => firstKey(items, 'Number') && kf.journals.get(firstKey(items, 'Number')),
    detailPath: '/journals/{number}',
    listPath: '/journals',
  },
  products: {
    list: (kf) => kf.products.list({ perpage: 50 }),
    detail: (kf, items) => firstKey(items, 'Id') && kf.products.get(firstKey(items, 'Id')),
    detailPath: '/products/{id}',
    listPath: '/products',
  },
  purchaseOrders: {
    list: (kf) => kf.purchaseOrders.list({ perpage: 50 }),
    detail: (kf, items) => firstKey(items, 'Number') && kf.purchaseOrders.get(firstKey(items, 'Number')),
    detailPath: '/purchaseorders/{number}',
    listPath: '/purchaseorders',
  },
  vatReturns: {
    list: (kf) => kf.vatReturns.list(),
    detail: (kf, items) => firstKey(items, 'Id') && kf.vatReturns.get(firstKey(items, 'Id')),
    detailPath: '/vatreturns/{id}',
    listPath: '/vatreturns',
  },
  currencies: {
    list: (kf) => kf.currencies.list(),
    detail: (kf, items) => firstKey(items, 'Id') && kf.currencies.get(firstKey(items, 'Id')),
    detailPath: '/currencies/{id}',
    listPath: '/currencies',
  },
  // List-only reference collections (no per-item detail endpoint we sync).
  quoteCategories: {
    list: (kf) => kf.quoteCategories.list(),
    listPath: '/quotecategories',
  },
  purchaseOrderCategories: {
    list: (kf) => kf.purchaseOrderCategories.list(),
    listPath: '/purchaseordercategories',
  },
  countries: {
    list: (kf) => kf.countries.list(),
    listPath: '/countries',
  },
  accountingPeriods: {
    list: (kf) => kf.accountingPeriods.list(),
    listPath: '/accountingperiods',
  },
  bankFeeds: {
    list: (kf) => kf.bankFeeds.list(),
    // Shape is undocumented in Swagger, so the detail key is a best guess; if
    // 'Id' is absent firstKey returns undefined and no detail is sampled.
    detail: (kf, items) => firstKey(items, 'Id') && kf.bankFeeds.get(firstKey(items, 'Id')),
    detailPath: '/bankfeeds/{id}',
    listPath: '/bankfeeds',
  },
  // A GET singleton, not a collection — `list` returns the settings object and
  // buildShapeReport shapes it directly (no detail fetch).
  vatSettings: {
    list: (kf) => kf.vatSettings.get(),
    listPath: '/vat/settings',
  },
  // Bulk payments have no list endpoint, and Create is a write we must never
  // call, so the record shape is sampled from BulkPayment_Get. A bulk payment
  // number only exists on a purchase settled by one, so resolve it from a
  // purchase's PaymentLines — fetching detail for up to 25 paid candidates —
  // then GET that one payment. Returns [] until a bulk payment exists to sample.
  bulkPayments: {
    list: async (kf) => {
      const purchases = await kf.purchases.list({ perpage: 100 });
      const paid = (purchases || []).filter((p) => (p?.TotalPaidAmount ?? 0) > 0).slice(0, 25);
      for (const p of paid) {
        if (p?.Number == null) continue;
        const detail = await kf.purchases.get(p.Number);
        const num = (detail?.PaymentLines || [])
          .map((l) => l?.BulkPaymentNumber)
          .find((n) => n != null);
        if (num != null) {
          const bp = await kf.bulkPayments.get('purchases', num);
          if (bp) return bp;
        }
      }
      return [];
    },
    listPath: '/purchases/bulk/payments/{number}',
  },
  // Notes are scoped to an object, so there is no top-level collection. Sample
  // the first purchase that actually carries notes — most carry none, and an
  // empty sample shapes nothing. Bounded to 25 purchases to cap the fan-out.
  notes: {
    list: async (kf) => {
      const purchases = await kf.purchases.list({ perpage: 25 });
      for (const p of (purchases || []).slice(0, 25)) {
        if (p?.Number == null) continue;
        const rows = await kf.notes.list('purchases', p.Number);
        const arr = Array.isArray(rows) ? rows : (rows?.Data || []);
        if (arr.length) return arr;
      }
      return [];
    },
    listPath: '/{objectType}/{objectNumber}/notes',
  },
};

/**
 * Capture the response shape(s) for one entity.
 * @param {string} name - key of SHAPE_ENDPOINTS
 * @param {object} [kf] - optional pre-created KashFlow client (reused across calls)
 * @returns {Promise<{entity: string, list: object, detail: object|null}>}
 */
export async function captureShape(name, kf = null) {
  const ep = SHAPE_ENDPOINTS[name];
  if (!ep) {
    const supported = Object.keys(SHAPE_ENDPOINTS).join(', ');
    throw new Error(`Unsupported entity "${name}". Supported: ${supported}`);
  }
  const client = kf || (await createClient());
  const items = await ep.list(client);
  const list = buildShapeReport(`GET ${ep.listPath}`, items);
  let detail = null;
  if (ep.detail) {
    const d = await ep.detail(client, items);
    if (d) detail = buildShapeReport(`GET ${ep.detailPath}`, d);
  }
  return { entity: name, list, detail };
}
