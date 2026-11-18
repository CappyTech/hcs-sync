/**
 * Projects are listed per customer.
 *
 * KashFlow's GET /projects is a bare array capped at 200 rows: it ignores
 * `page` and returns 200 rows however large `perpage` is (0.17.2 and 0.17.3
 * still listed exactly 200 against about 1,500 jobs). GET
 * /customers/{code}/projects is paginated, so listProjects walks every
 * customer and merges in the GET /projects page for projects with no customer.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/util/logger.js', () => {
  const noop = vi.fn();
  return { default: { info: noop, warn: noop, error: noop, debug: noop, trace: noop, child: () => ({ info: noop, warn: noop, error: noop, debug: noop }) } };
});
vi.mock('../src/kashflow/client.js', () => ({ default: vi.fn() }));
vi.mock('../src/server/progress.js', () => ({
  default: { setStage: vi.fn(), setItemTotal: vi.fn(), setItemDone: vi.fn(), incItem: vi.fn() },
}));
vi.mock('../src/db/mongoose.js', () => ({ isMongooseEnabled: vi.fn(() => false), connectMongoose: vi.fn() }));
vi.mock('../src/db/mongo.js', () => ({ ensureKashflowIndexes: vi.fn() }));
vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));

import { listProjects, CUSTOMER_PROJECTS_PERPAGE } from '../src/sync/run.js';

const range = (from, n, extra = {}) => Array.from({ length: n }, (_, i) => ({ Number: from + i, ...extra }));

function fakeKf({ recent = [], byCustomer = {} } = {}) {
  return {
    projects: {
      listAll: vi.fn(async () => structuredClone(recent)),
      listAllForCustomer: vi.fn(async (code) => {
        const v = byCustomer[code];
        if (v instanceof Error) throw v;
        return structuredClone(v || []);
      }),
    },
  };
}

describe('listProjects()', () => {
  it('lists every customer\'s projects, past the 200-row cap of GET /projects', async () => {
    const kf = fakeKf({
      recent: range(41101, 200, { CustomerCode: 'PLUS01' }), // the newest 200
      byCustomer: { PLUS01: range(40000, 1301, { CustomerCode: 'PLUS01' }), KNOW01: range(39000, 40, { CustomerCode: 'KNOW01' }) },
    });
    const { projects: result, seenByCustomer, fromCustomers } = await listProjects(kf, [{ Code: 'PLUS01' }, { Code: 'KNOW01' }]);

    expect(result).toHaveLength(1341);
    expect(new Set(result.map((p) => p.Number)).size).toBe(1341);
    expect(kf.projects.listAllForCustomer).toHaveBeenCalledWith('PLUS01', { perpage: CUSTOMER_PROJECTS_PERPAGE });
    expect(CUSTOMER_PROJECTS_PERPAGE).toBeLessThanOrEqual(100);
    expect(fromCustomers).toBe(1341);
    expect(seenByCustomer.get('PLUS01')).toHaveLength(1301);
    expect(seenByCustomer.get('KNOW01')).toEqual(range(39000, 40).map((p) => p.Number));
  });

  it('keeps a project from GET /projects that no customer lists', async () => {
    const kf = fakeKf({
      recent: [{ Number: 41300, CustomerCode: '' }, { Number: 41299, CustomerCode: 'C1' }],
      byCustomer: { C1: [{ Number: 41299, CustomerCode: 'C1', Name: 'per-customer row' }] },
    });
    const { projects: result } = await listProjects(kf, [{ Code: 'C1' }]);
    expect(result.map((p) => p.Number).sort()).toEqual([41299, 41300]);
    expect(result.find((p) => p.Number === 41299).Name).toBe('per-customer row');
  });

  it('skips blank and repeated customer codes', async () => {
    const kf = fakeKf();
    await listProjects(kf, [{ Code: 'C1' }, { Code: '' }, { Code: 'C1' }, {}]);
    expect(kf.projects.listAllForCustomer.mock.calls.map(([code]) => code)).toEqual(['C1']);
  });

  it('takes a customer the endpoint 404s as having no projects', async () => {
    const notFound = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    const kf = fakeKf({ recent: [{ Number: 9 }], byCustomer: { C1: [{ Number: 1 }], C2: notFound } });
    const { projects: result, seenByCustomer } = await listProjects(kf, [{ Code: 'C1' }, { Code: 'C2' }]);
    expect(result.map((p) => p.Number).sort()).toEqual([1, 9]);
    // A 404 is not proof the customer has no projects: never swept.
    expect([...seenByCustomer]).toEqual([['C1', [1]], ['C2', null]]);
  });

  it('falls back to GET /projects alone when a customer listing fails otherwise', async () => {
    const kf = fakeKf({ recent: range(41101, 200), byCustomer: { C1: [{ Number: 1 }], C2: new Error('KashFlow 500') } });
    const { projects: result, seenByCustomer } = await listProjects(kf, [{ Code: 'C1' }, { Code: 'C2' }]);
    expect(result).toHaveLength(200);
    // A short list must not drive the sweep.
    expect(seenByCustomer.size).toBe(0);
  });

  it('does not sweep a customer whose listing has a row without a Number', async () => {
    const kf = fakeKf({ byCustomer: { C1: [{ Number: 1 }, { Name: 'no number' }], C2: [] } });
    const { seenByCustomer } = await listProjects(kf, [{ Code: 'C1' }, { Code: 'C2' }]);
    expect(seenByCustomer.get('C1')).toBeNull();
    expect(seenByCustomer.get('C2')).toEqual([]);
  });

  it('fails when GET /projects itself fails, as a required list', async () => {
    const kf = fakeKf();
    kf.projects.listAll.mockRejectedValue(new Error('KashFlow 503'));
    await expect(listProjects(kf, [{ Code: 'C1' }])).rejects.toThrow('KashFlow 503');
  });
});
