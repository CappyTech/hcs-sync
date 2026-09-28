import express from 'express';
import runStore from '../runStore.js';
import { getMongoDb, isMongoEnabled } from '../../db/mongo.js';
import { entityBySummaryKey, SYNCED_COLLECTION_NAMES } from '../../sync/entities.js';
import { requireAdmin } from '../middleware/auth.js';
import { isRunning, lastRun, lastCounts, lastError } from '../syncController.js';

const router = express.Router();

// History pages
router.get('/history', requireAdmin, async (_req, res) => {
  try {
    const runs = await runStore.listRuns();
    res.render('layout', { title: 'Sync History', content: 'pages/history', runs, isRunning, lastRun, counts: lastCounts, lastError });
  } catch (err) {
    res.status(500).send(err?.message || 'Failed to load history');
  }
});

/**
 * Load the documents a run inserted for one entity, for the run page's
 * drilldown. `entity` is from the synced-entity registry: its summaryKey
 * indexes the run summary, its collectionName is what gets queried. Prefers the upsert filters captured during the run and falls back
 * to the createdByRunId tag for Mongo-compatible servers that don't return
 * upsertedIds from bulkWrite.
 *
 * @returns {Promise<{docs: object[]|null, source: string|null, error: string|null}>}
 */
async function loadUpsertedDocs(run, entity) {
  if (!isMongoEnabled()) {
    return { docs: null, source: null, error: 'MongoDB is not configured on the server (cannot load docs).' };
  }
  const filters = run?.summary?.mongoUpserts?.[entity.summaryKey]?.filters || [];
  const [query, source] = filters.length
    ? [{ $or: filters }, 'filters']
    : [{ createdByRunId: run.id }, 'createdByRunId'];
  try {
    const db = await getMongoDb();
    const docs = await db.collection(entity.collectionName).find(query, { limit: 200 }).toArray();
    return { docs, source, error: null };
  } catch (err) {
    return { docs: null, source: null, error: err?.message || 'Failed to load Mongo documents.' };
  }
}

/** Audit trail entries for a run, optionally narrowed to one collection. */
async function loadAuditEntries(runId, collection) {
  if (!isMongoEnabled()) return { entries: [], error: null };
  try {
    const db = await getMongoDb();
    const filter = { runId };
    if (collection) filter.collection = collection;
    const entries = await db
      .collection('audit_log')
      .find(filter)
      .sort({ timestamp: 1 })
      .limit(500)
      .toArray();
    return { entries, error: null };
  } catch (err) {
    return { entries: [], error: err?.message || 'Failed to load audit trail.' };
  }
}

router.get('/history/:id', requireAdmin, async (req, res) => {
  try {
    const run = await runStore.getRun(req.params.id);
    if (!run) return res.status(404).send('Run not found');

    // Two different names arrive here, and both are checked against the
    // synced-entity registry rather than trusted: mongoCollection is a run
    // summary key (e.g. 'vatRates'), auditCollection is the Mongo collection
    // the audit entries name (e.g. 'vatrates').
    const mongoCollectionRaw = String(req.query?.mongoCollection || '');
    const mongoEntity = entityBySummaryKey.get(mongoCollectionRaw) || null;
    const mongoCollection = mongoEntity ? mongoCollectionRaw : '';
    const mongoType = String(req.query?.mongoType || '');
    let mongoDocs = null;
    let mongoDocsError = null;
    let mongoDocsSource = null;
    const mongoUpsertedCount = Number(run?.summary?.mongo?.[mongoCollection]?.upserted ?? 0);

    if (mongoCollectionRaw && !mongoCollection) {
      mongoDocsError = 'Invalid collection name.';
    }

    if (mongoCollection && mongoType === 'upserted') {
      ({ docs: mongoDocs, source: mongoDocsSource, error: mongoDocsError } = await loadUpsertedDocs(run, mongoEntity));

      if (!mongoDocsError && Array.isArray(mongoDocs) && mongoDocs.length === 0 && mongoUpsertedCount > 0) {
        mongoDocsError =
          'This run reports inserted documents, but the server could not locate them for drilldown. ' +
          'If this run was created before insert tagging was added, re-run a sync to enable drilldown.';
      }
    }

    const auditCollectionRaw = String(req.query?.auditCollection || '');
    const auditCollection = SYNCED_COLLECTION_NAMES.has(auditCollectionRaw) ? auditCollectionRaw : '';
    const { entries: auditEntries, error: auditError } = await loadAuditEntries(run.id, auditCollection);

    res.render('layout', {
      title: 'Run Details',
      content: 'pages/run',
      run,
      isRunning,
      lastRun,
      counts: lastCounts,
      lastError,
      mongoCollection,
      mongoType,
      mongoDocs,
      mongoDocsError,
      mongoDocsSource,
      mongoUpsertedCount,
      auditEntries,
      auditError,
      auditCollection,
    });
  } catch (err) {
    res.status(500).send(err?.message || 'Failed to load run');
  }
});

// Revert endpoint (records the revert; no DB writes to synced data yet)
router.post('/history/:id/revert/:changeId', requireAdmin, async (req, res) => {
  const note = req.body?.note || '';
  try {
    const out = await runStore.revertChange(req.params.id, req.params.changeId, note);
    if (!out.ok) return res.status(400).send(out.message || 'Revert failed');
    res.redirect(`/history/${req.params.id}`);
  } catch (err) {
    res.status(500).send(err?.message || 'Revert failed');
  }
});

export default router;
