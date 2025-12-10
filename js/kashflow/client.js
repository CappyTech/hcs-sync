import axios from 'axios';
import config from '../config.js';
import logger from '../util/logger.js';

function createClient() {
  const http = axios.create({
    baseURL: config.baseUrl,
    timeout: config.timeoutMs,
    headers: config.token
      ? { Authorization: `Bearer ${config.token}` }
      : {},
  });

  http.interceptors.response.use(
    (res) => res,
    (err) => {
      const msg = err.response?.data || err.message;
      logger.error({ msg }, 'KashFlow API error');
      throw err;
    }
  );

  const getPaged = async (path, params = {}) => {
    const res = await http.get(path, { params });
    return res.data;
  };

  return {
    // Customers
    customers: {
      list: (params = {}) => getPaged('/customers', params),
      get: (code) => http.get(`/customers/${encodeURIComponent(code)}`).then((r) => r.data),
      create: (body) => http.post('/customers', body).then((r) => r.data),
      update: (code, body) => http.put(`/customers/${encodeURIComponent(code)}`, body).then((r) => r.data),
    },

    // Suppliers
    suppliers: {
      list: (params = {}) => getPaged('/suppliers', params),
      get: (code) => http.get(`/suppliers/${encodeURIComponent(code)}`).then((r) => r.data),
      create: (body) => http.post('/suppliers', body).then((r) => r.data),
      update: (code, body) => http.put(`/suppliers/${encodeURIComponent(code)}`, body).then((r) => r.data),
    },

    // Invoices
    invoices: {
      list: (params = {}) => getPaged('/invoices', params),
      get: (number) => http.get(`/invoices/${number}`).then((r) => r.data),
      create: (body) => http.post('/invoices', body).then((r) => r.data),
      update: (number, body) => http.put(`/invoices/${number}`, body).then((r) => r.data),
    },

    // Purchases
    purchases: {
      list: (params = {}) => getPaged('/purchases', params),
      get: (number) => http.get(`/purchases/${number}`).then((r) => r.data),
      create: (body) => http.post('/purchases', body).then((r) => r.data),
      update: (number, body) => http.put(`/purchases/${number}`, body).then((r) => r.data),
    },

    // Projects
    projects: {
      list: (params = {}) => getPaged('/projects', params),
      get: (number) => http.get(`/projects/${number}`).then((r) => r.data),
      create: (body) => http.post('/projects', body).then((r) => r.data),
      update: (number, body) => http.put(`/projects/${number}`, body).then((r) => r.data),
    },

    // Quotes
    quotes: {
      list: (params = {}) => getPaged('/quotes', params),
      get: (number) => http.get(`/quotes/${number}`).then((r) => r.data),
      create: (body) => http.post('/quotes', body).then((r) => r.data),
      update: (number, body) => http.put(`/quotes/${number}`, body).then((r) => r.data),
    },

    // Nominals (newer coverage)
    nominals: {
      list: () => http.get('/nominals').then((r) => r.data),
      getByCode: (code) => http.get(`/nominals/${encodeURIComponent(code)}`).then((r) => r.data),
      create: (body) => http.post('/nominals', body).then((r) => r.data),
      updateByCode: (code, body) => http.put(`/nominals/${encodeURIComponent(code)}`, body).then((r) => r.data),
      deleteByCode: (code) => http.delete(`/nominals/${encodeURIComponent(code)}`).then((r) => r.status === 204),
    },

    // Notes (generic, objectType per swagger: 1=Customers,2=Suppliers,3=Invoices,4=Quotes,5=Purchases,6=PurchaseOrders)
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
