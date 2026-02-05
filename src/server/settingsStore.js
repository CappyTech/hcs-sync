import { connectMongoose, isMongooseEnabled } from '../db/mongoose.js';
import Settings from './models/Settings.js';

const SETTINGS_ID = 'app';

async function ensureConnected() {
  if (!isMongooseEnabled()) {
    throw new Error('MongoDB is not configured; cannot persist settings');
  }
  await connectMongoose();
  try {
    await Settings.init();
  } catch {
    // Best effort
  }
}

export async function getSettings() {
  if (!isMongooseEnabled()) return null;
  await ensureConnected();
  const doc = await Settings.findOne({ id: SETTINGS_ID }).lean().exec();
  return doc || null;
}

export async function upsertCronSettings(cron) {
  await ensureConnected();
  const $set = {
    'cron.enabled': Boolean(cron.enabled),
    'cron.schedule': String(cron.schedule || ''),
    'cron.timezone': String(cron.timezone || ''),
    'cron.healthStaleMs': Number(cron.healthStaleMs || 0),
    updatedAt: Date.now(),
  };

  await Settings.updateOne(
    { id: SETTINGS_ID },
    {
      $set,
      $setOnInsert: { id: SETTINGS_ID },
    },
    { upsert: true }
  ).exec();

  return getSettings();
}

export default {
  getSettings,
  upsertCronSettings,
};
