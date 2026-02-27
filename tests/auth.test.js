import { describe, it, expect, vi } from 'vitest';

// Mock the sessionService so auth.js doesn't try real HTTP calls
vi.mock('../src/kashflow/sessionService.js', () => ({
  ensureSessionToken: vi.fn().mockResolvedValue('mock-session-token'),
  invalidateSession: vi.fn().mockResolvedValue(undefined),
  clearCachedToken: vi.fn(),
  withKfAuth: vi.fn(async (fn) => fn('mock-session-token')),
}));

describe('src/kashflow/auth.js (adapter)', () => {
  it('getSessionToken delegates to ensureSessionToken', async () => {
    const { getSessionToken } = await import('../src/kashflow/auth.js');
    const { ensureSessionToken } = await import('../src/kashflow/sessionService.js');

    const token = await getSessionToken();
    expect(token).toBe('mock-session-token');
    expect(ensureSessionToken).toHaveBeenCalled();
  });

  it('clearCachedSessionToken delegates to clearCachedToken', async () => {
    const { clearCachedSessionToken } = await import('../src/kashflow/auth.js');
    const { clearCachedToken } = await import('../src/kashflow/sessionService.js');

    clearCachedSessionToken();
    expect(clearCachedToken).toHaveBeenCalled();
  });

  it('re-exports ensureSessionToken, invalidateSession, withKfAuth', async () => {
    const auth = await import('../src/kashflow/auth.js');
    expect(typeof auth.ensureSessionToken).toBe('function');
    expect(typeof auth.invalidateSession).toBe('function');
    expect(typeof auth.withKfAuth).toBe('function');
  });
});
