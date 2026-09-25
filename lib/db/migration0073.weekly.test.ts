import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

test('migration 0073 records a weekly summary once per wallet per week, owned by the app user', async () => {
  const migration = await readFile(resolve(drizzleDir(), '0073_base_app_weekly_summary.sql'), 'utf8');
  // Re-runnable: applied by hand, perhaps twice.
  assert.match(migration, /CREATE TABLE IF NOT EXISTS base_app_weekly_summary/);
  // One row per (week, wallet) is what makes a second send impossible.
  assert.match(migration, /PRIMARY KEY \(week_close_at, wallet_address\)/);
  assert.match(migration, /wallet_address ~ '\^0x\[0-9a-f\]\{40\}\$'/);
  // A table created as postgres is one the notifier cannot write.
  assert.match(migration, /ALTER TABLE base_app_weekly_summary OWNER TO miorail_user/);
});
