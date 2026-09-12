import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { RWA_SIGNAL_KINDS_V1, RWA_ONCHAIN_SIGNAL_KINDS_V1 } from '../src/rwaSignals.js';

// A kind the code can emit and the database refuses is a worker that crashes on
// correct data; a kind the database accepts and the code has no schema for is a
// row nothing can read back. The two lists are written in different languages in
// different files, so the only thing that can keep them together is this.
function drizzlePath(name: string): string {
  const root = process.cwd().endsWith('lib/route-storage') ? '../..' : '.';
  return resolve(process.cwd(), root, 'lib/db/drizzle', name);
}

test('every signal kind the code knows is a kind the database accepts', async () => {
  const migration = await readFile(drizzlePath('0069_b20_corporate_actions.sql'), 'utf8');
  const block =
    migration.match(/ALTER TABLE rwa_signals ADD CONSTRAINT[\s\S]*?kind IN \(([\s\S]*?)\)\)/)?.[1] ??
    '';
  const inSql = [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...inSql].sort(), [...RWA_SIGNAL_KINDS_V1].sort());
});

test('the onchain kinds are a subset of the kinds, not a second list of them', () => {
  for (const kind of RWA_ONCHAIN_SIGNAL_KINDS_V1) {
    assert.ok(
      (RWA_SIGNAL_KINDS_V1 as readonly string[]).includes(kind),
      `${kind} is missing from the full list`,
    );
  }
});
