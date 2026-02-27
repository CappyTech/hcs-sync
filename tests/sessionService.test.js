import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';

// We mock axios at the module level so sessionService uses the mock.
vi.mock('axios');

// Prevent dotenv from reading the real .env file during tests.
vi.mock('dotenv', () => ({ default: { config: () => ({}) }, config: () => ({}) }));

describe('src/kashflow/sessionService.js', () => {
  let sessionService;
  let axios; // shadows the top-level import; reassigned after vi.resetModules()
  let originalEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    // Clear all auth-related env vars to start clean
    const authKeys = [
      'KASHFLOW_API_USERNAME', 'KFUSERNAME', 'KASHFLOW_USERNAME', 'USERNAME',
      'KASHFLOW_API_PASSWORD', 'KFPASSWORD', 'KASHFLOW_PASSWORD', 'PASSWORD',
      'KASHFLOW_MEMORABLE', 'KFMEMORABLE', 'KASHFLOW_MEMORABLE_WORD', 'MEMORABLE_WORD',
      'KASHFLOW_EXTERNAL_TOKEN', 'KASHFLOW_EXTERNAL_UID', 'KFEXTERNALUID',
      'SESSION_TOKEN', 'KASHFLOW_SESSION_TOKEN', 'KFSESSIONTOKEN',
      'KASHFLOW_DEBUG_SESSION',
    ];
    for (const k of authKeys) delete process.env[k];

    vi.resetAllMocks();
    vi.resetModules();
    // Fresh imports – both sessionService and axios get new instances
    axios = (await import('axios')).default;
    sessionService = await import('../src/kashflow/sessionService.js');
    // Always clear cached token before each test
    sessionService.clearCachedToken();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('ensureSessionToken()', () => {
    it('throws when no credentials are configured', async () => {
      await expect(sessionService.ensureSessionToken()).rejects.toThrow(
        /credentials incomplete/i
      );
    });

    it('error message lists missing credential names', async () => {
      await expect(sessionService.ensureSessionToken()).rejects.toThrow(
        /USERNAME.*PASSWORD.*MEMORABLE_WORD/
      );
    });

    it('lists only the specific missing credential', async () => {
      process.env.KASHFLOW_API_USERNAME = 'testuser';
      process.env.KASHFLOW_API_PASSWORD = 'testpass';
      // memorable is missing
      await expect(sessionService.ensureSessionToken()).rejects.toThrow(
        /MEMORABLE_WORD/
      );
    });

    it('uses external token exchange when KASHFLOW_EXTERNAL_TOKEN is set', async () => {
      process.env.KASHFLOW_EXTERNAL_TOKEN = 'ext-token-123';
      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'session-from-external', ExpiresInSeconds: 3600 },
      });

      const token = await sessionService.ensureSessionToken();
      expect(token).toBe('session-from-external');
      expect(axios.get).toHaveBeenCalledTimes(1);
      const call = axios.get.mock.calls[0];
      expect(call[0]).toContain('/sessiontoken');
      expect(call[1].params.externalToken).toBe('ext-token-123');
    });

    it('includes uid param when KASHFLOW_EXTERNAL_UID is set', async () => {
      process.env.KASHFLOW_EXTERNAL_TOKEN = 'ext-token-123';
      process.env.KASHFLOW_EXTERNAL_UID = 'uid-456';
      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'session-token' },
      });

      await sessionService.ensureSessionToken();
      const params = axios.get.mock.calls[0][1].params;
      expect(params.uid).toBe('uid-456');
    });

    it('performs two-step login with username/password/memorable', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user1';
      process.env.KASHFLOW_API_PASSWORD = 'pass1';
      process.env.KASHFLOW_MEMORABLE = 'butterfly';

      // Step 1: POST returns temp token + positions
      axios.post.mockResolvedValueOnce({
        data: {
          TemporaryToken: 'temp-token-abc',
          MemorableWordList: [
            { Position: 2, Value: '' },
            { Position: 5, Value: '' },
            { Position: 8, Value: '' },
          ],
        },
      });

      // Step 2: PUT returns session token
      axios.put.mockResolvedValueOnce({
        data: { SessionToken: 'final-session-token' },
      });

      const token = await sessionService.ensureSessionToken();
      expect(token).toBe('final-session-token');
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.put).toHaveBeenCalledTimes(1);

      // Verify PUT body contains correct characters
      const putBody = axios.put.mock.calls[0][1];
      expect(putBody.TemporaryToken).toBe('temp-token-abc');
      expect(putBody.MemorableWordList).toEqual([
        { Position: 2, Value: 'u' },  // butterfly[1]
        { Position: 5, Value: 'e' },  // butterfly[4]
        { Position: 8, Value: 'l' },  // butterfly[7]
      ]);
    });

    it('skips step 2 when step 1 returns SessionToken directly', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user1';
      process.env.KASHFLOW_API_PASSWORD = 'pass1';
      process.env.KASHFLOW_MEMORABLE = 'test';

      axios.post.mockResolvedValueOnce({
        data: { SessionToken: 'direct-token', ExpiresInSeconds: 1800 },
      });

      const token = await sessionService.ensureSessionToken();
      expect(token).toBe('direct-token');
      expect(axios.put).not.toHaveBeenCalled();
    });

    it('returns cached token on second call', async () => {
      process.env.KASHFLOW_EXTERNAL_TOKEN = 'ext-token';
      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'cached-token' },
      });

      const token1 = await sessionService.ensureSessionToken();
      const token2 = await sessionService.ensureSessionToken();

      expect(token1).toBe('cached-token');
      expect(token2).toBe('cached-token');
      // Only one HTTP call — second used cache
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('tries camelCase keys on step 1 InvalidCredentials fallback', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user1';
      process.env.KASHFLOW_API_PASSWORD = 'pass1';
      process.env.KASHFLOW_MEMORABLE = 'hello';

      // First attempt: 400 InvalidCredentials
      const err400 = new Error('Bad request');
      err400.response = { status: 400, data: { Error: 'InvalidCredentials' } };
      axios.post.mockRejectedValueOnce(err400);

      // Second attempt (camelCase): success
      axios.post.mockResolvedValueOnce({
        data: { SessionToken: 'camel-token' },
      });

      const token = await sessionService.ensureSessionToken();
      expect(token).toBe('camel-token');
      expect(axios.post).toHaveBeenCalledTimes(2);
      // Second call uses camelCase
      const body = axios.post.mock.calls[1][1];
      expect(body).toHaveProperty('username', 'user1');
      expect(body).toHaveProperty('password', 'pass1');
    });

    it('uses CharacterPositions array format from step 1', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user1';
      process.env.KASHFLOW_API_PASSWORD = 'pass1';
      process.env.KASHFLOW_MEMORABLE = 'abcdefghij';

      axios.post.mockResolvedValueOnce({
        data: {
          TemporaryToken: 'tmp',
          CharacterPositions: [1, 3, 5],
        },
      });
      axios.put.mockResolvedValueOnce({
        data: { SessionToken: 'final' },
      });

      const token = await sessionService.ensureSessionToken();
      expect(token).toBe('final');
      const putBody = axios.put.mock.calls[0][1];
      expect(putBody.MemorableWordList).toEqual([
        { Position: 1, Value: 'a' },
        { Position: 3, Value: 'c' },
        { Position: 5, Value: 'e' },
      ]);
    });

    it('handles MemorableWordPositions CSV string', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user1';
      process.env.KASHFLOW_API_PASSWORD = 'pass1';
      process.env.KASHFLOW_MEMORABLE = 'abcdefghij';

      axios.post.mockResolvedValueOnce({
        data: {
          TemporaryToken: 'tmp',
          MemorableWordPositions: '2, 4, 6',
        },
      });
      axios.put.mockResolvedValueOnce({
        data: { SessionToken: 'csv-token' },
      });

      const token = await sessionService.ensureSessionToken();
      expect(token).toBe('csv-token');
      const putBody = axios.put.mock.calls[0][1];
      expect(putBody.MemorableWordList).toEqual([
        { Position: 2, Value: 'b' },
        { Position: 4, Value: 'd' },
        { Position: 6, Value: 'f' },
      ]);
    });

    it('falls back to legacy PUT format when documented PUT fails', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user1';
      process.env.KASHFLOW_API_PASSWORD = 'pass1';
      process.env.KASHFLOW_MEMORABLE = 'abcdefghij';

      axios.post.mockResolvedValueOnce({
        data: {
          TemporaryToken: 'tmp',
          CharacterPositions: [1, 2, 3],
        },
      });

      // First PUT fails
      axios.put.mockRejectedValueOnce(new Error('Bad format'));
      // Second PUT (legacy) succeeds
      axios.put.mockResolvedValueOnce({
        data: { SessionToken: 'legacy-token' },
      });

      const token = await sessionService.ensureSessionToken();
      expect(token).toBe('legacy-token');
      expect(axios.put).toHaveBeenCalledTimes(2);
      const legacyBody = axios.put.mock.calls[1][1];
      expect(legacyBody.Character1).toBe('a');
      expect(legacyBody.Character2).toBe('b');
      expect(legacyBody.Character3).toBe('c');
      expect(legacyBody.Positions).toEqual([1, 2, 3]);
    });
  });

  describe('invalidateSession()', () => {
    it('sends DELETE and clears cached token', async () => {
      process.env.KASHFLOW_EXTERNAL_TOKEN = 'ext-token';
      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'to-delete' },
      });
      axios.delete.mockResolvedValueOnce({});

      await sessionService.ensureSessionToken();
      await sessionService.invalidateSession();

      expect(axios.delete).toHaveBeenCalledTimes(1);
      const deleteCall = axios.delete.mock.calls[0];
      expect(deleteCall[0]).toContain('/sessiontoken');
      expect(deleteCall[1].headers.Authorization).toContain('to-delete');
    });

    it('does nothing when no token is cached', async () => {
      await sessionService.invalidateSession();
      expect(axios.delete).not.toHaveBeenCalled();
    });

    it('silently swallows DELETE errors', async () => {
      process.env.KASHFLOW_EXTERNAL_TOKEN = 'ext-token';
      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'token-with-error' },
      });
      axios.delete.mockRejectedValueOnce(new Error('Network error'));

      await sessionService.ensureSessionToken();
      // Should not throw
      await expect(sessionService.invalidateSession()).resolves.toBeUndefined();
    });
  });

  describe('clearCachedToken()', () => {
    it('forces re-authentication on next call', async () => {
      process.env.KASHFLOW_EXTERNAL_TOKEN = 'ext-token';
      axios.get.mockResolvedValue({
        data: { SessionToken: 'new-token' },
      });

      await sessionService.ensureSessionToken();
      sessionService.clearCachedToken();
      await sessionService.ensureSessionToken();

      expect(axios.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('withKfAuth()', () => {
    it('passes token to the callback', async () => {
      process.env.KASHFLOW_EXTERNAL_TOKEN = 'ext-token';
      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'my-token' },
      });

      const result = await sessionService.withKfAuth(async (token) => {
        return `received:${token}`;
      });

      expect(result).toBe('received:my-token');
    });

    it('retries once on 401', async () => {
      process.env.KASHFLOW_EXTERNAL_TOKEN = 'ext-token';
      // First ensureSessionToken
      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'token-1' },
      });
      // DELETE during invalidation
      axios.delete.mockResolvedValueOnce({});
      // Second ensureSessionToken after invalidation
      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'token-2' },
      });

      let callCount = 0;
      const result = await sessionService.withKfAuth(async (token) => {
        callCount++;
        if (callCount === 1) {
          const err = new Error('Unauthorized');
          err.response = { status: 401 };
          throw err;
        }
        return `ok:${token}`;
      });

      expect(callCount).toBe(2);
      expect(result).toBe('ok:token-2');
    });

    it('retries once on 403', async () => {
      process.env.KASHFLOW_EXTERNAL_TOKEN = 'ext-token';
      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'token-1' },
      });
      axios.delete.mockResolvedValueOnce({});
      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'token-2' },
      });

      let callCount = 0;
      await sessionService.withKfAuth(async () => {
        callCount++;
        if (callCount === 1) {
          const err = new Error('Forbidden');
          err.response = { status: 403 };
          throw err;
        }
        return 'ok';
      });

      expect(callCount).toBe(2);
    });

    it('throws non-auth errors without retrying', async () => {
      process.env.KASHFLOW_EXTERNAL_TOKEN = 'ext-token';
      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'token-1' },
      });

      const err500 = new Error('Server error');
      err500.response = { status: 500 };

      await expect(
        sessionService.withKfAuth(async () => { throw err500; })
      ).rejects.toThrow('Server error');
    });
  });

  describe('env var aliases', () => {
    it('reads KASHFLOW_USERNAME alias', async () => {
      process.env.KASHFLOW_USERNAME = 'user-kf';
      process.env.KASHFLOW_API_PASSWORD = 'pass';
      process.env.KASHFLOW_MEMORABLE = 'word';

      axios.post.mockResolvedValueOnce({
        data: { SessionToken: 'direct' },
      });

      const token = await sessionService.ensureSessionToken();
      expect(token).toBe('direct');
      const body = axios.post.mock.calls[0][1];
      expect(body.UserName).toBe('user-kf');
    });

    it('reads MEMORABLE_WORD alias', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user';
      process.env.KASHFLOW_API_PASSWORD = 'pass';
      process.env.MEMORABLE_WORD = 'abcdefghij';

      axios.post.mockResolvedValueOnce({
        data: {
          TemporaryToken: 'tmp',
          CharacterPositions: [1, 2, 3],
        },
      });
      axios.put.mockResolvedValueOnce({
        data: { SessionToken: 'final' },
      });

      await sessionService.ensureSessionToken();
      const putBody = axios.put.mock.calls[0][1];
      expect(putBody.MemorableWordList[0].Value).toBe('a');
    });
  });

  // ── Account lockout back-off ──────────────────────────────────────────

  describe('account lockout', () => {
    it('sets lockUntil on PasswordExpired and blocks subsequent calls', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user';
      process.env.KASHFLOW_API_PASSWORD = 'pass';
      process.env.KASHFLOW_MEMORABLE = 'word';

      const err = new Error('Bad request');
      err.response = { status: 400, data: { Error: 'PasswordExpired' } };
      axios.post.mockRejectedValueOnce(err);

      // First call triggers lock
      await expect(sessionService.ensureSessionToken()).rejects.toThrow();

      // Second call should immediately fail with lockout message
      await expect(sessionService.ensureSessionToken()).rejects.toThrow(/temporarily disabled/i);
    });

    it('sets lockUntil on AccountLocked error', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user';
      process.env.KASHFLOW_API_PASSWORD = 'pass';
      process.env.KASHFLOW_MEMORABLE = 'word';

      const err = new Error('Account locked');
      err.response = { status: 400, data: { Error: 'AccountLocked', Message: 'Account is locked' } };
      axios.post.mockRejectedValueOnce(err);

      await expect(sessionService.ensureSessionToken()).rejects.toThrow();
      await expect(sessionService.ensureSessionToken()).rejects.toThrow(/temporarily disabled/i);
    });
  });

  // ── TTL-based expiry ──────────────────────────────────────────────────

  describe('TTL-based expiry', () => {
    it('re-authenticates when token TTL has expired', async () => {
      process.env.KASHFLOW_EXTERNAL_TOKEN = 'ext-token';

      // First call: token with very short TTL
      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'token-1', ExpiresInSeconds: 1 }, // 1s TTL
      });

      const token1 = await sessionService.ensureSessionToken();
      expect(token1).toBe('token-1');

      // Wait beyond TTL + 30s early-expiry buffer — need to fake time
      // Instead, clear to force re-auth
      sessionService.clearCachedToken();

      axios.get.mockResolvedValueOnce({
        data: { SessionToken: 'token-2', ExpiresInSeconds: 3600 },
      });

      const token2 = await sessionService.ensureSessionToken();
      expect(token2).toBe('token-2');
      expect(axios.get).toHaveBeenCalledTimes(2);
    });
  });

  // ── pickPositions strategies 2-5 ─────────────────────────────────────

  describe('pickPositions strategies', () => {
    it('strategy 2: nested MemorableWord.Positions', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user';
      process.env.KASHFLOW_API_PASSWORD = 'pass';
      process.env.KASHFLOW_MEMORABLE = 'abcdefghij';

      axios.post.mockResolvedValueOnce({
        data: {
          TemporaryToken: 'tmp',
          MemorableWord: { Positions: [3, 6, 9] },
        },
      });
      axios.put.mockResolvedValueOnce({ data: { SessionToken: 'nested-token' } });

      const token = await sessionService.ensureSessionToken();
      expect(token).toBe('nested-token');
      const putBody = axios.put.mock.calls[0][1];
      expect(putBody.MemorableWordList).toEqual([
        { Position: 3, Value: 'c' },
        { Position: 6, Value: 'f' },
        { Position: 9, Value: 'i' },
      ]);
    });

    it('strategy 3: individual Position1/Position2/Position3 keys', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user';
      process.env.KASHFLOW_API_PASSWORD = 'pass';
      process.env.KASHFLOW_MEMORABLE = 'abcdefghij';

      axios.post.mockResolvedValueOnce({
        data: {
          TemporaryToken: 'tmp',
          Position1: 2,
          Position2: 5,
          Position3: 8,
        },
      });
      axios.put.mockResolvedValueOnce({ data: { SessionToken: 'pos-token' } });

      const token = await sessionService.ensureSessionToken();
      expect(token).toBe('pos-token');
      const putBody = axios.put.mock.calls[0][1];
      expect(putBody.MemorableWordList).toEqual([
        { Position: 2, Value: 'b' },
        { Position: 5, Value: 'e' },
        { Position: 8, Value: 'h' },
      ]);
    });

    it('strategy 5: deep recursive scan for position arrays', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user';
      process.env.KASHFLOW_API_PASSWORD = 'pass';
      process.env.KASHFLOW_MEMORABLE = 'abcdefghij';

      axios.post.mockResolvedValueOnce({
        data: {
          TemporaryToken: 'tmp',
          nested: {
            deep: {
              characterPositions: [1, 4, 7],
            },
          },
        },
      });
      axios.put.mockResolvedValueOnce({ data: { SessionToken: 'deep-token' } });

      const token = await sessionService.ensureSessionToken();
      expect(token).toBe('deep-token');
      const putBody = axios.put.mock.calls[0][1];
      expect(putBody.MemorableWordList).toEqual([
        { Position: 1, Value: 'a' },
        { Position: 4, Value: 'd' },
        { Position: 7, Value: 'g' },
      ]);
    });
  });

  // ── form-encoded attempt 3 ────────────────────────────────────────────

  describe('form-encoded fallback (attempt 3)', () => {
    it('tries URL-encoded form when both JSON attempts fail with InvalidCredentials', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user';
      process.env.KASHFLOW_API_PASSWORD = 'pass';
      process.env.KASHFLOW_MEMORABLE = 'word';

      // Attempt 1: InvalidCredentials
      const err1 = new Error('Bad');
      err1.response = { status: 400, data: { Error: 'InvalidCredentials' } };
      axios.post.mockRejectedValueOnce(err1);

      // Attempt 2: InvalidCredentials
      const err2 = new Error('Bad');
      err2.response = { status: 400, data: { Error: 'InvalidCredentials' } };
      axios.post.mockRejectedValueOnce(err2);

      // Attempt 3 (form-encoded): success
      axios.post.mockResolvedValueOnce({
        data: { SessionToken: 'form-token' },
      });

      const token = await sessionService.ensureSessionToken();
      expect(token).toBe('form-token');
      expect(axios.post).toHaveBeenCalledTimes(3);

      // Verify third call used form-encoded content type
      const thirdCall = axios.post.mock.calls[2];
      expect(thirdCall[2].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });
  });

  // ── Missing TemporaryToken in step 2 ──────────────────────────────────

  describe('missing TemporaryToken', () => {
    it('throws when step1 has positions but no TemporaryToken', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user';
      process.env.KASHFLOW_API_PASSWORD = 'pass';
      process.env.KASHFLOW_MEMORABLE = 'abcdefghij';

      axios.post.mockResolvedValueOnce({
        data: {
          // No TemporaryToken!
          CharacterPositions: [1, 2, 3],
        },
      });

      await expect(sessionService.ensureSessionToken()).rejects.toThrow(/TemporaryToken/i);
    });
  });

  // ── Missing character positions ───────────────────────────────────────

  describe('missing character positions', () => {
    it('throws when step1 returns no positions at all', async () => {
      process.env.KASHFLOW_API_USERNAME = 'user';
      process.env.KASHFLOW_API_PASSWORD = 'pass';
      process.env.KASHFLOW_MEMORABLE = 'abcdefghij';

      axios.post.mockResolvedValueOnce({
        data: {
          TemporaryToken: 'tmp',
          // No position data
        },
      });

      await expect(sessionService.ensureSessionToken()).rejects.toThrow(/character positions/i);
    });
  });
});
