const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const invoiceSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
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
  VATNumber: String
}, { timestamps: true });

module.exports = {
  modelName: 'invoice',
  schema: invoiceSchema
};