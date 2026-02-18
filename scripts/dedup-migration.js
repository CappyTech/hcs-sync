#!/usr/bin/env node

/**
 * CLI wrapper for the dedup + uuid-backfill migration.
 *
 * Usage:
 *   node scripts/dedup-migration.js            # dry-run (default)
 *   node scripts/dedup-migration.js --apply     # actually delete duplicates
 *
 * Requires the same MONGO_* env vars used by the sync process.
 */

import dotenv from 'dotenv';
dotenv.config();

import { MongoClient } from 'mongodb';
import { runDedup } from '../src/db/dedup.js';

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

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  if (!mongoUri) {
    console.error('Error: MongoDB not configured. Set MONGO_URI or MONGO_HOST.');
    process.exit(1);
  }

  console.log(`Database: ${dbName}\n`);

  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const result = await runDedup(db, { dryRun });

    if (dryRun && (result.totalDeleted > 0 || result.totalBackfilled > 0)) {
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
