import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// The constraints in migration 0053, tested by violating them.
//
// The repository refuses these rows in TypeScript. This proves the DATABASE
// refuses them with the repository out of the way — and for this table that
// matters more than most, because a row here names a contract as wearing
// somebody else's name.
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const IMPOSTOR = '0xb200000000000000000000dead0000000000ad01';

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS official_asset_lookalikes CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0053_official_asset_lookalikes.sql'), 'utf8');
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('migration 0053 constraints', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('migration 0053 constraints', () => {
    const row = async (overrides: Record<string, unknown> = {}) => {
      const values = {
        chain_id: 8453,
        token_address: IMPOSTOR,
        official_address: AAPL,
        match_kind: 'symbol_exact',
        matched_value: 'AAPLc',
        launch_symbol: 'AAPLc',
        launch_name: 'Apple',
        launched_at: '2026-08-20T10:00:00.000Z',
        first_flagged_at: '2026-08-25T09:00:00.000Z',
        last_seen_at: '2026-08-25T09:00:00.000Z',
        ...overrides,
      };
      await sql!`
        INSERT INTO official_asset_lookalikes (
          chain_id, token_address, official_address, match_kind, matched_value,
          launch_symbol, launch_name, launched_at, first_flagged_at, last_seen_at
        ) VALUES (
          ${values.chain_id as number}, ${values.token_address as string},
          ${values.official_address as string}, ${values.match_kind as string},
          ${values.matched_value as string}, ${values.launch_symbol as string},
          ${values.launch_name as string}, ${values.launched_at as string | null},
          ${values.first_flagged_at as string}::timestamptz, ${values.last_seen_at as string}::timestamptz
        )`;
    };

    test('a contract cannot be an impostor of itself', async () => {
      await assert.rejects(
        row({ token_address: AAPL }),
        /official_asset_lookalikes_is_not_the_official/,
      );
    });

    test('a checksummed address is refused, so identity has one spelling', async () => {
      await assert.rejects(
        row({ token_address: '0xB200000000000000000000DEAD0000000000AD01' }),
        /official_asset_lookalikes_token_lower/,
      );
    });

    test('a match kind outside the three observable ones is refused', async () => {
      await assert.rejects(row({ match_kind: 'looks_dodgy' }), /official_asset_lookalikes_match_kind/);
    });

    test('a flag with nothing that matched is refused', async () => {
      // A row with an empty matched_value cannot show a reader WHY it was
      // flagged, which is the only thing that keeps this from being a verdict.
      await assert.rejects(row({ matched_value: '' }), /official_asset_lookalikes_matched_value_present/);
    });

    test('one contract is flagged once', async () => {
      await row();
      await assert.rejects(row(), /official_asset_lookalikes_token_unique/);
    });

    test('last seen cannot precede first flagged', async () => {
      await assert.rejects(
        row({
          token_address: '0xb200000000000000000000beef0000000000be02',
          last_seen_at: '2026-08-24T09:00:00.000Z',
        }),
        /official_asset_lookalikes_seen_order/,
      );
    });
  });
}
