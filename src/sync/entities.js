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
 * @property {string[]} scopeFields   fields the key is unique within ([] for a plain key)
 * @property {'string'|'any'} keyType 'string' when the key is a String in the schema
 * @property {string|undefined} lookupField  set only for pullable entities
 * @property {boolean} listOnly
 * @property {boolean} dedup           included in the duplicate cleanup
 */

/** @returns {SyncedEntity} */
export function describeEntity(model) {
  const cfg = model.syncConfig;
  return {
    model,
    summaryKey: cfg.summaryKey,
    collectionName: model.collection.collectionName,
    keyFields: [cfg.keyField, ...(cfg.fallbackKeyFields || [])],
    scopeFields: cfg.scopeFields || [],
    keyType: model.schema.path(cfg.keyField)?.instance === 'String' ? 'string' : 'any',
    lookupField: cfg.lookupField,
    listOnly: Boolean(cfg.listOnly),
    dedup: Boolean(cfg.dedup),
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

/**
 * The indexes each synced collection needs, derived from syncConfig:
 *
 *  - unique: the key. A plain key gets a partial unique index on keyField; a
 *    scoped key gets a unique compound index on scopeFields + keyField instead,
 *    and its bare keyField gets a non-unique index (it repeats across scopes).
 *  - secondary: non-unique indexes on the fallback keys and the lookup field,
 *    which the sync and manual pulls query by.
 *  - managedUniqueFields: the fields a unique index may legitimately cover, per
 *    collection — what the legacy-index repair in src/db/mongo.js keeps.
 */
export function indexPlan(entities = SYNCED_ENTITIES) {
  const managedUniqueFields = {};
  const unique = [];
  const scopedUnique = [];
  const secondary = [];
  for (const { collectionName, keyFields, scopeFields, keyType, lookupField } of entities) {
    const [keyField, ...fallbacks] = keyFields;
    managedUniqueFields[collectionName] = [...scopeFields, keyField];
    if (scopeFields.length) {
      scopedUnique.push({ collectionName, fields: [...scopeFields, keyField] });
      secondary.push({ collectionName, field: keyField });
    } else {
      unique.push({ collectionName, field: keyField, keyType });
    }
    const extra = new Set(fallbacks);
    if (lookupField && lookupField !== keyField) extra.add(lookupField);
    for (const field of extra) secondary.push({ collectionName, field });
  }
  return { managedUniqueFields, unique, scopedUnique, secondary };
}
