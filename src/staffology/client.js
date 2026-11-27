import axios from 'axios';
import config from '../config.js';
import logger from '../util/logger.js';

/**
 * Read-only Staffology Payroll API client.
 *
 * Auth is HTTP Basic: the API key is the password and the username can be
 * anything (Staffology's OpenAPI securitySchemes). A key carries the
 * permissions of the Staffology user who created it.
 *
 * Paging is zero-based pageNum + pageSize. Rate limits are not documented, so
 * 429 and 5xx are retried with backoff (honouring Retry-After).
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 200;
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createStaffologyClient({
  apiKey = config.staffologyApiKey,
  baseURL = config.staffologyBaseUrl,
  timeout = config.timeoutMs,
  retryDelayMs = 1000,
} = {}) {
  if (!apiKey) throw new Error('STAFFOLOGY_API_KEY is not set');

  const http = axios.create({
    baseURL,
    timeout,
    auth: { username: 'hcs-sync', password: apiKey },
    headers: { Accept: 'application/json' },
  });

  async function get(path, params = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await http.get(path, { params });
        return res.data;
      } catch (err) {
        const status = err?.response?.status;
        const retryable = status === 429 || (status >= 500 && status < 600) || err?.code === 'ECONNRESET';
        if (!retryable || attempt >= MAX_RETRIES) {
          const e = new Error(`Staffology GET ${path} failed${status ? ` (${status})` : ''}: ${err?.message || 'error'}`);
          e.status = status;
          throw e;
        }
        const retryAfter = Number(err?.response?.headers?.['retry-after']);
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelayMs * 2 ** attempt;
        logger.warn({ path, status, attempt: attempt + 1, wait }, 'Staffology request retrying');
        await sleep(wait);
      }
    }
  }

  /**
   * Every page of a list endpoint. Stops on a short page, and also when a page
   * repeats the previous one (an endpoint that ignores paging returns the whole
   * list every time).
   */
  async function getAll(path, params = {}) {
    const out = [];
    let prevFirst;
    for (let pageNum = 0; pageNum < MAX_PAGES; pageNum += 1) {
      const page = await get(path, { ...params, pageNum, pageSize: PAGE_SIZE });
      const rows = Array.isArray(page) ? page : [];
      if (!rows.length) break;
      const first = rows[0]?.id ?? JSON.stringify(rows[0]);
      if (pageNum > 0 && first === prevFirst) break;
      prevFirst = first;
      out.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    return out;
  }

  /** Some single-item endpoints are documented as returning an array. */
  const one = (data) => (Array.isArray(data) ? data[0] ?? null : data ?? null);

  const enc = encodeURIComponent;

  return {
    get,
    getAll,
    listEmployers: () => getAll('/employers'),
    listEmployees: (employerId) => getAll(`/employers/${enc(employerId)}/employees`),
    getEmployee: async (employerId, id) => one(await get(`/employers/${enc(employerId)}/employees/${enc(id)}`)),
    listSchedules: (employerId, taxYear) => get(`/employers/${enc(employerId)}/schedules/${enc(taxYear)}`),
    listPayRuns: (employerId, taxYear, payPeriod) =>
      get(`/employers/${enc(employerId)}/payrun/${enc(taxYear)}/${enc(payPeriod)}`),
    getPayRun: (employerId, taxYear, payPeriod, period, ordinal) =>
      get(`/employers/${enc(employerId)}/payrun/${enc(taxYear)}/${enc(payPeriod)}/${enc(period)}`,
        // Entries are paged on this endpoint too; one large page covers a small payroll.
        { pageNum: 0, pageSize: 500, ...(ordinal ? { ordinal } : {}) }),
    getPayRunEntry: async (employerId, taxYear, payPeriod, period, entryId, ordinal) =>
      one(await get(
        `/employers/${enc(employerId)}/payrun/${enc(taxYear)}/${enc(payPeriod)}/${enc(period)}/${enc(entryId)}`,
        ordinal ? { ordinal } : {},
      )),
  };
}

export default createStaffologyClient;
