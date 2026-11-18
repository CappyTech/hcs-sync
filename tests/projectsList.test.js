/**
 * The projects list is fetched in one large page.
 *
 * KashFlow's GET /projects returns a bare array and ignores `page` (page 2
 * comes back identical to page 1), so paging can never get past the first
 * page; it does honour `perpage`. Live shape capture, 18/11/2026: the default
 * page was 50 rows, newest first, and perpage=200 gave exactly 200 every run
 * against roughly 1,500 jobs in KashFlow.
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

import logger from '../src/util/logger.js';
import { listProjects, PROJECTS_PERPAGE } from '../src/sync/run.js';

const projects = (n) => Array.from({ length: n }, (_, i) => ({ Number: 41300 - i }));

describe('listProjects()', () => {
  it('asks for every project in one large page', async () => {
    const listAll = vi.fn(async () => projects(1543));
    const result = await listProjects({ projects: { listAll } });
    expect(result).toHaveLength(1543);
    expect(listAll).toHaveBeenCalledTimes(1);
    expect(listAll).toHaveBeenCalledWith({ perpage: PROJECTS_PERPAGE });
    expect(PROJECTS_PERPAGE).toBeGreaterThan(1500);
  });

  it('falls back to 200 per page when KashFlow rejects the large page', async () => {
    const listAll = vi.fn()
      .mockRejectedValueOnce(new Error('400 perpage out of range'))
      .mockResolvedValueOnce(projects(200));
    const result = await listProjects({ projects: { listAll } });
    expect(result).toHaveLength(200);
    expect(listAll.mock.calls.map(([p]) => p.perpage)).toEqual([PROJECTS_PERPAGE, 200]);
  });

  it('fails the run when the fallback fails too, as a required list', async () => {
    const listAll = vi.fn().mockRejectedValue(new Error('KashFlow 500'));
    await expect(listProjects({ projects: { listAll } })).rejects.toThrow('KashFlow 500');
  });

  it('warns when the list is a round 200s, the sign of a capped page', async () => {
    logger.warn.mockClear();
    await listProjects({ projects: { listAll: async () => projects(200) } });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectsListed: 200 }),
      expect.stringMatching(/may be capping/),
    );
  });
});
