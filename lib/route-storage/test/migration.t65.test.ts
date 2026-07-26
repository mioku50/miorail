import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// T65: the NFT tables (0017), what the client reported after calling the wallet
// (0018), and the two submission outcomes the blueprint could not previously
// express (0019). These assertions are about the SHAPE of the migrations, not
// about a live database — they catch schema/migration drift before Postgres
// ever sees it.

async function migration(file: string): Promise<string> {
  return readFile(resolve(process.cwd(), `../db/drizzle/${file}.sql`), 'utf8');
}

const T65_TABLES = [
  'nft_candidates',
  'nft_evidence',
  'nft_route_cards',
  'nft_purchase_blueprints',
  'nft_proofs',
  'nft_proof_events',
];

test('0017 creates every NFT table', async () => {
  const sql = await migration('0017_t65_nft_storage');
  for (const table of T65_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE "${table}"`), `${table} must be created`);
  }
});

test('0017 makes the ownership rule a DATABASE guarantee, not application logic', async () => {
  const sql = await migration('0017_t65_nft_storage');
  // A completed proof without a new owner and the block it was read at is not
  // expressible, whatever any future caller believes.
  assert.match(
    sql,
    /nft_proofs_ownership_check" CHECK \("final_status" <> 'completed' OR \("new_owner" IS NOT NULL AND "ownership_block_number" IS NOT NULL\)\)/,
  );
});

test('0018 keeps the client claim separate from the chain read', async () => {
  const sql = await migration('0018_t65_nft_submission');
  // The client-reported hash lives on the BLUEPRINT. nft_proofs holds what the
  // server read from Base; one column for both would let a claim become a fact.
  for (const column of ['submission_batch_id', 'submitted_transaction_hash', 'submitted_at']) {
    assert.match(sql, new RegExp(`ALTER TABLE "nft_purchase_blueprints" ADD COLUMN IF NOT EXISTS "${column}"`));
  }
  assert.ok(!/ALTER TABLE "nft_proofs"/.test(sql), 'the proof table must not learn a client claim');
});

test('0019 widens the status set and is additive', async () => {
  const sql = await migration('0019_t65_nft_submission_states');
  assert.ok(!/DROP TABLE|DELETE FROM|DROP COLUMN/i.test(sql), 'nothing may be dropped or deleted');
  // The only DROPs are the two CHECKs, each immediately re-added.
  const drops = sql.match(/DROP CONSTRAINT IF EXISTS "([^"]+)"/g) ?? [];
  assert.deepEqual(drops, [
    'DROP CONSTRAINT IF EXISTS "nft_purchase_blueprints_status_check"',
    'DROP CONSTRAINT IF EXISTS "nft_purchase_blueprints_cancelled_check"',
  ]);
  for (const status of ['submitted_unknown', 'cancelled']) {
    assert.ok(sql.includes(`'${status}'`), `${status} must be an allowed blueprint status`);
  }
  // A cancelled row claims no submission: that is the point of keeping the
  // state distinct from `submitted` at all.
  assert.match(
    sql,
    /nft_purchase_blueprints_cancelled_check" CHECK \("status" <> 'cancelled' OR \("submitted_at" IS NULL AND "submission_batch_id" IS NULL AND "submitted_transaction_hash" IS NULL\)\)/,
  );
});

test('the new status set is a strict superset of the old one', async () => {
  const before = await migration('0017_t65_nft_storage');
  const after = await migration('0019_t65_nft_submission_states');
  const statuses = (sql: string) => {
    const match = /nft_purchase_blueprints_status_check" CHECK \("status" IN \(([^)]+)\)\)/.exec(sql);
    assert.ok(match, 'the status CHECK must be present');
    return match[1].split(',').map((value) => value.trim().replace(/'/g, ''));
  };
  const widened = new Set(statuses(after));
  // No existing row can violate the new constraint, which is what makes this
  // migration safe to apply to a live table.
  for (const status of statuses(before)) {
    assert.ok(widened.has(status), `${status} must remain allowed`);
  }
});

test('the journal records every T65 migration exactly once, in order', async () => {
  const journal = JSON.parse(await readFile(resolve(process.cwd(), '../db/drizzle/meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const tags = journal.entries.map((entry) => entry.tag);
  const expected = ['0017_t65_nft_storage', '0018_t65_nft_submission', '0019_t65_nft_submission_states'];
  for (const tag of expected) {
    assert.equal(tags.filter((value) => value === tag).length, 1, `${tag} must appear exactly once`);
  }
  assert.deepEqual(
    expected.map((tag) => tags.indexOf(tag)).slice().sort((a, b) => a - b),
    expected.map((tag) => tags.indexOf(tag)),
    'the T65 migrations must be journalled in order',
  );
  // The journal is append-only: idx must equal position.
  journal.entries.forEach((entry, index) => assert.equal(entry.idx, index, 'journal idx must match its position'));
});
