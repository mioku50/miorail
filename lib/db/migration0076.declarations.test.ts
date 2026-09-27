import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

test('migration 0076 keeps one declaration per company and payment, and adds its signal kind', async () => {
  const migration = await readFile(resolve(drizzleDir(), '0076_dividend_declarations.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS dividend_declarations/);
  assert.match(migration, /PRIMARY KEY \(underlying_key, pay_date\)/);
  assert.match(migration, /CHECK \(record_date <= pay_date\)/);
  assert.match(migration, /CHECK \(declared_on <= record_date\)/);
  assert.match(migration, /source_kind IN \('sec_8k', 'company_newsroom', 'press_wire'\)/);
  assert.match(migration, /ALTER TABLE dividend_declarations OWNER TO miorail_user/);
  // Both kind lists carry every earlier kind and the new one.
  for (const table of ['rwa_signal_watch', 'rwa_signals']) {
    const block = migration.slice(migration.indexOf(`ALTER TABLE ${table} ADD CONSTRAINT`));
    const list = block.slice(0, block.indexOf('));'));
    for (const kind of [
      'official_source_added_asset',
      'official_asset_cash_exit_changed',
      'official_asset_multiplier_change_cancelled',
      'official_asset_dividend_declared',
    ]) {
      assert.match(list, new RegExp(`'${kind}'`), `${table} ${kind}`);
    }
  }
  // A company's declaration names no wallet.
  assert.doesNotMatch(migration.replace(/^--.*$/gm, ''), /wallet|holder|balance/i);
});
