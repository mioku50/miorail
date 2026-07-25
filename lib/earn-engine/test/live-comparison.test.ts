import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashEarnRouteIntentV1, type EarnRouteIntentV1 } from '@mioagent/route-domain';
import {
  MORPHO_GRAPHQL_ENDPOINT_V1,
  PINNED_BASE_USDC_V1,
  compareEarnRoutesV1,
  createLiveEarnDataSourceV1,
  pinnedEarnVenueV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T63A §4/§7 — the whole earn pipeline on LIVE-shaped data: intent → live
// Moonwell + Morpho readings → validated evidence → deterministic comparison →
// Earn Route Card. Both providers are served from recorded payloads through an
// injected fetch; the global fetch is a detonator, so a regression that reaches
// the network fails here instead of in production.
// ---------------------------------------------------------------------------

globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

const USDC = PINNED_BASE_USDC_V1;
const WALLET = '0x1111111111111111111111111111111111111111';
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const T0 = '2026-07-25T08:00:00.000Z';
const NOW = new Date('2026-07-25T08:45:30.000Z');
const MOONWELL_OBSERVED_AT = '2026-07-25T08:45:16.841Z';
const MORPHO_OBSERVED_AT = '2026-07-25T08:45:11.000Z';

const usdcAsset = {
  assetId: `eip155:8453/erc20:${USDC}`,
  chainId: 8453 as const,
  kind: 'erc20' as const,
  address: USDC,
  symbol: 'USDC',
  decimals: 6,
};
const amount = { asset: usdcAsset, amountAtomic: '500000000', amountDecimal: '500' };

function buildIntent(overrides: Partial<EarnRouteIntentV1> = {}): EarnRouteIntentV1 {
  const draft = {
    schemaVersion: 'earn-route-intent/v1',
    id: 'intent-live-1',
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: T0,
    updatedAt: T0,
    status: 'ready',
    intentHash: ZERO_HASH,
    goal: 'earn',
    asset: usdcAsset,
    amount,
    optimizationMode: 'best_net_yield',
    verificationDepth: 'standard',
    protocolConstraint: { mode: 'any', protocols: [] },
    executionRequested: false,
    ...overrides,
  } as EarnRouteIntentV1;
  return { ...draft, intentHash: hashEarnRouteIntentV1(draft) };
}

const MOONWELL_PAYLOAD = {
  success: true,
  data: [
    {
      asset: 'USDC',
      assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      mToken: 'mUSDC',
      mTokenAddress: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22',
      deprecated: false,
      // 5.20% base + incentives to 5.80% total.
      baseSupplyApy: 5.2,
      totalSupplyApr: 5.8,
      liquidityUsd: 1214587.9,
    },
  ],
  meta: { command: 'markets', chain: 'eip155:8453', timestamp: MOONWELL_OBSERVED_AT },
};

const MORPHO_PAYLOAD = {
  data: {
    vaultByAddress: {
      address: '0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca',
      name: 'Moonwell Flagship USDC',
      symbol: 'mwUSDC',
      chain: { id: 8453 },
      asset: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
      state: {
        timestamp: Math.floor(Date.parse(MORPHO_OBSERVED_AT) / 1000),
        blockNumber: 49089882,
        // 6.50% net, of which 0.60% is incentives → clearly above Moonwell.
        netApy: 0.065,
        netApyExcludingRewards: 0.059,
        fee: 0.15,
        totalAssets: 9542636897974,
        allRewards: [{ supplyApr: 0.006 }],
      },
      liquidity: { underlying: 9542636897974 },
    },
  },
};

type ProviderState = 'ok' | 'down';

function routedFetch(moonwell: ProviderState, morpho: ProviderState, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    const target = String(url);
    calls.push(target);
    const state = target.startsWith(MORPHO_GRAPHQL_ENDPOINT_V1) ? morpho : moonwell;
    if (state === 'down') throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const payload = target.startsWith(MORPHO_GRAPHQL_ENDPOINT_V1) ? MORPHO_PAYLOAD : MOONWELL_PAYLOAD;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function liveSource(moonwell: ProviderState = 'ok', morpho: ProviderState = 'ok', calls: string[] = []) {
  return createLiveEarnDataSourceV1({
    fetchImpl: routedFetch(moonwell, morpho, calls),
    chainReader: {
      async readMoonwellMarketSnapshot() {
        return {
          blockNumber: '49089880',
          underlyingAsset: PINNED_BASE_USDC_V1,
          availableLiquidityAtomic: '1214587904145',
        };
      },
    },
    // Disable the cache for the comparison tests so each case observes fresh.
    cache: { ttlMs: 0, errorTtlMs: 0, staleServeMs: 0 },
  });
}

describe('T63A live earn comparison', () => {
  test('both providers live → ranked comparison backed by verifiable evidence', async () => {
    const calls: string[] = [];
    const result = await compareEarnRoutesV1(
      { dataSource: liveSource('ok', 'ok', calls) },
      { intent: buildIntent(), now: NOW },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.routeCard.status, 'ready');
    assert.equal(result.failures.length, 0);
    assert.equal(result.routeCard.comparisons.length, 2);
    // Morpho's 6.50% net beats Moonwell's 5.80%.
    const recommended = result.routeCard.comparisons.find(
      (comparison) => comparison.candidate.candidateHash === result.routeCard.recommendedCandidateHash,
    );
    assert.equal(recommended?.candidate.protocol, 'morpho');
    assert.equal(recommended?.candidate.netApyBps, 650);

    const moonwell = result.entries.find((entry) => entry.candidate.protocol === 'moonwell')!;
    const morpho = result.entries.find((entry) => entry.candidate.protocol === 'morpho')!;

    // Evidence carries live provenance, per provider.
    assert.equal(moonwell.evidence.provider.id, 'moonwell-api-v1');
    assert.equal(moonwell.evidence.provider.operator, 'Moonwell');
    assert.equal(moonwell.evidence.blockNumber, '49089880');
    assert.equal(moonwell.evidence.observedAt, MOONWELL_OBSERVED_AT);
    assert.equal(moonwell.evidence.availableLiquidityAtomic, '1214587904145');
    assert.equal(moonwell.evidence.baseApyBps, 520);
    assert.equal(moonwell.evidence.rewardApyBps, 60);

    assert.equal(morpho.evidence.provider.id, 'morpho-api-v1');
    assert.equal(morpho.evidence.blockNumber, '49089882');
    assert.equal(morpho.evidence.observedAt, MORPHO_OBSERVED_AT);
    assert.equal(morpho.evidence.baseApyBps, 590);
    assert.equal(morpho.evidence.rewardApyBps, 60);
    assert.equal(morpho.evidence.fees.performanceFeeBps, 1500);
    assert.equal(morpho.evidence.withdrawalTerms.model, 'vault_redeem');

    for (const entry of result.entries) {
      // Pinned binding survives into the persisted artefacts.
      assert.equal(entry.evidence.contracts.asset, PINNED_BASE_USDC_V1);
      assert.equal(entry.evidence.contracts.target, pinnedEarnVenueV1(entry.candidate.protocol).target);
      assert.equal(entry.candidate.chainId, 8453);
      assert.match(entry.evidence.requestHash, /^0x[0-9a-f]{64}$/);
      assert.match(entry.evidence.responseHash, /^0x[0-9a-f]{64}$/);
      for (const bps of [entry.candidate.baseApyBps, entry.candidate.rewardApyBps, entry.candidate.netApyBps]) {
        assert.equal(bps === null || Number.isInteger(bps), true);
      }
    }
    // Read-only: one call per provider, nothing else.
    assert.equal(calls.length, 2);
  });

  test('one provider unavailable → degraded card: the reading is shown, no "best route" is claimed', async () => {
    const result = await compareEarnRoutesV1(
      { dataSource: liveSource('ok', 'down') },
      { intent: buildIntent(), now: NOW },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.routeCard.status, 'degraded');
    assert.equal(result.routeCard.recommendedCandidateHash, null);
    assert.equal(result.routeCard.recommendationReason, null);
    assert.match(String(result.routeCard.degradedReason), /Morpho/);
    assert.match(String(result.routeCard.degradedReason), /cannot establish a best route/);
    // The available venue is still compared, with its data intact.
    assert.equal(result.routeCard.comparisons.length, 1);
    assert.equal(result.routeCard.comparisons[0].candidate.protocol, 'moonwell');
    assert.equal(result.routeCard.comparisons[0].candidate.netApyBps, 580);
    assert.deepEqual(
      result.failures.map((failure) => [failure.protocol, failure.reason]),
      [['morpho', 'provider_timeout']],
    );
  });

  test('both providers unavailable → failed comparison, no card at all', async () => {
    const result = await compareEarnRoutesV1(
      { dataSource: liveSource('down', 'down') },
      { intent: buildIntent(), now: NOW },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'all_providers_unavailable');
    assert.deepEqual(result.failures.map((failure) => failure.protocol).sort(), ['moonwell', 'morpho']);
  });

  test('a deliberately narrowed comparison is NOT degraded by the availability rule', async () => {
    const result = await compareEarnRoutesV1(
      { dataSource: liveSource('ok', 'ok') },
      { intent: buildIntent({ protocolConstraint: { mode: 'include_only', protocols: ['moonwell'] } }), now: NOW },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.routeCard.comparisons.length, 1);
    assert.equal(result.routeCard.status, 'ready');
    assert.equal(result.routeCard.recommendedCandidateHash, result.routeCard.comparisons[0].candidate.candidateHash);
  });

  test('stale provider readings are shown but never ranked', async () => {
    const stale = createLiveEarnDataSourceV1({
      fetchImpl: routedFetch('ok', 'ok'),
      // A 1s freshness window makes both recorded readings older than the window.
      freshnessTtlMs: 1_000,
      cache: { ttlMs: 0, errorTtlMs: 0, staleServeMs: 0 },
    });
    const result = await compareEarnRoutesV1({ dataSource: stale }, { intent: buildIntent(), now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.routeCard.status, 'degraded');
    assert.equal(result.routeCard.recommendedCandidateHash, null);
    // The PERSISTED evidence records say stale too — not just the projection.
    assert.deepEqual(
      result.entries.map((entry) => entry.evidence.status),
      ['stale', 'stale'],
    );
    for (const comparison of result.routeCard.comparisons) {
      assert.equal(comparison.freshnessState, 'stale');
      const netYield = comparison.score.dimensions.find((dimension) => dimension.dimension === 'net_yield');
      assert.equal(netYield?.status, 'not_scored');
      assert.equal(netYield?.notScoredReason, 'stale_evidence');
      // Still shown: the APY the provider reported is not erased.
      assert.equal(Number.isInteger(comparison.apyComposition.netApyBps), true);
    }
  });

  test('APY ranking is deterministic: identical live payloads produce an identical card hash', async () => {
    const intent = buildIntent();
    const first = await compareEarnRoutesV1({ dataSource: liveSource() }, { intent, now: NOW });
    const second = await compareEarnRoutesV1({ dataSource: liveSource() }, { intent, now: NOW });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.routeCard.routeCardHash, second.routeCard.routeCardHash);
    assert.deepEqual(
      first.ranking.orderedCandidateHashes,
      second.ranking.orderedCandidateHashes,
    );
    assert.deepEqual(
      first.routeCard.comparisons.map((comparison) => comparison.candidate.protocol),
      ['morpho', 'moonwell'],
    );
  });

  test('highest_liquidity ranks on the atomic liquidity the providers actually reported', async () => {
    const result = await compareEarnRoutesV1(
      { dataSource: liveSource() },
      { intent: buildIntent({ optimizationMode: 'highest_liquidity' }), now: NOW },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Morpho's 9.54M USDC vault beats the Moonwell market's 1.21M of cash.
    const recommended = result.routeCard.comparisons.find(
      (comparison) => comparison.candidate.candidateHash === result.routeCard.recommendedCandidateHash,
    );
    assert.equal(recommended?.candidate.protocol, 'morpho');
    assert.equal(recommended?.candidate.availableLiquidityAtomic, '9542636897974');
  });
});
