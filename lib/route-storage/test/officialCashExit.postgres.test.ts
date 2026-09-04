import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import { ZERO_HASH_V1 } from '@mioagent/route-domain';
import postgres from 'postgres';

import {
  CashExitMeasurementRunV1Schema,
  CashExitSourceObservationV1Schema,
  hashCashExitObservationV1,
  hashCashExitRunV1,
  type CashExitMeasurementRunV1,
} from '../src/officialCashExit.js';
import { createDatabaseOfficialCashExitRepository } from '../src/officialCashExitDatabase.js';
import type { SqlTemplateExecutor } from '../src/types.js';

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(
  url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url),
);
const TOKEN = '0xb200000000000000000000c2e324d24d7eecd1fb';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NOW = '2026-08-25T12:00:00.000Z';
let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  return cwd.endsWith('lib/route-storage')
    ? resolve(cwd, '..', 'db', 'drizzle')
    : resolve(cwd, 'lib', 'db', 'drizzle');
}

function runV1(over: { size?: string; completedAt?: string } = {}): CashExitMeasurementRunV1 {
  const size = over.size ?? '100000000';
  const completedAt = over.completedAt ?? NOW;
  const runId = hashCashExitRunV1({
    schemaVersion: 'official-cash-exit-run/v1',
    chainId: 8453,
    tokenAddress: TOKEN,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['kyberswap'],
    destinations: ['USDC'],
    startedAt: NOW,
    completedAt,
    observations: [] as never,
  });
  const quote = (
    direction: 'buy' | 'sell',
    inputAddress: string,
    outputAddress: string,
    inputAtomic: string,
    outputAtomic: string,
  ) => ({
    direction,
    inputAddress,
    outputAddress,
    inputAtomic,
    outputAtomic,
    routeKey: `route-${direction}`,
    candidateHash: `0x${direction === 'buy' ? '11' : '22'.repeat(1)}`.padEnd(
      66,
      direction === 'buy' ? '1' : '2',
    ),
    evidenceHash: `0x${direction === 'buy' ? '33' : '44'.repeat(1)}`.padEnd(
      66,
      direction === 'buy' ? '3' : '4',
    ),
    observedAt: NOW,
    expiresAt: '2026-08-25T12:01:00.000Z',
    blockNumber: '5000',
    liquiditySources: ['aerodrome-cl'],
  });
  const draft = {
    schemaVersion: 'official-cash-exit-observation/v1' as const,
    observationHash: ZERO_HASH_V1,
    runId,
    chainId: 8453 as const,
    tokenAddress: TOKEN,
    tokenSymbol: 'AAPLc',
    tokenDecimals: 8,
    scope: 'public_ladder' as const,
    tenantId: null,
    sizeKind: 'cash_equivalent' as const,
    requestedCashAtomic: size,
    requestedTokenAtomic: null,
    testedTokenAtomic: '40000000',
    destination: 'USDC' as const,
    destinationAddress: USDC,
    destinationDecimals: 6,
    source: 'kyberswap',
    status: 'full' as const,
    evidenceStrength: 'router_quote' as const,
    executionProven: false as const,
    buyQuote: quote('buy', USDC, TOKEN, '100000000', '40000000'),
    sellQuote: quote('sell', TOKEN, USDC, '40000000', '99900000'),
    errorCode: null,
    observedAt: NOW,
    expiresAt: '2026-08-25T12:01:00.000Z',
  };
  const observation = CashExitSourceObservationV1Schema.parse({
    ...draft,
    observationHash: hashCashExitObservationV1(draft),
  });
  return CashExitMeasurementRunV1Schema.parse({
    schemaVersion: 'official-cash-exit-run/v1',
    runId,
    chainId: 8453,
    tokenAddress: TOKEN,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['kyberswap'],
    destinations: ['USDC'],
    startedAt: NOW,
    completedAt,
    observations: [observation],
  });
}

before(async () => {
  if (!throwaway) return;
  // Production's shared DB client uses unprepared postgres-js queries. JSONB
  // parameters serialize differently in that mode, so this test must exercise
  // the same boundary rather than the driver's prepared-query convenience.
  sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS official_cash_exit_runs CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0052_official_cash_exit.sql'), 'utf8');
  await sql.unsafe(migration);
  const snapshotMigration = await readFile(
    resolve(drizzleDir(), '0061_market_reality_evidence_snapshot.sql'),
    'utf8',
  );
  await sql.unsafe(snapshotMigration);
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres official cash exit', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('postgres official cash exit', () => {
    test('round-trips a hash-validated exact observation without losing JSON evidence', async () => {
      const executor: SqlTemplateExecutor = (strings, ...values) =>
        (
          sql as unknown as (
            strings: TemplateStringsArray,
            ...values: unknown[]
          ) => Promise<Record<string, unknown>[]>
        )(strings, ...values);
      const repository = createDatabaseOfficialCashExitRepository(executor);
      const run = runV1();
      await repository.recordCompletedRun(run);
      await repository.recordCompletedRun(run);
      assert.deepEqual(
        await repository.latestCompletedRun({
          chainId: 8453,
          tokenAddress: TOKEN,
          scope: 'public_ladder',
        }),
        run,
      );
    });

    test('the newest run is not always the run that answers the question', async () => {
      // Measured on production 2026-09-04. The public ladder measures four
      // fixed sizes; an on-demand measurement at any other size writes its own
      // run, and the next scheduled pass then becomes the NEWEST run without
      // containing that size. A $0.10 policy established at 20:06 and 20:08 was
      // made unreachable by the four-size pass at 20:17, and the agent surface
      // began refusing `route_policy_not_established` — a sentence about a
      // policy that was in fact established, in a run this read had stopped
      // looking at.
      const executor: SqlTemplateExecutor = (strings, ...values) =>
        (
          sql as unknown as (
            strings: TemplateStringsArray,
            ...values: unknown[]
          ) => Promise<Record<string, unknown>[]>
        )(strings, ...values);
      const repository = createDatabaseOfficialCashExitRepository(executor);
      await sql!.unsafe('DELETE FROM official_cash_exit_runs');

      const onDemand = runV1({ size: '100000', completedAt: '2026-09-04T17:08:00.000Z' });
      const ladderPass = runV1({ size: '100000000', completedAt: '2026-09-04T17:17:00.000Z' });
      await repository.recordCompletedRun(onDemand);
      await repository.recordCompletedRun(ladderPass);

      const ask = (containingRequestedCashAtomic: string | null) =>
        repository.latestCompletedRun({
          chainId: 8453,
          tokenAddress: TOKEN,
          scope: 'public_ladder',
          containingRequestedCashAtomic,
        });

      // The size that only the older run measured comes back from that run.
      assert.equal((await ask('100000'))?.runId, onDemand.runId);
      // A ladder size still comes from the newest pass, so nothing regressed
      // for the four sizes the schedule always covers.
      assert.equal((await ask('100000000'))?.runId, ladderPass.runId);
      // A size nobody ever measured falls back to the newest run, so the caller
      // refuses exactly as it did before rather than reaching further back.
      assert.equal((await ask('777'))?.runId, ladderPass.runId);
      // And with no size asked for, the read is the old one to the letter.
      assert.equal((await ask(null))?.runId, ladderPass.runId);
    });

    test('the series read returns the same total order the pair reads use', async () => {
      // A series and a pair drawn from it must never disagree about which run
      // came first: `completed_at` alone lets two runs stamped in the same
      // second swap places between reads and invent a change.
      const executor: SqlTemplateExecutor = (strings, ...values) =>
        (
          sql as unknown as (
            strings: TemplateStringsArray,
            ...values: unknown[]
          ) => Promise<Record<string, unknown>[]>
        )(strings, ...values);
      const repository = createDatabaseOfficialCashExitRepository(executor);
      const run = runV1();
      await repository.recordCompletedRun(run);

      const inside = await repository.completedRunsSince({
        chainId: 8453,
        tokenAddress: TOKEN,
        scope: 'public_ladder',
        since: new Date(Date.parse(run.completedAt) - 60_000).toISOString(),
        limit: 50,
      });
      assert.deepEqual(inside, [run], 'a run inside the window is in the window');

      const outside = await repository.completedRunsSince({
        chainId: 8453,
        tokenAddress: TOKEN,
        scope: 'public_ladder',
        since: new Date(Date.parse(run.completedAt) + 60_000).toISOString(),
        limit: 50,
      });
      assert.deepEqual(outside, [], 'and outside it, it is not');
    });

    test('the series read refuses to cross the tenant boundary', async () => {
      // Same guard the other two reads carry. A history query is exactly where
      // a tenant position would leak if the check were only on the newest read.
      const executor: SqlTemplateExecutor = (strings, ...values) =>
        (
          sql as unknown as (
            strings: TemplateStringsArray,
            ...values: unknown[]
          ) => Promise<Record<string, unknown>[]>
        )(strings, ...values);
      const repository = createDatabaseOfficialCashExitRepository(executor);
      await assert.rejects(
        () =>
          repository.completedRunsSince({
            chainId: 8453,
            tokenAddress: TOKEN,
            scope: 'public_ladder',
            tenantId: 'tenant',
            since: new Date(0).toISOString(),
            limit: 10,
          }),
        /public ladder is not tenant scoped/,
      );
      await assert.rejects(
        () =>
          repository.completedRunsSince({
            chainId: 8453,
            tokenAddress: TOKEN,
            scope: 'tenant_position',
            since: new Date(0).toISOString(),
            limit: 10,
          }),
        /tenant position read requires tenantId/,
      );
    });

    test('database refuses public evidence carrying a tenant', async () => {
      await assert.rejects(
        sql!`INSERT INTO official_cash_exit_runs (
          run_id, chain_id, token_address, scope, tenant_id, approved_sources,
          destinations, started_at, completed_at, observations
        ) VALUES (
          ${`0x${'aa'.repeat(32)}`}, 8453, ${TOKEN}, 'public_ladder', 'tenant',
          '["kyberswap"]'::jsonb, '["USDC"]'::jsonb, now(), now(), '[{}]'::jsonb
        )`,
        /official_cash_exit_tenant_scope/,
      );
    });
  });
}
