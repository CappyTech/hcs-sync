import { describe, it, expect } from 'vitest';
import { inferShape, mergeShapes, flattenShape, buildShapeReport } from '../src/util/shape.js';

describe('shape inference', () => {
  it('infers primitive types including integers, floats and date-time strings', () => {
    const fields = flattenShape(inferShape({
      Id: 4,
      Amount: 3954.6,
      Name: 'John Booth',
      Paid: true,
      IssuedDate: '2026-06-30 12:00:00',
      Missing: null,
    }));
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.Id.type).toBe('integer');
    expect(byName.Amount.type).toBe('number');
    expect(byName.Name.type).toBe('string');
    expect(byName.Paid.type).toBe('boolean');
    expect(byName.IssuedDate.type).toBe('string (date-time)');
    expect(byName.Missing.type).toBe('null');
  });

  it('merges array elements into a union and flags optional fields', () => {
    const payload = [
      { Id: 1, Note: 'x' },
      { Id: 2 },
      { Id: null, Extra: true },
    ];
    const fields = flattenShape(inferShape(payload));
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName['[].Id'].type).toBe('integer|null');
    expect(byName['[].Id'].optional).toBe(false);
    expect(byName['[].Note'].optional).toBe(true);
    expect(byName['[].Extra'].optional).toBe(true);
  });

  it('handles nested objects and arrays with dotted/bracket paths', () => {
    const payload = {
      PaymentLines: [{ AccountId: 4, Amount: 100.5 }],
      Currency: { Code: 'GBP' },
    };
    const fields = flattenShape(inferShape(payload));
    const names = fields.map((f) => f.name);
    expect(names).toContain('PaymentLines');
    expect(names).toContain('PaymentLines[].AccountId');
    expect(names).toContain('PaymentLines[].Amount');
    expect(names).toContain('Currency.Code');
  });

  it('folds null into object shapes as nullable', () => {
    const merged = mergeShapes(
      inferShape(null),
      inferShape({ Id: 1 }),
    );
    expect(merged.kind).toBe('object');
    expect(merged.nullable).toBe(true);
  });

  it('truncates long example values', () => {
    const fields = flattenShape(inferShape({ Note: 'a'.repeat(100) }));
    expect(fields[0].example.length).toBeLessThanOrEqual(61);
    expect(fields[0].example.endsWith('…')).toBe(true);
  });

  it('buildShapeReport records counts and endpoint', () => {
    const report = buildShapeReport('GET /bankaccounts', [{ Id: 1 }, { Id: 2 }]);
    expect(report.endpoint).toBe('GET /bankaccounts');
    expect(report.totalItems).toBe(2);
    expect(report.fields.some((f) => f.name === '[].Id')).toBe(true);
  });
});
