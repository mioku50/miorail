import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// The constraints in migration 0057, tested by violating them.
//
// The repository refuses these rows in TypeScript. This proves the DATABASE
// refuses them with the repository out of the way — which matters here because
// a row in `representation_ratio_change` is a claim that a corporate action
// happened to somebody's money, and the cheapest way to publish a false one is
// a script that skipped the interface.
//
// It DROPS both tables, so it runs only against a throwaway local database.
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const WAD = (10n ** 18n).toString();
const HASH = `0x${'a1'.repeat(32)}`;

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS representation_ratio_change CASCADE');
  await sql.unsafe('DROP TABLE IF EXISTS representation_ratio CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0057_representation_ratio.sql'), 'utf8');
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

async function refuses(statement: string, expected: RegExp): Promise<void> {
  await assert.rejects(async () => {
    await sql!.unsafe(statement);
  }, (error: unknown) => {
    const message = String((error as { message?: string }).message ?? error);
    assert.match(message, expected);
    return true;
  });
}

function ratioRow(over: Record<string, string> = {}): string {
  const v = {
    chain_id: '8453',
    token_address: `'${AAPL}'`,
    ratio_kind: `'b20_multiplier'`,
    application: `'apply_to_raw_balance'`,
    raw_value: `'${WAD}'`,
    scale: `'${WAD}'`,
    block_number: `'50480605'`,
    block_hash: `'${HASH}'`,
    evidence_hash: `'${HASH}'`,
    observed_at: `'2026-08-26T12:00:00Z'`,
    last_checked_at: `'2026-08-26T12:00:01Z'`,
    last_changed_at: 'NULL',
    reads: '1',
    changes: '0',
    created_at: `'2026-08-26T12:00:01Z'`,
    ...over,
  };
  return `INSERT INTO representation_ratio (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')})`;
}

if (!throwaway) {
  describe('migration 0057 constraints', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('migration 0057 constraints', () => {
    test('a change count with no time behind it is refused', async () => {
      await refuses(ratioRow({ changes: '3' }), /representation_ratio_change_has_a_time/);
      await refuses(
        ratioRow({ last_changed_at: `'2026-08-26T12:00:01Z'` }),
        /representation_ratio_change_has_a_time/,
      );
    });

    test('an unreviewed ratio kind cannot be stored', async () => {
      await refuses(
        ratioRow({ ratio_kind: `'dshare_balance_per_share'` }),
        /representation_ratio_kind/,
      );
    });

    test('a mixed-case address is refused rather than silently normalised', async () => {
      await refuses(
        ratioRow({ token_address: `'0xB200000000000000000000C2E324D24D7EECD1FB'` }),
        /representation_ratio_token_lower/,
      );
    });

    test('a zero ratio is not a ratio', async () => {
      await refuses(ratioRow({ raw_value: `'0'` }), /representation_ratio_value_digits/);
      await refuses(ratioRow({ scale: `'0'` }), /representation_ratio_scale_digits/);
    });

    test('a transition that did not move is refused', async () => {
      await refuses(
        `INSERT INTO representation_ratio_change (
           chain_id, token_address, ratio_kind, from_raw_value, to_raw_value, scale,
           block_number, block_hash, evidence_hash, observed_at, recorded_at
         ) VALUES (8453, '${AAPL}', 'b20_multiplier', '${WAD}', '${WAD}', '${WAD}',
           '50480605', '${HASH}', '${HASH}', '2026-08-26T12:00:00Z', '2026-08-26T12:00:01Z')`,
        /representation_ratio_change_moved/,
      );
    });

    test('one block yields at most one transition per representation', async () => {
      const insert = `INSERT INTO representation_ratio_change (
           chain_id, token_address, ratio_kind, from_raw_value, to_raw_value, scale,
           block_number, block_hash, evidence_hash, observed_at, recorded_at
         ) VALUES (8453, '${AAPL}', 'b20_multiplier', '${WAD}', '1020000000000000000', '${WAD}',
           '50490000', '${HASH}', '${HASH}', '2026-08-26T12:00:00Z', '2026-08-26T12:00:01Z')`;
      await sql!.unsafe(insert);
      await refuses(insert, /representation_ratio_change_once_per_block/);
    });

    test('a change cannot be recorded before it was observed', async () => {
      await refuses(
        `INSERT INTO representation_ratio_change (
           chain_id, token_address, ratio_kind, from_raw_value, to_raw_value, scale,
           block_number, block_hash, evidence_hash, observed_at, recorded_at
         ) VALUES (8453, '${AAPL}', 'b20_multiplier', '${WAD}', '1020000000000000000', '${WAD}',
           '50490777', '${HASH}', '${HASH}', '2026-08-26T12:00:00Z', '2026-08-26T11:00:00Z')`,
        /representation_ratio_change_recorded_after/,
      );
    });
  });
}
