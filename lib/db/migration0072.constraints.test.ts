import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

test('migration 0072 admits a send beside every goal the two tables already hold', async () => {
  const migration = await readFile(resolve(drizzleDir(), '0072_gift_send_goal.sql'), 'utf8');

  // One transaction: a run table that admits a send while its Blueprint table
  // still refuses one would accept a gift it can never prepare.
  assert.match(migration, /^BEGIN;$/m);
  assert.match(migration, /^COMMIT;$/m);

  // Widened, never narrowed: every goal production already stores stays
  // admitted, or re-adding the check fails on the rows that are there.
  const runs = migration.match(/"route_runs_goal_check"\s+CHECK \("goal" IN \(([^)]*)\)\)/)?.[1] ?? '';
  assert.deepEqual(
    runs.split(',').map((goal) => goal.trim()),
    ["'swap'", "'earn'", "'commerce'", "'nft'", "'private_ai'", "'send'"],
  );
  const blueprints =
    migration.match(/"execution_blueprints_goal_check"\s+CHECK \("goal" IN \(([^)]*)\)\)/)?.[1] ?? '';
  assert.deepEqual(
    blueprints.split(',').map((goal) => goal.trim()),
    ["'swap'", "'earn'", "'send'"],
  );

  // Re-runnable: the drop tolerates a database where the check is missing.
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "route_runs_goal_check"/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "execution_blueprints_goal_check"/);
});
