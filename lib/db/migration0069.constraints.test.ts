import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

async function migrationText(name: string): Promise<string> {
  return readFile(resolve(drizzleDir(), name), 'utf8');
}

test('migration 0069 keeps a corporate action whole or empty, never half-read', async () => {
  const migration = await migrationText('0069_b20_corporate_actions.sql');

  // The raw log is the thing that makes an unreadable payload recoverable.
  // Without these two columns, a layout this build cannot decode would be a
  // corporate action we noticed and permanently could not describe.
  assert.match(migration, /topics\s+jsonb\s+NOT NULL/);
  assert.match(migration, /data\s+text\s+NOT NULL/);

  // When the action executed, and when we read it. Separate columns, and the
  // constraint that keeps them in the right order.
  assert.match(migration, /block_time\s+timestamptz NOT NULL/);
  assert.match(migration, /observed_at >= block_time/);

  const decoded =
    migration.match(/b20_corporate_actions_decoded_is_complete CHECK \(([\s\S]*?)\n {2}\),/)?.[1] ?? '';
  assert.match(decoded, /announcement_id IS NOT NULL AND caller IS NOT NULL/);
  assert.match(decoded, /description IS NOT NULL AND uri IS NOT NULL/);
  const topicOnly =
    migration.match(/b20_corporate_actions_topic_only_is_empty CHECK \(([\s\S]*?)\n {2}\),/)?.[1] ?? '';
  assert.match(topicOnly, /announcement_id IS NULL AND caller IS NULL/);
  assert.match(topicOnly, /multiplier_wad IS NULL/);

  // One log is one row for all time — the whole reorg policy the confirmation
  // depth does not cover.
  assert.match(migration, /UNIQUE \(chain_id, transaction_hash, log_index\)/);

  // A zero multiplier is not a ratio, and a card that rendered one would show a
  // share count collapsing to nothing.
  assert.match(migration, /multiplier_wad ~ '\^\[1-9\]\[0-9\]\*\$'/);

  // Every migration here is applied by hand, and a CREATE TABLE run as
  // `postgres` leaves the app with no SELECT or INSERT. That has shipped twice.
  assert.match(migration, /ALTER TABLE b20_corporate_actions OWNER TO miorail_user/);
  assert.match(migration, /ALTER SEQUENCE b20_corporate_actions_id_seq OWNER TO miorail_user/);
});

test('migration 0069 widens both signal kind lists, and by the same two kinds', async () => {
  const migration = await migrationText('0069_b20_corporate_actions.sql');
  const blocks = migration.match(/kind IN \(([\s\S]*?)\)\)/g) ?? [];
  assert.equal(blocks.length, 2, 'the watch table and the signal table are both widened');
  for (const block of blocks) {
    assert.match(block, /official_asset_corporate_action_announced/);
    assert.match(block, /official_asset_multiplier_changed/);
    // ...and the six that were already there stay there. A DROP CONSTRAINT
    // that re-adds a shorter list would silently stop accepting older kinds.
    for (const existing of [
      'official_source_added_asset',
      'official_source_removed_asset',
      'official_asset_lookalike_created',
      'official_asset_market_became_active',
      'official_asset_market_became_unreachable',
      'official_asset_cash_exit_changed',
    ]) {
      assert.ok(block.includes(existing), `${existing} survives the widening`);
    }
  }
});
