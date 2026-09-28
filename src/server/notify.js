import logger from '../util/logger.js';
import { sendDiscord } from '../util/discord.js';

// Not a collection — a sub-tally of bankTransactions, so it must not be reported
// as a resource in its own right.
const NON_RESOURCE_COUNT_KEYS = new Set(['bankTransactionsSoftDeleted', 'bankTransactionsFetched']);

/**
 * Summarise what a run actually changed.
 *
 * Two independent signals, because either one alone under-reports:
 *
 *  - **Count deltas** — a collection gained or lost documents. The set of
 *    collections is derived from what the sync returns, never a hardcoded list:
 *    `counts` carries 21 collections and the old hardcoded 8 silently omitted
 *    bankTransactions, journals, countries, vatReturns and the rest, so real
 *    changes in them were invisible to both the run summary and Discord.
 *  - **Mongo write stats** — documents modified in place. A count delta cannot
 *    see these at all: a run that rewrites 8,690 existing bank transactions and
 *    adds none leaves the count identical and used to report "no changes".
 */
export function summariseRunChanges(prev, curr, mongo) {
  const names = new Set([
    ...Object.keys(curr || {}),
    ...Object.keys(prev || {}),
    ...Object.keys(mongo || {}),
  ]);

  const out = [];
  for (const name of names) {
    if (NON_RESOURCE_COUNT_KEYS.has(name)) continue;
    const before = prev ? prev[name] ?? null : null;
    const after = curr ? curr[name] ?? null : null;
    const stats = mongo?.[name] || null;
    const upserted = Number(stats?.upserted) || 0;
    const modified = Number(stats?.modified) || 0;
    const countChanged = before !== after && !(before === null && after === null);
    if (!countChanged && !upserted && !modified) continue;
    out.push({ name, before, after, countChanged, upserted, modified });
  }

  // Largest write first, so the Discord field cap keeps the significant ones.
  out.sort((a, b) => (b.upserted + b.modified) - (a.upserted + a.modified)
    || a.name.localeCompare(b.name));
  return out;
}

export function formatRunChange(c) {
  const parts = [];
  if (c.countChanged) {
    const diff = (c.after ?? 0) - (c.before ?? 0);
    parts.push(`${c.before ?? '—'} → ${c.after ?? '—'} (${diff >= 0 ? '+' : ''}${diff})`);
  } else {
    if (c.after !== null) parts.push(String(c.after));
    if (c.upserted) parts.push(`${c.upserted} added`);
  }
  if (c.modified) parts.push(`${c.modified} modified`);
  return parts.join(' · ') || '—';
}

/**
 * Post the Discord alert for a successful run.
 */
export function notifyRunCompleted({ result, prevCounts, counts, requestedBy }) {
  // Discord alert — only for runs that actually changed data; silent on no-op
  // success to keep a frequent cron quiet. Failures always alert (see the
  // notifyRunFailed).
  //
  // A run that skipped an account is neither: nothing changed, but the run
  // is not clean either. Before this, a per-account bank fetch failure was
  // visible ONLY as a warn line in the container log — the run resolved,
  // Discord said "Completed", and the only outward sign was a nonsense
  // count delta on a green embed. It now alerts in its own right, in red.
  const partialBank = result?.partial?.bankTransactions || [];
  try {
    const changed = summariseRunChanges(prevCounts, counts || {}, result?.mongo);
    const deltaFields = changed.map((c) => ({
      name: c.name,
      value: formatRunChange(c),
      inline: true,
    }));

    const upsertTotal = changed.reduce((a, c) => a + c.upserted, 0);
    const modifiedTotal = changed.reduce((a, c) => a + c.modified, 0);

    if (partialBank.length > 0) {
      const accounts = partialBank.map((f) => f.accountId).join(', ');
      const fields = deltaFields.slice(0, 20);
      fields.push({
        name: 'Bank accounts not fetched',
        value: accounts,
        inline: true,
      });
      fields.push({
        name: 'Reason',
        value: String(partialBank[0]?.message || 'unknown').slice(0, 200),
        inline: true,
      });
      fields.push({ name: 'Trigger', value: String(requestedBy || 'unknown'), inline: true });
      sendDiscord({
        ok: false,
        title: 'Heron CS | Sync — Completed with warnings',
        // Say plainly what did NOT happen, because the obvious reading of a
        // bank alert is that rows vanished. They cannot have: the
        // soft-delete sweep only runs after a successful, non-empty fetch,
        // so a skipped account leaves its stored ledger exactly as it was.
        description: `${partialBank.length} bank account(s) could not be read from KashFlow. `
          + 'Their stored transactions are unchanged — nothing was deleted. '
          + 'The next successful run will pick them up.',
        fields,
      }).catch(() => {});
    } else if (deltaFields.length > 0) {
      // Discord caps an embed at 25 fields; keep room for the summary fields.
      const shown = deltaFields.slice(0, 22);
      const fields = shown;
      if (changed.length > shown.length) {
        fields.push({
          name: 'Not shown',
          value: `+${changed.length - shown.length} more collection(s)`,
          inline: true,
        });
      }
      fields.push({
        name: 'Totals',
        value: `${upsertTotal} added · ${modifiedTotal} modified`,
        inline: true,
      });
      fields.push({ name: 'Trigger', value: String(requestedBy || 'unknown'), inline: true });
      sendDiscord({
        ok: true,
        title: 'Heron CS | Sync — Completed',
        description: 'Sync completed with data changes.',
        fields,
      }).catch(() => {});
    }
  } catch (e) {
    logger.warn({ err: { message: e?.message } }, 'Failed to build Discord success alert');
  }
}

/** Post the Discord alert for a failed run. Failures always notify. */
export function notifyRunFailed({ error, requestedBy }) {
  sendDiscord({
    ok: false,
    title: 'Heron CS | Sync — Failed',
    description: error || 'Sync failed — see the run logs for details.',
    fields: [{ name: 'Trigger', value: String(requestedBy || 'unknown'), inline: true }],
  }).catch(() => {});
}
