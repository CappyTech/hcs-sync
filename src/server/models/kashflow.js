import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';

/**
 * KashFlow REST models – built from @cappytech/hcs-schemas (shared with hcs-app).
 *
 * Each schema extends the shared field definitions with sync-specific metadata
 * (syncedAt, createdByRunId), uses strict: false so undeclared KashFlow fields
 * are still persisted, and adds syncConfig statics for the sync engine.
 */

const { uuidField } = schemas;

// Fields that only hcs-sync writes; kept separate from the shared schema.
const syncOnlyFields = {
  syncedAt: { type: Date, default: null },
  detailSyncedAt: { type: Date, default: null },
  createdByRunId: { type: String, default: null },
};

/**
 * Fields managed internally by the sync engine — excluded from payload
 * flattening (buildUpsertUpdate) and audit diffs (deepDiff).
 */
export const SYNC_INTERNAL_FIELDS = new Set([
  '_id', '__v', 'data', 'uuid',
  'syncedAt', 'detailSyncedAt', 'createdAt', 'updatedAt', 'createdByRunId',
]);

/** Build a Mongoose schema from shared entity definition + sync extras. */
function buildSchema(entity, extraFields = {}, schemaOpts = {}) {
  const schema = new mongoose.Schema(
    { uuid: uuidField, ...syncOnlyFields, ...entity.fields, ...extraFields },
    { collection: entity.collection, strict: false, minimize: false, timestamps: true, ...schemaOpts },
  );
  entity.indexes.forEach(idx => schema.index(idx.fields, idx.options));
  return schema;
}

// ── Customer ────────────────────────────────────────────────────────────

const CustomerSchema = buildSchema(schemas.customer);

CustomerSchema.statics.syncConfig = {
  keyField: 'Id',
  protectedFields: [],
};

export const Customer =
  mongoose.models.customer || mongoose.model('customer', CustomerSchema);

// ── Supplier ────────────────────────────────────────────────────────────

const SupplierSchema = buildSchema(schemas.supplier);

SupplierSchema.statics.syncConfig = {
  keyField: 'Id',
  protectedFields: ['Subcontractor', 'IsSubcontractor', 'CISRate', 'CISNumber'],
};

export const Supplier =
  mongoose.models.supplier || mongoose.model('supplier', SupplierSchema);

// ── Invoice ─────────────────────────────────────────────────────────────

const InvoiceSchema = buildSchema(schemas.invoice);

InvoiceSchema.statics.syncConfig = {
  keyField: 'Id',
  protectedFields: [],
};

export const Invoice =
  mongoose.models.invoice || mongoose.model('invoice', InvoiceSchema);

// ── Quote ───────────────────────────────────────────────────────────────

const QuoteSchema = buildSchema(schemas.quote);

QuoteSchema.statics.syncConfig = {
  keyField: 'Id',
  protectedFields: [],
};

export const Quote =
  mongoose.models.quote || mongoose.model('quote', QuoteSchema);

// ── Purchase ────────────────────────────────────────────────────────────

const PurchasePaymentLineSchema = new mongoose.Schema(
  schemas.purchase.paymentLineFields,
  { _id: false }
);

const PurchaseSchema = buildSchema(schemas.purchase, {
  PaymentLines: [PurchasePaymentLineSchema],
});

// ── Purchase transform helpers ──────────────────────────────────────────

/**
 * Convert a KashFlow date string (e.g. "2025-12-10 12:00:00") to a JS Date.
 * Returns null for null / undefined / empty / unparseable values.
 */
export function toDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Compute the CIS TaxYear and TaxMonth for a given date.
 *
 * Rules:
 *   Tax year starts 6 April.  A date before 6 April belongs to the previous year.
 *   Tax month 1 = 6 Apr \u2013 5 May, month 2 = 6 May \u2013 5 Jun, \u2026, month 12 = 6 Mar \u2013 5 Apr.
 *
 * Returns { TaxYear: Number, TaxMonth: Number } or null if the date is invalid.
 */
export function computeCisTaxPeriod(date) {
  const d = toDate(date);
  if (!d) return null;

  // KashFlow dates represent UK local time.  Extract date parts in
  // Europe/London so that e.g. "2026-04-05T23:00:00Z" (6 Apr 2026 BST)
  // is correctly treated as 6 April, not 5 April.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(d);

  const year  = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value) - 1; // 0-based
  const day   = Number(parts.find(p => p.type === 'day').value);

  // Tax year that this date falls in (labelled by the starting calendar year).
  const taxYear = (month > 3 || (month === 3 && day >= 6)) ? year : year - 1;

  // Months elapsed since 6 April of the tax year.
  let monthDiff = (month - 3) + (year - taxYear) * 12;
  if (day < 6) monthDiff -= 1;
  const taxMonth = monthDiff + 1; // 1-based

  return { TaxYear: taxYear, TaxMonth: taxMonth };
}

/**
 * Mutate a purchase item in-place:
 *   1. Convert date-string fields to proper JS Date objects.
 *   2. Compute and set TaxYear / TaxMonth from the earliest payment date.
 */
export function preparePurchaseForUpsert(item) {
  // --- Convert top-level date fields --------------------------------
  item.PaidDate   = toDate(item.PaidDate);
  item.IssuedDate = toDate(item.IssuedDate);
  item.DueDate    = toDate(item.DueDate);

  // --- Convert PaymentLines date fields -----------------------------
  if (Array.isArray(item.PaymentLines)) {
    for (const pl of item.PaymentLines) {
      pl.PayDate = toDate(pl.PayDate);
      pl.Date    = toDate(pl.Date);
    }
  }

  // --- Derive reference date (priority order) -----------------------
  let refDate = null;
  if (Array.isArray(item.PaymentLines)) {
    for (const pl of item.PaymentLines) {
      if (pl.PayDate) { refDate = pl.PayDate; break; }
    }
  }
  if (!refDate && item.PaidDate)   refDate = item.PaidDate;
  if (!refDate && item.IssuedDate) refDate = item.IssuedDate;

  // --- Compute CIS tax period ---------------------------------------
  const period = computeCisTaxPeriod(refDate);
  if (period) {
    item.TaxYear  = period.TaxYear;
    item.TaxMonth = period.TaxMonth;
  }

  return item;
}

PurchaseSchema.statics.syncConfig = {
  keyField: 'Id',
  protectedFields: ['SubmissionDate'],
  transform: preparePurchaseForUpsert,
};

export const Purchase =
  mongoose.models.purchase || mongoose.model('purchase', PurchaseSchema);

// ── Project ─────────────────────────────────────────────────────────────

const ProjectSchema = buildSchema(schemas.project, {
  deletedAt: { type: Date, default: null },
  lastSeenRun: Date,
});

ProjectSchema.statics.syncConfig = {
  keyField: 'Id',
  fallbackKeyField: 'Number',
  protectedFields: ['deletedAt'],
};

export const Project =
  mongoose.models.project || mongoose.model('project', ProjectSchema);

// ── Nominal ─────────────────────────────────────────────────────────────

const NominalSchema = buildSchema(schemas.nominal);

NominalSchema.statics.syncConfig = {
  keyField: 'Id',
  fallbackKeyField: 'Code',
  protectedFields: [],
};

export const Nominal =
  mongoose.models.nominal || mongoose.model('nominal', NominalSchema);

// ── Note ────────────────────────────────────────────────────────────────

const NoteSchema = buildSchema(schemas.note);

export const Note =
  mongoose.models.note || mongoose.model('note', NoteSchema);

// ── VATRate ──────────────────────────────────────────────────────────────

const VATRateSchema = buildSchema(schemas.vatRate);

VATRateSchema.statics.syncConfig = {
  keyField: 'VATId',
  protectedFields: [],
};

export const VATRate =
  mongoose.models.vatrate || mongoose.model('vatrate', VATRateSchema);

// ── Convenience map ─────────────────────────────────────────────────────

const models = {
  Customer,
  Supplier,
  Invoice,
  Quote,
  Purchase,
  Project,
  Nominal,
  Note,
  VATRate,
};

export default models;
