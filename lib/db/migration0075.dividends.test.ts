import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

test('migration 0075 keeps one immutable supply reading per token and record date', async () => {
  const migration = await readFile(resolve(drizzleDir(), '0075_dividend_record_supply.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS dividend_record_supply/);
  assert.match(migration, /PRIMARY KEY \(chain_id, token_address, record_date\)/);
  // The block read must be at or before the close it answers for.
  assert.match(migration, /CHECK \(block_time <= record_close_at\)/);
  assert.match(migration, /total_supply_atomic ~ '\^\[0-9\]\+\$'/);
  assert.match(migration, /ALTER TABLE dividend_record_supply OWNER TO miorail_user/);
  // Nothing about a holder: a supply is a fact about the token.
  assert.doesNotMatch(migration.replace(/^--.*$/gm, ''), /wallet|holder|balance/i);
});
