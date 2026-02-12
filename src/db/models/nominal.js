const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// Nominal (Chart of Accounts) schema aligned with other REST models
const nominalSchema = new mongoose.Schema({
    uuid: { type: String, unique: true, required: true, default: uuidv4 },
    Id: Number,
    Code: Number, // e.g., 5000
    Name: String, // e.g., Materials Purchased
    // Some APIs return a string for Type; coerce any non-null value to string
    Type: { type: String, set: v => (v == null ? v : String(v)) },
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
    StockWarningQuantity: Number
}, { timestamps: true });

module.exports = {
    modelName: 'nominal',
    schema: nominalSchema
};