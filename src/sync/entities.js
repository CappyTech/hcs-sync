/**
 * The synced-entity registry, derived from each model's syncConfig.
 *
 * Everything that needs to know "which entities does hcs-sync write, under
 * what name, keyed on what" reads it from here rather than keeping its own
 * list — the sync phases, the manual pull, and the history page's
 * collection allowlist. See the syncConfig contract in
 * src/server/models/kashflow.js.
 */
import models from '../server/models/kashflow.js';

/**
 * @typedef {object} SyncedEntity
 * @property {import('mongoose').Model} model
 * @property {string} summaryKey      key in run counts and the Mongo write summary
 * @property {string} collectionName  the Mongo collection the model writes to
 * @property {string[]} keyFields     upsert key, then its fallbacks, in order
 * @property {string|undefined} lookupField  set only for pullable entities
 * @property {boolean} listOnly
 */

/** @returns {SyncedEntity} */
export function describeEntity(model) {
  const cfg = model.syncConfig;
  return {
    model,
    summaryKey: cfg.summaryKey,
    collectionName: model.collection.collectionName,
    keyFields: [cfg.keyField, ...(cfg.fallbackKeyFields || [])],
    lookupField: cfg.lookupField,
    listOnly: Boolean(cfg.listOnly),
  };
}

// A model is synced when it declares a summaryKey. BankReconciliation is null
// against hcs-schemas < 2.1.0, hence the guard.
export const SYNCED_ENTITIES = Object.values(models)
  .filter((model) => model?.syncConfig?.summaryKey)
  .map(describeEntity);

export const entityBySummaryKey = new Map(SYNCED_ENTITIES.map((e) => [e.summaryKey, e]));

export const SYNCED_COLLECTION_NAMES = new Set(SYNCED_ENTITIES.map((e) => e.collectionName));

/** Models whose list payload is all there is — no detail phase. */
export const LIST_ONLY_MODELS = SYNCED_ENTITIES.filter((e) => e.listOnly).map((e) => e.model);

/**
 * The entity type hcs-app and the debug page use for a manual pull: the
 * summary key, lower-cased and singular ('purchaseOrders' → 'purchaseorder').
 * It is part of the /api/pull contract, so it must not drift.
 */
export function pullTypeOf(summaryKey) {
  return summaryKey.toLowerCase().replace(/s$/, '');
}
