/**
 * Tests for the synced-entity registry (src/sync/entities.js) and the
 * syncConfig metadata it is derived from.
 *
 * Several of these values are contracts with the outside world — run summary
 * keys feed Discord and run history, collection names are what hcs-app reads,
 * and pull types are the /api/pull vocabulary hcs-app sends — so they are
 * pinned exactly rather than just checked for shape.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));

import models from '../src/server/models/kashflow.js';
import {
  SYNCED_ENTITIES, entityBySummaryKey, SYNCED_COLLECTION_NAMES, LIST_ONLY_MODELS, pullTypeOf, indexPlan,
} from '../src/sync/entities.js';
import { ENTITY_CONFIG } from '../src/sync/pull.js';

const byKey = Object.fromEntries(SYNCED_ENTITIES.map((e) => [e.summaryKey, e]));

describe('synced-entity registry', () => {
  it('maps every summary key to its Mongo collection', () => {
    expect(Object.fromEntries(SYNCED_ENTITIES.map((e) => [e.summaryKey, e.collectionName]))).toEqual({
      customers: 'customers',
      suppliers: 'suppliers',
      invoices: 'invoices',
      quotes: 'quotes',
      purchases: 'purchases',
      projects: 'projects',
      nominals: 'nominals',
      vatRates: 'vatrates',
      bankAccounts: 'bankaccounts',
      bankTransactions: 'banktransactions',
      bankReconciliations: 'bankreconciliations',
      journals: 'journals',
      products: 'products',
      purchaseOrders: 'purchaseorders',
      quoteCategories: 'quotecategories',
      purchaseOrderCategories: 'purchaseordercategories',
      currencies: 'currencies',
      countries: 'countries',
      accountingPeriods: 'accountingperiods',
      vatReturns: 'vatreturns',
    });
  });

  it('leaves out models that are not synced', () => {
    expect(SYNCED_COLLECTION_NAMES.has('notes')).toBe(false);
    expect(entityBySummaryKey.has('notes')).toBe(false);
  });

  it('declares keys with their fallbacks in order', () => {
    expect(byKey.journals.keyFields).toEqual(['Id', 'Number']);
    expect(byKey.products.keyFields).toEqual(['Id', 'Code']);
    expect(byKey.purchaseOrders.keyFields).toEqual(['Id', 'Number']);
    expect(byKey.currencies.keyFields).toEqual(['Id', 'Code']);
    expect(byKey.countries.keyFields).toEqual(['Id', 'Code']);
    expect(byKey.quoteCategories.keyFields).toEqual(['Number']);
    expect(byKey.vatRates.keyFields).toEqual(['VATId']);
    expect(byKey.bankReconciliations.keyFields).toEqual(['ReconKey']);
    expect(byKey.nominals.keyFields).toEqual(['Id', 'Code']);
    expect(byKey.bankAccounts.keyFields).toEqual(['Id', 'Code']);
  });

  it('scopes only the bank transaction key, to the feed account', () => {
    const scoped = SYNCED_ENTITIES.filter((e) => e.scopeFields.length);
    expect(scoped.map((e) => [e.summaryKey, e.scopeFields])).toEqual([['bankTransactions', ['AccountId']]]);
  });

  it('marks exactly the historical dedup collections, never a scoped one', () => {
    const dedup = SYNCED_ENTITIES.filter((e) => e.dedup);
    expect(dedup.map((e) => e.collectionName)).toEqual([
      'customers', 'suppliers', 'invoices', 'quotes', 'purchases', 'projects', 'nominals',
    ]);
    expect(dedup.every((e) => e.scopeFields.length === 0)).toBe(true);
  });

  it('marks exactly the entities with no detail phase as list-only', () => {
    expect(LIST_ONLY_MODELS.map((m) => m.syncConfig.summaryKey).sort()).toEqual([
      'accountingPeriods', 'countries', 'currencies', 'journals', 'products',
      'purchaseOrderCategories', 'purchaseOrders', 'quoteCategories', 'vatReturns',
    ]);
  });

  it('gives every synced model the syncConfig fields the engine relies on', () => {
    for (const model of Object.values(models)) {
      if (!model?.syncConfig?.summaryKey) continue;
      expect(typeof model.syncConfig.keyField).toBe('string');
      expect(Array.isArray(model.syncConfig.protectedFields)).toBe(true);
    }
  });
});

describe('pull types', () => {
  it('singularises and lower-cases the summary key', () => {
    expect(pullTypeOf('purchaseOrders')).toBe('purchaseorder');
    expect(pullTypeOf('vatReturns')).toBe('vatreturn');
    expect(pullTypeOf('invoices')).toBe('invoice');
  });

  it('keeps the /api/pull vocabulary and lookups hcs-app depends on', () => {
    const summary = Object.fromEntries(Object.entries(ENTITY_CONFIG).map(([type, cfg]) => [
      type, [cfg.model.modelName, cfg.getMethod, cfg.keyField, cfg.lookupField],
    ]));
    expect(summary).toEqual({
      customer: ['customer', 'customers', 'Id', 'Code'],
      supplier: ['supplier', 'suppliers', 'Id', 'Code'],
      invoice: ['invoice', 'invoices', 'Id', 'Number'],
      quote: ['quote', 'quotes', 'Id', 'Number'],
      purchase: ['purchase', 'purchases', 'Id', 'Number'],
      project: ['project', 'projects', 'Id', 'Number'],
      journal: ['journal', 'journals', 'Id', 'Number'],
      product: ['product', 'products', 'Id', 'Code'],
      purchaseorder: ['purchaseorder', 'purchaseOrders', 'Id', 'Number'],
      vatreturn: ['vatreturn', 'vatReturns', 'Id', 'Id'],
    });
  });
});

describe('index plan', () => {
  const plan = indexPlan();
  const names = (list) => list.map((i) => `${i.collectionName}.${i.field ?? i.fields.join('+')}`).sort();

  it('puts a unique index on every plain key', () => {
    expect(names(plan.unique)).toEqual([
      'accountingperiods.Id', 'bankaccounts.Id', 'bankreconciliations.ReconKey', 'countries.Id',
      'currencies.Id', 'customers.Id', 'invoices.Id', 'journals.Id', 'nominals.Id', 'products.Id',
      'projects.Id', 'purchaseordercategories.Number', 'purchaseorders.Id', 'purchases.Id',
      'quotecategories.Number', 'quotes.Id', 'suppliers.Id', 'vatrates.VATId', 'vatreturns.Id',
    ]);
  });

  it('treats only string keys as strings (blank values are unset before indexing)', () => {
    expect(plan.unique.filter((i) => i.keyType === 'string').map((i) => i.field)).toEqual(['ReconKey']);
  });

  it('keys bank transactions on the (AccountId, Id) composite, not a bare Id', () => {
    expect(plan.scopedUnique).toEqual([{ collectionName: 'banktransactions', fields: ['AccountId', 'Id'] }]);
    expect(names(plan.unique)).not.toContain('banktransactions.Id');
  });

  it('indexes fallback keys, lookup fields and the scoped bare key, non-uniquely', () => {
    expect(names(plan.secondary)).toEqual([
      'bankaccounts.Code', 'banktransactions.Id', 'countries.Code', 'currencies.Code',
      'customers.Code', 'invoices.Number', 'journals.Number', 'nominals.Code', 'products.Code',
      'projects.Number', 'purchaseorders.Number', 'purchases.Number', 'quotes.Number', 'suppliers.Code',
    ]);
  });

  it('lets the legacy-index repair keep each collection\'s full key', () => {
    expect(plan.managedUniqueFields.banktransactions).toEqual(['AccountId', 'Id']);
    expect(plan.managedUniqueFields.bankreconciliations).toEqual(['ReconKey']);
    expect(Object.keys(plan.managedUniqueFields)).toHaveLength(20);
  });
});
