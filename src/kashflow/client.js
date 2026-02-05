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

  const listWithFallback = async (primaryPath, fallbackPath, params = {}) => {
    try {
      return await listInternal(primaryPath, params);
    } catch (err) {
      if (err?.response?.status === 404 && fallbackPath) {
        return await listInternal(fallbackPath, params);
      }
      throw err;
    }
  };

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
        url = next; // absolute URL supported by axios; if relative, baseURL will apply
        query = undefined; // subsequent pages already encoded in next URL
      } else {
        break;
      }
    }
    return items;
  };

  const listAllWithFallback = async (primaryPath, fallbackPath, params = {}) => {
    try {
      return await listAllInternal(primaryPath, params);
    } catch (err) {
      if (err?.response?.status === 404 && fallbackPath) {
        return await listAllInternal(fallbackPath, params);
      }
      throw err;
    }
  };

  const getPaged = async (path, params = {}) => {
    const res = await http.get(path, { params });
    return res.data;
  };

  return {
    metadata: {
      get: () => http.get('/metadata').then((r) => r.data),
    },
    customers: {
      list: (params = {}) => listWithFallback('/customers', '/customers/list', params),
      listAll: (params = {}) => listAllWithFallback('/customers', '/customers/list', params),
      get: (code) => http.get(`/customers/${encodeURIComponent(code)}`).then((r) => r.data),
      create: (body) => http.post('/customers', body).then((r) => r.data),
      update: (code, body) => http.put(`/customers/${encodeURIComponent(code)}`, body).then((r) => r.data),
    },
    suppliers: {
      list: (params = {}) => listWithFallback('/suppliers', '/suppliers/list', params),
      listAll: (params = {}) => listAllWithFallback('/suppliers', '/suppliers/list', params),
      get: (code) => http.get(`/suppliers/${encodeURIComponent(code)}`).then((r) => r.data),
      create: (body) => http.post('/suppliers', body).then((r) => r.data),
      update: (code, body) => http.put(`/suppliers/${encodeURIComponent(code)}`, body).then((r) => r.data),
    },
    invoices: {
      list: (params = {}) => listWithFallback('/invoices', '/invoices/list', params),
      listAll: (params = {}) => listAllWithFallback('/invoices', '/invoices/list', params),
      get: (number) => http.get(`/invoices/${number}`).then((r) => r.data),
      create: (body) => http.post('/invoices', body).then((r) => r.data),
      update: (number, body) => http.put(`/invoices/${number}`, body).then((r) => r.data),
    },
    purchases: {
      list: (params = {}) => listWithFallback('/purchases', '/purchases/list', params),
      listAll: (params = {}) => listAllWithFallback('/purchases', '/purchases/list', params),
      get: (number) => http.get(`/purchases/${number}`).then((r) => r.data),
      create: (body) => http.post('/purchases', body).then((r) => r.data),
      update: (number, body) => http.put(`/purchases/${number}`, body).then((r) => r.data),
    },
    projects: {
      list: (params = {}) => listWithFallback('/projects', '/projects/list', params),
      listAll: (params = {}) => listAllWithFallback('/projects', '/projects/list', params),
      get: (number) => http.get(`/projects/${number}`).then((r) => r.data),
      create: (body) => http.post('/projects', body).then((r) => r.data),
      update: (number, body) => http.put(`/projects/${number}`, body).then((r) => r.data),
    },
    quotes: {
      list: (params = {}) => listWithFallback('/quotes', '/quotes/list', params),
      listAll: (params = {}) => listAllWithFallback('/quotes', '/quotes/list', params),
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
  };
}

export default createClient;