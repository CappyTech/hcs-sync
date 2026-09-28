/**
 * Entry point: build the app, start listening, then load the effective cron
 * config. Everything else lives in app.js and the modules it wires together.
 */
import logger from '../util/logger.js';
import config from '../config.js';
import { isMongooseEnabled } from '../db/mongoose.js';
import fs from 'fs';
import { createApp } from './app.js';
import { loadSettingsIntoCache, applyCronConfig, getEffectiveCronConfig } from './syncController.js';
import { summariseRunChanges, formatRunChange } from './notify.js';

const app = createApp();
const port = Number(process.env.PORT || 3000);

function isLikelyRunningInDocker() {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

function warnIfMongoPointsToLocalhost() {
  if (!isMongooseEnabled()) return;

  const host = String(config.mongoHost || '').trim().toLowerCase();
  const uri = String(config.mongoUri || '').trim();

  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const isLocalUri =
    !!uri &&
    /mongodb(\+srv)?:\/\/(?:[^@/]+@)?(localhost|127\.0\.0\.1|\[::1\]|::1)(?::\d+)?\//i.test(uri);

  if ((isLocalHost || isLocalUri) && isLikelyRunningInDocker()) {
    logger.warn(
      {
        mongoHost: config.mongoHost || null,
        mongoUriProvided: Boolean(config.mongoUri),
      },
      'MongoDB is configured to connect to localhost from inside Docker; this usually fails. Use a container hostname (e.g. hcs-mongo) on a shared network, or set MONGO_URI.'
    );
  }
}

const server = app.listen(port, () => {
  logger.info({ port }, 'Server listening');
  warnIfMongoPointsToLocalhost();

  // Load settings and apply cron config after the server is up.
  (async () => {
    try {
      await loadSettingsIntoCache();
      applyCronConfig();
      logger.info({ cron: getEffectiveCronConfig() }, 'Effective cron config loaded');
    } catch (err) {
      logger.error({ err: { message: err?.message } }, 'Failed to load settings / start cron scheduler');
    }
  })();
});

export { app, server, summariseRunChanges, formatRunChange };
