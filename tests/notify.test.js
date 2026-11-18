/**
 * Discord alerts for a resolved run. sendDiscord is stubbed: nothing is posted.
 *
 * A run that resolves is not necessarily clean. A failed best-effort list or
 * stored documents lagging KashFlow's numbering must post "Completed with
 * warnings" even when no data changed, because a quiet cron is exactly how
 * nine months of unsaved quotes went unnoticed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/util/logger.js', () => {
  const noop = vi.fn();
  return { default: { info: noop, warn: noop, error: noop, debug: noop } };
});
vi.mock('../src/util/discord.js', () => ({ sendDiscord: vi.fn(() => Promise.resolve(true)) }));

import { sendDiscord } from '../src/util/discord.js';
import { notifyRunCompleted, collectRunWarnings } from '../src/server/notify.js';

const counts = { customers: 5, quotes: 10 };

beforeEach(() => { sendDiscord.mockClear(); });

describe('collectRunWarnings()', () => {
  it('is clean for a clean result', () => {
    expect(collectRunWarnings({ failedFetches: [], partial: { bankTransactions: [] }, freshness: null }).hasWarnings)
      .toBe(false);
    expect(collectRunWarnings(null).hasWarnings).toBe(false);
  });

  it('gathers every kind of warning', () => {
    const w = collectRunWarnings({
      failedFetches: ['journals', 'vatReturns'],
      partial: { bankTransactions: [{ accountId: 7, message: 'timeout' }] },
      freshness: { stale: [{ collection: 'quotes' }], unreadable: [{ collection: 'purchases', message: 'x' }] },
    });
    expect(w).toEqual({
      bankAccountsNotFetched: [7],
      failedFetches: ['journals', 'vatReturns'],
      stale: [{ collection: 'quotes' }],
      freshnessUnreadable: [{ collection: 'purchases', message: 'x' }],
      hasWarnings: true,
    });
  });
});

describe('notifyRunCompleted()', () => {
  it('stays silent for a clean run with no changes', () => {
    notifyRunCompleted({ result: { failedFetches: [] }, prevCounts: counts, counts, requestedBy: 'cron' });
    expect(sendDiscord).not.toHaveBeenCalled();
  });

  it('alerts with warnings, naming each failed list, even when nothing changed', () => {
    notifyRunCompleted({
      result: { failedFetches: ['journals', 'products'] }, prevCounts: counts, counts, requestedBy: 'cron',
    });
    expect(sendDiscord).toHaveBeenCalledTimes(1);
    const msg = sendDiscord.mock.calls[0][0];
    expect(msg.ok).toBe(false);
    expect(msg.title).toBe('Heron CS | Sync — Completed with warnings');
    expect(msg.fields).toContainEqual(expect.objectContaining({ name: 'Lists not fetched', value: 'journals, products' }));
  });

  it('alerts when stored documents lag KashFlow numbering', () => {
    notifyRunCompleted({
      result: {
        freshness: {
          stale: [{ collection: 'quotes', highestStored: 41200, nextAvailable: 51764, gap: 10563 }],
          unreadable: [],
        },
      },
      prevCounts: counts,
      counts,
      requestedBy: 'cron',
    });
    const msg = sendDiscord.mock.calls[0][0];
    expect(msg.title).toBe('Heron CS | Sync — Completed with warnings');
    expect(msg.description).toContain('quotes');
    expect(msg.fields).toContainEqual(expect.objectContaining({
      name: 'Behind: quotes', value: 'stored up to 41200, KashFlow next is 51764 (10563 behind)',
    }));
  });

  it('alerts when the freshness check could not run', () => {
    notifyRunCompleted({
      result: { freshness: { stale: [], unreadable: [{ collection: 'purchases', message: '503' }] } },
      prevCounts: counts,
      counts,
    });
    const msg = sendDiscord.mock.calls[0][0];
    expect(msg.fields).toContainEqual(expect.objectContaining({ name: 'Freshness not checked', value: 'purchases: 503' }));
  });

  it('keeps the bank-account wording and fits within 25 fields with many changes', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, i]));
    notifyRunCompleted({
      result: { partial: { bankTransactions: [{ accountId: 1003, message: 'timeout' }] }, failedFetches: ['currencies'] },
      prevCounts: {},
      counts: many,
      requestedBy: 'manual',
    });
    const msg = sendDiscord.mock.calls[0][0];
    expect(msg.description).toContain('nothing was deleted');
    expect(msg.fields).toContainEqual(expect.objectContaining({ name: 'Bank accounts not fetched', value: '1003' }));
    expect(msg.fields).toContainEqual(expect.objectContaining({ name: 'Lists not fetched', value: 'currencies' }));
    expect(msg.fields.length).toBeLessThanOrEqual(25);
    expect(msg.fields.at(-1)).toEqual({ name: 'Trigger', value: 'manual', inline: true });
  });

  it('posts a plain Completed for a clean run with changes', () => {
    notifyRunCompleted({ result: {}, prevCounts: counts, counts: { ...counts, quotes: 11 }, requestedBy: 'cron' });
    expect(sendDiscord.mock.calls[0][0].title).toBe('Heron CS | Sync — Completed');
  });
});
