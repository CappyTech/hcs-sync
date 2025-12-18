const defaultItems = () => ({
  customers: { done: 0, total: 0 },
  suppliers: { done: 0, total: 0 },
  projects: { done: 0, total: 0 },
  nominals: { done: 0, total: 0 },
  invoices: { done: 0, total: 0 },
  quotes: { done: 0, total: 0 },
  purchases: { done: 0, total: 0 },
});

const state = {
  isRunning: false,
  startedAt: null,
  stage: 'idle',
  items: defaultItems(),
  counts: null,
  lastError: null,
  lastRun: null,
};

function start() {
  state.isRunning = true;
  state.startedAt = Date.now();
  state.stage = 'starting';
  state.items = defaultItems();
  state.counts = null;
  state.lastError = null;
}

function setStage(stage) {
  state.stage = stage;
}

function setItemTotal(name, total) {
  if (!state.items[name]) state.items[name] = { done: 0, total: 0 };
  state.items[name].total = Number(total) || 0;
}

function setItemDone(name, done) {
  if (!state.items[name]) state.items[name] = { done: 0, total: 0 };
  state.items[name].done = Math.min(Number(done) || 0, state.items[name].total || Number.MAX_SAFE_INTEGER);
}

function incItem(name, delta = 1) {
  if (!state.items[name]) state.items[name] = { done: 0, total: 0 };
  state.items[name].done += Number(delta) || 0;
}

function finish(counts) {
  state.isRunning = false;
  state.stage = 'finished';
  state.counts = counts || null;
  state.lastRun = Date.now();
}

function fail(message) {
  state.isRunning = false;
  state.stage = 'failed';
  state.lastError = message || 'Sync failed';
}

function getState() {
  return state;
}

export default {
  start,
  setStage,
  setItemTotal,
  setItemDone,
  incItem,
  finish,
  fail,
  getState,
};
