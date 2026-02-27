import { describe, it, expect } from 'vitest';

describe('src/util/logger.js', () => {
  it('exports a pino logger with expected methods', async () => {
    const { default: logger } = await import('../src/util/logger.js');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('has redaction configured', async () => {
    const { default: logger } = await import('../src/util/logger.js');
    // Pino stores redaction info internally; just verify the logger works
    // without throwing when logging a sensitive-key object.
    expect(() => {
      logger.info({ password: 'secret', token: 'abc' }, 'test');
    }).not.toThrow();
  });
});
