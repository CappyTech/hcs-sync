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
    // CIS submission fields added by hcs-app
    ReadableString: String,
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
