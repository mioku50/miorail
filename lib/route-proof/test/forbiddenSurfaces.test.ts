import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

test('route-proof never references send_calls, x402, ActionInbox, or SpendPermission', () => {
  const forbidden = /send_calls|x402|actioninbox|spendpermission/i;
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith('.ts')) continue;
    const content = readFileSync(path.join(srcDir, file), 'utf8');
    assert.equal(forbidden.test(content), false, `${file} must not reference forbidden surfaces`);
  }
});
