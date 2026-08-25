import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// The constraints in migration 0055, tested by violating them.
//
// The repository refuses these rows in TypeScript. This proves the DATABASE
// refuses them with the repository out of the way, which matters here because
// every row is a public claim that something CHANGED — and the cheapest way to
// publish a false one is to write it from a script that skipped the interface.
//
// It DROPS both tables, so it runs only against a throwaway local database.
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
  await sql.unsafe('DROP TABLE IF EXISTS rwa_signals CASCADE');
  await sql.unsafe('DROP TABLE IF EXISTS rwa_signal_watch CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0055_rwa_signals.sql'), 'utf8');
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('migration 0055 constraints', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('migration 0055 constraints', () => {
    const row = async (overrides: Record<string, unknown> = {}) => {
      const values = {
        chain_id: 8453,
        kind: 'official_asset_lookalike_created',
        subject_address: IMPOSTOR,
        official_address: AAPL,
        occurred_at: '2026-08-25T12:00:00.000Z',
        recorded_at: '2026-08-25T12:00:01.000Z',
        dedupe_key: `official_asset_lookalike_created:${IMPOSTOR}`,
        facts: JSON.stringify({ matchedAlias: 'published_ticker' }),
        ...overrides,
      };
      await sql!`
        INSERT INTO rwa_signals (
          chain_id, kind, subject_address, official_address,
          occurred_at, recorded_at, dedupe_key, facts
        ) VALUES (
          ${values.chain_id as number}, ${values.kind as string},
          ${values.subject_address as string}, ${values.official_address as string | null},
          ${values.occurred_at as string}::timestamptz, ${values.recorded_at as string}::timestamptz,
          ${values.dedupe_key as string}, ${values.facts as string}::text::jsonb
        )`;
    };

    test('a kind nothing emits is refused', async () => {
      await assert.rejects(row({ kind: 'price_went_up' }), /rwa_signals_kind/);
    });

    test('a checksummed address is refused, so identity has one spelling', async () => {
      await assert.rejects(
        row({ subject_address: '0xB200000000000000000000DEAD0000000000AD01' }),
        /rwa_signals_subject_lower/,
      );
    });

    test('a lookalike signal without the asset it resembles is refused', async () => {
      // Half a comparison renders against a blank, which is the shape that
      // gets read as an accusation.
      await assert.rejects(
        row({ official_address: null }),
        /rwa_signals_lookalike_names_official/,
      );
    });

    test('a signal cannot name one contract as both the subject and the official', async () => {
      await assert.rejects(row({ subject_address: AAPL }), /rwa_signals_official_is_not_the_subject/);
    });

    test('a row recorded before it happened is refused', async () => {
      await assert.rejects(
        row({ recorded_at: '2026-08-25T11:00:00.000Z' }),
        /rwa_signals_recorded_after_occurred/,
      );
    });

    test('facts must be an object, so a surface can read them by name', async () => {
      await assert.rejects(row({ facts: '"a string"' }), /rwa_signals_facts_object/);
    });

    test('one transition is recorded once, however often a pass re-runs', async () => {
      await row();
      await assert.rejects(row({ recorded_at: '2026-08-26T12:00:01.000Z' }), /rwa_signals_dedupe/);
    });

    test('a watch kind outside the emitted set is refused', async () => {
      await assert.rejects(
        sql!`INSERT INTO rwa_signal_watch (chain_id, kind, watching_since)
             VALUES (8453, 'vibes', now())`,
        /rwa_signal_watch_kind/,
      );
    });
  });
}
