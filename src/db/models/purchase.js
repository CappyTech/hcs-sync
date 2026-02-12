const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const purchaseSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
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
  PaymentLines: [new mongoose.Schema({
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
    PayDate: Date
  }, { _id: false })],
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
  SubmissionDate: Date,
  TaxMonth: Number,
  TaxYear: Number
}, { timestamps: true });

module.exports = {
  modelName: 'purchase',
  schema: purchaseSchema
};