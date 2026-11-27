import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const httpGet = vi.fn();
vi.mock('axios', () => ({
  default: { create: vi.fn(() => ({ get: (...a) => httpGet(...a) })) },
}));

const {
  parseTaxYear, taxYearOf, payRunRef, normaliseEmployee, normalisePayRunEntry,
} = await import('../src/staffology/normalise.js');
const { createStaffologyClient } = await import('../src/staffology/client.js');
const { runStaffologySync, resolveEmployerId } = await import('../src/staffology/run.js');
const { triggerStaffologySync, state } = await import('../src/staffology/controller.js');
const config = (await import('../src/config.js')).default;
const axios = (await import('axios')).default;

describe('staffology normalise', () => {
  it('maps tax years both ways and finds the tax year of a date', () => {
    expect(parseTaxYear('Year2026')).toBe(2026);
    expect(taxYearOf(new Date('2026-04-05T12:00:00Z'))).toBe(2025);
    expect(taxYearOf(new Date('2026-04-06T12:00:00Z'))).toBe(2026);
    expect(taxYearOf(new Date('2027-01-10T12:00:00Z'))).toBe(2026);
  });

  it('reads period and ordinal from a pay run list item url', () => {
    expect(payRunRef({ url: 'https://x/employers/e/payrun/Year2026/Weekly/12' })).toEqual({ period: 12, ordinal: 1 });
    expect(payRunRef({ url: '/employers/e/payrun/Year2026/Weekly/3?ordinal=2' })).toEqual({ period: 3, ordinal: 2 });
    expect(payRunRef({ metadata: { period: 7, ordinal: 1 } })).toEqual({ period: 7, ordinal: 1 });
    expect(payRunRef({ url: '/nothing' })).toBeNull();
  });

  it('normalises an employee without NI number or personal details', () => {
    const doc = normaliseEmployee({
      id: 'emp-1', status: 'Current',
      personalDetails: { firstName: 'A', lastName: 'B', niNumber: 'XX000000X', dateOfBirth: '1990-01-01' },
      employmentDetails: { payrollCode: 'P1', jobTitle: 'Joiner', starterDetails: { startDate: '2025-05-01' } },
      payOptions: { basis: 'Hourly', period: 'Weekly', baseHourlyRate: 15.5 },
    }, { employerId: 'er-1' });
    expect(doc).toMatchObject({ Source: 'staffology', ExternalId: 'emp-1', PayrollCode: 'P1', PayBasis: 'Hourly', BaseHourlyRate: 15.5 });
    expect(JSON.stringify(doc)).not.toContain('XX000000X');
    expect(JSON.stringify(doc)).not.toContain('1990');
  });

  it('normalises a pay run entry, filling gaps from the run', () => {
    const doc = normalisePayRunEntry({
      id: 'ent-1', employee: { id: 'emp-1', name: 'A B' },
      employmentDetails: { payrollCode: 'P1' },
      totals: { gross: 100, tax: 10, employeeNi: 5, employerNi: 6, employeePensionContribution: 3, employerPensionContribution: 2, netPay: 82, totalCost: 108 },
      payOptions: { regularPayLines: [{ code: 'BASICHOURLY', value: 100, rate: 10, multiplier: 10 }] },
    }, { employerId: 'er-1', run: { taxYear: 'Year2026', payPeriod: 'Weekly', period: 12, startDate: '2026-06-20', endDate: '2026-06-26', isClosed: true } });
    expect(doc).toMatchObject({
      ExternalId: 'ent-1', TaxYear: 2026, PayPeriod: 'Weekly', Period: 12, Ordinal: 1, IsClosed: true, PayrollCode: 'P1',
      Totals: { Gross: 100, EmployeePension: 3, EmployerPension: 2, NetPay: 82 },
      PayLines: [{ Code: 'BASICHOURLY', Multiplier: 10 }],
    });
    expect(doc.StartDate).toBeInstanceOf(Date);
  });
});

describe('staffology client', () => {
  beforeEach(() => httpGet.mockReset());

  it('uses Basic auth with the key as the password', () => {
    createStaffologyClient({ apiKey: 'k-123', baseURL: 'https://api.example' });
    expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://api.example',
      auth: { username: 'hcs-sync', password: 'k-123' },
    }));
  });

  it('refuses to start without a key', () => {
    expect(() => createStaffologyClient({ apiKey: '' })).toThrow(/STAFFOLOGY_API_KEY/);
  });

  it('pages until a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` }));
    httpGet.mockResolvedValueOnce({ data: full }).mockResolvedValueOnce({ data: [{ id: 'b0' }] });
    const c = createStaffologyClient({ apiKey: 'k' });
    const rows = await c.getAll('/employers');
    expect(rows).toHaveLength(101);
    expect(httpGet.mock.calls[1][1].params).toMatchObject({ pageNum: 1, pageSize: 100 });
  });

  it('stops when an endpoint ignores paging and repeats itself', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` }));
    httpGet.mockResolvedValue({ data: full });
    const rows = await createStaffologyClient({ apiKey: 'k' }).getAll('/x');
    expect(rows).toHaveLength(100);
  });

  it('retries a 429 then succeeds', async () => {
    httpGet
      .mockRejectedValueOnce({ response: { status: 429, headers: {} } })
      .mockResolvedValueOnce({ data: { ok: true } });
    const c = createStaffologyClient({ apiKey: 'k', retryDelayMs: 1 });
    await expect(c.get('/x')).resolves.toEqual({ ok: true });
  });

  it('does not retry a 401', async () => {
    httpGet.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { response: { status: 401, headers: {} } }));
    const err = await createStaffologyClient({ apiKey: 'k' }).get('/x').catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/\(401\)/);
    expect(httpGet).toHaveBeenCalledTimes(1);
  });
});

// ── run ──

function fakeModels(stored = []) {
  const docs = [...stored];
  const match = (f) => (d) => Object.entries(f).every(([k, v]) => (v && typeof v === 'object' && '$ne' in v ? d[k] !== v.$ne : d[k] === v));
  const entryModel = { countDocuments: async (f) => docs.filter(match(f)).length };
  return { models: { PayrollEmployee: {}, PayrollPayRunEntry: entryModel }, docs };
}

function fakeClient({ employers = [{ id: 'er-1' }], periods = [1, 2, 3] } = {}) {
  return {
    listEmployers: vi.fn(async () => employers),
    listEmployees: vi.fn(async () => [{ id: 'emp-1' }]),
    getEmployee: vi.fn(async () => ({ id: 'emp-1', employmentDetails: { payrollCode: 'P1' } })),
    listSchedules: vi.fn(async () => [{ payPeriod: 'Weekly', isConfigured: true }]),
    listPayRuns: vi.fn(async (_e, year) => (year === 'Year2026'
      ? periods.map((p) => ({ url: `/employers/er-1/payrun/Year2026/Weekly/${p}` }))
      : [])),
    getPayRun: vi.fn(async (_e, _y, _pp, period) => ({ period, isClosed: period < 3, entries: [{ id: `ent-${period}` }] })),
    getPayRunEntry: vi.fn(async (_e, _y, _pp, period, id) => ({ id, employmentDetails: { payrollCode: 'P1' }, totals: { gross: 100 } })),
  };
}

describe('staffology run', () => {
  const now = new Date('2026-07-01T12:00:00Z');

  it('uses the only employer, or demands STAFFOLOGY_EMPLOYER_ID when there are several', async () => {
    await expect(resolveEmployerId(fakeClient(), '')).resolves.toBe('er-1');
    await expect(resolveEmployerId(fakeClient({ employers: [{ id: 'a' }, { id: 'b' }] }), '')).rejects.toThrow(/STAFFOLOGY_EMPLOYER_ID/);
    await expect(resolveEmployerId(fakeClient({ employers: [] }), 'set')).resolves.toBe('set');
  });

  it('fetches every period the first time and upserts employees and entries', async () => {
    const client = fakeClient();
    const { models } = fakeModels();
    const upsert = vi.fn(async (_m, docs) => ({ upserted: docs.length, modified: 0 }));
    const r = await runStaffologySync({ client, models, upsert, now, yearsBack: 1 });
    expect(r.errors).toEqual([]);
    expect(r.employees.fetched).toBe(1);
    expect(r.payRuns).toMatchObject({ listed: 3, fetched: 3, skippedClosed: 0 });
    expect(r.entries.fetched).toBe(3);
    const entryDocs = upsert.mock.calls.filter(([m]) => m === models.PayrollPayRunEntry).flatMap(([, d]) => d);
    expect(entryDocs.map((d) => d.Period)).toEqual([1, 2, 3]);
    expect(entryDocs[0]).toMatchObject({ TaxYear: 2026, PayPeriod: 'Weekly', IsClosed: true });
  });

  it('skips closed periods already stored, but always refetches the latest', async () => {
    const client = fakeClient();
    const stored = [1, 2, 3].map((p) => ({ Source: 'staffology', TaxYear: 2026, PayPeriod: 'Weekly', Period: p, Ordinal: 1, IsClosed: true }));
    const { models } = fakeModels(stored);
    const upsert = vi.fn(async () => ({ upserted: 0, modified: 0 }));
    const r = await runStaffologySync({ client, models, upsert, now, yearsBack: 1 });
    expect(r.payRuns).toMatchObject({ fetched: 1, skippedClosed: 2 });
    expect(client.getPayRun).toHaveBeenCalledTimes(1);
    expect(client.getPayRun.mock.calls[0][3]).toBe(3);
  });

  it('records a failed entry and carries on', async () => {
    const client = fakeClient();
    client.getPayRunEntry.mockImplementation(async (_e, _y, _pp, period, id) => {
      if (period === 2) throw new Error('boom');
      return { id, totals: {} };
    });
    const { models } = fakeModels();
    const r = await runStaffologySync({ client, models, upsert: async (_m, d) => ({ upserted: d.length, modified: 0 }), now });
    expect(r.entries.fetched).toBe(2);
    expect(r.errors).toEqual([{ where: 'entry ent-2', message: 'boom' }]);
  });

  it('treats a tax year Staffology rejects as not set up', async () => {
    const client = fakeClient();
    client.listPayRuns.mockImplementation(async () => { const e = new Error('bad year'); e.status = 400; throw e; });
    const { models } = fakeModels();
    const r = await runStaffologySync({ client, models, upsert: async () => ({ upserted: 0, modified: 0 }), now });
    expect(r.errors).toEqual([]);
    expect(r.payRuns.listed).toBe(0);
  });
});

describe('staffology controller', () => {
  it('does nothing without an API key', async () => {
    const prev = config.staffologyApiKey;
    config.staffologyApiKey = '';
    await expect(triggerStaffologySync()).resolves.toMatchObject({ started: false, reason: 'not-configured' });
    config.staffologyApiKey = prev;
  });

  it('keeps a failure in its own state and never rejects', async () => {
    const prev = config.staffologyApiKey;
    config.staffologyApiKey = 'k';
    const out = await triggerStaffologySync({ run: async () => { throw new Error('down'); } });
    await expect(out.promise).resolves.toBeNull();
    expect(state.lastError).toBe('down');
    expect(state.isRunning).toBe(false);
    config.staffologyApiKey = prev;
  });
});
