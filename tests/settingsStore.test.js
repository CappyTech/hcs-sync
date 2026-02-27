import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dotenv
vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));

// ── Shared spies for Settings model chain ────────────────────────────────
const mockExec = vi.fn();
const mockLean = vi.fn(() => ({ exec: mockExec }));
const mockFindOne = vi.fn(() => ({ lean: mockLean }));
const mockUpdateOneExec = vi.fn();
const mockUpdateOne = vi.fn(() => ({ exec: mockUpdateOneExec }));
const mockInit = vi.fn().mockResolvedValue(undefined);

// Mock mongoose module – default to "enabled"
const mockIsMongooseEnabled = vi.fn(() => true);
const mockConnectMongoose = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/db/mongoose.js', () => ({
  isMongooseEnabled: (...a) => mockIsMongooseEnabled(...a),
  connectMongoose: (...a) => mockConnectMongoose(...a),
}));

// Mock Settings model
vi.mock('../src/server/models/Settings.js', () => ({
  default: {
    findOne: (...args) => mockFindOne(...args),
    updateOne: (...args) => mockUpdateOne(...args),
    init: (...args) => mockInit(...args),
  },
}));

// Static import is fine here – no module-level state to isolate
import settingsStore from '../src/server/settingsStore.js';

describe('src/server/settingsStore.js', () => {
  beforeEach(() => {
    // Reset call counts / once-queues while preserving delegation chains
    mockExec.mockReset();
    mockLean.mockReset().mockImplementation(() => ({ exec: mockExec }));
    mockFindOne.mockReset().mockImplementation(() => ({ lean: mockLean }));
    mockUpdateOneExec.mockReset();
    mockUpdateOne.mockReset().mockImplementation(() => ({ exec: mockUpdateOneExec }));
    mockInit.mockReset().mockResolvedValue(undefined);
    mockIsMongooseEnabled.mockReset().mockReturnValue(true);
    mockConnectMongoose.mockReset().mockResolvedValue(undefined);
  });

  describe('getSettings()', () => {
    it('returns null when Mongoose is disabled', async () => {
      mockIsMongooseEnabled.mockReturnValue(false);
      const result = await settingsStore.getSettings();
      expect(result).toBeNull();
    });

    it('returns document when found', async () => {
      const doc = { id: 'app', cron: { enabled: true, schedule: '*/5 * * * *' } };
      mockExec.mockResolvedValueOnce(doc);
      const result = await settingsStore.getSettings();
      expect(result).toEqual(doc);
    });

    it('returns null when no document found', async () => {
      mockExec.mockResolvedValueOnce(null);
      const result = await settingsStore.getSettings();
      expect(result).toBeNull();
    });

    it('calls connectMongoose before querying', async () => {
      mockExec.mockResolvedValueOnce(null);
      await settingsStore.getSettings();
      expect(mockConnectMongoose).toHaveBeenCalled();
    });
  });

  describe('upsertCronSettings()', () => {
    it('throws when Mongoose is disabled', async () => {
      mockIsMongooseEnabled.mockReturnValue(false);
      await expect(settingsStore.upsertCronSettings({ enabled: true, schedule: '* * * * *' }))
        .rejects.toThrow(/MongoDB is not configured/i);
    });

    it('calls updateOne with correct $set and $setOnInsert', async () => {
      mockUpdateOneExec.mockResolvedValueOnce({});
      // getSettings is called inside upsertCronSettings, so mock that too
      mockExec.mockResolvedValueOnce({ id: 'app', cron: { enabled: true } });

      await settingsStore.upsertCronSettings({
        enabled: true,
        schedule: '*/10 * * * *',
        timezone: 'America/New_York',
        healthStaleMs: 60000,
      });

      expect(mockUpdateOne).toHaveBeenCalledWith(
        { id: 'app' },
        expect.objectContaining({
          $set: expect.objectContaining({
            'cron.enabled': true,
            'cron.schedule': '*/10 * * * *',
            'cron.timezone': 'America/New_York',
            'cron.healthStaleMs': 60000,
          }),
          $setOnInsert: { id: 'app' },
        }),
        { upsert: true },
      );
    });

    it('coerces boolean/string/number values', async () => {
      mockUpdateOneExec.mockResolvedValueOnce({});
      mockExec.mockResolvedValueOnce(null);

      await settingsStore.upsertCronSettings({
        enabled: 'yes',  // truthy → true
        schedule: null,   // → ''
        timezone: 42,     // → '42'
        healthStaleMs: 'abc', // → NaN → 0 via Number()
      });

      expect(mockUpdateOne).toHaveBeenCalledWith(
        { id: 'app' },
        expect.objectContaining({
          $set: expect.objectContaining({
            'cron.enabled': true,
            'cron.schedule': '',
            'cron.timezone': '42',
          }),
        }),
        { upsert: true },
      );
    });

    it('returns the result of getSettings()', async () => {
      mockUpdateOneExec.mockResolvedValueOnce({});
      const doc = { id: 'app', cron: { enabled: false } };
      mockExec.mockResolvedValueOnce(doc);

      const result = await settingsStore.upsertCronSettings({ enabled: false, schedule: '0 * * * *' });
      expect(result).toEqual(doc);
    });
  });
});
