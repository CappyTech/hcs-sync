/**
 * Freshness check: does what we store keep up with what KashFlow has issued?
 *
 * Every run used to report success purely because nothing threw. For nine
 * months no quote was saved (every row was skipped for a missing Id) and
 * projects sat at exactly 200 (only the first page was read), and nothing
 * above the container log noticed. KashFlow hands out document numbers
 * sequentially, so its next free number is an independent yardstick: the
 * highest stored Number should sit just below it. A gap wider than the
 * threshold means documents KashFlow has issued are missing from Mongo.
 *
 * Best-effort throughout: a failed nextAvailable read or Mongo query is
 * recorded and warned about, never thrown, so the check can never fail a run.
 */

/** Which KashFlow next-number kinds are checked, and the collection each one tracks. */
export const FRESHNESS_KINDS = [
  { kind: 'quote', summaryKey: 'quotes', model: 'Quote' },
  { kind: 'invoice', summaryKey: 'invoices', model: 'Invoice' },
  { kind: 'project', summaryKey: 'projects', model: 'Project' },
  { kind: 'purchase', summaryKey: 'purchases', model: 'Purchase' },
];

const NUMBER_KEYS = ['Number', 'NextNumber', 'NextAvailableNumber', 'NextAvailable', 'Value', 'number', 'value'];

function toFiniteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * KashFlow's Swagger gives no response schema for /nextavailable*number, so
 * accept a bare number, a numeric string, or an object carrying the number
 * under a likely key (or as its only numeric value).
 *
 * @returns {number|null} null when no number can be read from the response
 */
export function parseNextAvailableNumber(value) {
  const direct = toFiniteNumber(value);
  if (direct !== null) return direct;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of NUMBER_KEYS) {
    const n = toFiniteNumber(value[key]);
    if (n !== null) return n;
  }
  const numeric = Object.values(value).map(toFiniteNumber).filter((n) => n !== null);
  return numeric.length === 1 ? numeric[0] : null;
}

/** Highest Number among the model's live (not soft-deleted) documents, or null when there are none. */
async function highestStoredNumber(model) {
  const doc = await model
    .findOne({ deletedAt: null, Number: { $type: 'number' } })
    .sort({ Number: -1 })
    .select({ Number: 1 })
    .lean();
  return doc ? toFiniteNumber(doc.Number) : null;
}

/**
 * Compare each collection's highest stored Number with KashFlow's next free one.
 *
 * @param {object} ctx       run context (emitLog)
 * @param {object} kf        KashFlow client (kf.nextAvailable.get)
 * @param {object} opts
 * @param {object} opts.models    { Quote, Invoice, Project, Purchase } Mongoose models
 * @param {number} opts.threshold largest tolerated gap between the expected and stored highest Number
 * @returns {Promise<{threshold: number, checks: object[], stale: object[], unreadable: object[]}>}
 */
export async function checkFreshness(ctx, kf, { models, threshold }) {
  const checks = [];
  const unreadable = [];

  await Promise.all(FRESHNESS_KINDS.map(async ({ kind, summaryKey, model: modelName }) => {
    const model = models?.[modelName];
    if (!model) return;
    let raw;
    try {
      raw = await kf.nextAvailable.get(kind);
    } catch (e) {
      unreadable.push({ kind, collection: summaryKey, message: String(e?.message || e) });
      return;
    }
    const nextAvailable = parseNextAvailableNumber(raw);
    if (nextAvailable === null) {
      unreadable.push({ kind, collection: summaryKey, message: `Unrecognised response: ${JSON.stringify(raw)?.slice(0, 100)}` });
      return;
    }
    let highestStored;
    try {
      highestStored = await highestStoredNumber(model);
    } catch (e) {
      unreadable.push({ kind, collection: summaryKey, message: `Mongo: ${String(e?.message || e)}` });
      return;
    }
    // The next free number minus one is the newest document KashFlow has issued.
    const gap = (nextAvailable - 1) - (highestStored ?? 0);
    checks.push({ kind, collection: summaryKey, highestStored, nextAvailable, gap, stale: gap > threshold });
  }));

  // Promise.all completes in any order; keep reports stable.
  const order = (x) => FRESHNESS_KINDS.findIndex((k) => k.kind === x.kind);
  checks.sort((a, b) => order(a) - order(b));
  unreadable.sort((a, b) => order(a) - order(b));
  const stale = checks.filter((c) => c.stale);

  for (const u of unreadable) {
    ctx.emitLog('warn', `Freshness check could not read ${u.collection}`, u);
  }
  for (const c of stale) {
    ctx.emitLog('warn', `Stored ${c.collection} lag KashFlow`, {
      collection: c.collection, highestStored: c.highestStored, nextAvailable: c.nextAvailable, gap: c.gap, threshold,
    });
  }
  if (checks.length && !stale.length) {
    ctx.emitLog('info', 'Freshness check ok', Object.fromEntries(checks.map((c) => [c.collection, c.gap])));
  }

  return { threshold, checks, stale, unreadable };
}
