#!/usr/bin/env node

/**
 * CLI wrapper for the dedup + uuid-backfill migration.
 *
 * Usage:
 *   node scripts/dedup-migration.js            # dry-run (default)
 *   node scripts/dedup-migration.js --apply     # actually delete duplicates
 *
 * Uses the same MongoDB connection, and so the same database, as the sync
 * (see src/db/mongoose.js).
 */

import mongoose from 'mongoose';
import { connectMongoose, disconnectMongoose, getMongoDb, isMongooseEnabled } from '../src/db/mongoose.js';
import { runDedup } from '../src/db/dedup.js';

const dryRun = !process.argv.includes('--apply');

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  if (!isMongooseEnabled()) {
    console.error('Error: MongoDB not configured. Set MONGO_URI or MONGO_HOST.');
    process.exit(1);
  }

  try {
    await connectMongoose();
    console.log(`Database: ${mongoose.connection.name}\n`);
    const db = await getMongoDb();
    const result = await runDedup(db, { dryRun });

    if (dryRun && (result.totalDeleted > 0 || result.totalBackfilled > 0)) {
      console.log('\nRe-run with --apply to execute changes.');
    }
  } finally {
    await disconnectMongoose();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
