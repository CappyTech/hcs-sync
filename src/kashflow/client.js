import axios from 'axios';
import config from '../config.js';
import logger from '../util/logger.js';
import { getSessionToken, clearCachedSessionToken } from './auth.js';

function buildAuthHeaders(token) {
  let t = String(token || '').trim();
  // Allow tokens copied from UIs/env files that may include wrapping quotes.
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      t = t.slice(1, -1).trim();
    }
  }

  // Some UIs/API responses omit GUID dashes; normalize 32-hex into 8-4-4-4-12.
  if (/^[0-9a-fA-F]{32}$/.test(t)) {
    t = `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20)}`;
  }
  const isKF = t.startsWith('KF_');
  const isGuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(t);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (isKF) {
    headers.Authorization = `Bearer ${t}`;
  } else if (isGuid) {
    headers.Authorization = `KfToken ${t}`;
  } else {
    headers.Authorization = `Bearer ${t}`;
  }
  // Some deployments also accept this header
  headers['X-SessionToken'] = t;
  return { headers, isKF, isGuid, token: t };
}

async function createClient() {
  const sessionToken = await getSessionToken();
  if (!sessionToken) {
    throw new Error('No session token available');
  }
  const { headers: defaultHeaders, isKF, isGuid, token: sanitizedToken } = buildAuthHeaders(sessionToken);
  if (!isKF && !isGuid) {
    logger.warn({ tokenPrefix: String(sanitizedToken).slice(0, 8) }, 'SESSION_TOKEN format is unexpected (neither KF_ nor GUID)');
  }
  const http = axios.create({
    baseURL: config.baseUrl,
    timeout: config.timeoutMs,
    headers: defaultHeaders,
  });

  /**
   * KashFlow's SQL layer timing out, which it reports as a 400.
   *
   * The body is `{ Error: "-2146232060", Message: "Execution Timeout Expired. …" }`
   * — a .NET SqlException surfaced verbatim, not a client error. It is entirely
   * server-side, so `HTTP_TIMEOUT_MS` does not cover it and never will: the
   * request completes promptly, carrying a failure.
   *
   * It hits the largest account (611594, ~8,400 transactions over ~40 paginated
   * requests) roughly nightly. Without a retry, one bad page aborts that
   * account for the whole run and 8,413 rows silently drop out of the fetch —
   * the account looks stale for an hour and the Discord alert reads like mass
   * deletion. Matched on the numeric code rather than the message text, which
   * is human-readable prose and not a contract.
   */
  const SQL_TIMEOUT_CODE = '-2146232060';
  const isTransientBackendTimeout = (err) => {
    if (err.response?.status !== 400) return false;
    const body = err.response?.data;
    return String(body?.Error ?? '') === SQL_TIMEOUT_CODE;
  };

  // Four attempts, not two. Measured over three days of logs: 25 of these
  // timeouts fired, 23 cleared on the first or second retry and 2 exhausted the
  // pair — both on 611594, both on the 01:00 run, when KashFlow's database is
  // evidently busiest (they cluster 00:00–03:00). Each attempt costs ~30s
  // server-side, so the worst case here is ~3 minutes on one account against an
  // hourly cron and a run that already takes ~4 minutes. Cheap insurance
  // against losing a whole account's fetch for an hour.
  const RETRY_DELAYS_MS = [2000, 8000, 20000, 45000];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Retry once on 401 by refreshing the session token
  http.interceptors.response.use(
    (res) => res,
    async (err) => {
      const status = err.response?.status;
      const msg = err.response?.data || err.message;
      const url = err.config ? `${err.config.baseURL || ''}${err.config.url || ''}` : '';
      const original = err.config;
      if (status === 401 && !original.__retried) {
        try {
          clearCachedSessionToken();
          const newToken = await getSessionToken();
          const built = buildAuthHeaders(newToken);
          original.headers = { ...(original.headers || {}), ...built.headers };
          original.__retried = true;
          return http.request(original);
        } catch (e) {
          logger.error({ msg: e.message }, 'Re-auth attempt failed');
        }
      }
      // Backed off rather than immediate: the timeout means KashFlow's database
      // is already struggling, so retrying instantly tends to reproduce it.
      if (isTransientBackendTimeout(err)) {
        const attempt = original.__timeoutRetries || 0;
        if (attempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[attempt];
          original.__timeoutRetries = attempt + 1;
          logger.warn(
            { url, attempt: attempt + 1, of: RETRY_DELAYS_MS.length, delayMs: delay },
            'KashFlow backend timeout; retrying',
          );
          await sleep(delay);
          return http.request(original);
        }
        logger.error(
          { url, attempts: RETRY_DELAYS_MS.length },
          'KashFlow backend timeout persisted after retries',
        );
      }

      logger.error({ status, url, msg }, 'KashFlow API error');
      throw err;
    }
  );

  const normalizeList = (payload) => {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.Data)) return payload.Data;
    return [];
  };

  const listInternal = async (path, params = {}) => {
    const res = await http.get(path, { params });
    return normalizeList(res.data);
  };

  // All-or-nothing on purpose: a page that fails discards the pages already
  // collected. That looks wasteful and is not — bank transactions feed
  // sweepMissingBankTransactions, which soft-deletes anything the fetch did not
  // return for that account. Handing back a partial list would present ~8,000
  // real rows as deleted from KashFlow. The caller must never see a short list
  // it cannot distinguish from a complete one.
  const listAllInternal = async (path, params = {}) => {
    let items = [];
    let url = path;
    let query = params;
    while (true) {
      const res = await http.get(url, { params: query });
      const data = res.data;
      items = items.concat(normalizeList(data));
      const next = data?.MetaData?.NextPageUrl || data?.MetaData?.NextPageURL;
      if (next) {
        url = next;
        query = undefined;
      } else {
        break;
      }
    }
    return items;
  };

  return {
    customers: {
      list: (params = {}) => listInternal('/customers', params),
      listAll: (params = {}) => listAllInternal('/customers', params),
      get: (code) => http.get(`/customers/${encodeURIComponent(code)}`).then((r) => r.data),
      create: (body) => http.post('/customers', body).then((r) => r.data),
      update: (code, body) => http.put(`/customers/${encodeURIComponent(code)}`, body).then((r) => r.data),
    },
    suppliers: {
      list: (params = {}) => listInternal('/suppliers', params),
      listAll: (params = {}) => listAllInternal('/suppliers', params),
      get: (code) => http.get(`/suppliers/${encodeURIComponent(code)}`).then((r) => r.data),
      create: (body) => http.post('/suppliers', body).then((r) => r.data),
      update: (code, body) => http.put(`/suppliers/${encodeURIComponent(code)}`, body).then((r) => r.data),
    },
    invoices: {
      list: (params = {}) => listInternal('/invoices', params),
      listAll: (params = {}) => listAllInternal('/invoices', params),
      get: (number) => http.get(`/invoices/${number}`).then((r) => r.data),
      create: (body) => http.post('/invoices', body).then((r) => r.data),
      update: (number, body) => http.put(`/invoices/${number}`, body).then((r) => r.data),
    },
    purchases: {
      list: (params = {}) => listInternal('/purchases', params),
      listAll: (params = {}) => listAllInternal('/purchases', params),
      get: (number) => http.get(`/purchases/${number}`).then((r) => r.data),
      create: (body) => http.post('/purchases', body).then((r) => r.data),
      update: (number, body) => http.put(`/purchases/${number}`, body).then((r) => r.data),
    },
    projects: {
      list: (params = {}) => listInternal('/projects', params),
      listAll: (params = {}) => listAllInternal('/projects', params),
      get: (number) => http.get(`/projects/${number}`).then((r) => r.data),
      create: (body) => http.post('/projects', body).then((r) => r.data),
      update: (number, body) => http.put(`/projects/${number}`, body).then((r) => r.data),
    },
    quotes: {
      list: (params = {}) => listInternal('/quotes', params),
      listAll: (params = {}) => listAllInternal('/quotes', params),
      get: (number) => http.get(`/quotes/${number}`).then((r) => r.data),
      create: (body) => http.post('/quotes', body).then((r) => r.data),
      update: (number, body) => http.put(`/quotes/${number}`, body).then((r) => r.data),
    },
    nominals: {
      list: () => http.get('/nominals').then((r) => normalizeList(r.data)),
      getByCode: (code) => http.get(`/nominals/${encodeURIComponent(code)}`).then((r) => r.data),
      create: (body) => http.post('/nominals', body).then((r) => r.data),
      updateByCode: (code, body) => http.put(`/nominals/${encodeURIComponent(code)}`, body).then((r) => r.data),
      deleteByCode: (code) => http.delete(`/nominals/${encodeURIComponent(code)}`).then((r) => r.status === 204),
    },
    notes: {
      list: (objectType, objectNumber) => http.get(`/${objectType}/${objectNumber}/notes`).then((r) => r.data),
      get: (objectType, objectNumber, number) => http.get(`/${objectType}/${objectNumber}/notes/${number}`).then((r) => r.data),
      create: (objectType, objectNumber, text) => http.post(`/${objectType}/${objectNumber}/notes`, { Text: text }).then((r) => r.data),
      update: (objectType, objectNumber, number, text) => http.put(`/${objectType}/${objectNumber}/notes/${number}`, { Number: number, Text: text }).then((r) => r.data),
      delete: (objectType, objectNumber, number) => http.delete(`/${objectType}/${objectNumber}/notes/${number}`).then((r) => r.status === 204),
    },
    vatRates: {
      list: () => http.get('/vat/settings/vatrates').then((r) => normalizeList(r.data)),
    },
    bankAccounts: {
      // Include archived accounts so historical PaymentLines.AccountId always resolves
      list: (params = {}) => listInternal('/bankaccounts', { includeArchivedAccounts: true, ...params }),
      get: (id) => http.get(`/bankaccounts/${id}`).then((r) => r.data),
    },
    bankTransactions: {
      list: (accountId, params = {}) => listInternal(`/bankaccounts/${accountId}/transactions`, params),
      listAll: (accountId, params = {}) => listAllInternal(`/bankaccounts/${accountId}/transactions`, params),
      get: (accountId, transactionId) => http.get(`/bankaccounts/${accountId}/transactions/${transactionId}`).then((r) => r.data),
    },
    // READ-ONLY BY DESIGN. hcs-app reconciles locally and never writes back to
    // KashFlow, so the create/update/delete reconciliation endpoints are
    // deliberately absent from this client — as are
    // `PUT /bankaccounts/{id}/transactionlist` and
    // `POST /bankaccounts/assign-transaction-to-new-entity`, both of which
    // DELETE the source bank transaction on success. Their absence here is the
    // enforcement mechanism; do not add them without revisiting that decision.
    bankReconciliations: {
      list: (accountId, params = {}) =>
        listInternal(`/bankaccounts/${accountId}/reconciliations`, params),
      listAll: (accountId, params = {}) =>
        listAllInternal(`/bankaccounts/${accountId}/reconciliations`, params),
      get: (accountId, reconciliationId, params = {}) =>
        http
          .get(`/bankaccounts/${accountId}/reconciliations/${reconciliationId}`, { params })
          .then((r) => r.data),
      metadata: (accountId) =>
        http
          .get(`/bankaccounts/${accountId}/reconciliations/metadata`)
          .then((r) => r.data),
    },
    // Read-only, like the rest of this client. Bank feeds are the connections
    // KashFlow pulls statement lines from; their response shape is undocumented
    // in Swagger, which is why exposing them for the shape sampler is useful.
    bankFeeds: {
      list: (params = {}) => listInternal('/bankfeeds', params),
      get: (id) => http.get(`/bankfeeds/${id}`).then((r) => r.data),
    },
    // GET-only VAT settings singleton (the detailed one — FRS nominals, cash
    // accounting, MOSS, lock-transaction). No collection; `get` returns the object.
    vatSettings: {
      get: () => http.get('/vat/settings').then((r) => r.data),
    },
    journals: {
      list: (params = {}) => listInternal('/journals', params),
      listAll: (params = {}) => listAllInternal('/journals', params),
      get: (number) => http.get(`/journals/${number}`).then((r) => r.data),
      create: (body) => http.post('/journals', body).then((r) => r.data),
      update: (number, body) => http.put(`/journals/${number}`, body).then((r) => r.data),
      delete: (number) => http.delete(`/journals/${number}`).then((r) => r.status === 204),
    },
    products: {
      list: (params = {}) => listInternal('/products', params),
      listAll: (params = {}) => listAllInternal('/products', params),
      get: (id) => http.get(`/products/${id}`).then((r) => r.data),
      create: (body) => http.post('/products', body).then((r) => r.data),
      update: (id, body) => http.put(`/products/${id}`, body).then((r) => r.data),
      delete: (id) => http.delete(`/products/${id}`).then((r) => r.status === 204),
    },
    purchaseOrders: {
      list: (params = {}) => listInternal('/purchaseorders', params),
      listAll: (params = {}) => listAllInternal('/purchaseorders', params),
      get: (number) => http.get(`/purchaseorders/${number}`).then((r) => r.data),
      create: (body) => http.post('/purchaseorders', body).then((r) => r.data),
      update: (number, body) => http.put(`/purchaseorders/${number}`, body).then((r) => r.data),
    },
    quoteCategories: {
      list: () => http.get('/quotecategories').then((r) => normalizeList(r.data)),
      create: (body) => http.post('/quotecategories', body).then((r) => r.data),
      update: (number, body) => http.put(`/quotecategories/${number}`, body).then((r) => r.data),
      delete: (number) => http.delete(`/quotecategories/${number}`).then((r) => r.status === 204),
    },
    purchaseOrderCategories: {
      list: () => http.get('/purchaseordercategories').then((r) => normalizeList(r.data)),
      create: (body) => http.post('/purchaseordercategories', body).then((r) => r.data),
      update: (number, body) => http.put(`/purchaseordercategories/${number}`, body).then((r) => r.data),
      delete: (number) => http.delete(`/purchaseordercategories/${number}`).then((r) => r.status === 204),
    },
    currencies: {
      list: () => http.get('/currencies').then((r) => normalizeList(r.data)),
      get: (id) => http.get(`/currencies/${id}`).then((r) => r.data),
      create: (body) => http.post('/currencies', body).then((r) => r.data),
      update: (id, body) => http.put(`/currencies/${id}`, body).then((r) => r.data),
      delete: (id) => http.delete(`/currencies/${id}`).then((r) => r.status === 204),
    },
    countries: {
      list: () => http.get('/countries').then((r) => normalizeList(r.data)),
    },
    accountingPeriods: {
      list: () => http.get('/accountingperiods').then((r) => normalizeList(r.data)),
      create: (body) => http.post('/accountingperiods', body).then((r) => r.data),
      delete: (id) => http.delete(`/accountingperiods/${id}`).then((r) => r.status === 204),
    },
    vatReturns: {
      // page=0 & pagesize=0 returns all records
      list: (params = {}) => listInternal('/vatreturns', { page: 0, pagesize: 0, status: 0, ...params }),
      get: (id) => http.get(`/vatreturns/${id}`).then((r) => r.data),
    },
  };
}

export default createClient;