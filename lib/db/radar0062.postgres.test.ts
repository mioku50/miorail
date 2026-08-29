import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import {
  RouteStorageConflictError,
  type SqlTemplateExecutor,
} from '../route-storage/src/index.js';

import { createDatabaseMarketRealityRadarRepositoryV1 } from '../rwa-market-reality/src/radarDatabase.js';
import { MarketRealityRadarPointV1Schema } from '../rwa-market-reality/src/radar.js';

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(
  url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url),
);
const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const UNDERLYING = 'security:isin:US67066G1040';
const POLICY = `0x${'bb'.repeat(32)}`;
let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  return cwd.endsWith('lib/db') ? resolve(cwd, 'drizzle') : resolve(cwd, 'lib', 'db', 'drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 4, prepare: false, onnotice: () => {} });
  for (const table of [
    'market_reality_radar_events',
    'market_reality_radar_state',
    'market_reality_radar_watches',
    'underlying_identity_observation',
    'representation_underlying',
    'underlying_asset',
    'issuer_representation',
    'issuer_membership_check',
    'representation_ratio_change',
    'representation_ratio',
    'official_assets',
    'official_asset_sources',
  ]) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  for (const file of [
    '0050_official_assets.sql',
    '0057_representation_ratio.sql',
    '0058_issuer_membership.sql',
    '0059_underlying_identity_and_backed.sql',
    '0062_market_reality_radar.sql',
  ]) {
    await sql.unsafe(
      (await readFile(resolve(drizzleDir(), file), 'utf8')).replaceAll('--> statement-breakpoint', ''),
    );
  }
  await sql.unsafe(`INSERT INTO underlying_asset (
    underlying_key, asset_class, canonical_name, display_symbol, identifier_scheme,
    identifier_value, source_kind, source_ref, source_hash, observed_at
  ) VALUES ('${UNDERLYING}', 'equity', 'NVIDIA Corporation', 'NVDA', 'isin',
    'US67066G1040', 'coinbase_b20_metadata', 'reviewed instrument',
    '${'aa'.repeat(32)}', '2026-08-28T06:00:00.000Z')`);
  await sql.unsafe(`INSERT INTO representation_underlying (
    chain_id, token_address, underlying_key, source_kind, source_ref, source_hash,
    issuer_id, issuer_instrument_key, caip10, representation_kind, evidence_strength, observed_at
  ) VALUES (8453, '${TOKEN}', '${UNDERLYING}', 'coinbase_b20_metadata',
    'reviewed instrument', '${'aa'.repeat(32)}', 'coinbase',
    'coinbase:b20_address:${TOKEN}', 'eip155:8453:${TOKEN}', 'b20_asset',
    'reviewed_machine_address_mapping', '2026-08-28T06:00:00.000Z')`);
});

after(async () => sql?.end({ timeout: 5 }));

if (!throwaway) {
  describe('postgres Market Reality Radar repository', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('postgres Market Reality Radar repository', () => {
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (
        sql as unknown as (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ) => Promise<Record<string, unknown>[]>
      )(strings, ...values);
    const repository = createDatabaseMarketRealityRadarRepositoryV1(executor);
    const question = (requestedCashAtomic: string) => ({
      underlyingKey: UNDERLYING,
      tokenAddress: TOKEN,
      direction: 'sell' as const,
      requestedCashAtomic,
      destination: 'USDC' as const,
      routePolicyKey: POLICY,
      approvedSources: ['kyberswap'],
    });

    test('round-trips a cursor and tenant-scoped event, then cascades on removal', async () => {
      const watch = await repository.addWatch({
        userId: 'radar-owner',
        question: question('1000000000'),
        issuerId: 'coinbase',
        representationKind: 'b20_asset',
        now: '2026-08-28T06:00:00.000Z',
      });
      const baseline = MarketRealityRadarPointV1Schema.parse({
        snapshotHash: `0x${'11'.repeat(32)}`,
        observationHash: `0x${'12'.repeat(32)}`,
        tokenAddress: TOKEN,
        direction: 'sell',
        requestedCashAtomic: '1000000000',
        destination: 'USDC',
        routePolicyKey: POLICY,
        approvedSources: ['kyberswap'],
        status: 'no_route',
        source: 'kyberswap',
        observedAt: '2026-08-28T07:00:00.000Z',
        returnedCashAtomic: null,
        effectivePriceAtomic: null,
        effectivePriceDecimals: null,
        reference: {
          status: 'unknown',
          marketSession: 'unknown',
          publicationMode: 'unknown',
          freshness: 'unknown',
          reasonCode: 'not_reviewed',
        },
        ratio: null,
      });
      await repository.recordEvaluation({
        watch,
        at: '2026-08-28T07:01:00.000Z',
        outcome: 'baseline',
        point: baseline,
        events: [],
      });
      const next = MarketRealityRadarPointV1Schema.parse({
        ...baseline,
        snapshotHash: `0x${'21'.repeat(32)}`,
        observationHash: `0x${'22'.repeat(32)}`,
        status: 'quoted',
        observedAt: '2026-08-28T07:30:00.000Z',
        returnedCashAtomic: '995800000',
      });
      const event = {
        eventId: `0x${'31'.repeat(32)}`,
        watchId: watch.watchId,
        chainId: 8453 as const,
        tokenAddress: TOKEN,
        kind: 'route_became_available' as const,
        previousSnapshotHash: baseline.snapshotHash,
        snapshotHash: next.snapshotHash,
        previousObservedAt: baseline.observedAt,
        occurredAt: next.observedAt,
        approvedSources: ['kyberswap'],
        facts: { previousStatus: 'no_route' as const, status: 'quoted' as const, source: 'kyberswap' },
      };
      await repository.recordEvaluation({
        watch,
        at: '2026-08-28T07:31:00.000Z',
        outcome: 'compared',
        point: next,
        events: [event],
      });
      assert.deepEqual(await repository.pointForWatch({ watchId: watch.watchId }), next);
      assert.deepEqual(await repository.eventsForUser({ userId: 'radar-owner', limit: 10 }), [event]);
      assert.deepEqual(await repository.eventsForUser({ userId: 'another-tenant', limit: 10 }), []);
      assert.equal(
        await repository.removeWatch({ userId: 'another-tenant', watchId: watch.watchId }),
        false,
      );
      assert.equal(await repository.removeWatch({ userId: 'radar-owner', watchId: watch.watchId }), true);
      assert.equal(await repository.pointForWatch({ watchId: watch.watchId }), null);
    });

    test('the database-backed allocator cannot exceed 25 watches for a tenant', async () => {
      for (let index = 1; index <= 25; index += 1) {
        await repository.addWatch({
          userId: 'capacity-owner',
          question: question(String(2_000_000 + index)),
          issuerId: 'coinbase',
          representationKind: 'b20_asset',
          now: `2026-08-28T06:${String(index).padStart(2, '0')}:00.000Z`,
        });
      }
      await assert.rejects(
        () =>
          repository.addWatch({
            userId: 'capacity-owner',
            question: question('3000000'),
            issuerId: 'coinbase',
            representationKind: 'b20_asset',
            now: '2026-08-28T06:30:00.000Z',
          }),
        RouteStorageConflictError,
      );
      assert.equal((await repository.watchesForUser({ userId: 'capacity-owner' })).length, 25);
    });
  });
}
