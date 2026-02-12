const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const projectSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  // KashFlow identifiers and key fields
  Id: { type: Number },
  Number: { type: Number },
  Name: { type: String },
  Description: { type: String },
  Reference: { type: String },
  CustomerCode: { type: String },
  // Business fields
  Status: { type: String }, // e.g., 'Active', 'Pending', 'In Progress', 'Completed'
  Note: { type: String },
  // Lifecycle/ops fields
  deletedAt: { type: Date, default: null },
  lastSeenRun: { type: Date }
}, { timestamps: true });

module.exports = {
  modelName: 'project',
  schema: projectSchema
};