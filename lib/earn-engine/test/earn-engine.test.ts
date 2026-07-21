import test from 'node:test';
import assert from 'node:assert/strict';
import { hashEarnRouteIntentV1, type EarnRouteIntentV1 } from '@mioagent/route-domain';
import {
  compareEarnRoutesV1,
  createCuratedEarnDataSourceV1,
  selectEarnProtocolsV1,
  type EarnDataSourceObserveInput,
  type EarnDataSourceV1,
  type EarnObservationResultV1,
} from '../src/index.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WALLET = '0x1111111111111111111111111111111111111111';
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const T0 = '2026-07-21T10:00:00.000Z';
const NOW = new Date('2026-07-21T12:00:00.000Z');

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
    id: 'intent-1',
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

function fakeSource(build: (input: EarnDataSourceObserveInput) => EarnObservationResultV1): EarnDataSourceV1 {
  return { id: 'fake', async observe(input) { return build(input); } };
}

test('best_net_yield ranks Morpho above Moonwell and recommends it', async () => {
  const result = await compareEarnRoutesV1(
    { dataSource: createCuratedEarnDataSourceV1() },
    { intent: buildIntent({ optimizationMode: 'best_net_yield' }), now: NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.routeCard.status, 'ready');
  assert.equal(result.routeCard.comparisons.length, 2);
  const rec = result.routeCard.comparisons.find(
    (c) => c.candidate.candidateHash === result.routeCard.recommendedCandidateHash,
  );
  assert.equal(rec?.candidate.protocol, 'morpho');
  assert.equal(Number.isInteger(rec?.candidate.netApyBps), true);
  // ranked order: morpho first
  assert.equal(result.routeCard.comparisons[0].candidate.protocol, 'morpho');
});

test('lowest_risk degrades with NO recommendation (no contract-risk evidence)', async () => {
  const result = await compareEarnRoutesV1(
    { dataSource: createCuratedEarnDataSourceV1() },
    { intent: buildIntent({ optimizationMode: 'lowest_risk' }), now: NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.routeCard.status, 'degraded');
  assert.equal(result.routeCard.recommendedCandidateHash, null);
  assert.equal(result.routeCard.recommendationReason, null);
  assert.ok(result.routeCard.degradedReason);
  for (const c of result.routeCard.comparisons) {
    const safety = c.score.dimensions.find((d) => d.dimension === 'transaction_safety');
    assert.equal(safety?.status, 'not_scored');
    assert.deepEqual(safety?.missingEvidence, ['contract_risk']);
  }
});

test('explicit protocol constraint restricts candidates', async () => {
  assert.deepEqual(selectEarnProtocolsV1({ mode: 'any', protocols: [] }), ['moonwell', 'morpho']);
  assert.deepEqual(selectEarnProtocolsV1({ mode: 'include_only', protocols: ['moonwell'] }), ['moonwell']);
  assert.deepEqual(selectEarnProtocolsV1({ mode: 'exclude', protocols: ['morpho'] }), ['moonwell']);

  const result = await compareEarnRoutesV1(
    { dataSource: createCuratedEarnDataSourceV1() },
    { intent: buildIntent({ protocolConstraint: { mode: 'include_only', protocols: ['moonwell'] } }), now: NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.routeCard.comparisons.length, 1);
  assert.equal(result.routeCard.comparisons[0].candidate.protocol, 'moonwell');
});

test('stale APY is excluded from ranking (best_net_yield degrades when all stale)', async () => {
  const stale = fakeSource((input) => ({
    ok: true,
    observation: {
      baseApyBps: 500,
      rewardApyBps: 0,
      netApyBps: 500,
      availableLiquidityAtomic: '100000000000',
      fees: { performanceFeeBps: 0, managementFeeBps: 0 },
      withdrawalTerms: { model: input.venue.withdrawalModel, instant: true, noticePeriodSeconds: null },
      blockNumber: null,
      observedAt: '2026-07-21T11:00:00.000Z',
      expiresAt: '2026-07-21T11:05:00.000Z', // expired well before NOW (12:00)
      requestHash: `0x${'1'.repeat(64)}`,
      responseHash: `0x${'2'.repeat(64)}`,
      sourceIndependence: 'overlapping',
      providerId: 'stale-src',
      providerDisplayName: 'Stale',
    },
  }));
  const result = await compareEarnRoutesV1({ dataSource: stale }, { intent: buildIntent({ optimizationMode: 'best_net_yield' }), now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.routeCard.status, 'degraded');
  assert.equal(result.routeCard.recommendedCandidateHash, null);
  for (const c of result.routeCard.comparisons) {
    assert.equal(c.freshnessState, 'stale');
    const netYield = c.score.dimensions.find((d) => d.dimension === 'net_yield');
    assert.equal(netYield?.status, 'not_scored');
    assert.equal(netYield?.notScoredReason, 'stale_evidence');
  }
});

test('missing liquidity data => liquidity Not scored, but net yield still ranks', async () => {
  const noLiquidity = fakeSource((input) => ({
    ok: true,
    observation: {
      baseApyBps: input.protocol === 'morpho' ? 700 : 500,
      rewardApyBps: 0,
      netApyBps: input.protocol === 'morpho' ? 700 : 500,
      availableLiquidityAtomic: null,
      fees: { performanceFeeBps: 0, managementFeeBps: 0 },
      withdrawalTerms: { model: input.venue.withdrawalModel, instant: true, noticePeriodSeconds: null },
      blockNumber: null,
      observedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
      requestHash: `0x${'1'.repeat(64)}`,
      responseHash: `0x${'2'.repeat(64)}`,
      sourceIndependence: 'overlapping',
      providerId: 'noliq',
      providerDisplayName: 'NoLiq',
    },
  }));
  const result = await compareEarnRoutesV1({ dataSource: noLiquidity }, { intent: buildIntent({ optimizationMode: 'best_net_yield' }), now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.routeCard.status, 'ready'); // net yield present + fresh
  for (const c of result.routeCard.comparisons) {
    assert.equal(c.liquidityState, 'not_scored');
    const liq = c.score.dimensions.find((d) => d.dimension === 'liquidity');
    assert.equal(liq?.status, 'not_scored');
    assert.ok(c.missingEvidence.includes('liquidity'));
  }
});

test('highest_liquidity recommends the deeper venue; simplest_route prefers direct withdrawal', async () => {
  const byLiquidity = await compareEarnRoutesV1(
    { dataSource: createCuratedEarnDataSourceV1() },
    { intent: buildIntent({ optimizationMode: 'highest_liquidity' }), now: NOW },
  );
  const bySimplicity = await compareEarnRoutesV1(
    { dataSource: createCuratedEarnDataSourceV1() },
    { intent: buildIntent({ optimizationMode: 'simplest_route' }), now: NOW },
  );
  assert.equal(byLiquidity.ok && bySimplicity.ok, true);
  if (!byLiquidity.ok || !bySimplicity.ok) return;
  const liqRec = byLiquidity.routeCard.comparisons.find((c) => c.candidate.candidateHash === byLiquidity.routeCard.recommendedCandidateHash);
  const simpleRec = bySimplicity.routeCard.comparisons.find((c) => c.candidate.candidateHash === bySimplicity.routeCard.recommendedCandidateHash);
  assert.equal(liqRec?.candidate.protocol, 'moonwell'); // 4.2T > 1.8T
  assert.equal(simpleRec?.candidate.protocol, 'moonwell'); // direct withdrawal beats vault redeem
});

test('deterministic: identical inputs produce an identical route card hash', async () => {
  const intent = buildIntent({ optimizationMode: 'best_net_yield' });
  const a = await compareEarnRoutesV1({ dataSource: createCuratedEarnDataSourceV1() }, { intent, now: NOW });
  const b = await compareEarnRoutesV1({ dataSource: createCuratedEarnDataSourceV1() }, { intent, now: NOW });
  assert.equal(a.ok && b.ok, true);
  if (a.ok && b.ok) assert.equal(a.routeCard.routeCardHash, b.routeCard.routeCardHash);
});
