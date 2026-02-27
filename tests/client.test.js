import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

// Mock auth so createClient doesn't attempt real HTTP
const mockGetSessionToken = vi.fn().mockResolvedValue('test-session-token');
const mockClearCachedSessionToken = vi.fn();

vi.mock('../src/kashflow/auth.js', () => ({
  getSessionToken: (...args) => mockGetSessionToken(...args),
  clearCachedSessionToken: (...args) => mockClearCachedSessionToken(...args),
}));

// We need to mock axios.create to return a controllable mock instance
vi.mock('axios', () => {
  const mockInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      response: { use: vi.fn() },
      request: { use: vi.fn() },
    },
    request: vi.fn(),
  };
  return {
    default: {
      create: vi.fn(() => mockInstance),
      __mockInstance: mockInstance,
    },
  };
});

describe('src/kashflow/client.js', () => {
  let createClient;
  let mockHttp;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../src/kashflow/client.js');
    createClient = mod.default;
    mockHttp = (await import('axios')).default.__mockInstance;
  });

  it('creates a client with resource namespaces', async () => {
    const kf = await createClient();
    expect(kf).toHaveProperty('customers');
    expect(kf).toHaveProperty('suppliers');
    expect(kf).toHaveProperty('invoices');
    expect(kf).toHaveProperty('purchases');
    expect(kf).toHaveProperty('projects');
    expect(kf).toHaveProperty('quotes');
    expect(kf).toHaveProperty('nominals');
    expect(kf).toHaveProperty('notes');
    expect(kf).toHaveProperty('metadata');
  });

  it('registers a response interceptor for 401 retry', async () => {
    await createClient();
    expect(mockHttp.interceptors.response.use).toHaveBeenCalledTimes(1);
  });

  describe('customers', () => {
    it('list calls GET /customers', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: [{ Code: 'C1' }] });
      const kf = await createClient();
      const result = await kf.customers.list();
      expect(result).toEqual([{ Code: 'C1' }]);
      expect(mockHttp.get).toHaveBeenCalledWith('/customers', { params: {} });
    });

    it('get calls GET /customers/:code', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: { Code: 'C1', Name: 'Test' } });
      const kf = await createClient();
      const result = await kf.customers.get('C1');
      expect(result).toEqual({ Code: 'C1', Name: 'Test' });
    });

    it('create calls POST /customers', async () => {
      mockHttp.post.mockResolvedValueOnce({ data: { Code: 'NEW' } });
      const kf = await createClient();
      const result = await kf.customers.create({ Name: 'New Customer' });
      expect(result).toEqual({ Code: 'NEW' });
    });

    it('update calls PUT /customers/:code', async () => {
      mockHttp.put.mockResolvedValueOnce({ data: { Code: 'C1', Name: 'Updated' } });
      const kf = await createClient();
      const result = await kf.customers.update('C1', { Name: 'Updated' });
      expect(result).toEqual({ Code: 'C1', Name: 'Updated' });
    });
  });

  describe('suppliers', () => {
    it('list calls GET /suppliers', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: [] });
      const kf = await createClient();
      await kf.suppliers.list();
      expect(mockHttp.get).toHaveBeenCalledWith('/suppliers', { params: {} });
    });
  });

  describe('invoices', () => {
    it('list calls GET /invoices', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: { Data: [{ Number: 1 }] } });
      const kf = await createClient();
      const result = await kf.invoices.list();
      expect(result).toEqual([{ Number: 1 }]);
    });
  });

  describe('nominals', () => {
    it('list calls GET /nominals', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: [{ Code: '4000' }] });
      const kf = await createClient();
      const result = await kf.nominals.list();
      expect(result).toEqual([{ Code: '4000' }]);
    });

    it('deleteByCode calls DELETE /nominals/:code', async () => {
      mockHttp.delete.mockResolvedValueOnce({ status: 204 });
      const kf = await createClient();
      const result = await kf.nominals.deleteByCode('4000');
      expect(result).toBe(true);
    });
  });

  describe('notes', () => {
    it('create calls POST /:objectType/:objectNumber/notes', async () => {
      mockHttp.post.mockResolvedValueOnce({ data: { Number: 1, Text: 'hi' } });
      const kf = await createClient();
      const result = await kf.notes.create('invoices', 123, 'hi');
      expect(mockHttp.post).toHaveBeenCalledWith('/invoices/123/notes', { Text: 'hi' });
      expect(result).toEqual({ Number: 1, Text: 'hi' });
    });
  });

  describe('listAll with pagination', () => {
    it('follows NextPageUrl for multi-page results', async () => {
      // Page 1
      mockHttp.get.mockResolvedValueOnce({
        data: {
          Data: [{ Code: 'A' }],
          MetaData: { NextPageUrl: '/customers?page=2' },
        },
      });
      // Page 2
      mockHttp.get.mockResolvedValueOnce({
        data: {
          Data: [{ Code: 'B' }],
          MetaData: { NextPageUrl: null },
        },
      });

      const kf = await createClient();
      const result = await kf.customers.listAll();
      expect(result).toEqual([{ Code: 'A' }, { Code: 'B' }]);
      expect(mockHttp.get).toHaveBeenCalledTimes(2);
    });
  });

  // ── buildAuthHeaders (tested via axios.create headers) ────────────────

  describe('buildAuthHeaders', () => {
    it('uses Bearer for KF_ prefixed tokens', async () => {
      mockGetSessionToken.mockResolvedValueOnce('KF_abc123');
      await createClient();
      const headers = axios.create.mock.calls.at(-1)[0].headers;
      expect(headers.Authorization).toBe('Bearer KF_abc123');
      expect(headers['X-SessionToken']).toBe('KF_abc123');
    });

    it('uses KfToken for GUID tokens', async () => {
      mockGetSessionToken.mockResolvedValueOnce('12345678-1234-1234-8234-123456789abc');
      await createClient();
      const headers = axios.create.mock.calls.at(-1)[0].headers;
      expect(headers.Authorization).toBe('KfToken 12345678-1234-1234-8234-123456789abc');
    });

    it('normalizes 32-hex GUID (no dashes) to 8-4-4-4-12', async () => {
      mockGetSessionToken.mockResolvedValueOnce('12345678123412348234123456789abc');
      await createClient();
      const headers = axios.create.mock.calls.at(-1)[0].headers;
      expect(headers.Authorization).toBe('KfToken 12345678-1234-1234-8234-123456789abc');
    });

    it('strips wrapping quotes from token', async () => {
      mockGetSessionToken.mockResolvedValueOnce('"KF_quoted"');
      await createClient();
      const headers = axios.create.mock.calls.at(-1)[0].headers;
      expect(headers.Authorization).toBe('Bearer KF_quoted');
    });

    it('uses Bearer for non-KF non-GUID tokens', async () => {
      mockGetSessionToken.mockResolvedValueOnce('random-token-value');
      await createClient();
      const headers = axios.create.mock.calls.at(-1)[0].headers;
      expect(headers.Authorization).toBe('Bearer random-token-value');
    });
  });

  // ── No session token error ────────────────────────────────────────────

  describe('no session token', () => {
    it('throws when getSessionToken returns null', async () => {
      mockGetSessionToken.mockResolvedValueOnce(null);
      await expect(createClient()).rejects.toThrow(/No session token/);
    });

    it('throws when getSessionToken returns empty string', async () => {
      mockGetSessionToken.mockResolvedValueOnce('');
      await expect(createClient()).rejects.toThrow(/No session token/);
    });
  });

  // ── 401 interceptor actual retry ──────────────────────────────────────

  describe('401 interceptor retry', () => {
    it('retries with a fresh token on 401', async () => {
      const kf = await createClient();
      // Get the error interceptor
      const errorHandler = mockHttp.interceptors.response.use.mock.calls[0][1];

      mockGetSessionToken.mockResolvedValueOnce('new-token-after-refresh');
      mockHttp.request.mockResolvedValueOnce({ data: 'success' });

      const err = {
        response: { status: 401, data: 'Unauthorized' },
        config: { url: '/test', headers: {}, baseURL: 'http://api' },
        message: 'Unauthorized',
      };
      const result = await errorHandler(err);
      expect(mockClearCachedSessionToken).toHaveBeenCalled();
      expect(mockHttp.request).toHaveBeenCalledTimes(1);
      expect(result.data).toBe('success');
    });

    it('does not retry twice (marks __retried)', async () => {
      const kf = await createClient();
      const errorHandler = mockHttp.interceptors.response.use.mock.calls[0][1];

      const err = {
        response: { status: 401, data: 'Unauthorized' },
        config: { url: '/test', headers: {}, baseURL: 'http://api', __retried: true },
        message: 'Unauthorized',
      };
      await expect(errorHandler(err)).rejects.toBeDefined();
    });

    it('does not retry non-401 errors', async () => {
      const kf = await createClient();
      const errorHandler = mockHttp.interceptors.response.use.mock.calls[0][1];

      const err = {
        response: { status: 500, data: 'Server Error' },
        config: { url: '/test', headers: {}, baseURL: 'http://api' },
        message: 'Server Error',
      };
      await expect(errorHandler(err)).rejects.toBeDefined();
      expect(mockClearCachedSessionToken).not.toHaveBeenCalled();
    });
  });

  // ── listWithFallback 404 ──────────────────────────────────────────────

  describe('listWithFallback', () => {
    it('falls back to /customers/list on 404', async () => {
      const err404 = new Error('Not Found');
      err404.response = { status: 404 };
      mockHttp.get
        .mockRejectedValueOnce(err404) // primary fails
        .mockResolvedValueOnce({ data: [{ Code: 'FB' }] }); // fallback

      const kf = await createClient();
      const result = await kf.customers.list();
      expect(result).toEqual([{ Code: 'FB' }]);
      expect(mockHttp.get).toHaveBeenCalledTimes(2);
    });

    it('throws non-404 errors without falling back', async () => {
      const err500 = new Error('Server Error');
      err500.response = { status: 500 };
      mockHttp.get.mockRejectedValueOnce(err500);

      const kf = await createClient();
      await expect(kf.customers.list()).rejects.toThrow('Server Error');
    });
  });

  // ── suppliers CRUD ────────────────────────────────────────────────────

  describe('suppliers CRUD', () => {
    it('get calls GET /suppliers/:code', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: { Code: 'S1', Name: 'Sup' } });
      const kf = await createClient();
      const result = await kf.suppliers.get('S1');
      expect(result).toEqual({ Code: 'S1', Name: 'Sup' });
    });
    it('create calls POST /suppliers', async () => {
      mockHttp.post.mockResolvedValueOnce({ data: { Code: 'SNEW' } });
      const kf = await createClient();
      const result = await kf.suppliers.create({ Name: 'New' });
      expect(result).toEqual({ Code: 'SNEW' });
    });
    it('update calls PUT /suppliers/:code', async () => {
      mockHttp.put.mockResolvedValueOnce({ data: { Code: 'S1' } });
      const kf = await createClient();
      const result = await kf.suppliers.update('S1', { Name: 'Upd' });
      expect(result).toEqual({ Code: 'S1' });
    });
  });

  // ── invoices CRUD ─────────────────────────────────────────────────────

  describe('invoices CRUD', () => {
    it('get calls GET /invoices/:number', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: { Number: 1 } });
      const kf = await createClient();
      expect(await kf.invoices.get(1)).toEqual({ Number: 1 });
    });
    it('create calls POST /invoices', async () => {
      mockHttp.post.mockResolvedValueOnce({ data: { Number: 2 } });
      const kf = await createClient();
      expect(await kf.invoices.create({ Total: 50 })).toEqual({ Number: 2 });
    });
    it('update calls PUT /invoices/:number', async () => {
      mockHttp.put.mockResolvedValueOnce({ data: { Number: 1, Total: 100 } });
      const kf = await createClient();
      expect(await kf.invoices.update(1, { Total: 100 })).toEqual({ Number: 1, Total: 100 });
    });
  });

  // ── purchases CRUD ────────────────────────────────────────────────────

  describe('purchases CRUD', () => {
    it('list calls GET /purchases', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: [] });
      const kf = await createClient();
      await kf.purchases.list();
      expect(mockHttp.get).toHaveBeenCalledWith('/purchases', { params: {} });
    });
    it('get calls GET /purchases/:number', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: { Number: 10 } });
      const kf = await createClient();
      expect(await kf.purchases.get(10)).toEqual({ Number: 10 });
    });
    it('create calls POST /purchases', async () => {
      mockHttp.post.mockResolvedValueOnce({ data: { Number: 11 } });
      const kf = await createClient();
      expect(await kf.purchases.create({})).toEqual({ Number: 11 });
    });
    it('update calls PUT /purchases/:number', async () => {
      mockHttp.put.mockResolvedValueOnce({ data: { Number: 10 } });
      const kf = await createClient();
      expect(await kf.purchases.update(10, {})).toEqual({ Number: 10 });
    });
  });

  // ── projects CRUD ─────────────────────────────────────────────────────

  describe('projects CRUD', () => {
    it('list calls GET /projects', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: [] });
      const kf = await createClient();
      await kf.projects.list();
      expect(mockHttp.get).toHaveBeenCalledWith('/projects', { params: {} });
    });
    it('get calls GET /projects/:number', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: { Number: 5 } });
      const kf = await createClient();
      expect(await kf.projects.get(5)).toEqual({ Number: 5 });
    });
    it('create calls POST /projects', async () => {
      mockHttp.post.mockResolvedValueOnce({ data: { Number: 6 } });
      const kf = await createClient();
      expect(await kf.projects.create({})).toEqual({ Number: 6 });
    });
    it('update calls PUT /projects/:number', async () => {
      mockHttp.put.mockResolvedValueOnce({ data: { Number: 5 } });
      const kf = await createClient();
      expect(await kf.projects.update(5, {})).toEqual({ Number: 5 });
    });
  });

  // ── quotes CRUD ───────────────────────────────────────────────────────

  describe('quotes CRUD', () => {
    it('list calls GET /quotes', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: [] });
      const kf = await createClient();
      await kf.quotes.list();
      expect(mockHttp.get).toHaveBeenCalledWith('/quotes', { params: {} });
    });
    it('get calls GET /quotes/:number', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: { Number: 3 } });
      const kf = await createClient();
      expect(await kf.quotes.get(3)).toEqual({ Number: 3 });
    });
    it('create calls POST /quotes', async () => {
      mockHttp.post.mockResolvedValueOnce({ data: { Number: 4 } });
      const kf = await createClient();
      expect(await kf.quotes.create({})).toEqual({ Number: 4 });
    });
    it('update calls PUT /quotes/:number', async () => {
      mockHttp.put.mockResolvedValueOnce({ data: { Number: 3 } });
      const kf = await createClient();
      expect(await kf.quotes.update(3, {})).toEqual({ Number: 3 });
    });
  });

  // ── nominals extended ─────────────────────────────────────────────────

  describe('nominals extended', () => {
    it('getByCode calls GET /nominals/:code', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: { Code: '4000', Name: 'Sales' } });
      const kf = await createClient();
      expect(await kf.nominals.getByCode('4000')).toEqual({ Code: '4000', Name: 'Sales' });
    });
    it('create calls POST /nominals', async () => {
      mockHttp.post.mockResolvedValueOnce({ data: { Code: '5000' } });
      const kf = await createClient();
      expect(await kf.nominals.create({ Name: 'Cost' })).toEqual({ Code: '5000' });
    });
    it('updateByCode calls PUT /nominals/:code', async () => {
      mockHttp.put.mockResolvedValueOnce({ data: { Code: '4000' } });
      const kf = await createClient();
      expect(await kf.nominals.updateByCode('4000', { Name: 'Updated' })).toEqual({ Code: '4000' });
    });
  });

  // ── notes extended ────────────────────────────────────────────────────

  describe('notes extended', () => {
    it('list calls GET /:objectType/:objectNumber/notes', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: [{ Number: 1 }] });
      const kf = await createClient();
      const result = await kf.notes.list('invoices', 10);
      expect(mockHttp.get).toHaveBeenCalledWith('/invoices/10/notes');
      expect(result).toEqual([{ Number: 1 }]);
    });
    it('get calls GET /:objectType/:objectNumber/notes/:number', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: { Number: 2, Text: 'hi' } });
      const kf = await createClient();
      expect(await kf.notes.get('invoices', 10, 2)).toEqual({ Number: 2, Text: 'hi' });
    });
    it('update calls PUT /:objectType/:objectNumber/notes/:number', async () => {
      mockHttp.put.mockResolvedValueOnce({ data: { Number: 2, Text: 'updated' } });
      const kf = await createClient();
      expect(await kf.notes.update('invoices', 10, 2, 'updated')).toEqual({ Number: 2, Text: 'updated' });
    });
    it('delete calls DELETE and returns boolean', async () => {
      mockHttp.delete.mockResolvedValueOnce({ status: 204 });
      const kf = await createClient();
      expect(await kf.notes.delete('invoices', 10, 2)).toBe(true);
    });
  });

  // ── metadata ──────────────────────────────────────────────────────────

  describe('metadata', () => {
    it('get calls GET /metadata', async () => {
      mockHttp.get.mockResolvedValueOnce({ data: { OrganisationName: 'Test' } });
      const kf = await createClient();
      expect(await kf.metadata.get()).toEqual({ OrganisationName: 'Test' });
    });
  });
});
