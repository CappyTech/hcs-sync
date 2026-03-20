/**
 * Deep recursive diff between two plain objects (e.g. Mongo document vs incoming payload).
 *
 * Returns an array of change entries: { path, before, after, type }
 *   - type: 'added' | 'removed' | 'changed'
 *   - path: dot-separated with bracket notation for array items, e.g.
 *       "LineItems[Id=501].Quantity"  (key-based match)
 *       "WHTReferences[2]"            (index-based match)
 *
 * Arrays are matched by a configurable key field per parent field name
 * (falls back to index-based when no key is defined or items lack the key).
 */

/** Default key fields used to match array elements by identity. */
export const ARRAY_KEYS = {
  LineItems: 'Id',
  PaymentLines: 'Id',
  Contacts: 'Email',
  Addresses: 'PostCode',
  DeliveryAddresses: 'PostCode',
  ReminderLetters: 'Id',
};

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CHANGES = 200;

/** Fields that always change on every sync and are not interesting to audit. */
const SKIP_FIELDS = new Set([
  '_id', '__v', 'uuid', 'syncedAt', 'createdAt', 'updatedAt', 'createdByRunId',
]);

function isDate(v) {
  return v instanceof Date || (typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}/.test(v));
}

function toTime(v) {
  if (v instanceof Date) return v.getTime();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? NaN : d.getTime();
}

/**
 * @param {object|null} before  - existing Mongo document (lean plain object)
 * @param {object|null} after   - incoming $set fields (or full payload)
 * @param {object}      [opts]
 * @param {number}      [opts.maxDepth=3]
 * @param {number}      [opts.maxChanges=200]
 * @param {object}      [opts.arrayKeys=ARRAY_KEYS]
 * @param {Set<string>} [opts.skipFields=SKIP_FIELDS]
 * @returns {{ path: string, before: *, after: *, type: string }[]}
 */
export default function deepDiff(before, after, opts = {}) {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxChanges = opts.maxChanges ?? DEFAULT_MAX_CHANGES;
  const arrayKeys = opts.arrayKeys ?? ARRAY_KEYS;
  const skipFields = opts.skipFields ?? SKIP_FIELDS;
  const changes = [];

  function diff(oldVal, newVal, path, depth) {
    if (changes.length >= maxChanges) return;

    const oldNull = oldVal == null;
    const newNull = newVal == null;

    if (oldNull && newNull) return;

    if (oldNull) {
      changes.push({ path, before: null, after: newVal, type: 'added' });
      return;
    }
    if (newNull) {
      changes.push({ path, before: oldVal, after: null, type: 'removed' });
      return;
    }

    // Arrays
    const oldIsArr = Array.isArray(oldVal);
    const newIsArr = Array.isArray(newVal);
    if (oldIsArr || newIsArr) {
      if (!oldIsArr || !newIsArr) {
        changes.push({ path, before: oldVal, after: newVal, type: 'changed' });
        return;
      }
      diffArray(oldVal, newVal, path, depth);
      return;
    }

    // Objects (but not Date instances — treat those as scalars)
    if (typeof oldVal === 'object' && typeof newVal === 'object'
        && !(oldVal instanceof Date) && !(newVal instanceof Date)) {
      if (depth >= maxDepth) {
        if (stableStringify(oldVal) !== stableStringify(newVal)) {
          changes.push({ path, before: oldVal, after: newVal, type: 'changed' });
        }
        return;
      }
      diffObject(oldVal, newVal, path, depth);
      return;
    }

    // Scalar / Date comparison
    if (isDate(oldVal) && isDate(newVal)) {
      const t1 = toTime(oldVal);
      const t2 = toTime(newVal);
      if (t1 !== t2) {
        changes.push({ path, before: oldVal, after: newVal, type: 'changed' });
      }
      return;
    }

    // eslint-disable-next-line eqeqeq
    if (oldVal !== newVal) {
      changes.push({ path, before: oldVal, after: newVal, type: 'changed' });
    }
  }

  function diffObject(oldObj, newObj, basePath, depth) {
    const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
    for (const key of allKeys) {
      if (changes.length >= maxChanges) break;
      if (skipFields.has(key)) continue;
      const p = basePath ? `${basePath}.${key}` : key;
      diff(oldObj[key], newObj[key], p, depth + 1);
    }
  }

  function diffArray(oldArr, newArr, basePath, depth) {
    if (depth >= maxDepth) {
      if (stableStringify(oldArr) !== stableStringify(newArr)) {
        changes.push({
          path: basePath,
          before: `[${oldArr.length} items]`,
          after: `[${newArr.length} items]`,
          type: 'changed',
        });
      }
      return;
    }

    // Determine array key from the last segment of the path.
    const fieldName = basePath.includes('.') ? basePath.split('.').pop() : basePath;
    const keyField = arrayKeys[fieldName] || null;

    const hasObjects = (oldArr.length > 0 && typeof oldArr[0] === 'object')
      || (newArr.length > 0 && typeof newArr[0] === 'object');

    if (keyField && hasObjects) {
      diffArrayByKey(oldArr, newArr, basePath, depth, keyField);
    } else {
      diffArrayByIndex(oldArr, newArr, basePath, depth);
    }
  }

  function diffArrayByKey(oldArr, newArr, basePath, depth, keyField) {
    const oldMap = new Map();
    const oldNoKey = [];
    for (const item of oldArr) {
      const k = item?.[keyField];
      if (k != null) oldMap.set(String(k), item);
      else oldNoKey.push(item);
    }
    const newMap = new Map();
    const newNoKey = [];
    for (const item of newArr) {
      const k = item?.[keyField];
      if (k != null) newMap.set(String(k), item);
      else newNoKey.push(item);
    }

    // Removed items
    for (const [k, oldItem] of oldMap) {
      if (changes.length >= maxChanges) break;
      if (!newMap.has(k)) {
        changes.push({ path: `${basePath}[${keyField}=${k}]`, before: oldItem, after: null, type: 'removed' });
      }
    }

    // Added / changed items
    for (const [k, newItem] of newMap) {
      if (changes.length >= maxChanges) break;
      const oldItem = oldMap.get(k);
      if (!oldItem) {
        changes.push({ path: `${basePath}[${keyField}=${k}]`, before: null, after: newItem, type: 'added' });
      } else {
        diffObject(oldItem, newItem, `${basePath}[${keyField}=${k}]`, depth + 1);
      }
    }

    // Items without a key — fall back to index matching within the no-key subset
    diffArrayByIndex(oldNoKey, newNoKey, basePath, depth, true);
  }

  function diffArrayByIndex(oldArr, newArr, basePath, depth, noKeySubset = false) {
    const maxLen = Math.max(oldArr.length, newArr.length);
    for (let i = 0; i < maxLen; i++) {
      if (changes.length >= maxChanges) break;
      const suffix = noKeySubset ? `[noKey:${i}]` : `[${i}]`;
      diff(oldArr[i], newArr[i], `${basePath}${suffix}`, depth + 1);
    }
  }

  // Kick off
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    // Only diff fields that are present in `after` (the incoming payload / $set).
    // Fields in `before` that are absent from `after` are not being touched by the upsert.
    const afterKeys = Object.keys(after);
    for (const key of afterKeys) {
      if (changes.length >= maxChanges) break;
      if (skipFields.has(key)) continue;
      diff(before[key], after[key], key, 0);
    }
  }

  return changes;
}

/** Deterministic JSON for comparison (sorts object keys). */
function stableStringify(val) {
  if (val === null || val === undefined) return String(val);
  if (typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(stableStringify).join(',')}]`;
  const keys = Object.keys(val).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(val[k])}`).join(',')}}`;
}

export { SKIP_FIELDS, DEFAULT_MAX_DEPTH, DEFAULT_MAX_CHANGES, stableStringify };
