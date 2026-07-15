import assert from 'node:assert/strict';
import test from 'node:test';
import { findLiquidityOverlapsV1 } from '@mioagent/route-domain';
import {
  KyberSwapRouteAdapter,
  UniswapSwapRouteAdapter,
} from '../src/index.js';
import {
  NOW,
  POOL,
  WALLET,
  kyberResponse,
  makeIntent,
  mockKyberExecutor,
  responseFetch,
  uniswapResponse,
} from './fixtures.js';

test('KyberSwap preserves Uniswap pool provenance and overlapping evidence is detected', async () => {
  const intent = makeIntent();
  const uniswap = await new UniswapSwapRouteAdapter({
    apiKey: 'fixture-key',
    fetchImpl: responseFetch(uniswapResponse(intent)),
  }).quote({ intent, walletAddress: WALLET, requestId: 'overlap-uniswap', now: NOW });
  const kyber = await new KyberSwapRouteAdapter({
    executorFactory: () => mockKyberExecutor({ status: 200, data: kyberResponse(intent) }),
  }).quote({ intent, walletAddress: WALLET, requestId: 'overlap-kyber', now: NOW });

  assert.equal(uniswap.outcome, 'quoted');
  assert.equal(kyber.outcome, 'quoted');
  if (uniswap.outcome !== 'quoted' || kyber.outcome !== 'quoted') return;
  assert.equal(uniswap.evidence[0].pools[0].address, POOL);
  assert.equal(kyber.evidence[0].pools[0].address, POOL);
  assert.equal(kyber.evidence[0].liquiditySources[0].protocol, 'uniswap-v3');
  const overlaps = findLiquidityOverlapsV1([uniswap.evidence[0], kyber.evidence[0]]);
  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0].providerIds, ['kyberswap', 'uniswap']);
});

test('provider names alone are not treated as independent evidence', async () => {
  const intent = makeIntent();
  const kyber = await new KyberSwapRouteAdapter({
    executorFactory: () => mockKyberExecutor({ status: 200, data: kyberResponse(intent) }),
  }).quote({ intent, walletAddress: WALLET, requestId: 'not-independent', now: NOW });
  assert.equal(kyber.outcome, 'quoted');
  if (kyber.outcome !== 'quoted') return;
  assert.equal(kyber.candidate.trustMetadata.sourceIndependence, 'overlapping');
  assert.notEqual(kyber.evidence[0].liquiditySources[0].sourceKey, 'kyberswap');
});

test('routes without pool addresses report sourceIndependence unknown', async () => {
  const intent = makeIntent();
  const result = await new KyberSwapRouteAdapter({
    executorFactory: () =>
      mockKyberExecutor({
        status: 200,
        data: kyberResponse(intent, { route: [[{ exchange: 'uniswap-v3' }]] }),
      }),
  }).quote({ intent, walletAddress: WALLET, requestId: 'unknown-pools', now: NOW });
  assert.equal(result.outcome, 'quoted');
  if (result.outcome !== 'quoted') return;
  assert.equal(result.evidence[0].pools.length, 0);
  assert.equal(result.candidate.trustMetadata.sourceIndependence, 'unknown');
  assert.ok(result.candidate.trustMetadata.riskFlags.includes('liquidity-pools-unknown'));
});

test('quoted candidate and evidence hashes validate and remain stable', async () => {
  const intent = makeIntent();
  const adapter = new UniswapSwapRouteAdapter({
    apiKey: 'fixture-key',
    fetchImpl: responseFetch(uniswapResponse(intent)),
  });
  const input = { intent, walletAddress: WALLET, requestId: 'stable-hashes', now: NOW } as const;
  const first = await adapter.quote(input);
  const second = await adapter.quote(input);
  assert.equal(first.outcome, 'quoted');
  assert.equal(second.outcome, 'quoted');
  if (first.outcome !== 'quoted' || second.outcome !== 'quoted') return;
  assert.equal(first.candidate.candidateHash, second.candidate.candidateHash);
  assert.equal(first.evidence[0].evidenceHash, second.evidence[0].evidenceHash);
  assert.equal(first.evidence[0].requestHash, second.evidence[0].requestHash);
  assert.equal(first.evidence[0].responseHash, second.evidence[0].responseHash);
});
