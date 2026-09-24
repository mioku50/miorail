import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';
import { RouteIntentV1Schema, ZERO_HASH_V1, hashRouteIntentV1, type AssetRefV1, type RouteIntentV1 } from '@mioagent/route-domain';
import { resolveEarnIntentV1 } from '@mioagent/intent-engine';

import { createDatabaseRouteStorageRepository, type SqlTemplateExecutor } from '../src/index.js';
import { createRouteStorageFixtureGraph } from './fixture-graph.js';

// ---------------------------------------------------------------------------
// Every route family keeps its runs in ONE table, each with its own intent
// shape. The swap getter parses what it finds as a RouteIntentV1, so it must
// only find the goals that store one — a swap and a gift from holdings.
//
// Until 2026-09-24 the Postgres query had no goal filter: an earn run was found
// and failed to parse, and the submission path's
// `getRouteRun(...) ?? getEarnRouteRun(...)` threw before it could fall back.
// The in-memory fake returned null, so no unit test could see it.
//
// Runs only against a THROWAWAY database named by MIOAGENT_MIGRATION_TEST_URL:
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/routeRunGoal.postgres.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const TENANT = `eip155:8453:${WALLET}`;
const NVDA: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0xb20000000000000000000078ee7ce2fe4908108c',
  chainId: 8453,
  kind: 'erc20',
  address: '0xb20000000000000000000078ee7ce2fe4908108c',
  symbol: 'NVDAc',
  decimals: 8,
};

let sql: ReturnType<typeof postgres> | null = null;

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  // The columns of 0012_t51_route_storage.sql, with the goal column 0014 added
  // and the check 0072 widened. No foreign key: this suite is about the read.
  await sql.unsafe(`
    DROP TABLE IF EXISTS route_runs CASCADE;
    CREATE TABLE route_runs (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL,
      wallet_address text NOT NULL,
      chain_id integer NOT NULL,
      goal text DEFAULT 'swap' NOT NULL,
      schema_version text NOT NULL,
      status text NOT NULL,
      intent_hash text NOT NULL,
      intent_payload jsonb NOT NULL,
      idempotency_key text NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      completed_at timestamp with time zone,
      CONSTRAINT route_runs_goal_check CHECK (goal IN ('swap', 'earn', 'commerce', 'nft', 'private_ai', 'send'))
    );
    CREATE UNIQUE INDEX route_runs_user_idempotency_unique ON route_runs (user_id, idempotency_key);
  `);
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

function sendIntent(): RouteIntentV1 {
  const now = '2026-09-24T12:00:00.000Z';
  const draft: RouteIntentV1 = {
    schemaVersion: 'route-intent/v1',
    id: 'gift-send:goal-filter',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: now,
    updatedAt: now,
    status: 'ready',
    intentHash: ZERO_HASH_V1,
    goal: 'send',
    fromAsset: NVDA,
    toAsset: null,
    amount: { asset: NVDA, amountAtomic: '44227', amountDecimal: '0.00044227' },
    optimizationMode: 'simplest_route',
    verificationDepth: 'enhanced',
    protocolConstraint: { mode: 'any', protocols: [] },
    slippageConstraint: { maxBps: 0, source: 'policy' },
    executionRequested: true,
  };
  return RouteIntentV1Schema.parse({ ...draft, intentHash: hashRouteIntentV1(draft) });
}

if (!throwaway) {
  describe('postgres route run goals', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('postgres route run goals', () => {
    test('the swap getter finds a swap and a send, and never an earn run', async () => {
      const repository = createDatabaseRouteStorageRepository(sql as unknown as SqlTemplateExecutor);

      const swap = createRouteStorageFixtureGraph(TENANT, 'goal-filter', WALLET).intent;
      await repository.createRouteRun(swap, `swap:${swap.id}`);
      const send = sendIntent();
      await repository.createSendRouteRun(send, send.id);
      const resolution = resolveEarnIntentV1({
        message: 'Deposit 500 USDC for yield.',
        tenantId: TENANT,
        walletAddress: WALLET,
        now: new Date('2026-09-24T12:00:00.000Z'),
      });
      assert.equal(resolution.status, 'ready');
      if (resolution.status !== 'ready') return;
      const earn = await repository.createEarnRouteRun(resolution.intent, `earn:${resolution.intent.id}`);

      assert.equal((await repository.getRouteRun(swap.id, TENANT))?.goal, 'swap');
      assert.equal((await repository.getRouteRun(send.id, TENANT))?.goal, 'send');
      // Not found — rather than found and thrown on.
      assert.equal(await repository.getRouteRun(earn.id, TENANT), null);

      // The lookup recordBlueprintSubmissionV1 and submission recovery make.
      const run =
        (await repository.getRouteRun(earn.id, TENANT)) ?? (await repository.getEarnRouteRun(earn.id, TENANT));
      assert.equal(run?.id, earn.id);
      assert.equal(run?.intent.schemaVersion, 'earn-route-intent/v1');
    });
  });
}
