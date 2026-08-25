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

function runV1(): CashExitMeasurementRunV1 {
  const runId = hashCashExitRunV1({
    schemaVersion: 'official-cash-exit-run/v1',
    chainId: 8453,
    tokenAddress: TOKEN,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['kyberswap'],
    destinations: ['USDC'],
    startedAt: NOW,
    completedAt: NOW,
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
    requestedCashAtomic: '100000000',
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
    completedAt: NOW,
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
