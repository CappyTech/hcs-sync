const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// REST Note model maps KashFlow entity notes
// Endpoints: GET/POST/PUT/DELETE /{objectType}/{objectNumber}/notes(/ {number})
// objectType typically 'customers' | 'suppliers' | 'invoices' | 'purchases' etc.

const noteSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  // KashFlow note identifiers
  Number: { type: Number },

  // Target entity metadata
  ObjectType: { type: String, required: true }, // e.g., 'customers', 'suppliers', 'invoices', 'purchases'
  ObjectNumber: { type: Number, required: true }, // target entity numeric identifier

  // Content
  Text: { type: String, required: true },
  // KashFlow canonical fields per API docs
  Date: { type: Date },
  LastModifiedBy: { type: String },

  // Optional metadata commonly present in KF responses
  CreatedDate: { type: Date },
  LastUpdatedDate: { type: Date },
  Author: { type: String },
  // For linking back to UI when available
  Permalink: { type: String }
}, { timestamps: true });

module.exports = {
  modelName: 'note',
  schema: noteSchema
};
