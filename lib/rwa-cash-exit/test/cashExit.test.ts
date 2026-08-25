import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { stableHashV1 } from '@mioagent/route-domain';
import {
  createMemoryOfficialCashExitRepository,
  type OfficialCashExitRepositoryV1,
} from '@mioagent/route-storage';
import {
  buildQuoteArtifacts,
  KYBERSWAP_PROVIDER_V1,
  type SwapAdapterResult,
  type SwapRouteAdapter,
} from '@mioagent/swap-adapters';

import { measureOfficialCashExitV1 } from '../src/measure.js';
import { assembleCashExitLadderV1 } from '../src/projection.js';

const TOKEN = '0xb2000000000000000000007bf6d5cbb0e24cb301' as const;
const WALLET = '0x1111111111111111111111111111111111111111' as const;
const NOW = new Date('2026-08-25T12:00:00.000Z');

function quoted(
  input: Parameters<SwapRouteAdapter['quote']>[0],
  outputAtomic: string,
): SwapAdapterResult {
  const requestHash = stableHashV1('test/request', { requestId: input.requestId });
  const responseHash = stableHashV1('test/response', { requestId: input.requestId, outputAtomic });
  const artifacts = buildQuoteArtifacts({
    adapterId: 'kyberswap',
    intent: input.intent,
    provider: KYBERSWAP_PROVIDER_V1,
    requestId: input.requestId,
    providerQuoteId: null,
    requestHash,
    responseHash,
    expectedOutputAtomic: outputAtomic,
    gas: {
      gasUnits: '210000',
      maxFeePerGasWei: null,
      estimatedCostNative: null,
      estimatedCostUsd: '0.05',
    },
    priceImpactBps: 10,
    observedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + 30_000).toISOString(),
    blockNumber: '35000000',
    provenance: { pools: [], liquiditySources: [] },
    riskFlags: ['aggregated-route'],
    usesExternalAggregators: true,
    sourceIndependence: 'unknown',
  });
  return { outcome: 'quoted', candidate: artifacts.candidate, evidence: [artifacts.evidence] };
}

function adapterV1(): SwapRouteAdapter {
  return {
    id: 'kyberswap',
    supports: () => true,
    async quote(input) {
      const from = input.intent.fromAsset!;
      const to = input.intent.toAsset!;
      const amount = input.intent.amount.amountAtomic;
      if (from.symbol === 'USDC') {
        if (amount === '100000000') return quoted(input, '100000000');
        if (amount === '1000000000') return quoted(input, '1000000000');
        if (amount === '10000000000') return quoted(input, '10000000000');
        return {
          outcome: 'unavailable',
          provider: 'kyberswap',
          errorCode: 'provider_no_route',
          retryable: false,
        };
      }
      if (amount === '10000000000') {
        return {
          outcome: 'unavailable',
          provider: 'kyberswap',
          errorCode: 'provider_no_route',
          retryable: false,
        };
      }
      const output =
        to.symbol === 'USDC'
          ? ((BigInt(amount) * 99n) / 100n).toString()
          : (BigInt(amount) * 300_000_000n).toString();
      return quoted(input, output);
    },
  };
}

async function publicRun(repository: OfficialCashExitRepositoryV1) {
  return measureOfficialCashExitV1({
    repository,
    adapters: [adapterV1()],
    token: { address: TOKEN, symbol: 'AAPLc', decimals: 8 },
    walletAddress: WALLET,
    tenantId: `eip155:8453:${WALLET}`,
    scope: 'public_ladder',
    now: () => NOW,
  });
}

describe('official cash-exit ladder', () => {
  test('keeps exact quote evidence separate from unrun simulation and never interpolates', async () => {
    const repository = createMemoryOfficialCashExitRepository();
    const run = await publicRun(repository);
    const ladder = assembleCashExitLadderV1({ publicRun: run, now: NOW });
    const usdc = ladder.rungs.filter((rung) => rung.destination === 'USDC');
    assert.deepEqual(
      usdc.map((rung) => rung.status),
      ['full', 'full', 'partial', 'measurement_failed'],
    );
    assert.equal(usdc[2]!.lowerBoundRequestedCashAtomic, '1000000000');
    assert.equal(usdc[2]!.exactExecutableTokenAtomic, '1000000000');
    assert.equal(usdc[2]!.interpolated, false);
    assert.equal(usdc[2]!.derivedFromExactRung, true);
    assert.equal(usdc[0]!.quoteEvidence[0]?.kind, 'router_quote');
    assert.deepEqual(usdc[0]!.simulationEvidence, {
      status: 'not_simulated',
      kind: 'route_simulation',
      candidateHash: null,
      evidenceHash: null,
      observedAt: null,
      blockNumber: null,
    });
    assert.equal(usdc[0]!.executionProven, false);
    assert.ok(!JSON.stringify(ladder).match(/calldata|approval/i));
  });

  test('a buy-side venue miss is a sizing failure, never an asset unavailable claim', async () => {
    const run = await publicRun(createMemoryOfficialCashExitRepository());
    const hundredThousand = run.observations.filter(
      (row) => row.requestedCashAtomic === '100000000000',
    );
    assert.ok(hundredThousand.every((row) => row.status === 'measurement_failed'));
    assert.ok(hundredThousand.every((row) => row.errorCode === 'cash_size_anchor_no_route'));
  });

  test('actual-position no-route can be unavailable only after the approved router answers', async () => {
    const repository = createMemoryOfficialCashExitRepository();
    const noRoute: SwapRouteAdapter = {
      id: 'kyberswap',
      supports: () => true,
      quote: async () => ({
        outcome: 'unavailable',
        provider: 'kyberswap',
        errorCode: 'provider_no_route',
        retryable: false,
      }),
    };
    const run = await measureOfficialCashExitV1({
      repository,
      adapters: [noRoute],
      token: { address: TOKEN, symbol: 'AAPLc', decimals: 8 },
      walletAddress: WALLET,
      tenantId: `eip155:8453:${WALLET}`,
      scope: 'tenant_position',
      positionTokenAtomic: '123456789',
      now: () => NOW,
    });
    assert.ok(run.observations.every((row) => row.status === 'unavailable'));
    const ladder = assembleCashExitLadderV1({ publicRun: null, positionRun: run, now: NOW });
    assert.ok(ladder.rungs.every((rung) => rung.status === 'unavailable'));
  });

  test('provider failure remains measurement_failed and expires to not_measured', async () => {
    const failed: SwapRouteAdapter = {
      id: 'kyberswap',
      supports: () => true,
      quote: async () => ({
        outcome: 'timeout',
        provider: 'kyberswap',
        errorCode: 'provider_timeout',
        retryable: true,
      }),
    };
    const run = await measureOfficialCashExitV1({
      repository: createMemoryOfficialCashExitRepository(),
      adapters: [failed],
      token: { address: TOKEN, symbol: 'AAPLc', decimals: 8 },
      walletAddress: WALLET,
      tenantId: `eip155:8453:${WALLET}`,
      scope: 'tenant_position',
      positionTokenAtomic: '1',
      now: () => NOW,
    });
    const fresh = assembleCashExitLadderV1({ publicRun: null, positionRun: run, now: NOW });
    assert.ok(fresh.rungs.every((rung) => rung.status === 'measurement_failed'));
    const stale = assembleCashExitLadderV1({
      publicRun: null,
      positionRun: run,
      now: new Date(NOW.getTime() + 61_000),
    });
    assert.ok(stale.rungs.every((rung) => rung.status === 'not_measured'));
  });
});
