import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isDbEnabled as isMongoEnabled, getDb as getMongoDb } from '../db/mongo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '../../data');
const runsFile = path.join(dataDir, 'runs.json');

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(runsFile)) fs.writeFileSync(runsFile, JSON.stringify({ runs: [] }, null, 2));
}

function readRuns() {
  ensureDataDir();
  try {
    const buf = fs.readFileSync(runsFile, 'utf8');
    const parsed = JSON.parse(buf || '{}');
    return parsed.runs || [];
  } catch {
    return [];
  }
}

function writeRuns(runs) {
  ensureDataDir();
  fs.writeFileSync(runsFile, JSON.stringify({ runs }, null, 2));
}

function randomId() {
  try { return crypto.randomUUID(); } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

async function getRunsCollection() {
  const db = await getMongoDb();
  return db.collection('runs');
}

function shouldUseMongo() {
  return isMongoEnabled();
}

export async function beginRun(metadata = {}) {
  const id = randomId();
  const run = {
    _id: id,
    id,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    metadata,
    summary: null,
    changes: [],
  };

  if (shouldUseMongo()) {
    const col = await getRunsCollection();
    await col.updateOne({ _id: id }, { $setOnInsert: run }, { upsert: true });
    return id;
  }

  const runs = readRuns();
  runs.unshift({ ...run, _id: undefined });
  writeRuns(runs);
  return id;
}

export async function recordChange(runId, change) {
  const entry = {
    id: randomId(),
    ts: Date.now(),
    entityType: change.entityType,
    entityId: change.entityId,
    action: change.action, // 'create' | 'update' | 'delete' | 'info'
    reason: change.reason || '',
    source: change.source || 'system', // 'kashflow' | 'database' | 'system' | 'user'
    before: change.before ?? null,
    after: change.after ?? null,
    diff: change.diff ?? null,
    reverted: false,
    revertNote: null,
  };

  if (shouldUseMongo()) {
    const col = await getRunsCollection();
    const res = await col.updateOne(
      { _id: runId },
      { $push: { changes: entry } },
      { upsert: false }
    );
    return res.matchedCount ? entry.id : false;
  }

  const runs = readRuns();
  const run = runs.find((r) => r.id === runId);
  if (!run) return false;
  run.changes.push(entry);
  writeRuns(runs);
  return entry.id;
}

export async function finishRun(runId, summary = {}) {
  const patch = {
    status: summary.error ? 'failed' : 'finished',
    finishedAt: Date.now(),
    summary,
  };

  if (shouldUseMongo()) {
    const col = await getRunsCollection();
    const res = await col.updateOne({ _id: runId }, { $set: patch }, { upsert: false });
    return Boolean(res.matchedCount);
  }

  const runs = readRuns();
  const run = runs.find((r) => r.id === runId);
  if (!run) return false;
  Object.assign(run, patch);
  writeRuns(runs);
  return true;
}

export async function listRuns() {
  if (shouldUseMongo()) {
    const col = await getRunsCollection();
    return await col.find({}).sort({ startedAt: -1 }).toArray();
  }
  return readRuns();
}

export async function getRun(runId) {
  if (shouldUseMongo()) {
    const col = await getRunsCollection();
    return await col.findOne({ _id: runId });
  }
  const runs = readRuns();
  return runs.find((r) => r.id === runId) || null;
}

export async function revertChange(runId, changeId, note = '') {
  if (shouldUseMongo()) {
    const col = await getRunsCollection();
    const res = await col.updateOne(
      { _id: runId, 'changes.id': changeId },
      {
        $set: {
          'changes.$.reverted': true,
          'changes.$.revertNote': note || 'Marked reverted (no DB write performed)',
        },
      }
    );
    if (!res.matchedCount) return { ok: false, message: 'Change not found' };
    return { ok: true };
  }

  const runs = readRuns();
  const run = runs.find((r) => r.id === runId);
  if (!run) return { ok: false, message: 'Run not found' };
  const change = run.changes.find((c) => c.id === changeId);
  if (!change) return { ok: false, message: 'Change not found' };
  // No DB yet: mark as reverted and capture note
  change.reverted = true;
  change.revertNote = note || 'Marked reverted (no DB write performed)';
  writeRuns(runs);
  return { ok: true };
}

export function requestPull(entityType, entityId) {
  // No queue yet: return a plan that the server could execute manually
  return {
    ok: true,
    plan: {
      action: 'pull',
      entityType,
      entityId,
      note: 'Manual single-entity pull requested (no execution yet)'
    }
  };
}

export default {
  beginRun,
  recordChange,
  finishRun,
  listRuns,
  getRun,
  revertChange,
  requestPull,
};
