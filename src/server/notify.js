import logger from '../util/logger.js';
import { sendDiscord } from '../util/discord.js';
import { syncLabel } from '../util/brand.js';

// Not collections — sub-tallies of bankTransactions and quotes, so they must not
// be reported as resources in their own right.
const NON_RESOURCE_COUNT_KEYS = new Set([
  'bankTransactionsSoftDeleted', 'bankTransactionsFetched',
  'quotesSoftDeleted', 'invoicesSoftDeleted', 'projectsSoftDeleted', 'customersSoftDeleted',
  'purchasesSoftDeleted', 'suppliersSoftDeleted',
]);

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
 * Everything about a resolved run that is not clean, in one place, so the run
 * log, the stored run summary, the run page and Discord all agree on what a
 * "completed with warnings" run is.
 *
 *  - bankAccountsNotFetched — per-account bank fetches that failed
 *  - failedFetches          — best-effort lists (journals, products, …) whose
 *                             fetch failed and were treated as empty
 *  - stale                  — collections whose highest stored Number lags
 *                             KashFlow's next free number (src/sync/freshness.js)
 *  - freshnessUnreadable    — collections the freshness check could not check
 */
export function collectRunWarnings(result) {
  const bankAccountsNotFetched = (result?.partial?.bankTransactions || []).map((f) => f.accountId);
  const failedFetches = [...(result?.failedFetches || [])];
  const stale = [...(result?.freshness?.stale || [])];
  const freshnessUnreadable = [...(result?.freshness?.unreadable || [])];
  return {
    bankAccountsNotFetched,
    failedFetches,
    stale,
    freshnessUnreadable,
    hasWarnings: bankAccountsNotFetched.length > 0 || failedFetches.length > 0
      || stale.length > 0 || freshnessUnreadable.length > 0,
  };
}

/** One freshness check, e.g. "stored up to 41200, KashFlow next is 51764 (10563 behind)". */
export function formatStale(c) {
  return `stored up to ${c.highestStored ?? 'none'}, KashFlow next is ${c.nextAvailable} (${c.gap} behind)`;
}

/** Build the description and fields of the "Completed with warnings" embed. */
function buildWarningAlert(warnings, deltaFields, requestedBy, partialBank) {
  const lines = [];
  const fields = [];
  if (warnings.stale.length) {
    lines.push(`Stored ${warnings.stale.map((c) => c.collection).join(', ')} lag KashFlow's numbering — `
      + 'documents KashFlow has issued are not being saved.');
    for (const c of warnings.stale) {
      fields.push({ name: `Behind: ${c.collection}`, value: formatStale(c), inline: false });
    }
  }
  if (warnings.failedFetches.length) {
    lines.push('Some KashFlow lists could not be fetched; their stored data and counts are unchanged this run.');
    fields.push({ name: 'Lists not fetched', value: warnings.failedFetches.join(', ').slice(0, 1000), inline: false });
  }
  if (warnings.bankAccountsNotFetched.length) {
    // Say plainly what did NOT happen, because the obvious reading of a bank
    // alert is that rows vanished. They cannot have: the soft-delete sweep
    // only runs after a successful, non-empty fetch, so a skipped account
    // leaves its stored ledger exactly as it was.
    lines.push(`${warnings.bankAccountsNotFetched.length} bank account(s) could not be read from KashFlow. `
      + 'Their stored transactions are unchanged — nothing was deleted. '
      + 'The next successful run will pick them up.');
    fields.push({ name: 'Bank accounts not fetched', value: warnings.bankAccountsNotFetched.join(', '), inline: true });
    fields.push({ name: 'Reason', value: String(partialBank[0]?.message || 'unknown').slice(0, 200), inline: true });
  }
  if (warnings.freshnessUnreadable.length) {
    lines.push('The freshness check could not run for some collections.');
    fields.push({
      name: 'Freshness not checked',
      value: warnings.freshnessUnreadable.map((u) => `${u.collection}: ${u.message}`).join('\n').slice(0, 1000),
      inline: false,
    });
  }
  // Discord caps an embed at 25 fields: warnings first, then as many data
  // changes as fit, leaving one for the trigger.
  const room = Math.max(0, 24 - fields.length);
  const all = [...fields, ...deltaFields.slice(0, room)];
  all.push({ name: 'Trigger', value: String(requestedBy || 'unknown'), inline: true });
  return { description: lines.join('\n\n'), fields: all };
}

/**
 * Post the Discord alert for a successful run.
 */
export function notifyRunCompleted({ result, prevCounts, counts, requestedBy }) {
  // Discord alert — for runs that changed data or finished with warnings;
  // silent on a clean no-op success to keep a frequent cron quiet. Failures
  // always alert (see notifyRunFailed).
  //
  // A run with warnings is neither a failure nor a no-op: a skipped bank
  // account, a best-effort list that failed, or stored documents lagging
  // KashFlow's numbering. Each was visible only in the container log, or not
  // at all — nine months of unsaved quotes reported plain success — so they
  // now alert in their own right, in red.
  const partialBank = result?.partial?.bankTransactions || [];
  const warnings = collectRunWarnings(result);
  try {
    const changed = summariseRunChanges(prevCounts, counts || {}, result?.mongo);
    const deltaFields = changed.map((c) => ({
      name: c.name,
      value: formatRunChange(c),
      inline: true,
    }));

    const upsertTotal = changed.reduce((a, c) => a + c.upserted, 0);
    const modifiedTotal = changed.reduce((a, c) => a + c.modified, 0);

    if (warnings.hasWarnings) {
      const { description, fields } = buildWarningAlert(warnings, deltaFields, requestedBy, partialBank);
      sendDiscord({
        ok: false,
        title: `${syncLabel()} — Completed with warnings`,
        description,
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
        title: `${syncLabel()} — Completed`,
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
    title: `${syncLabel()} — Failed`,
    description: error || 'Sync failed — see the run logs for details.',
    fields: [{ name: 'Trigger', value: String(requestedBy || 'unknown'), inline: true }],
  }).catch(() => {});
}
