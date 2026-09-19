import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { RWA_SIGNAL_KINDS_V1, RWA_ONCHAIN_SIGNAL_KINDS_V1 } from '../src/rwaSignals.js';

// A kind the code can emit and the database refuses is a worker that crashes on
// correct data; a kind the database accepts and the code has no schema for is a
// row nothing can read back. The two lists are written in different languages in
// different files, so the only thing that can keep them together is this.
function drizzleDir(): string {
  const root = process.cwd().endsWith('lib/route-storage') ? '../..' : '.';
  return resolve(process.cwd(), root, 'lib/db/drizzle');
}

/**
 * The constraint AS IT STANDS, which is the last migration that redefines it.
 *
 * This used to name one migration file. That worked until a later migration
 * added a kind, at which point the test was checking a constraint the database
 * no longer has — passing or failing on history rather than on the schema. A
 * pinned filename is a pin to a moment; the schema is the newest definition.
 */
async function latestKindConstraintV1(table: string): Promise<string[]> {
  const dir = drizzleDir();
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  let newest: string[] | null = null;
  for (const name of files) {
    const sql = await readFile(resolve(dir, name), 'utf8');
    const pattern = new RegExp(
      `ALTER TABLE ${table} ADD CONSTRAINT[\\s\\S]*?kind IN \\(([\\s\\S]*?)\\)\\)`,
    );
    const block = sql.match(pattern)?.[1];
    if (block !== undefined) newest = [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
  }
  assert.ok(newest !== null, `no migration defines the ${table} kind constraint`);
  return newest!;
}

test('every signal kind the code knows is a kind the database accepts', async () => {
  const inSql = await latestKindConstraintV1('rwa_signals');
  assert.deepEqual([...inSql].sort(), [...RWA_SIGNAL_KINDS_V1].sort());
});

test('the watch table accepts every kind too, or a watch cannot be opened for it', async () => {
  // The two constraints are written out separately in SQL and drift
  // independently. A kind the signals table accepts and the watch table does
  // not is a kind nothing can ever start watching, so it would never emit.
  const inSql = await latestKindConstraintV1('rwa_signal_watch');
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
