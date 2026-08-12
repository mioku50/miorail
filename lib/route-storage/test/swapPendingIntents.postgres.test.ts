import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';

import { createDatabaseSwapPendingIntentRepository } from '../src/swapPendingIntentsDatabase.js';
import { swapPendingIntentContractV1 } from './swapPendingIntents.contract.js';

// ---------------------------------------------------------------------------
// The same contract the in-memory repository is held to, run against real
// Postgres — because the CHECK constraints are half of the guarantee and a
// zod schema alone cannot prove they exist.
//
// Runs only against a THROWAWAY database named by MIOAGENT_MIGRATION_TEST_URL:
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/swapPendingIntents.postgres.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/db')) return resolve(cwd, 'drizzle');
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle');
  return resolve(cwd, 'lib', 'db', 'drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS swap_pending_intents CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0036_swap_pending_intents.sql'), 'utf8');
  const providerExpansion = await readFile(
    resolve(drizzleDir(), '0039_swap_pending_intent_providers.sql'),
    'utf8',
  );
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  await sql.unsafe(providerExpansion.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres swap pending intents', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('postgres swap pending intents: the constraints themselves', () => {
    // The shared contract cannot reach these. Every write goes through zod
    // first, so a refusal there proves the schema and says NOTHING about the
    // database — and the CHECK constraints are what protect a future writer
    // that skips the repository. These INSERT directly to make them answer.
    const columns =
      'tenant_id, wallet_address, chain_id, source_request_id, created_at, expires_at,' +
      ' amount_decimal, from_asset_symbol, to_asset_symbol, optimization_mode,' +
      ' verification_depth, protocol_mode, protocol_names, slippage_max_bps, execution_requested';
    const valid = [
      `'tenant-raw'`, `'0x1111111111111111111111111111111111111111'`, '8453', `'request-raw'`,
      `'2026-08-11T12:00:00Z'`, `'2026-08-11T12:10:00Z'`,
      `'100'`, `'USDC'`, 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL',
    ];
    const at = (index: number, value: string): string =>
      valid.map((current, position) => (position === index ? value : current)).join(', ');

    const refused: Array<[string, string]> = [
      ['another chain', at(2, '1')],
      ['an uppercase wallet', at(1, `'0x1111111111111111111111111111111111111AAA'`)],
      ['expiry before creation', at(5, `'2026-08-11T11:00:00Z'`)],
      ['an inexact amount', at(6, `'50%'`)],
      ['an untrusted asset', at(7, `'DOGE'`)],
      ['the same asset twice', `${at(7, `'ETH'`).replace(/, NULL, NULL, NULL, NULL, NULL, NULL, NULL$/, `, 'ETH', NULL, NULL, NULL, NULL, NULL, NULL`)}`],
      ['nothing grounded', at(6, 'NULL').replace(`'USDC'`, 'NULL')],
      ['an unknown optimization mode', at(9, `'cheapest_possible'`)],
      ['the default verification depth', at(10, `'standard'`)],
      ['slippage beyond 100%', at(13, '20000')],
      ['protocol mode any', at(11, `'any'`).replace(/NULL, NULL, NULL$/, `ARRAY['uniswap']::text[], NULL, NULL`)],
      ['a mode with no protocols', at(11, `'include_only'`)],
      ['protocols with no mode', at(12, `ARRAY['uniswap']::text[]`)],
      [
        'an unconstrainable protocol',
        at(11, `'exclude'`).replace(/NULL, NULL, NULL$/, `ARRAY['sushiswap']::text[], NULL, NULL`),
      ],
    ];

    for (const [why, values] of refused) {
      test(`refuses ${why}`, async () => {
        await sql!.unsafe('TRUNCATE swap_pending_intents');
        await assert.rejects(
          () => sql!.unsafe(`INSERT INTO swap_pending_intents (${columns}) VALUES (${values})`),
          `the database accepted ${why}`,
        );
      });
    }

    test('accepts the row every refusal above was derived from', async () => {
      // The control. Without it, a typo in the INSERT would make all fourteen
      // refusals pass for the wrong reason.
      await sql!.unsafe('TRUNCATE swap_pending_intents');
      await sql!.unsafe(`INSERT INTO swap_pending_intents (${columns}) VALUES (${valid.join(', ')})`);
      const rows = await sql!.unsafe('SELECT count(*)::int AS total FROM swap_pending_intents');
      assert.equal(rows[0]?.total, 1);
    });
  });

  swapPendingIntentContractV1('postgres', async () => {
    await sql!.unsafe('TRUNCATE swap_pending_intents');
    // postgres-js's tagged template is structurally wider than the executor
    // this package accepts, so it is narrowed here exactly as the other
    // suites narrow it — one seam, not a cast inside the repository.
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<Record<string, unknown>[]>)(strings, ...values);
    return { repository: createDatabaseSwapPendingIntentRepository(executor) };
  });
}
