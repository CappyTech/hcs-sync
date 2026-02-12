const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const quoteSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
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
  CustomerCode: String
}, { timestamps: true });

module.exports = {
  modelName: 'quote',
  schema: quoteSchema
};