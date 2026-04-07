import crypto from 'node:crypto';
import mongoose from 'mongoose';
import logger from '../util/logger.js';
import createClient from '../kashflow/client.js';
import { connectMongoose, isMongooseEnabled } from '../db/mongoose.js';
import {
  Customer, Supplier, Invoice, Quote, Purchase, Project,
  SYNC_INTERNAL_FIELDS,
} from '../server/models/kashflow.js';
import { buildUpsertUpdate } from './run.js';

export { ENTITY_CONFIG };

/**
 * Map of entity types to their model, client method, and key config.
 */
const ENTITY_CONFIG = {
  purchase:  { model: Purchase,  getMethod: 'purchases',  keyField: 'Id', lookupField: 'Number' },
  invoice:   { model: Invoice,   getMethod: 'invoices',   keyField: 'Id', lookupField: 'Number' },
  quote:     { model: Quote,     getMethod: 'quotes',     keyField: 'Id', lookupField: 'Number' },
  customer:  { model: Customer,  getMethod: 'customers',  keyField: 'Id', lookupField: 'Code'   },
  supplier:  { model: Supplier,  getMethod: 'suppliers',  keyField: 'Id', lookupField: 'Code'   },
  project:   { model: Project,   getMethod: 'projects',   keyField: 'Id', lookupField: 'Number' },
};

/**
 * Fetch and upsert a single entity from KashFlow by its Number (or Code).
 *
 * @param {string} entityType - e.g. 'purchase', 'invoice', 'customer'
 * @param {string|number} entityId - The KashFlow Number or Code to fetch
 * @returns {Promise<object>} Result with before/after summary
 */
export async function pullSingleEntity(entityType, entityId) {
  const cfg = ENTITY_CONFIG[entityType];
  if (!cfg) {
    const supported = Object.keys(ENTITY_CONFIG).join(', ');
    throw new Error(`Unsupported entity type "${entityType}". Supported: ${supported}`);
  }

  if (!isMongooseEnabled()) {
    throw new Error('MongoDB is not configured');
  }
  await connectMongoose();

  const kf = await createClient();
  const { model, getMethod, keyField, lookupField } = cfg;

  // Fetch full detail from KashFlow
  logger.info({ entityType, entityId }, 'Manual pull: fetching from KashFlow');
  const full = await kf[getMethod].get(entityId);
  if (!full) {
    throw new Error(`KashFlow returned no data for ${entityType} ${entityId}`);
  }

  // Apply model transform if one exists (e.g. preparePurchaseForUpsert)
  if (model.syncConfig?.transform) {
    model.syncConfig.transform(full);
  }

  const id = full[keyField] ?? full.Id ?? full.id;
  if (id == null) {
    throw new Error(`Response missing key field "${keyField}"`);
  }

  // Read existing document for comparison
  const existing = await model.findOne({ [keyField]: id }).lean();

  // Build and execute upsert
  const now = new Date();
  const update = buildUpsertUpdate({
    keyField,
    keyValue: id,
    payload: full,
    syncedAt: now,
    model,
  });
  update.$set.detailSyncedAt = now;

  await model.bulkWrite([{
    updateOne: {
      filter: { [keyField]: id },
      update,
      upsert: true,
    },
  }], { ordered: false });

  // Verify the write took effect
  const after = await model.findOne({ [keyField]: id }).lean();
  const afterLineItems = Array.isArray(after?.LineItems) ? after.LineItems.length : 0;
  const afterPaymentLines = Array.isArray(after?.PaymentLines) ? after.PaymentLines.length : 0;

  const action = existing ? 'updated' : 'created';
  logger.info({ entityType, entityId, id, action, afterLineItems, afterPaymentLines }, 'Manual pull: upsert complete');

  return {
    ok: true,
    action,
    entityType,
    entityId,
    [keyField]: id,
    [lookupField]: full[lookupField],
    detailSyncedAt: now.toISOString(),
    debug: {
      kashflowLineItems: Array.isArray(full.LineItems) ? full.LineItems.length : 0,
      kashflowPaymentLines: Array.isArray(full.PaymentLines) ? full.PaymentLines.length : 0,
      kashflowGrossAmount: full.GrossAmount ?? null,
      setFields: Object.keys(update.$set).sort(),
      afterLineItems,
      afterPaymentLines,
      afterGrossAmount: after?.GrossAmount ?? null,
      afterDetailSyncedAt: after?.detailSyncedAt ?? null,
    },
  };
}

/**
 * Diagnose sync state for a single entity — compares MongoDB doc vs live KashFlow data.
 *
 * @param {string} entityType - e.g. 'purchase', 'invoice', 'customer'
 * @param {string|number} entityId - The KashFlow Number or Code to look up
 * @returns {Promise<object>} Diagnostic report
 */
export async function debugEntity(entityType, entityId) {
  const cfg = ENTITY_CONFIG[entityType];
  if (!cfg) {
    const supported = Object.keys(ENTITY_CONFIG).join(', ');
    throw new Error(`Unsupported entity type "${entityType}". Supported: ${supported}`);
  }

  const report = { entityType, entityId, mongo: null, kashflow: null, diagnosis: [] };
  const { model, getMethod, keyField, lookupField } = cfg;

  // ── MongoDB lookup ──────────────────────────────────────────────────
  if (isMongooseEnabled()) {
    await connectMongoose();
    // Try lookup by the lookupField first (Number/Code), fallback to keyField (Id)
    let doc = await model.findOne({ [lookupField]: entityId }).lean();
    if (!doc && !isNaN(entityId)) {
      doc = await model.findOne({ [keyField]: Number(entityId) }).lean();
    }

    if (doc) {
      const lineItems = doc.LineItems;
      const paymentLines = doc.PaymentLines;
      report.mongo = {
        [keyField]: doc[keyField],
        [lookupField]: doc[lookupField],
        syncedAt: doc.syncedAt || null,
        detailSyncedAt: doc.detailSyncedAt || null,
        createdAt: doc.createdAt || null,
        updatedAt: doc.updatedAt || null,
        hasLineItems: Array.isArray(lineItems) && lineItems.length > 0,
        lineItemsCount: Array.isArray(lineItems) ? lineItems.length : 0,
        hasPaymentLines: Array.isArray(paymentLines) && paymentLines.length > 0,
        paymentLinesCount: Array.isArray(paymentLines) ? paymentLines.length : 0,
        NetAmount: doc.NetAmount ?? null,
        VATAmount: doc.VATAmount ?? null,
        GrossAmount: doc.GrossAmount ?? doc.ProjectGrossAmount ?? null,
        Status: doc.Status ?? null,
        fieldCount: Object.keys(doc).length,
        fields: Object.keys(doc).sort(),
      };

      // Diagnostics from MongoDB state
      if (!doc.detailSyncedAt) {
        report.diagnosis.push('MISSING_DETAIL_SYNC: Document has never had a Phase 2 detail sync (detailSyncedAt is null). LineItems/PaymentLines may be absent.');
      }
      if (doc.syncedAt && doc.detailSyncedAt && doc.syncedAt > doc.detailSyncedAt) {
        report.diagnosis.push('STALE_DETAIL: Phase 1 (syncedAt) is newer than Phase 2 (detailSyncedAt). A recent list sync overwrote fields but detail was not re-fetched.');
      }
      if (!Array.isArray(lineItems) || lineItems.length === 0) {
        report.diagnosis.push('NO_LINE_ITEMS: No LineItems array in MongoDB document.');
      }
      if (!Array.isArray(paymentLines) || paymentLines.length === 0) {
        report.diagnosis.push('NO_PAYMENT_LINES: No PaymentLines array in MongoDB document.');
      }
    } else {
      report.diagnosis.push('NOT_IN_MONGO: Document not found in MongoDB.');
    }
  } else {
    report.diagnosis.push('MONGO_DISABLED: MongoDB is not configured; cannot check local state.');
  }

  // ── KashFlow lookup ─────────────────────────────────────────────────
  try {
    const kf = await createClient();
    const full = await kf[getMethod].get(entityId);
    if (full) {
      const lineItems = full.LineItems;
      const paymentLines = full.PaymentLines;
      report.kashflow = {
        [keyField]: full[keyField],
        [lookupField]: full[lookupField],
        hasLineItems: Array.isArray(lineItems) && lineItems.length > 0,
        lineItemsCount: Array.isArray(lineItems) ? lineItems.length : 0,
        hasPaymentLines: Array.isArray(paymentLines) && paymentLines.length > 0,
        paymentLinesCount: Array.isArray(paymentLines) ? paymentLines.length : 0,
        NetAmount: full.NetAmount ?? null,
        VATAmount: full.VATAmount ?? null,
        GrossAmount: full.GrossAmount ?? full.ProjectGrossAmount ?? null,
        Status: full.Status ?? null,
        fieldCount: Object.keys(full).length,
        fields: Object.keys(full).sort(),
      };

      // Compare with MongoDB
      if (report.mongo) {
        const mongoDoc = report.mongo;

        if (mongoDoc.lineItemsCount !== report.kashflow.lineItemsCount) {
          report.diagnosis.push(
            `LINE_ITEMS_MISMATCH: MongoDB has ${mongoDoc.lineItemsCount} LineItems, KashFlow has ${report.kashflow.lineItemsCount}.`
          );
        }
        if (mongoDoc.paymentLinesCount !== report.kashflow.paymentLinesCount) {
          report.diagnosis.push(
            `PAYMENT_LINES_MISMATCH: MongoDB has ${mongoDoc.paymentLinesCount} PaymentLines, KashFlow has ${report.kashflow.paymentLinesCount}.`
          );
        }
        if (Number(mongoDoc.NetAmount) !== Number(report.kashflow.NetAmount)) {
          report.diagnosis.push(
            `NET_AMOUNT_MISMATCH: MongoDB=${mongoDoc.NetAmount}, KashFlow=${report.kashflow.NetAmount}`
          );
        }
        if (Number(mongoDoc.GrossAmount) !== Number(report.kashflow.GrossAmount)) {
          report.diagnosis.push(
            `GROSS_AMOUNT_MISMATCH: MongoDB=${mongoDoc.GrossAmount}, KashFlow=${report.kashflow.GrossAmount}`
          );
        }

        // Check for fields in KashFlow not present in MongoDB
        const mongoFields = new Set(report.mongo.fields);
        const missingFields = report.kashflow.fields.filter(f => !mongoFields.has(f));
        if (missingFields.length > 0) {
          report.diagnosis.push(`MISSING_FIELDS: KashFlow has fields not in MongoDB: ${missingFields.join(', ')}`);
        }
      }
    } else {
      report.diagnosis.push('NOT_IN_KASHFLOW: KashFlow returned no data for this identifier.');
    }
  } catch (err) {
    report.diagnosis.push(`KASHFLOW_ERROR: Failed to fetch from KashFlow: ${err.message}`);
  }

  if (report.diagnosis.length === 0) {
    report.diagnosis.push('OK: MongoDB and KashFlow data appear in sync.');
  }

  return report;
}
