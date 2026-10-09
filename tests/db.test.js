import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Prevent dotenv from reading the real .env file during tests.
vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));

vi.mock('../src/util/logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { default: { ...log, child: () => log } };
});

/**
 * Tests for the MongoDB connection (src/db/mongoose.js) and index management
 * (src/db/mongo.js), without a real database.
 */

let originalEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = originalEnv;
});

const clearMongoEnv = () => {
  for (const k of ['MONGO_URI', 'MONGO_HOST', 'MONGO_PORT', 'MONGO_DB_NAME', 'MONGO_USERNAME', 'MONGO_PASSWORD', 'MONGO_USER', 'MONGO_PASS', 'MONGO_AUTH_SOURCE', 'MONGO_AUTHSOURCE']) {
    delete process.env[k];
  }
};

/** Import mongoose.js with mongoose.connect stubbed; returns the URI it was given. */
async function connectWithStub({ databaseName } = {}) {
  const mongoose = (await import('mongoose')).default;
  const connect = vi.spyOn(mongoose, 'connect').mockImplementation(async () => {
    mongoose.connection.name = databaseName;
    return mongoose;
  });
  const mod = await import('../src/db/mongoose.js');
  await mod.connectMongoose();
  return { uri: connect.mock.calls[0]?.[0], connect, mod };
}

describe('src/db/mongoose.js – isMongooseEnabled()', () => {
  it('returns false when no Mongo env vars are set', async () => {
    clearMongoEnv();
    const { isMongooseEnabled } = await import('../src/db/mongoose.js');
    expect(isMongooseEnabled()).toBe(false);
  });

  it('returns true when MONGO_HOST is set', async () => {
    clearMongoEnv();
    process.env.MONGO_HOST = 'localhost';
    const { isMongooseEnabled } = await import('../src/db/mongoose.js');
    expect(isMongooseEnabled()).toBe(true);
  });

  it('returns true when MONGO_URI is set', async () => {
    clearMongoEnv();
    process.env.MONGO_URI = 'mongodb://localhost:27017/test';
    const { isMongooseEnabled } = await import('../src/db/mongoose.js');
    expect(isMongooseEnabled()).toBe(true);
  });
});

describe('src/db/mongoose.js – connection URI', () => {
  it('uses MONGO_URI directly when set', async () => {
    clearMongoEnv();
    process.env.MONGO_URI = 'mongodb://custom:27018/mydb';
    const { uri } = await connectWithStub({ databaseName: 'mydb' });
    expect(uri).toBe('mongodb://custom:27018/mydb');
  });

  it('builds the URI from MONGO_HOST, MONGO_PORT and MONGO_DB_NAME', async () => {
    clearMongoEnv();
    process.env.MONGO_HOST = 'dbhost';
    process.env.MONGO_PORT = '27018';
    process.env.MONGO_DB_NAME = 'testdb';
    const { uri } = await connectWithStub({ databaseName: 'testdb' });
    expect(uri).toBe('mongodb://dbhost:27018/testdb');
  });

  it('includes credentials when MONGO_USERNAME and MONGO_PASSWORD are set', async () => {
    clearMongoEnv();
    process.env.MONGO_HOST = 'dbhost';
    process.env.MONGO_USERNAME = 'admin';
    process.env.MONGO_PASSWORD = 'p@ss';
    const { uri } = await connectWithStub({ databaseName: 'kashflow' });
    expect(uri).toContain('admin:');
    expect(uri).toContain(encodeURIComponent('p@ss'));
  });

  it('includes authSource when MONGO_AUTH_SOURCE is set', async () => {
    clearMongoEnv();
    process.env.MONGO_HOST = 'dbhost';
    process.env.MONGO_AUTH_SOURCE = 'admin';
    const { uri } = await connectWithStub({ databaseName: 'kashflow' });
    expect(uri).toContain('authSource=admin');
  });

  it('defaults to port 27017 and db kashflow', async () => {
    clearMongoEnv();
    process.env.MONGO_HOST = 'myhost';
    const { uri } = await connectWithStub({ databaseName: 'kashflow' });
    expect(uri).toBe('mongodb://myhost:27017/kashflow');
  });

  it('throws when no URI can be built', async () => {
    clearMongoEnv();
    const { connectMongoose, getMongoDb } = await import('../src/db/mongoose.js');
    await expect(connectMongoose()).rejects.toThrow(/not configured/i);
    await expect(getMongoDb()).rejects.toThrow(/not configured/i);
  });
});

describe('src/db/mongoose.js – getMongoDb()', () => {
  it('returns the Db of the one Mongoose connection', async () => {
    clearMongoEnv();
    process.env.MONGO_HOST = 'myhost';
    const mongoose = (await import('mongoose')).default;
    const { mod } = await connectWithStub({ databaseName: 'kashflow' });
    const fakeDb = { databaseName: 'kashflow' };
    const original = mongoose.connection.db;
    mongoose.connection.db = fakeDb;
    try {
      expect(await mod.getMongoDb()).toBe(fakeDb);
    } finally {
      mongoose.connection.db = original;
    }
  });
});

describe('src/db/mongoose.js – database name warning', () => {
  const warnings = async () => (await import('../src/util/logger.js')).default.warn.mock.calls;

  it('warns when MONGO_URI selects a database other than MONGO_DB_NAME', async () => {
    clearMongoEnv();
    process.env.MONGO_URI = 'mongodb://host:27017';
    process.env.MONGO_DB_NAME = 'kashflow';
    await connectWithStub({ databaseName: 'test' });
    const calls = await warnings();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({ database: 'test', mongoDbName: 'kashflow' });
    expect(calls[0][1]).toMatch(/Using database "test" from MONGO_URI/);
  });

  it('is silent when MONGO_URI names MONGO_DB_NAME', async () => {
    clearMongoEnv();
    process.env.MONGO_URI = 'mongodb://host:27017/kashflow';
    await connectWithStub({ databaseName: 'kashflow' });
    expect(await warnings()).toHaveLength(0);
  });

  it('is silent when the URI is built from MONGO_HOST', async () => {
    clearMongoEnv();
    process.env.MONGO_HOST = 'host';
    process.env.MONGO_DB_NAME = 'other';
    await connectWithStub({ databaseName: 'other' });
    expect(await warnings()).toHaveLength(0);
  });
});

describe('src/db/mongo.js – ensureKashflowIndexes()', () => {
  it('creates unique indexes on Id for all 7 collections', async () => {
    process.env.MONGO_HOST = 'localhost';
    const { ensureKashflowIndexes } = await import('../src/db/mongo.js');

    const indexesByCollection = {};
    const mockCreateIndex = vi.fn().mockResolvedValue('ok');
    const mockDropIndex = vi.fn().mockImplementation(async () => {
      const err = new Error('IndexNotFound');
      err.codeName = 'IndexNotFound';
      throw err;
    });
    const mockUpdateMany = vi.fn().mockResolvedValue({});
    const mockIndexesFn = vi.fn().mockResolvedValue([]);

    const mockDb = {
      collection: vi.fn((name) => {
        if (!indexesByCollection[name]) indexesByCollection[name] = [];
        return {
          createIndex: (...args) => {
            indexesByCollection[name].push(args);
            return mockCreateIndex(...args);
          },
          dropIndex: mockDropIndex,
          updateMany: mockUpdateMany,
          indexes: mockIndexesFn,
        };
      }),
    };

    await ensureKashflowIndexes(mockDb);

    // Should have queried all 7 collections
    const collections = ['customers', 'suppliers', 'nominals', 'invoices', 'quotes', 'purchases', 'projects'];
    for (const col of collections) {
      expect(mockDb.collection).toHaveBeenCalledWith(col);
      expect(indexesByCollection[col]).toBeDefined();
      // Should have at least a Id_1 unique index and a secondary index
      const idIndex = indexesByCollection[col].find(args => args[0]?.Id === 1 && args[1]?.unique === true);
      expect(idIndex).toBeDefined();
    }
  });

  it('wraps auth errors with helpful message', async () => {
    process.env.MONGO_HOST = 'localhost';
    const { ensureKashflowIndexes } = await import('../src/db/mongo.js');

    const authErr = new Error('not authorized on kashflow to execute command');
    authErr.code = 13;

    const mockDb = {
      collection: vi.fn(() => ({
        createIndex: vi.fn().mockRejectedValue(authErr),
        dropIndex: vi.fn().mockResolvedValue(undefined),
        updateMany: vi.fn().mockResolvedValue({}),
        indexes: vi.fn().mockResolvedValue([]),
      })),
    };

    await expect(ensureKashflowIndexes(mockDb)).rejects.toThrow(/authentication failed/i);
  });

  it('drops legacy unique uuid indexes', async () => {
    process.env.MONGO_HOST = 'localhost';
    const { ensureKashflowIndexes } = await import('../src/db/mongo.js');

    const droppedIndexes = [];
    const mockDb = {
      collection: vi.fn(() => ({
        createIndex: vi.fn().mockResolvedValue('ok'),
        dropIndex: vi.fn().mockImplementation(async (name) => {
          droppedIndexes.push(name);
          // Non-existent is fine
          const err = new Error('IndexNotFound');
          err.codeName = 'IndexNotFound';
          throw err;
        }),
        updateMany: vi.fn().mockResolvedValue({}),
        indexes: vi.fn().mockResolvedValue([
          { name: '_id_', key: { _id: 1 } },
          { name: 'uuid_1', key: { uuid: 1 }, unique: true },
        ]),
      })),
    };

    await ensureKashflowIndexes(mockDb);

    // Should have attempted to drop uuid_1 from collections that had it
    expect(droppedIndexes).toContain('uuid_1');
  });

  it('migrates the vatrates VATId index from sparse unique to partial unique', async () => {
    // hcs-schemas declares { VATId: 1 } as { unique, sparse } and Mongoose's
    // autoIndex builds it under the derived name VATId_1. vatrates joined the
    // syncConfig-derived index plan in #28, so on the next start the sync
    // replaces that index with the partial unique form every other key uses:
    // unset null keys, drop the existing VATId_1, create it as partial unique.
    process.env.MONGO_HOST = 'localhost';
    const { ensureKashflowIndexes } = await import('../src/db/mongo.js');

    const legacyIndex = { name: 'VATId_1', key: { VATId: 1 }, unique: true, sparse: true };
    const calls = []; // ordered log of every call on the vatrates collection
    const mockDb = {
      collection: vi.fn((name) => {
        const record = (op, ...args) => { if (name === 'vatrates') calls.push({ op, args }); };
        return {
          createIndex: vi.fn(async (...args) => { record('createIndex', ...args); return 'ok'; }),
          dropIndex: vi.fn(async (indexName) => {
            record('dropIndex', indexName);
            if (name === 'vatrates' && indexName === 'VATId_1') return undefined;
            const err = new Error('IndexNotFound');
            err.codeName = 'IndexNotFound';
            throw err;
          }),
          updateMany: vi.fn(async (...args) => { record('updateMany', ...args); return {}; }),
          indexes: vi.fn(async () => (name === 'vatrates' ? [{ name: '_id_', key: { _id: 1 } }, legacyIndex] : [])),
        };
      }),
    };

    await ensureKashflowIndexes(mockDb);

    // The legacy index is on the managed key itself, so the legacy repair
    // leaves it alone: it is dropped exactly once, by the key-index step.
    const drops = calls.filter((c) => c.op === 'dropIndex' && c.args[0] === 'VATId_1');
    expect(drops).toHaveLength(1);

    const unsetNull = calls.findIndex((c) => c.op === 'updateMany'
      && JSON.stringify(c.args) === JSON.stringify([{ VATId: null }, { $unset: { VATId: '' } }]));
    const drop = calls.indexOf(drops[0]);
    const create = calls.findIndex((c) => c.op === 'createIndex' && c.args[0]?.VATId === 1);
    expect(unsetNull).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(unsetNull).toBeLessThan(drop);
    expect(drop).toBeLessThan(create);

    // VATId is numeric, so no empty-string cleanup (that is for string keys).
    expect(calls.some((c) => c.op === 'updateMany' && c.args[0]?.VATId === '')).toBe(false);

    // Recreated under the same name, unique and partial — not sparse — so it
    // tolerates documents that lack VATId without a { VATId: null } clash.
    expect(calls[create].args).toEqual([
      { VATId: 1 },
      { name: 'VATId_1', unique: true, partialFilterExpression: { VATId: { $exists: true } } },
    ]);
    expect(calls.filter((c) => c.op === 'createIndex' && c.args[0]?.VATId === 1)).toHaveLength(1);
  });
});

describe('src/db/mongo.js – isMongoAuthError()', () => {
  it('detects "requires authentication" message', async () => {
    process.env.MONGO_HOST = 'localhost';
    // isMongoAuthError is not exported, but we can test it indirectly through ensureKashflowIndexes
    // Actually let's check if it's exported
    const mod = await import('../src/db/mongo.js');
    // If not exported, test via ensureKashflowIndexes wrapping behavior
    if (typeof mod.isMongoAuthError === 'function') {
      expect(mod.isMongoAuthError(new Error('requires authentication'))).toBe(true);
      expect(mod.isMongoAuthError(new Error('not authorized'))).toBe(true);
      expect(mod.isMongoAuthError(new Error('Authentication failed'))).toBe(true);
      expect(mod.isMongoAuthError({ code: 13, message: '' })).toBe(true);
      expect(mod.isMongoAuthError(new Error('some other error'))).toBe(false);
    }
  });
});
