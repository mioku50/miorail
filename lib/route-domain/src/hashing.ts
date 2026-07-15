import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export type HashV1 = `0x${string}`;

export const ZERO_HASH_V1 = `0x${'0'.repeat(64)}` as HashV1;

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalizeV1(value: unknown, seen: Set<object>): CanonicalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical JSON does not support non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'undefined')
    throw new TypeError('Canonical JSON does not support undefined array values');
  if (typeof value === 'bigint')
    throw new TypeError('Canonical JSON requires bigint values to be decimal strings');
  if (typeof value !== 'object')
    throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  if (seen.has(value)) throw new TypeError('Canonical JSON does not support cyclic values');

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalizeV1(item, seen));

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON supports plain objects only');
    }

    const output: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodeUnits)) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) output[key] = canonicalizeV1(inner, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJsonValueV1(value: unknown): CanonicalJsonValue {
  return canonicalizeV1(value, new Set());
}

export function canonicalJsonV1(value: unknown): string {
  return JSON.stringify(canonicalJsonValueV1(value));
}

export function stableHashV1(domain: string, payload: unknown): HashV1 {
  if (!/^[a-z0-9][a-z0-9._/-]{2,127}$/.test(domain)) {
    throw new TypeError('Hash domain must be a lowercase versioned identifier');
  }
  const bytes = utf8ToBytes(canonicalJsonV1({ domain: `miorail:${domain}`, payload }));
  return `0x${bytesToHex(sha256(bytes))}` as HashV1;
}

const LIFECYCLE_FIELDS_V1 = new Set(['id', 'createdAt', 'updatedAt', 'status']);

/** Returns the immutable financial payload used by contract-specific hashes. */
export function financialContentV1(
  value: Record<string, unknown>,
  excludedFields: readonly string[] = [],
): Record<string, unknown> {
  const excluded = new Set([...LIFECYCLE_FIELDS_V1, ...excludedFields]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
}
