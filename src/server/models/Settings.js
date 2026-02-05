import mongoose from 'mongoose';

const CronSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    schedule: { type: String, default: '0 * * * *' },
    timezone: { type: String, default: '' },
    healthStaleMs: { type: Number, default: 0 },
  },
  { _id: false }
);

const SettingsSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    cron: { type: CronSchema, default: () => ({}) },
    updatedAt: { type: Number, default: null },
  },
  {
    collection: 'settings',
    minimize: false,
  }
);

export default mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);
