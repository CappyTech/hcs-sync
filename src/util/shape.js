/**
 * Response-shape inference for KashFlow API payloads.
 *
 * KashFlow's Swagger is incomplete, so we sample live responses and infer
 * field types ourselves. The output is designed to feed hcs-app's
 * apiDocsConfig.js: a flattened field list with dotted paths, `[]` for array
 * elements, a type union, an optional flag, and a truncated example value.
 */

const KF_DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function primitiveType(value) {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'string') return KF_DATE_RE.test(value.trim()) ? 'string (date-time)' : 'string';
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (t === 'boolean') return 'boolean';
  return t; // symbol/function/bigint — shouldn't occur in JSON
}

/**
 * Infer a shape descriptor for a JSON value.
 * Descriptors:
 *   { kind: 'primitive', types: Set<string>, example }
 *   { kind: 'array', items: descriptor|null, seenCount }
 *   { kind: 'object', fields: Map<name, { shape, seenIn }>, seenCount }
 */
export function inferShape(value, opts = {}) {
  const maxArraySample = opts.maxArraySample ?? 50;

  if (Array.isArray(value)) {
    let items = null;
    const sample = value.slice(0, maxArraySample);
    for (const el of sample) {
      const s = inferShape(el, opts);
      items = items ? mergeShapes(items, s) : s;
    }
    return { kind: 'array', items, seenCount: 1 };
  }
  if (value !== null && typeof value === 'object') {
    const fields = new Map();
    for (const [k, v] of Object.entries(value)) {
      fields.set(k, { shape: inferShape(v, opts), seenIn: 1 });
    }
    return { kind: 'object', fields, seenCount: 1 };
  }
  const example = value == null ? undefined : value;
  return { kind: 'primitive', types: new Set([primitiveType(value)]), example };
}

/** Merge two shape descriptors into a union. */
export function mergeShapes(a, b) {
  if (!a) return b;
  if (!b) return a;

  if (a.kind === b.kind) {
    if (a.kind === 'primitive') {
      const types = new Set([...a.types, ...b.types]);
      // Prefer a non-null example
      const example = a.example !== undefined ? a.example : b.example;
      return { kind: 'primitive', types, example };
    }
    if (a.kind === 'array') {
      return {
        kind: 'array',
        items: mergeShapes(a.items, b.items),
        seenCount: a.seenCount + b.seenCount,
      };
    }
    // object: union of fields; count how many merged objects contain each field
    const fields = new Map();
    const total = a.seenCount + b.seenCount;
    const keys = new Set([...a.fields.keys(), ...b.fields.keys()]);
    for (const k of keys) {
      const fa = a.fields.get(k);
      const fb = b.fields.get(k);
      fields.set(k, {
        shape: mergeShapes(fa?.shape ?? null, fb?.shape ?? null),
        seenIn: (fa?.seenIn ?? 0) + (fb?.seenIn ?? 0),
      });
    }
    return { kind: 'object', fields, seenCount: total };
  }

  // Kind mismatch (e.g. null primitive vs object): fold null into the richer shape
  const prim = a.kind === 'primitive' ? a : b.kind === 'primitive' ? b : null;
  const other = prim === a ? b : a;
  if (prim && prim.types.size === 1 && prim.types.has('null')) {
    return { ...other, nullable: true };
  }
  // Genuinely mixed types: represent as a primitive union
  const typeName = (s) => (s.kind === 'primitive' ? [...s.types] : [s.kind]);
  return { kind: 'primitive', types: new Set([...typeName(a), ...typeName(b)]), example: undefined };
}

function typeString(shape) {
  if (!shape) return 'unknown';
  const suffix = shape.nullable ? '|null' : '';
  if (shape.kind === 'primitive') return [...shape.types].sort().join('|');
  if (shape.kind === 'array') return 'array' + suffix;
  return 'object' + suffix;
}

function truncateExample(v, max = 60) {
  if (v === undefined) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Flatten a shape into apiDocsConfig-style field rows:
 *   [{ name: 'PaymentLines[].AccountId', type: 'integer|null', optional: false, example: '4' }]
 */
export function flattenShape(shape, prefix = '', out = []) {
  if (!shape) return out;
  if (shape.kind === 'object') {
    for (const [k, { shape: fs, seenIn }] of shape.fields) {
      const name = prefix ? `${prefix}.${k}` : k;
      const optional = seenIn < shape.seenCount;
      if (fs && (fs.kind === 'object' || fs.kind === 'array')) {
        out.push({ name, type: typeString(fs), optional });
        flattenShape(fs, name, out);
      } else {
        out.push({ name, type: typeString(fs), optional, example: truncateExample(fs?.example) });
      }
    }
    return out;
  }
  if (shape.kind === 'array') {
    const name = `${prefix}[]`;
    if (shape.items && (shape.items.kind === 'object' || shape.items.kind === 'array')) {
      flattenShape(shape.items, name, out);
    } else if (shape.items) {
      out.push({ name, type: typeString(shape.items), optional: false, example: truncateExample(shape.items.example) });
    }
    return out;
  }
  out.push({ name: prefix || '(value)', type: typeString(shape), optional: false, example: truncateExample(shape.example) });
  return out;
}

/** Full report for one endpoint response. */
export function buildShapeReport(name, payload, opts = {}) {
  const shape = inferShape(payload, opts);
  return {
    endpoint: name,
    fetchedAt: new Date().toISOString(),
    sampledItems: Array.isArray(payload) ? Math.min(payload.length, opts.maxArraySample ?? 50) : 1,
    totalItems: Array.isArray(payload) ? payload.length : 1,
    fields: flattenShape(shape),
  };
}
