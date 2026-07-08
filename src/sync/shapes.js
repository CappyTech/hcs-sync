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
