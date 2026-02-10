import { connectMongoose, isMongooseEnabled } from '../db/mongoose.js';
import Run from './models/Run.js';

function newId() {
  // Node 20 has global crypto.randomUUID().
  return globalThis.crypto?.randomUUID?.() || `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

async function ensureConnected() {
  if (!isMongooseEnabled()) {
    throw new Error('MongoDB is not configured; cannot persist runs');
  }
  await connectMongoose();
  // Ensure schema indexes exist (best effort).
  try {
    await Run.init();
  } catch {
    // Ignore init errors; queries can still work.
  }
}

export async function beginRun(metadata = {}) {
  await ensureConnected();
  const id = newId();
  const run = {
    id,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    metadata,
    summary: null,
    changes: [],
    logs: [],
  };
  await Run.create(run);
  return id;
}

export async function recordLog(runId, log) {
  await ensureConnected();

  const entry = {
    id: newId(),
    ts: Date.now(),
    level: String(log?.level || 'info'),
    message: String(log?.message || ''),
    stage: log?.stage ? String(log.stage) : null,
    meta: typeof log?.meta === 'undefined' ? null : (log?.meta ?? null),
  };

  // Cap log growth to keep run documents manageable.
  const maxEntries = Number(process.env.RUN_LOG_MAX_ENTRIES || 1000);
  const slice = Number.isFinite(maxEntries) && maxEntries > 0 ? -Math.floor(maxEntries) : -1000;

  const out = await Run.updateOne(
    { id: runId },
    { $push: { logs: { $each: [entry], $slice: slice } } }
  ).exec();

  if (out.matchedCount === 0) return false;
  return entry.id;
}

export async function recordChange(runId, change) {
  await ensureConnected();
  const entry = {
    id: newId(),
    ts: Date.now(),
    entityType: change.entityType,
    entityId: change.entityId,
    action: change.action,
    reason: change.reason || '',
    source: change.source || 'system',
    before: change.before ?? null,
    after: change.after ?? null,
    diff: change.diff ?? null,
    reverted: false,
    revertNote: null,
  };

  const out = await Run.updateOne({ id: runId }, { $push: { changes: entry } }).exec();
  if (out.matchedCount === 0) return false;
  return entry.id;
}

export async function finishRun(runId, summary = {}) {
  await ensureConnected();
  const status = summary.error ? 'failed' : 'finished';
  const out = await Run.updateOne(
    { id: runId },
    { $set: { status, finishedAt: Date.now(), summary } }
  ).exec();
  return out.matchedCount > 0;
}

export async function listRuns({ limit = 200 } = {}) {
  await ensureConnected();
  return Run.find({})
    .select({
      logs: 0,
      'changes.before': 0,
      'changes.after': 0,
      'changes.diff': 0,
    })
    .sort({ startedAt: -1 })
    .limit(limit)
    .lean()
    .exec();
}

export async function getRun(runId) {
  await ensureConnected();
  return Run.findOne({ id: runId }).lean().exec();
}

export async function revertChange(runId, changeId, note = '') {
  await ensureConnected();

  const runExists = await Run.exists({ id: runId });
  if (!runExists) return { ok: false, message: 'Run not found' };

  const out = await Run.updateOne(
    { id: runId },
    {
      $set: {
        'changes.$[c].reverted': true,
        'changes.$[c].revertNote': note || 'Marked reverted (no DB write performed)',
      },
    },
    { arrayFilters: [{ 'c.id': changeId }] }
  ).exec();

  if (out.modifiedCount === 0) return { ok: false, message: 'Change not found' };
  return { ok: true };
}

export function requestPull(entityType, entityId) {
  return {
    ok: true,
    plan: {
      action: 'pull',
      entityType,
      entityId,
      note: 'Manual single-entity pull requested (no execution yet)',
    },
  };
}

export default {
  beginRun,
  recordChange,
  recordLog,
  finishRun,
  listRuns,
  getRun,
  revertChange,
  requestPull,
};
