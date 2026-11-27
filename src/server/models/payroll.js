import crypto from 'node:crypto';
import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';

/**
 * Payroll provider models (Staffology today), built from @cappytech/hcs-schemas
 * like the KashFlow models, but registered on the Staffology database's
 * connection rather than the default one, and deliberately without a
 * syncConfig: the KashFlow entity registry, dedup and history never see them.
 *
 * null when the installed hcs-schemas predates 3.1.0.
 */
function buildSchema(entity) {
  const schema = new mongoose.Schema(
    { uuid: schemas.uuidField, ...entity.fields },
    { collection: entity.collection, strict: false, minimize: false, timestamps: true },
  );
  entity.indexes.forEach((idx) => schema.index(idx.fields, idx.options));
  return schema;
}

const cache = new WeakMap();

/** @returns {{ PayrollEmployee: mongoose.Model, PayrollPayRunEntry: mongoose.Model } | null} */
export function payrollModels(conn) {
  if (!schemas.payrollEmployee || !schemas.payrollPayRunEntry) return null;
  if (cache.has(conn)) return cache.get(conn);
  const models = {
    PayrollEmployee: conn.models.payrollemployee
      || conn.model('payrollemployee', buildSchema(schemas.payrollEmployee)),
    PayrollPayRunEntry: conn.models.payrollpayrunentry
      || conn.model('payrollpayrunentry', buildSchema(schemas.payrollPayRunEntry)),
  };
  cache.set(conn, models);
  return models;
}

/** Bulk upsert normalised docs keyed on (Source, ExternalId). */
export async function upsertBySourceId(model, docs) {
  if (!docs.length) return { upserted: 0, modified: 0, matched: 0 };
  const ops = docs.map((doc) => ({
    updateOne: {
      filter: { Source: doc.Source, ExternalId: doc.ExternalId },
      update: { $set: doc, $setOnInsert: { uuid: crypto.randomUUID() } },
      upsert: true,
    },
  }));
  const res = await model.bulkWrite(ops, { ordered: false });
  return {
    upserted: res.upsertedCount ?? 0,
    modified: res.modifiedCount ?? 0,
    matched: res.matchedCount ?? 0,
  };
}
