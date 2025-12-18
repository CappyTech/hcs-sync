import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../util/logger.js';
import runSync from '../sync/run.js';

const app = express();
const port = Number(process.env.PORT || 3000);

let lastRun = null;
let isRunning = false;
let lastCounts = null;
let lastError = null;
const logs = [];

// EJS setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'public')));
// Serve Flowbite JS from node_modules
app.use('/static/vendor/flowbite', express.static(path.join(__dirname, '../../node_modules/flowbite/dist')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', isRunning, lastRun });
});
// Simple logs stub (extend later)
app.get('/logs', (_req, res) => {
  res.render('logs', { logs });
});
app.get('/logs.json', (_req, res) => {
  res.json({ logs });
});

app.get('/', (_req, res) => {
  res.render('index', { isRunning, lastRun, counts: lastCounts, lastError });
});

app.post('/run', async (_req, res) => {
  if (isRunning) {
    return res.status(409).send('Sync already running');
  }
  isRunning = true;
  lastError = null;
  logs.unshift({ time: Date.now(), level: 'info', message: 'Sync started' });
  runSync()
    .then((result) => {
      lastRun = Date.now();
      isRunning = false;
      lastCounts = result && result.counts ? result.counts : lastCounts;
      lastError = null;
      logs.unshift({ time: Date.now(), level: 'success', message: 'Sync completed successfully', meta: { counts: lastCounts } });
    })
    .catch((err) => {
      logger.error({ status: err.response?.status, message: err.message, data: err.response?.data }, 'Sync failed via dashboard');
      isRunning = false;
      lastError = err?.response?.data?.Message || err?.message || 'Sync failed';
      logs.unshift({ time: Date.now(), level: 'error', message: 'Sync failed', meta: { error: err?.message } });
    });
  res.redirect('/');
});

app.listen(port, () => {
  logger.info({ port }, 'Server listening');
});
