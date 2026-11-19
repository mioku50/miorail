import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import { readPublicLadderNoMarketTokensV1 } from '../src/publicLadderMids.js';
import type { SqlTemplateExecutor } from '../src/types.js';

// ---------------------------------------------------------------------------
// "No market on Base yet" against real Postgres (2026-11-19): a token is named
// only when its newest public run found no route for $100 AND no identified
// pool holds it. It DROPS the two tables, so it runs only against a throwaway
// local database.
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));
let sql: ReturnType<typeof postgres> | null = null;

const drizzleDir = (): string => (process.cwd().endsWith('lib/route-storage')
  ? resolve(process.cwd(), '..', 'db', 'drizzle') : resolve(process.cwd(), 'lib', 'db', 'drizzle'));

// Synthetic tokens and pools: nothing here is a real contract.
const token = (n: number) => `0xb2${String(n).padStart(38, '0')}`;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NOW = new Date('2026-11-19T18:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
let runs = 0;

async function run(tokenAddress: string, completedAt: string, observations: Array<{ size?: string; quoted?: boolean; errorCode?: string | null }>) {
  runs += 1;
  const rows = observations.map((o) => ({ requestedCashAtomic: o.size ?? '100000000', buyQuote: o.quoted ? { outputAtomic: '1' } : null,
    sellQuote: null, errorCode: o.errorCode ?? null, status: o.quoted ? 'full' : 'measurement_failed' }));
  await sql!`INSERT INTO official_cash_exit_runs (run_id, chain_id, token_address, scope, tenant_id, approved_sources, destinations, started_at, completed_at, observations)
    VALUES (${`0x${runs.toString(16).padStart(64, '0')}`}, 8453, ${tokenAddress}, 'public_ladder', NULL, ${sql!.json(['kyberswap'])}, ${sql!.json(['USDC'])},
      ${completedAt}, ${completedAt}, ${sql!.json(rows)})`;
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS official_cash_exit_runs CASCADE');
  await sql.unsafe('DROP TABLE IF EXISTS market_venues CASCADE');
  await sql.unsafe(await readFile(resolve(drizzleDir(), '0052_official_cash_exit.sql'), 'utf8'));
  await sql.unsafe(await readFile(resolve(drizzleDir(), '0061_market_reality_evidence_snapshot.sql'), 'utf8'));
  await sql.unsafe(await readFile(resolve(drizzleDir(), '0051_market_tail.sql'), 'utf8'));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

describe('stocks nobody makes a market in on Base', { skip: !throwaway }, () => {
  test('named only with no route at $100 in the newest run and no identified pool', async () => {
    const executor = sql as unknown as SqlTemplateExecutor;
    // 1: minted, no pool, no route: named.
    await run(token(1), at(10), [{ errorCode: 'cash_size_anchor_no_route' }, { size: '1000000000', errorCode: 'cash_size_anchor_no_route' }]);
    // 2: the router does not know it yet, and no pool: named.
    await run(token(2), at(10), [{ errorCode: 'provider_unsupported_token' }]);
    // 3: no route, but a pool Miorail identified holds it (a router late to it): not named.
    await run(token(3), at(10), [{ errorCode: 'cash_size_anchor_no_route' }]);
    await sql!`INSERT INTO market_venues (chain_id, address, kind, token0, token1, first_seen_at, identified_at)
      VALUES (8453, ${`0x${'c'.repeat(40)}`}, 'paired_pool', ${token(3)}, ${USDC}, ${at(60)}, ${at(60)})`;
    // A candidate is not a pool: token 1 stays named with one beside it.
    await sql!`INSERT INTO market_venues (chain_id, address, kind, first_seen_at) VALUES (8453, ${`0x${'d'.repeat(40)}`}, 'candidate', ${at(60)})`;
    // 4: quoted (ANTc on 2026-11-19, with no pool indexed yet): not named.
    await run(token(4), at(10), [{ quoted: true }]);
    // 5: throttled: an answer about nothing, so not named.
    await run(token(5), at(10), [{ errorCode: 'cash_size_anchor_no_route' }, { errorCode: 'provider_rate_limited' }]);
    // 6: no route once, then quoted in the newest run: the newest run speaks.
    await run(token(6), at(70), [{ errorCode: 'cash_size_anchor_no_route' }]);
    await run(token(6), at(10), [{ quoted: true }]);
    // 7: quoted once, then no route in the newest run: named.
    await run(token(7), at(70), [{ quoted: true }]);
    await run(token(7), at(10), [{ errorCode: 'provider_token_unpriced' }]);
    // 8: no route, but only in a run older than the window: not named.
    await run(token(8), at(400), [{ errorCode: 'cash_size_anchor_no_route' }]);
    // 9: its newest run never asked for $100: not named.
    await run(token(9), at(10), [{ size: '1000000000', errorCode: 'cash_size_anchor_no_route' }]);

    const since = new Date(NOW.getTime() - 6 * 3_600_000);
    assert.deepEqual(await readPublicLadderNoMarketTokensV1(executor, { since }), [token(1), token(2), token(7)]);
  });
});
