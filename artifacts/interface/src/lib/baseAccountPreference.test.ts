import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { BASE_ACCOUNT_PREFERENCE_V1 } from './baseAccountPreference';

function entrySource(): string {
  const cwd = process.cwd();
  const root = cwd.endsWith('artifacts/interface') ? cwd : resolve(cwd, 'artifacts/interface');
  return readFileSync(resolve(root, 'src/main.tsx'), 'utf8');
}

test('the Base Account connector is created with its telemetry off', () => {
  // Left on, the library adds an inline analytics script to every page as it loads: the one thing in
  // our own bundle that broke the page's script rule (audit AUTH-7, 2026-11-12).
  assert.deepEqual(BASE_ACCOUNT_PREFERENCE_V1, { telemetry: false });
  const source = entrySource();
  const created = source.match(/baseAccount\(\{[^)]*\}\)/g) ?? [];
  assert.ok(created.length > 0, 'the entry file no longer creates the Base Account connector');
  for (const call of created) {
    assert.match(call, /preference: BASE_ACCOUNT_PREFERENCE_V1/, `created without the preference: ${call}`);
  }
  // A bare `baseAccount()` would bring the default back.
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /baseAccount\(\s*\)/);
});
