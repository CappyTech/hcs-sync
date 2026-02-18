#!/usr/bin/env node

/**
 * One-time migration: deduplicate MongoDB collections synced from KashFlow.
 *
 * Strategy (two passes per collection):
 *
 *   Pass 1 – Remove uuid-less duplicates
 *     Group documents by the KashFlow `Id` field.  Within each duplicate group,
 *     keep every document that already has a `uuid` and delete those without.
 *     If ALL copies lack a uuid, keep the oldest one (by `syncedAt` / `_id`)
 *     because it is most likely to carry edits made by hcs-app.
 *
 *   Pass 2 – Backfill missing uuids
 *     Any surviving document that still lacks a uuid gets a fresh UUIDv4
 *     assigned.  This is necessary because the sync's `$setOnInsert` only
 *     fires on inserts, not on updates to existing matched documents.
 *
 * After the migration completes, each KashFlow `Id` maps to exactly one document
 * and the unique index on `Id` can be enforced.  The next sync will fill in any
 * missing uuids via `$setOnInsert`.
 *
 * Usage:
 *   node scripts/dedup-migration.js            # dry-run (default)
 *   node scripts/dedup-migration.js --apply     # actually delete duplicates
 *
 * Requires the same MONGO_* env vars used by the sync process.
 */

import dotenv from 'dotenv';
dotenv.config();

import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';

// ── Config ──────────────────────────────────────────────────────────────

const mongoUri = process.env.MONGO_URI || buildUri();
const dbName = process.env.MONGO_DB_NAME || 'kashflow';
const dryRun = !process.argv.includes('--apply');

function buildUri() {
  const host = process.env.MONGO_HOST;
  if (!host) return '';
  const port = Number(process.env.MONGO_PORT || 27017);
  const user = process.env.MONGO_USERNAME || process.env.MONGO_USER || '';
  const pass = process.env.MONGO_PASSWORD || process.env.MONGO_PASS || '';
  const authSource = process.env.MONGO_AUTH_SOURCE || process.env.MONGO_AUTHSOURCE || '';
  const hasCreds = Boolean(user || pass);
  const authPart = hasCreds
    ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
    : '';
  const params = new URLSearchParams();
  if (authSource) params.set('authSource', authSource);
  const query = params.toString();
  return `mongodb://${authPart}${host}:${port}/${encodeURIComponent(dbName)}${query ? `?${query}` : ''}`;
}

// ── Collections to deduplicate ──────────────────────────────────────────

const COLLECTIONS = [
  { name: 'customers',  idField: 'Id' },
  { name: 'suppliers',  idField: 'Id' },
  { name: 'invoices',   idField: 'Id' },
  { name: 'quotes',     idField: 'Id' },
  { name: 'purchases',  idField: 'Id' },
  { name: 'projects',   idField: 'Id' },
  { name: 'nominals',   idField: 'Id' },
];

// ── Main ────────────────────────────────────────────────────────────────

async function dedup(db, { name, idField }) {
  const col = db.collection(name);

  // ── Pass 1: remove uuid-less copies when a uuid-bearing copy exists ───
  //
  // Aggregation pushes { _id, uuid, syncedAt } per doc, so we can separate
  // "has uuid" from "no uuid" within each group.

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
    console.log(`  ${name}: no duplicates found`);
    return { collection: name, duplicateGroups: 0, deleted: 0 };
  }

  let totalDeleted = 0;

  for (const group of duplicates) {
    const docs = group.docs;

    // Partition into docs with and without a uuid.
    const withUuid = docs.filter((d) => d.uuid);
    const withoutUuid = docs.filter((d) => !d.uuid);

    let toDelete = [];

    if (withUuid.length > 0) {
      // At least one copy has a uuid → delete every copy that lacks one.
      toDelete.push(...withoutUuid.map((d) => d._id));

      // If multiple copies have uuids, keep the oldest — it is most likely
      // to carry edits made by hcs-app (CIS fields, notes, etc.).
      if (withUuid.length > 1) {
        sortOldestFirst(withUuid);
        toDelete.push(...withUuid.slice(1).map((d) => d._id));
      }
    } else {
      // No copy has a uuid — keep the oldest one (may have hcs-app edits).
      // The uuid backfill pass will assign it a uuid afterwards.
      sortOldestFirst(docs);
      toDelete.push(...docs.slice(1).map((d) => d._id));
    }

    if (toDelete.length === 0) continue;

    if (!dryRun) {
      const result = await col.deleteMany({ _id: { $in: toDelete } });
      totalDeleted += result.deletedCount || 0;
    } else {
      totalDeleted += toDelete.length;
    }
  }

  const action = dryRun ? 'would delete' : 'deleted';
  console.log(`  ${name}: ${duplicates.length} duplicate groups, ${action} ${totalDeleted} documents`);
  return { collection: name, duplicateGroups: duplicates.length, deleted: totalDeleted };
}

/** Sort docs array in-place: oldest first (by syncedAt, then _id). */
function sortOldestFirst(docs) {
  docs.sort((a, b) => {
    const aTime = a.syncedAt ? new Date(a.syncedAt).getTime() : 0;
    const bTime = b.syncedAt ? new Date(b.syncedAt).getTime() : 0;
    if (aTime !== bTime) return aTime - bTime;
    // Earlier ObjectId = older document
    return String(a._id).localeCompare(String(b._id));
  });
}

async function main() {
  if (!mongoUri) {
    console.error('Error: MongoDB not configured. Set MONGO_URI or MONGO_HOST.');
    process.exit(1);
  }

  console.log(dryRun ? '=== DRY RUN (pass --apply to execute) ===' : '=== APPLYING DEDUPLICATION ===');
  console.log(`Database: ${dbName}\n`);

  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(dbName);

    // ── Pass 1: deduplicate ─────────────────────────────────────────────
    console.log('Pass 1: Deduplicate by Id (prefer docs with uuid)\n');
    const results = [];
    for (const spec of COLLECTIONS) {
      results.push(await dedup(db, spec));
    }

    // ── Pass 2: backfill uuids ──────────────────────────────────────────
    //
    // After dedup, some surviving docs may still lack a uuid (the old sync
    // never set one).  $setOnInsert in the sync only fires on inserts, not
    // updates, so we must backfill here.
    console.log('\nPass 2: Backfill missing uuids\n');
    let totalBackfilled = 0;
    for (const { name } of COLLECTIONS) {
      const col = db.collection(name);
      const missing = await col.countDocuments({ $or: [{ uuid: { $exists: false } }, { uuid: null }, { uuid: '' }] });
      if (missing === 0) {
        console.log(`  ${name}: all documents have uuids`);
        continue;
      }
      if (!dryRun) {
        const cursor = col.find({ $or: [{ uuid: { $exists: false } }, { uuid: null }, { uuid: '' }] });
        const ops = [];
        for await (const doc of cursor) {
          ops.push({
            updateOne: {
              filter: { _id: doc._id },
              update: { $set: { uuid: crypto.randomUUID() } },
            },
          });
          if (ops.length >= 500) {
            await col.bulkWrite(ops, { ordered: false });
            ops.length = 0;
          }
        }
        if (ops.length) await col.bulkWrite(ops, { ordered: false });
        console.log(`  ${name}: backfilled uuid on ${missing} documents`);
      } else {
        console.log(`  ${name}: would backfill uuid on ${missing} documents`);
      }
      totalBackfilled += missing;
    }

    // ── Summary ─────────────────────────────────────────────────────────
    console.log('\n=== Summary ===');
    const totalGroups = results.reduce((s, r) => s + r.duplicateGroups, 0);
    const totalDeleted = results.reduce((s, r) => s + r.deleted, 0);
    console.log(`Total duplicate groups: ${totalGroups}`);
    console.log(`Total documents ${dryRun ? 'to delete' : 'deleted'}: ${totalDeleted}`);
    console.log(`Total uuids ${dryRun ? 'to backfill' : 'backfilled'}: ${totalBackfilled}`);

    if (dryRun && (totalDeleted > 0 || totalBackfilled > 0)) {
      console.log('\nRe-run with --apply to execute changes.');
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
