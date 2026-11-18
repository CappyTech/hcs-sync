/**
 * The freshness check: stored highest Number vs KashFlow's next free number.
 *
 * For nine months no quote was saved and projects sat at 200, while every run
 * reported success. These pin that such a gap is reported, and that the check
 * itself can never fail a run.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseNextAvailableNumber, checkFreshness } from '../src/sync/freshness.js';

function fakeModel(highest, { throws } = {}) {
  const calls = [];
  return {
    calls,
    findOne(filter) {
      calls.push(filter);
      const chain = {
        sort: (s) => { calls.push({ sort: s }); return chain; },
        select: () => chain,
        lean: async () => {
          if (throws) throw new Error(throws);
          return highest == null ? null : { Number: highest };
        },
      };
      return chain;
    },
  };
}

const kfWith = (map) => ({
  nextAvailable: {
    get: async (kind) => {
      const v = map[kind];
      if (v instanceof Error) throw v;
      return v;
    },
  },
});

describe('parseNextAvailableNumber()', () => {
  it('reads a bare number or numeric string', () => {
    expect(parseNextAvailableNumber(1001)).toBe(1001);
    expect(parseNextAvailableNumber(' 1001 ')).toBe(1001);
  });

  it('reads an object under a likely key, or its only numeric value', () => {
    expect(parseNextAvailableNumber({ Number: 7 })).toBe(7);
    expect(parseNextAvailableNumber({ NextNumber: '8' })).toBe(8);
    expect(parseNextAvailableNumber({ Whatever: 9, Label: 'x' })).toBe(9);
  });

  it('returns null for anything else', () => {
    expect(parseNextAvailableNumber(null)).toBeNull();
    expect(parseNextAvailableNumber('')).toBeNull();
    expect(parseNextAvailableNumber('abc')).toBeNull();
    expect(parseNextAvailableNumber([1])).toBeNull();
    expect(parseNextAvailableNumber({ A: 1, B: 2 })).toBeNull();
    expect(parseNextAvailableNumber(Number.NaN)).toBeNull();
  });
});

describe('checkFreshness()', () => {
  it('flags a collection whose stored Numbers lag past the threshold', async () => {
    const ctx = { emitLog: vi.fn() };
    const models = {
      Quote: fakeModel(41200), Invoice: fakeModel(999), Project: fakeModel(200), Purchase: fakeModel(50),
    };
    const out = await checkFreshness(ctx, kfWith({ quote: 51764, invoice: 1000, project: 206, purchase: 57 }), {
      models, threshold: 5,
    });

    expect(out.checks.map((c) => [c.collection, c.gap, c.stale])).toEqual([
      ['quotes', 10563, true],
      ['invoices', 0, false],
      ['projects', 5, false], // exactly the threshold is tolerated
      ['purchases', 6, true],
    ]);
    expect(out.stale.map((c) => c.collection)).toEqual(['quotes', 'purchases']);
    expect(out.unreadable).toEqual([]);
    expect(ctx.emitLog).toHaveBeenCalledWith('warn', 'Stored quotes lag KashFlow', expect.objectContaining({
      highestStored: 41200, nextAvailable: 51764, gap: 10563, threshold: 5,
    }));
  });

  it('ignores soft-deleted documents and reads the highest numeric Number', async () => {
    const quote = fakeModel(10);
    await checkFreshness({ emitLog: vi.fn() }, kfWith({ quote: 11 }), { models: { Quote: quote }, threshold: 5 });
    expect(quote.calls[0]).toEqual({ deletedAt: null, Number: { $type: 'number' } });
    expect(quote.calls[1]).toEqual({ sort: { Number: -1 } });
  });

  it('treats an empty collection as stored up to nothing', async () => {
    const out = await checkFreshness({ emitLog: vi.fn() }, kfWith({ quote: 51764 }), {
      models: { Quote: fakeModel(null) }, threshold: 5,
    });
    expect(out.checks[0]).toMatchObject({ highestStored: null, gap: 51763, stale: true });
  });

  it('records a failed or unparseable nextAvailable read and a Mongo error as unreadable, never throwing', async () => {
    const ctx = { emitLog: vi.fn() };
    const out = await checkFreshness(ctx, kfWith({
      quote: new Error('503'), invoice: { Foo: 'bar' }, project: 10, purchase: 10,
    }), {
      models: {
        Quote: fakeModel(1), Invoice: fakeModel(1), Project: fakeModel(null, { throws: 'mongo down' }), Purchase: fakeModel(9),
      },
      threshold: 5,
    });
    expect(out.unreadable.map((u) => [u.collection, u.message])).toEqual([
      ['quotes', '503'],
      ['invoices', expect.stringContaining('Unrecognised response')],
      ['projects', 'Mongo: mongo down'],
    ]);
    expect(out.checks.map((c) => c.collection)).toEqual(['purchases']);
    expect(out.stale).toEqual([]);
    expect(ctx.emitLog).toHaveBeenCalledWith('warn', 'Freshness check could not read quotes', expect.any(Object));
  });

  it('logs ok when nothing lags', async () => {
    const ctx = { emitLog: vi.fn() };
    await checkFreshness(ctx, kfWith({ quote: 11 }), { models: { Quote: fakeModel(10) }, threshold: 5 });
    expect(ctx.emitLog).toHaveBeenCalledWith('info', 'Freshness check ok', { quotes: 0 });
  });
});
