/**
 * Deduplication + uuid-backfill logic for KashFlow MongoDB collections.
 *
 * Exports a single `runDedup(db, options)` function that can be called
 * from the CLI migration script or from the server's dashboard route.
 *
 * Returns a detailed result object with per-collection stats and an
 * itemised `actions` array recording every delete and uuid backfill.
 */

import crypto from 'node:crypto';

const COLLECTIONS = [
  { name: 'customers',  idField: 'Id' },
  { name: 'suppliers',  idField: 'Id' },
  { name: 'invoices',   idField: 'Id' },
  { name: 'quotes',     idField: 'Id' },
  { name: 'purchases',  idField: 'Id' },
  { name: 'projects',   idField: 'Id' },
  { name: 'nominals',   idField: 'Id' },
];

/** Sort docs array in-place: oldest first (by syncedAt, then _id). */
function sortOldestFirst(docs) {
  docs.sort((a, b) => {
    const aTime = a.syncedAt ? new Date(a.syncedAt).getTime() : 0;
    const bTime = b.syncedAt ? new Date(b.syncedAt).getTime() : 0;
    if (aTime !== bTime) return aTime - bTime;
    return String(a._id).localeCompare(String(b._id));
  });
}

async function dedupCollection(db, { name, idField }, { dryRun = false, log = console.log, actions = [] } = {}) {
  const col = db.collection(name);

  const pipeline = [
    { $match: { [idField]: { $exists: true, $ne: null } } },
    {
      $group: {
        _id: `$${idField}`,
        count: { $sum: 1 },
        docs: { $push: { _id: '$_id', uuid: '$uuid', syncedAt: '$syncedAt' } },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ];

  const duplicates = await col.aggregate(pipeline, { allowDiskUse: true }).toArray();

  if (duplicates.length === 0) {
    log(`  ${name}: no duplicates found`);
    return { collection: name, duplicateGroups: 0, deleted: 0 };
  }

  let totalDeleted = 0;

  for (const group of duplicates) {
    const entityId = group._id; // KashFlow Id value
    const docs = group.docs;
    const withUuid = docs.filter((d) => d.uuid);
    const withoutUuid = docs.filter((d) => !d.uuid);

    let kept = null;
    let toDelete = [];

    if (withUuid.length > 0) {
      toDelete.push(...withoutUuid.map((d) => d._id));
      if (withUuid.length > 1) {
        sortOldestFirst(withUuid);
        kept = withUuid[0];
        toDelete.push(...withUuid.slice(1).map((d) => d._id));
      } else {
        kept = withUuid[0];
      }
    } else {
      sortOldestFirst(docs);
      kept = docs[0];
      toDelete.push(...docs.slice(1).map((d) => d._id));
    }

    if (toDelete.length === 0) continue;

    // Log every deletion with full context
    const action = dryRun ? 'would-delete' : 'deleted';
    for (const deletedId of toDelete) {
      const deletedDoc = docs.find((d) => String(d._id) === String(deletedId));
      const entry = {
        type: action,
        collection: name,
        entityId,
        documentId: String(deletedId),
        hadUuid: Boolean(deletedDoc?.uuid),
        uuid: deletedDoc?.uuid || null,
        syncedAt: deletedDoc?.syncedAt || null,
        keptDocumentId: kept ? String(kept._id) : null,
        keptUuid: kept?.uuid || null,
        reason: deletedDoc?.uuid
          ? 'duplicate with uuid (newer copy removed, oldest kept)'
          : 'duplicate without uuid (uuid-bearing copy kept)',
      };
      actions.push(entry);
      log(`  ${name}: ${action} _id=${entry.documentId} (${idField}=${entityId}, uuid=${entry.uuid || 'none'}) — kept _id=${entry.keptDocumentId}`);
    }

    if (!dryRun) {
      const result = await col.deleteMany({ _id: { $in: toDelete } });
      totalDeleted += result.deletedCount || 0;
    } else {
      totalDeleted += toDelete.length;
    }
  }

  const verb = dryRun ? 'would delete' : 'deleted';
  log(`  ${name}: ${duplicates.length} duplicate groups, ${verb} ${totalDeleted} documents`);
  return { collection: name, duplicateGroups: duplicates.length, deleted: totalDeleted };
}

async function backfillUuids(db, { dryRun = false, log = console.log, actions = [] } = {}) {
  let totalBackfilled = 0;
  const missingFilter = { $or: [{ uuid: { $exists: false } }, { uuid: null }, { uuid: '' }] };

  for (const { name, idField } of COLLECTIONS) {
    const col = db.collection(name);
    const missing = await col.countDocuments(missingFilter);
    if (missing === 0) {
      log(`  ${name}: all documents have uuids`);
      continue;
    }
    if (!dryRun) {
      const cursor = col.find(missingFilter);
      const ops = [];
      for await (const doc of cursor) {
        const newUuid = crypto.randomUUID();
        ops.push({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { uuid: newUuid } },
          },
        });

        const entry = {
          type: 'uuid-backfill',
          collection: name,
          entityId: doc[idField] ?? null,
          documentId: String(doc._id),
          assignedUuid: newUuid,
        };
        actions.push(entry);
        log(`  ${name}: assigned uuid=${newUuid} to _id=${entry.documentId} (${idField}=${entry.entityId ?? 'n/a'})`);

        if (ops.length >= 500) {
          await col.bulkWrite(ops, { ordered: false });
          ops.length = 0;
        }
      }
      if (ops.length) await col.bulkWrite(ops, { ordered: false });
      log(`  ${name}: backfilled uuid on ${missing} documents`);
    } else {
      // In dry-run, just count and report without per-doc detail
      const cursor = col.find(missingFilter, { projection: { _id: 1, [idField]: 1 } });
      for await (const doc of cursor) {
        const entry = {
          type: 'would-uuid-backfill',
          collection: name,
          entityId: doc[idField] ?? null,
          documentId: String(doc._id),
          assignedUuid: null,
        };
        actions.push(entry);
        log(`  ${name}: would assign uuid to _id=${entry.documentId} (${idField}=${entry.entityId ?? 'n/a'})`);
      }
      log(`  ${name}: would backfill uuid on ${missing} documents`);
    }
    totalBackfilled += missing;
  }

  return totalBackfilled;
}

/**
 * Run the full dedup + uuid-backfill pipeline.
 *
 * @param {import('mongodb').Db} db  - MongoDB database instance
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]  - if true, report what would be done without modifying data
 * @param {Function} [options.log]          - logging function (default: console.log)
 * @returns {Promise<{collections: object[], totalGroups: number, totalDeleted: number, totalBackfilled: number, actions: object[]}>}
 */
export async function runDedup(db, { dryRun = false, log = console.log } = {}) {
  const actions = []; // itemised log of every change
  const opts = { dryRun, log, actions };

  log(dryRun ? '=== DRY RUN ===' : '=== APPLYING DEDUPLICATION ===');

  // Pass 1: deduplicate
  log('\nPass 1: Deduplicate by Id (prefer docs with uuid)\n');
  const results = [];
  for (const spec of COLLECTIONS) {
    results.push(await dedupCollection(db, spec, opts));
  }

  // Pass 2: backfill uuids
  log('\nPass 2: Backfill missing uuids\n');
  const totalBackfilled = await backfillUuids(db, opts);

  const totalGroups = results.reduce((s, r) => s + r.duplicateGroups, 0);
  const totalDeleted = results.reduce((s, r) => s + r.deleted, 0);

  log('\n=== Summary ===');
  log(`Total duplicate groups: ${totalGroups}`);
  log(`Total documents ${dryRun ? 'to delete' : 'deleted'}: ${totalDeleted}`);
  log(`Total uuids ${dryRun ? 'to backfill' : 'backfilled'}: ${totalBackfilled}`);
  log(`Total actions recorded: ${actions.length}`);

  return { collections: results, totalGroups, totalDeleted, totalBackfilled, actions };
}

export default runDedup;
