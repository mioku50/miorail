import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

function drizzlePath(file: string): string {
  const cwd = process.cwd();
  return resolve(
    cwd.endsWith('lib/route-storage')
      ? resolve(cwd, '..', 'db', 'drizzle')
      : resolve(cwd, 'lib', 'db', 'drizzle'),
    file,
  );
}

test('0061 is nullable and additive, so old cash-exit evidence is never rewritten', async () => {
  const sql = await readFile(drizzlePath('0061_market_reality_evidence_snapshot.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS market_reality_snapshots jsonb/);
  assert.doesNotMatch(sql, /UPDATE\s+official_cash_exit_runs/i);
  assert.doesNotMatch(sql, /NOT NULL/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM/i);
});

test('0061 is the append-only next migration journal entry', async () => {
  const journal = JSON.parse(await readFile(drizzlePath('meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  assert.deepEqual(journal.entries[61], {
    ...journal.entries[61],
    idx: 61,
    tag: '0061_market_reality_evidence_snapshot',
  });
});
