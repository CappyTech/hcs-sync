const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const customerSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
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
  Source: Number,
  CreateCustomerCodeIfDuplicate: Boolean,
  CreateCustomerNameIfEmptyOrNull: Boolean
}, { timestamps: true });

module.exports = {
  modelName: 'customer',
  schema: customerSchema
};