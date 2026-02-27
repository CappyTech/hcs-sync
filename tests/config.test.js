import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Prevent dotenv from reading the real .env file during tests.
// This ensures only env vars we explicitly set in each test are present.
vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));

describe('src/config.js', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Reset the module cache so each test gets a fresh config evaluation
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default values when no env vars are set', async () => {
    // Clear any env vars that config reads
    delete process.env.BASE_URL;
    delete process.env.KASHFLOW_BASE_URL;
    delete process.env.HTTP_TIMEOUT_MS;
    delete process.env.CONCURRENCY;
    delete process.env.DETAIL_CONCURRENCY;
    delete process.env.MONGO_URI;
    delete process.env.MONGO_HOST;
    delete process.env.MONGO_PORT;
    delete process.env.MONGO_DB_NAME;
    delete process.env.CRON_ENABLED;
    delete process.env.CRON_SCHEDULE;
    delete process.env.CRON_TIMEZONE;

    // Dynamic import so env is read fresh
    const { default: config } = await import('../src/config.js');

    expect(config.baseUrl).toBe('https://api.kashflow.com/v2');
    expect(config.timeoutMs).toBe(30000);
    expect(config.concurrency).toBe(4);
    expect(config.detailConcurrency).toBe(8);
    expect(config.mongoDbName).toBe('kashflow');
    expect(config.cronEnabled).toBe(false);
    expect(config.cronSchedule).toBe('0 * * * *');
    expect(config.cronTimezone).toBe('Europe/London');
  });

  it('reads BASE_URL from env', async () => {
    process.env.BASE_URL = 'https://custom.example.com/v3';
    const { default: config } = await import('../src/config.js');
    expect(config.baseUrl).toBe('https://custom.example.com/v3');
  });

  it('reads KASHFLOW_BASE_URL when BASE_URL is absent', async () => {
    delete process.env.BASE_URL;
    process.env.KASHFLOW_BASE_URL = 'https://kf.example.com/v2';
    const { default: config } = await import('../src/config.js');
    expect(config.baseUrl).toBe('https://kf.example.com/v2');
  });

  it('parses numeric env vars correctly', async () => {
    process.env.HTTP_TIMEOUT_MS = '5000';
    process.env.CONCURRENCY = '16';
    process.env.DETAIL_CONCURRENCY = '32';
    process.env.MONGO_PORT = '27018';

    const { default: config } = await import('../src/config.js');

    expect(config.timeoutMs).toBe(5000);
    expect(config.concurrency).toBe(16);
    expect(config.detailConcurrency).toBe(32);
    expect(config.mongoPort).toBe(27018);
  });

  it('parses CRON_ENABLED as boolean', async () => {
    process.env.CRON_ENABLED = 'true';
    const { default: config } = await import('../src/config.js');
    expect(config.cronEnabled).toBe(true);
  });

  it('treats CRON_ENABLED=1 as true', async () => {
    process.env.CRON_ENABLED = '1';
    const { default: config } = await import('../src/config.js');
    expect(config.cronEnabled).toBe(true);
  });

  it('does not have a token field', async () => {
    const { default: config } = await import('../src/config.js');
    expect(config).not.toHaveProperty('token');
  });

  it('reads custom CRON_SCHEDULE', async () => {
    process.env.CRON_SCHEDULE = '*/15 * * * *';
    const { default: config } = await import('../src/config.js');
    expect(config.cronSchedule).toBe('*/15 * * * *');
  });

  it('reads custom CRON_TIMEZONE', async () => {
    process.env.CRON_TIMEZONE = 'America/New_York';
    const { default: config } = await import('../src/config.js');
    expect(config.cronTimezone).toBe('America/New_York');
  });

  it('reads CRON_HEALTH_STALE_MS', async () => {
    process.env.CRON_HEALTH_STALE_MS = '120000';
    const { default: config } = await import('../src/config.js');
    expect(config.cronHealthStaleMs).toBe(120000);
  });

  it('reads MONGO_USERNAME alias', async () => {
    process.env.MONGO_USERNAME = 'admin';
    const { default: config } = await import('../src/config.js');
    expect(config.mongoUsername).toBe('admin');
  });

  it('reads MONGO_USER fallback', async () => {
    delete process.env.MONGO_USERNAME;
    process.env.MONGO_USER = 'user2';
    const { default: config } = await import('../src/config.js');
    expect(config.mongoUsername).toBe('user2');
  });

  it('reads MONGO_PASSWORD alias', async () => {
    process.env.MONGO_PASSWORD = 'secret';
    const { default: config } = await import('../src/config.js');
    expect(config.mongoPassword).toBe('secret');
  });

  it('reads MONGO_PASS fallback', async () => {
    delete process.env.MONGO_PASSWORD;
    process.env.MONGO_PASS = 'fallback';
    const { default: config } = await import('../src/config.js');
    expect(config.mongoPassword).toBe('fallback');
  });

  it('reads MONGO_AUTH_SOURCE alias', async () => {
    process.env.MONGO_AUTH_SOURCE = 'authdb';
    const { default: config } = await import('../src/config.js');
    expect(config.mongoAuthSource).toBe('authdb');
  });

  it('reads MONGO_AUTHSOURCE fallback', async () => {
    delete process.env.MONGO_AUTH_SOURCE;
    process.env.MONGO_AUTHSOURCE = 'admin';
    const { default: config } = await import('../src/config.js');
    expect(config.mongoAuthSource).toBe('admin');
  });

  it('reads MONGO_URI directly', async () => {
    process.env.MONGO_URI = 'mongodb://custom:27018/mydb';
    const { default: config } = await import('../src/config.js');
    expect(config.mongoUri).toBe('mongodb://custom:27018/mydb');
  });

  it('reads MONGO_HOST directly', async () => {
    process.env.MONGO_HOST = 'db.example.com';
    const { default: config } = await import('../src/config.js');
    expect(config.mongoHost).toBe('db.example.com');
  });
});
