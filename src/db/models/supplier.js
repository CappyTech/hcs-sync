const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const supplierSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
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
  // CIS fields
  Subcontractor: { type: Boolean, default: false },
  IsSubcontractor: { type: Boolean, default: false },
  CISRate: { type: Number, enum: [null, 0, 0.2, 0.3], default: null },
  CISNumber: { type: String, default: null }
}, { timestamps: true });

module.exports = {
  modelName: 'supplier',
  schema: supplierSchema
};