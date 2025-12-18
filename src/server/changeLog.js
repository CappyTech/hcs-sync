import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

export function beginRun(metadata = {}) {
  const runs = readRuns();
  const id = randomId();
  const run = {
    id,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    metadata,
    summary: null,
    changes: [],
  };
  runs.unshift(run);
  writeRuns(runs);
  return id;
}

export function recordChange(runId, change) {
  const runs = readRuns();
  const run = runs.find((r) => r.id === runId);
  if (!run) return false;
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
  run.changes.push(entry);
  writeRuns(runs);
  return entry.id;
}

export function finishRun(runId, summary = {}) {
  const runs = readRuns();
  const run = runs.find((r) => r.id === runId);
  if (!run) return false;
  run.status = summary.error ? 'failed' : 'finished';
  run.finishedAt = Date.now();
  run.summary = summary;
  writeRuns(runs);
  return true;
}

export function listRuns() {
  return readRuns();
}

export function getRun(runId) {
  const runs = readRuns();
  return runs.find((r) => r.id === runId) || null;
}

export function revertChange(runId, changeId, note = '') {
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
