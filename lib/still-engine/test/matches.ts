// The subset match the engine's tests were written against (vitest's toMatchObject): every key
// the expected object names must match, recursively; arrays must match in length and order;
// anything else is compared strictly.

import assert from 'node:assert/strict';

export function assertMatches(actual: unknown, expected: unknown, path = 'value'): void {
  if (expected !== null && typeof expected === 'object' && !(expected instanceof Date) && !(expected instanceof RegExp)) {
    assert.ok(actual !== null && typeof actual === 'object', `${path}: expected an object, got ${String(actual)}`);
    if (Array.isArray(expected)) {
      assert.ok(Array.isArray(actual), `${path}: expected an array`);
      assert.equal(actual.length, expected.length, `${path}: length`);
      expected.forEach((item, i) => assertMatches(actual[i], item, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(expected)) {
      assertMatches((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
    return;
  }
  assert.deepEqual(actual, expected, path);
}
