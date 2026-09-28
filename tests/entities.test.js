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
  SYNCED_ENTITIES, entityBySummaryKey, SYNCED_COLLECTION_NAMES, LIST_ONLY_MODELS, pullTypeOf,
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
