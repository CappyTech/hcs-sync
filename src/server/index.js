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
  res.render('index', { isRunning, lastRun, counts: lastCounts });
});

app.get('/', (_req, res) => {
  res.render('index', { isRunning, lastRun, counts: lastCounts });
});

app.post('/run', async (_req, res) => {
  if (isRunning) {
    return res.status(409).send('Sync already running');
  }
  isRunning = true;
  runSync()
    .then(() => {
      lastRun = Date.now();
      isRunning = false;
    })
    .catch((err) => {
      logger.error({ err }, 'Sync failed via dashboard');
      isRunning = false;
    });
  res.redirect('/');
});

app.listen(port, () => {
  logger.info({ port }, 'Server listening');
});
