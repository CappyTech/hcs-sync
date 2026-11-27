import config from '../config.js';
import logger from '../util/logger.js';
import { createStaffologyClient } from './client.js';
import {
  SOURCE,
  normaliseEmployee,
  normalisePayRunEntry,
  payRunRef,
  taxYearKey,
  taxYearOf,
} from './normalise.js';

/**
 * One Staffology sync: employees, then pay run entries for the current tax
 * year and STAFFOLOGY_YEARS_BACK before it, for every pay period the employer
 * has a schedule for. Read-only against Staffology; writes only the Staffology
 * database (see src/db/mongoose.js getStaffologyConnection).
 *
 * A pay period whose stored entries are all closed is not fetched again, except
 * the latest period of each schedule, so after the first run each sync fetches
 * roughly one week.
 *
 * Dependencies are injectable for tests.
 */
const FALLBACK_PERIODS = ['Weekly', 'Monthly'];
const DETAIL_CONCURRENCY = 3;

async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function resolveEmployerId(client, configured = config.staffologyEmployerId) {
  if (configured) return configured;
  const employers = await client.listEmployers();
  if (employers.length === 1) return employers[0].id;
  if (!employers.length) throw new Error('The Staffology API key cannot see any employer');
  throw new Error(
    `The Staffology API key can see ${employers.length} employers; set STAFFOLOGY_EMPLOYER_ID to the one to sync`,
  );
}

/** Pay periods the employer runs payroll on, from its schedules; falls back to Weekly + Monthly. */
async function payPeriodsFor(client, employerId, taxYear) {
  try {
    const schedules = await client.listSchedules(employerId, taxYearKey(taxYear));
    const periods = [...new Set((Array.isArray(schedules) ? schedules : [])
      .filter((s) => s && s.isConfigured !== false && s.payPeriod)
      .map((s) => String(s.payPeriod)))];
    return periods.length ? periods : FALLBACK_PERIODS;
  } catch (err) {
    logger.warn({ taxYear, err: err.message }, 'Staffology schedules unavailable; trying Weekly and Monthly');
    return FALLBACK_PERIODS;
  }
}

/** Is every stored entry of this period closed? (false when none are stored) */
async function periodClosedLocally(Entry, { taxYear, payPeriod, period, ordinal }) {
  const filter = { Source: SOURCE, TaxYear: taxYear, PayPeriod: payPeriod, Period: period, Ordinal: ordinal };
  const [total, open] = await Promise.all([
    Entry.countDocuments(filter),
    Entry.countDocuments({ ...filter, IsClosed: { $ne: true } }),
  ]);
  return total > 0 && open === 0;
}

export async function runStaffologySync({
  settings = { apiKey: config.staffologyApiKey, employerId: config.staffologyEmployerId },
  client = createStaffologyClient({ apiKey: settings.apiKey }),
  models,
  upsert,
  now = new Date(),
  yearsBack = config.staffologyYearsBack,
} = {}) {
  if (!models || !upsert) {
    const { getStaffologyConnection } = await import('../db/mongoose.js');
    const { payrollModels, upsertBySourceId } = await import('../server/models/payroll.js');
    models = models || payrollModels(await getStaffologyConnection());
    upsert = upsert || upsertBySourceId;
    if (!models) throw new Error('Installed @cappytech/hcs-schemas has no payroll entities (needs 3.1.0 or later)');
  }
  const { PayrollEmployee, PayrollPayRunEntry } = models;

  const started = Date.now();
  const result = {
    employerId: null,
    employees: { fetched: 0, upserted: 0, modified: 0 },
    payRuns: { listed: 0, fetched: 0, skippedClosed: 0 },
    entries: { fetched: 0, upserted: 0, modified: 0 },
    errors: [],
    durationMs: 0,
  };
  const fail = (where, err) => {
    result.errors.push({ where, message: err?.message || String(err) });
    logger.warn({ where, err: err?.message }, 'Staffology sync step failed');
  };

  const employerId = await resolveEmployerId(client, settings.employerId || '');
  result.employerId = employerId;

  // ── Employees ──
  try {
    const items = await client.listEmployees(employerId);
    const docs = (await mapPool(items, DETAIL_CONCURRENCY, async (item) => {
      try {
        const emp = await client.getEmployee(employerId, item.id);
        return emp ? normaliseEmployee(emp, { employerId, listItem: item, now }) : null;
      } catch (err) {
        fail(`employee ${item.id}`, err);
        return null;
      }
    })).filter(Boolean);
    result.employees.fetched = docs.length;
    const w = await upsert(PayrollEmployee, docs);
    result.employees.upserted = w.upserted;
    result.employees.modified = w.modified;
  } catch (err) {
    fail('employees', err);
  }

  // ── Pay runs ──
  const currentYear = taxYearOf(now);
  for (let taxYear = currentYear - Math.max(0, yearsBack); taxYear <= currentYear; taxYear += 1) {
    const payPeriods = await payPeriodsFor(client, employerId, taxYear);
    for (const payPeriod of payPeriods) {
      let refs;
      try {
        const items = await client.listPayRuns(employerId, taxYearKey(taxYear), payPeriod);
        refs = (Array.isArray(items) ? items : []).map(payRunRef).filter(Boolean);
      } catch (err) {
        if (err.status === 400 || err.status === 404) continue; // year or period not set up
        fail(`pay runs ${taxYear} ${payPeriod}`, err);
        continue;
      }
      result.payRuns.listed += refs.length;
      const latest = refs.reduce((m, r) => Math.max(m, r.period), 0);

      for (const ref of refs) {
        const key = { taxYear, payPeriod, period: ref.period, ordinal: ref.ordinal };
        if (ref.period !== latest && await periodClosedLocally(PayrollPayRunEntry, key)) {
          result.payRuns.skippedClosed += 1;
          continue;
        }
        try {
          const run = await client.getPayRun(employerId, taxYearKey(taxYear), payPeriod, ref.period, ref.ordinal);
          result.payRuns.fetched += 1;
          const runCtx = { ...run, taxYear: run?.taxYear ?? taxYearKey(taxYear), payPeriod: run?.payPeriod ?? payPeriod, period: run?.period ?? ref.period, ordinal: run?.ordinal ?? ref.ordinal };
          const entryItems = Array.isArray(run?.entries) ? run.entries : [];
          const docs = (await mapPool(entryItems, DETAIL_CONCURRENCY, async (item) => {
            try {
              const entry = await client.getPayRunEntry(employerId, taxYearKey(taxYear), payPeriod, ref.period, item.id, ref.ordinal);
              return entry ? normalisePayRunEntry(entry, { employerId, run: runCtx, item, now }) : null;
            } catch (err) {
              fail(`entry ${item.id}`, err);
              return null;
            }
          })).filter(Boolean);
          result.entries.fetched += docs.length;
          const w = await upsert(PayrollPayRunEntry, docs);
          result.entries.upserted += w.upserted;
          result.entries.modified += w.modified;
        } catch (err) {
          fail(`pay run ${taxYear} ${payPeriod} ${ref.period}`, err);
        }
      }
    }
  }

  result.durationMs = Date.now() - started;
  return result;
}

export default runStaffologySync;
