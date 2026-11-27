import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { companyName, companyShortName, syncLabel } from '../src/util/brand.js';

describe('brand', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ['COMPANY_NAME', 'COMPANY_SHORT_NAME']) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('names no company until one is configured', () => {
    expect(companyName()).toBe('');
    expect(syncLabel()).toBe('HCS Sync');
  });

  it('labels the dashboard and alerts with the configured company', () => {
    process.env.COMPANY_NAME = 'Example Building Co LTD';
    expect(syncLabel()).toBe('Example Building Co LTD | Sync');
    process.env.COMPANY_SHORT_NAME = ' Example ';
    expect(companyShortName()).toBe('Example');
    expect(syncLabel()).toBe('Example | Sync');
  });
});
