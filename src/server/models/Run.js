import mongoose from 'mongoose';

const ChangeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    ts: { type: Number, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    action: { type: String, required: true },
    reason: { type: String, default: '' },
    source: { type: String, default: 'system' },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    diff: { type: mongoose.Schema.Types.Mixed, default: null },
    reverted: { type: Boolean, default: false },
    revertNote: { type: String, default: null },
  },
  { _id: false }
);

const RunSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    status: { type: String, required: true, index: true },
    startedAt: { type: Number, required: true, index: true },
    finishedAt: { type: Number, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    summary: { type: mongoose.Schema.Types.Mixed, default: null },
    changes: { type: [ChangeSchema], default: [] },
  },
  {
    collection: 'runs',
    minimize: false,
  }
);

RunSchema.index({ status: 1, startedAt: -1 });

export default mongoose.models.Run || mongoose.model('Run', RunSchema);
