import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../src/util/logger.js', () => {
  const noop = vi.fn();
  return { default: { info: noop, warn: noop, error: noop, debug: noop, child: () => ({ info: noop, warn: noop, error: noop }) } };
});

const { loginMode, ssoCookieDomain, appPublicUrl } = await import('../src/server/middleware/auth.js');

const ENV_KEYS = ['HCS_SYNC_LOGIN_MODE', 'HCS_SYNC_API_KEY', 'HCS_SSO_COOKIE_DOMAIN', 'HCS_APP_BASE_URL', 'HCS_APP_PUBLIC_URL'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('loginMode', () => {
  it('redirects through hcs-app when an API key is configured', () => {
    process.env.HCS_SYNC_API_KEY = 'k';
    delete process.env.HCS_SYNC_LOGIN_MODE;
    expect(loginMode()).toBe('redirect');
  });

  // Local dev with no hcs-app: the form's dev bypass is the only way in.
  it('falls back to the form outside production when no API key is set', () => {
    delete process.env.HCS_SYNC_API_KEY;
    delete process.env.HCS_SYNC_LOGIN_MODE;
    expect(loginMode()).toBe('form');
  });

  it('honours an explicit HCS_SYNC_LOGIN_MODE', () => {
    process.env.HCS_SYNC_API_KEY = 'k';
    process.env.HCS_SYNC_LOGIN_MODE = 'Form';
    expect(loginMode()).toBe('form');
    delete process.env.HCS_SYNC_API_KEY;
    process.env.HCS_SYNC_LOGIN_MODE = 'redirect';
    expect(loginMode()).toBe('redirect');
  });

  it('ignores an unknown HCS_SYNC_LOGIN_MODE', () => {
    process.env.HCS_SYNC_API_KEY = 'k';
    process.env.HCS_SYNC_LOGIN_MODE = 'sometimes';
    expect(loginMode()).toBe('redirect');
  });
});

describe('ssoCookieDomain', () => {
  it('derives the shared parent domain, as hcs-app does', () => {
    delete process.env.HCS_SSO_COOKIE_DOMAIN;
    process.env.HCS_APP_BASE_URL = 'https://app.heroncs.co.uk';
    expect(ssoCookieDomain({ hostname: 'sync.heroncs.co.uk' })).toBe('.heroncs.co.uk');
  });

  it('prefers HCS_SSO_COOKIE_DOMAIN', () => {
    process.env.HCS_SSO_COOKIE_DOMAIN = '.example.test';
    expect(ssoCookieDomain({ hostname: 'sync.heroncs.co.uk' })).toBe('.example.test');
  });

  it('returns no domain for unrelated hosts or the same host', () => {
    delete process.env.HCS_SSO_COOKIE_DOMAIN;
    process.env.HCS_APP_BASE_URL = 'https://app.heroncs.co.uk';
    expect(ssoCookieDomain({ hostname: 'localhost' })).toBe('');
    expect(ssoCookieDomain({ hostname: 'app.heroncs.co.uk' })).toBe('');
  });
});

// The live stack sets HCS_APP_BASE_URL to the internal compose address for
// server-to-server calls; sending a browser there broke sign-in.
describe('appPublicUrl', () => {
  it('does not send the browser to an internal service address', () => {
    delete process.env.HCS_APP_PUBLIC_URL;
    process.env.HCS_APP_BASE_URL = 'http://hcs-app:5000';
    expect(appPublicUrl()).toBe('https://app.heroncs.co.uk');
  });

  it('uses a public HCS_APP_BASE_URL as is', () => {
    delete process.env.HCS_APP_PUBLIC_URL;
    process.env.HCS_APP_BASE_URL = 'https://app.example.test/';
    expect(appPublicUrl()).toBe('https://app.example.test');
  });

  it('prefers HCS_APP_PUBLIC_URL', () => {
    process.env.HCS_APP_PUBLIC_URL = 'https://hcs.example.test/';
    process.env.HCS_APP_BASE_URL = 'http://hcs-app:5000';
    expect(appPublicUrl()).toBe('https://hcs.example.test');
  });

  it('derives the cookie domain from the public address', () => {
    delete process.env.HCS_SSO_COOKIE_DOMAIN;
    delete process.env.HCS_APP_PUBLIC_URL;
    process.env.HCS_APP_BASE_URL = 'http://hcs-app:5000';
    expect(ssoCookieDomain({ hostname: 'sync.heroncs.co.uk' })).toBe('.heroncs.co.uk');
  });
});
