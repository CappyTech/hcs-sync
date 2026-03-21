import mongoose from 'mongoose';
import crypto from 'node:crypto';

/**
 * KashFlow REST models – aligned with hcs-app (CappyTech/hcs-app Working branch).
 *
 * Each schema mirrors the hcs-app model exactly so both apps share the same
 * collection shape.  Sync-specific metadata (`syncedAt`, `createdByRunId`) is
 * added on top.  All schemas use `strict: false` so KashFlow fields that
 * aren't explicitly declared still get persisted.
 */

// ── Helpers ─────────────────────────────────────────────────────────────

function uuidv4() {
  return crypto.randomUUID();
}

// Fields that only hcs-sync writes; kept separate from the hcs-app schema.
const syncOnlyFields = {
  syncedAt: { type: Date, default: null },
  createdByRunId: { type: String, default: null },
};

/**
 * Fields managed internally by the sync engine — excluded from payload
 * flattening (buildUpsertUpdate) and audit diffs (deepDiff).
 */
export const SYNC_INTERNAL_FIELDS = new Set([
  '_id', '__v', 'data', 'uuid',
  'syncedAt', 'createdAt', 'updatedAt', 'createdByRunId',
]);

// ── Customer ────────────────────────────────────────────────────────────

const CustomerSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: uuidv4 },
    ...syncOnlyFields,
    Id: Number,
    Code: String,
    Name: String,
    DisplayName: String,
    Note: String,
    CreatedDate: Date,
    LastUpdatedDate: Date,
    FirstInvoiceDate: Date,
    LastInvoiceDate: Date,
    InvoiceCount: Number,
    InvoicedNetAmount: Number,
    InvoicedVATAmount: Number,
    OutstandingBalance: Number,
    TotalPaidAmount: Number,
    DiscountRate: Number,
    DefaultNominalCode: Number,
    DefaultCustomerReference: String,
    VATNumber: String,
    IsRegisteredInEC: Boolean,
    IsRegisteredOutsideEC: Boolean,
    IsArchived: Boolean,
    ReceivesWholesalePricing: Boolean,
    ApplyWHT: Boolean,
    WHTRate: Number,
    WHTReferences: [mongoose.Schema.Types.Mixed],
    AutoIncludeVATNumber: Boolean,
    AverageDaysToPay: Number,
    UseCustomDeliveryAddress: Boolean,
    AutomaticCreditControlEnabled: Boolean,
    IsGoCardlessMandateSet: Boolean,
    Key: String,
    Source: Number,
    PaymentTerms: mongoose.Schema.Types.Mixed,
    Currency: mongoose.Schema.Types.Mixed,
    Contacts: [mongoose.Schema.Types.Mixed],
    Addresses: [mongoose.Schema.Types.Mixed],
    DeliveryAddresses: [mongoose.Schema.Types.Mixed],
    CustomCheckBoxes: [mongoose.Schema.Types.Mixed],
    CustomTextBoxes: [mongoose.Schema.Types.Mixed],
    Email: String,
    EmailTemplateNumber: Number,
    FaxNumber: String,
    MobileNumber: String,
    TelephoneNumber: String,
    UniqueEntityNumber: String,
    Website: String,
    ShowDiscount: Boolean,
    CreateCustomerCodeIfDuplicate: Boolean,
    CreateCustomerNameIfEmptyOrNull: Boolean,
  },
  {
    collection: 'customers',
    strict: false,
    minimize: false,
    timestamps: true,
  }
);

CustomerSchema.index({ Id: 1 }, { unique: true, sparse: true });

CustomerSchema.statics.syncConfig = {
  keyField: 'Id',
  protectedFields: [],
};

export const Customer =
  mongoose.models.customer || mongoose.model('customer', CustomerSchema);

// ── Supplier ────────────────────────────────────────────────────────────

const SupplierSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: uuidv4 },
    ...syncOnlyFields,
    Id: Number,
    Code: String,
    Name: String,
    Note: String,
    CreatedDate: Date,
    LastUpdatedDate: Date,
    FirstPurchaseDate: Date,
    LastPurchaseDate: Date,
    OutstandingBalance: Number,
    TotalPaidAmount: Number,
    DefaultNominalCode: Number,
    VATNumber: String,
    IsRegisteredInEC: Boolean,
    IsArchived: Boolean,
    PaymentTerms: mongoose.Schema.Types.Mixed,
    Currency: mongoose.Schema.Types.Mixed,
    Contacts: [mongoose.Schema.Types.Mixed],
    Address: mongoose.Schema.Types.Mixed,
    DeliveryAddresses: [mongoose.Schema.Types.Mixed],
    DefaultPdfTheme: Number,
    PaymentMethod: Number,
    CreateSupplierCodeIfDuplicate: Boolean,
    CreateSupplierNameIfEmptyOrNull: Boolean,
    UniqueEntityNumber: String,
    VatNumber: String,
    WithholdingTaxRate: Number,
    WithholdingTaxReferences: mongoose.Schema.Types.Mixed,
    // CIS fields managed by hcs-app – protected from sync overwrites.
    Subcontractor: { type: Boolean, default: false },
    IsSubcontractor: { type: Boolean, default: false },
    CISRate: { type: Number, enum: [null, 0, 0.2, 0.3], default: null },
    CISNumber: { type: String, default: null },
  },
  {
    collection: 'suppliers',
    strict: false,
    minimize: false,
    timestamps: true,
  }
);

SupplierSchema.index({ Id: 1 }, { unique: true, sparse: true });

SupplierSchema.statics.syncConfig = {
  keyField: 'Id',
  protectedFields: ['Subcontractor', 'IsSubcontractor', 'CISRate', 'CISNumber'],
};

export const Supplier =
  mongoose.models.supplier || mongoose.model('supplier', SupplierSchema);

// ── Invoice ─────────────────────────────────────────────────────────────

const InvoiceSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: uuidv4 },
    ...syncOnlyFields,
    Id: Number,
    Number: { type: Number, unique: true, required: true },
    CustomerId: Number,
    CustomerName: String,
    CustomerReference: String,
    Currency: mongoose.Schema.Types.Mixed,
    NetAmount: Number,
    GrossAmount: Number,
    VATAmount: Number,
    AmountPaid: Number,
    TotalPaidAmount: Number,
    Paid: Number,
    IssuedDate: Date,
    DueDate: Date,
    PaidDate: Date,
    LastPaymentDate: Date,
    Status: String,
    LineItems: [mongoose.Schema.Types.Mixed],
    PaymentLines: [mongoose.Schema.Types.Mixed],
    DeliveryAddress: mongoose.Schema.Types.Mixed,
    Address: mongoose.Schema.Types.Mixed,
    UseCustomDeliveryAddress: Boolean,
    Permalink: String,
    PackingSlipPermalink: String,
    ReminderLetters: [mongoose.Schema.Types.Mixed],
    PreviousNumber: Number,
    NextNumber: Number,
    OverdueDays: Number,
    AutomaticCreditControlEnabled: Boolean,
    CustomerDiscount: Number,
    EmailCount: Number,
    InvoiceInECMemberState: Boolean,
    InvoiceOutsideECMemberState: Boolean,
    SuppressNumber: Number,
    UpdateCustomerAddress: Boolean,
    UpdateCustomerDeliveryAddress: Boolean,
    VATNumber: String,
  },
  {
    collection: 'invoices',
    strict: false,
    minimize: false,
    timestamps: true,
  }
);

InvoiceSchema.index({ Id: 1 }, { unique: true, sparse: true });

InvoiceSchema.statics.syncConfig = {
  keyField: 'Id',
  protectedFields: [],
};

export const Invoice =
  mongoose.models.invoice || mongoose.model('invoice', InvoiceSchema);

// ── Quote ───────────────────────────────────────────────────────────────

const QuoteSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: uuidv4 },
    ...syncOnlyFields,
    Id: Number,
    Number: { type: Number, unique: true, required: true },
    CustomerId: Number,
    CustomerName: String,
    Date: Date,
    GrossAmount: Number,
    NetAmount: Number,
    VATAmount: Number,
    CustomerReference: String,
    LineItems: [mongoose.Schema.Types.Mixed],
    Permalink: String,
    PreviousNumber: Number,
    NextNumber: Number,
    Status: String,
    Category: mongoose.Schema.Types.Mixed,
    Currency: mongoose.Schema.Types.Mixed,
    CustomerCode: String,
  },
  {
    collection: 'quotes',
    strict: false,
    minimize: false,
    timestamps: true,
  }
);

QuoteSchema.index({ Id: 1 }, { unique: true, sparse: true });

QuoteSchema.statics.syncConfig = {
  keyField: 'Id',
  protectedFields: [],
};

export const Quote =
  mongoose.models.quote || mongoose.model('quote', QuoteSchema);

// ── Purchase ────────────────────────────────────────────────────────────

const PurchasePaymentLineSchema = new mongoose.Schema(
  {
    BulkPaymentNumber: Number,
    Permalink: String,
    PaymentProcessorEnumValue: String,
    IsPaymentCreditNote: Boolean,
    VATReturnId: Number,
    Id: Number,
    Date: Date,
    BulkId: Number,
    BFSTransactionId: mongoose.Schema.Types.Mixed,
    PaymentProcessor: Number,
    AccountId: Number,
    Note: String,
    Method: Number,
    Amount: Number,
    PayDate: Date,
  },
  { _id: false }
);

const PurchaseSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: uuidv4 },
    ...syncOnlyFields,
    Id: Number,
    Number: { type: Number, unique: true, required: true },
    SupplierId: Number,
    SupplierCode: String,
    SupplierName: String,
    SupplierReference: String,
    Currency: mongoose.Schema.Types.Mixed,
    DueDate: Date,
    GrossAmount: Number,
    HomeCurrencyGrossAmount: Number,
    IssuedDate: Date,
    FileCount: Number,
    LineItems: [mongoose.Schema.Types.Mixed],
    NetAmount: Number,
    NextNumber: Number,
    OverdueDays: Number,
    PaidDate: Date,
    PaymentLines: [PurchasePaymentLineSchema],
    Permalink: String,
    PreviousNumber: Number,
    PurchaseInECMemberState: Boolean,
    Status: String,
    StockManagementApplicable: Boolean,
    TotalPaidAmount: Number,
    VATAmount: Number,
    AdditionalFieldValue: String,
    IsWhtDeductionToBeApplied: Boolean,
    ReadableString: String,
    // CIS submission fields added by hcs-app - not part of KashFlow's core purchase model.
    SubmissionDate: Date,
    TaxMonth: Number,
    TaxYear: Number,
  },
  {
    collection: 'purchases',
    strict: false,
    minimize: false,
    timestamps: true,
  }
);

PurchaseSchema.index({ Id: 1 }, { unique: true, sparse: true });

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

const ProjectSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: uuidv4 },
    ...syncOnlyFields,
    Id: { type: Number },
    Number: { type: Number },
    Name: { type: String },
    Description: { type: String },
    Reference: { type: String },
    CustomerCode: { type: String },
    Status: { type: String },
    Note: { type: String },
    deletedAt: { type: Date, default: null },
    lastSeenRun: { type: Date },
  },
  {
    collection: 'projects',
    strict: false,
    minimize: false,
    timestamps: true,
  }
);

ProjectSchema.index({ Id: 1 }, { unique: true, sparse: true });

ProjectSchema.statics.syncConfig = {
  keyField: 'Id',
  fallbackKeyField: 'Number',
  protectedFields: ['deletedAt'],
};

export const Project =
  mongoose.models.project || mongoose.model('project', ProjectSchema);

// ── Nominal ─────────────────────────────────────────────────────────────

const NominalSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: uuidv4 },
    ...syncOnlyFields,
    Id: Number,
    Code: Number,
    Name: String,
    Type: { type: String, set: (v) => (v == null ? v : String(v)) },
    NomType: Number,
    Sa103Code: Number,
    DefaultProduct: mongoose.Schema.Types.Mixed,
    Disallowed: Boolean,
    ComplianceCode: String,
    Archived: Boolean,
    DigitalService: Boolean,
    IsProduct: Number,
    AutoFillLineItem: Boolean,
    Price: Number,
    WholeSalePrice: Number,
    VATRate: Number,
    VATExempt: Boolean,
    Description: String,
    Special: Number,
    Classification: String,
    ControlAccountClassification: String,
    AllowDelete: Boolean,
    PlOption: Number,
    BsOption: Number,
    IRISCoAName: String,
    IsIRISCoA: Boolean,
    ManageStockLevel: Boolean,
    QuantityInStock: Number,
    StockWarningQuantity: Number,
  },
  {
    collection: 'nominals',
    strict: false,
    minimize: false,
    timestamps: true,
  }
);

NominalSchema.index({ Id: 1 }, { unique: true, sparse: true });

NominalSchema.statics.syncConfig = {
  keyField: 'Id',
  fallbackKeyField: 'Code',
  protectedFields: [],
};

export const Nominal =
  mongoose.models.nominal || mongoose.model('nominal', NominalSchema);

// ── Note ────────────────────────────────────────────────────────────────

const NoteSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: uuidv4 },
    ...syncOnlyFields,
    // KashFlow note identifiers
    Number: { type: Number },
    // Target entity metadata
    ObjectType: { type: String, required: true },
    ObjectNumber: { type: Number, required: true },
    // Content
    Text: { type: String, required: true },
    // KashFlow canonical fields
    Date: { type: Date },
    LastModifiedBy: { type: String },
    CreatedDate: { type: Date },
    LastUpdatedDate: { type: Date },
    Author: { type: String },
    Permalink: { type: String },
  },
  {
    collection: 'notes',
    strict: false,
    minimize: false,
    timestamps: true,
  }
);

export const Note =
  mongoose.models.note || mongoose.model('note', NoteSchema);

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
};

export default models;
