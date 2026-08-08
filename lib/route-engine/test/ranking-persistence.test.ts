import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';
import { createSwapRouteEngine, RouteEnginePersistenceError } from '../src/index.js';
import {
  NOW,
  WALLET,
  makeCandidate,
  makeIntent,
  quotedAdapter,
} from './fixtures.js';

const engine = createSwapRouteEngine();

test('same Uniswap pool across direct and aggregate candidates is overlap and lowers confidence', async () => {
  const intent = makeIntent();
  const uniswap = makeCandidate(intent, 'uniswap');
  const kyber = makeCandidate(intent, 'kyberswap');
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'overlap', now: NOW, adapters: [quotedAdapter('uniswap', uniswap), quotedAdapter('kyberswap', kyber)] });
  assert.ok(result.crossCandidateOverlaps.some((overlap) => overlap.sourceKey.includes('/pool:')));
  assert.equal(result.comparisonConfidence.label, 'medium');
  assert.ok(result.comparisonConfidence.reasons.includes('overlapping_liquidity'));
});

test('same protocol with different pools does not imply overlap', async () => {
  const intent = makeIntent();
  const uniswap = makeCandidate(intent, 'uniswap', { poolAddress: '0x2222222222222222222222222222222222222222' });
  const kyber = makeCandidate(intent, 'kyberswap', { poolAddress: '0x3333333333333333333333333333333333333333' });
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'different-pools', now: NOW, adapters: [quotedAdapter('uniswap', uniswap), quotedAdapter('kyberswap', kyber)] });
  assert.deepEqual(result.crossCandidateOverlaps, []);
  assert.equal(result.comparisonConfidence.label, 'high');
});

test('unknown provenance never becomes independent merely from provider count', async () => {
  const intent = makeIntent();
  const uniswap = makeCandidate(intent, 'uniswap', { poolAddress: null, sourceIndependence: 'unknown' });
  const kyber = makeCandidate(intent, 'kyberswap', { poolAddress: null, sourceIndependence: 'unknown', sourceKey: 'eip155:8453/kyber:unknown' });
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'unknown', now: NOW, adapters: [quotedAdapter('uniswap', uniswap), quotedAdapter('kyberswap', kyber)] });
  assert.deepEqual(result.crossCandidateOverlaps, []);
  assert.equal(result.comparisonConfidence.label, 'medium');
  assert.ok(result.comparisonConfidence.reasons.includes('incomplete_provenance'));
});

test('lowest fees and simplest route use their documented deterministic ranking facts', async () => {
  const feeIntent = makeIntent({ optimizationMode: 'lowest_fees' });
  const feeUni = makeCandidate(feeIntent, 'uniswap', { gasUsd: '0.20' });
  const feeKyber = makeCandidate(feeIntent, 'kyberswap', { gasUsd: '0.80' });
  const fees = await engine.evaluate({ intent: feeIntent, walletAddress: WALLET, requestId: 'fees', now: NOW, adapters: [quotedAdapter('uniswap', feeUni), quotedAdapter('kyberswap', feeKyber)] });
  assert.equal(fees.recommendedCandidateHash, feeUni.candidateHash);

  const simpleIntent = makeIntent({ optimizationMode: 'simplest_route' });
  const simpleUni = makeCandidate(simpleIntent, 'uniswap', { callCount: 1, approvalCount: 0 });
  const simpleKyber = makeCandidate(simpleIntent, 'kyberswap', { callCount: 2, approvalCount: 1 });
  const simplest = await engine.evaluate({ intent: simpleIntent, walletAddress: WALLET, requestId: 'simple', now: NOW, adapters: [quotedAdapter('uniswap', simpleUni), quotedAdapter('kyberswap', simpleKyber)] });
  assert.equal(simplest.recommendedCandidateHash, simpleUni.candidateHash);
});

test('lowest fees refuses a comparison when any otherwise usable route lacks gas USD', async () => {
  const intent = makeIntent({ optimizationMode: 'lowest_fees' });
  const uniswap = makeCandidate(intent, 'uniswap', { gasUsd: '0.20' });
  const kyber = makeCandidate(intent, 'kyberswap', { gasUsd: null });
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'fees-gap', now: NOW, adapters: [quotedAdapter('uniswap', uniswap), quotedAdapter('kyberswap', kyber)] });
  assert.equal(result.outcome, 'degraded');
  assert.equal(result.reason, 'insufficient_rankable_candidates');
  assert.equal(result.recommendedCandidateHash, null);
});

for (const optimizationMode of ['lowest_risk', 'fastest_execution', 'mev_protected'] as const) {
  test(`${optimizationMode} returns candidates but no unsupported recommendation`, async () => {
    const intent = makeIntent({ optimizationMode });
    const uniswap = makeCandidate(intent, 'uniswap');
    const kyber = makeCandidate(intent, 'kyberswap');
    const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: optimizationMode, now: NOW, adapters: [quotedAdapter('uniswap', uniswap), quotedAdapter('kyberswap', kyber)] });
    assert.equal(result.outcome, 'degraded');
    assert.equal(result.reason, 'unsupported_optimization_evidence');
    assert.equal(result.recommendedCandidateHash, null);
    assert.equal(result.candidates.length, 2);
  });
}

test('optional in-memory persistence round-trips hashes through one route run', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const intent = makeIntent();
  const uniswap = makeCandidate(intent, 'uniswap', { poolAddress: '0x2222222222222222222222222222222222222222' });
  const kyber = makeCandidate(intent, 'kyberswap', { poolAddress: '0x3333333333333333333333333333333333333333' });
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'persist', now: NOW, adapters: [quotedAdapter('uniswap', uniswap), quotedAdapter('kyberswap', kyber)], repository });
  const candidates = await repository.listCandidates(intent.id, intent.tenantId);
  const sets = await repository.listEvidenceSets(intent.id, intent.tenantId);
  const scores = await repository.listScoreSnapshots(intent.id, intent.tenantId);
  assert.deepEqual(candidates.map((item) => item.candidateHash).sort(), result.candidates.map((item) => item.candidateHash).sort());
  assert.deepEqual(sets.map((item) => item.evidenceSetHash).sort(), result.evidenceSets.map((item) => item.evidenceSetHash).sort());
  assert.deepEqual(scores.map((item) => item.pathScoreHash).sort(), result.pathScores.map((item) => item.pathScoreHash).sort());
  assert.ok(await repository.getRouteRun(intent.id, intent.tenantId));
});

test('omitted repository performs no persistence and invalid evaluation is not persisted', async () => {
  const intent = makeIntent();
  const candidate = makeCandidate(intent, 'uniswap');
  const repository = new InMemoryRouteStorageRepository();
  await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'no-repository', now: NOW, adapters: [quotedAdapter('uniswap', candidate)] });
  assert.equal(await repository.getRouteRun(intent.id, intent.tenantId), null);

  const badEvidence = { ...candidate, candidateHash: `0x${'f'.repeat(64)}` };
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'invalid-not-persisted', now: NOW, adapters: [quotedAdapter('uniswap', badEvidence as typeof candidate)], repository });
  assert.equal(result.outcome, 'failed');
  assert.equal(await repository.getRouteRun(intent.id, intent.tenantId), null);
});

test('injected storage failure fails the evaluation instead of falling back', async () => {
  const intent = makeIntent({ protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] } });
  const candidate = makeCandidate(intent, 'uniswap');
  const repository = new InMemoryRouteStorageRepository();
  const failingRepository = {
    ...repository,
    createRouteRun: async () => {
      throw new Error('fixture storage failure');
    },
  } as unknown as InMemoryRouteStorageRepository;
  await assert.rejects(
    engine.evaluate({ intent, walletAddress: WALLET, requestId: 'storage-failure', now: NOW, adapters: [quotedAdapter('uniswap', candidate)], repository: failingRepository }),
    RouteEnginePersistenceError,
  );
});

// ---------------------------------------------------------------------------
// One unscorable route must not veto a comparison between the others.
//
// Production, every run: Aerodrome quotes on-chain and reports no USD gas
// cost, so its metric is `not_scored`. Ranking bailed out entirely if ANY
// route lacked a net result, so Aerodrome's missing valuation discarded a
// perfectly good comparison between KyberSwap and Uniswap. No ranking, no
// recommendation, no Route Card — and a Review button with nothing behind it,
// four layers away from a missing field.
//
// "No data means not scored, not an invented rating" is the rule. Not scored
// is what the unpriced route gets; it is not what the priced ones get.
// ---------------------------------------------------------------------------

test('an unpriced third route is left out of the ranking, not allowed to cancel it', async () => {
  const intent = makeIntent({ optimizationMode: 'best_net_result' });
  const uniswap = makeCandidate(intent, 'uniswap', { gasUsd: '0.20' });
  const kyber = makeCandidate(intent, 'kyberswap', { gasUsd: '0.80' });
  // Aerodrome: quoted and usable, but with no USD gas it cannot be scored.
  const aerodrome = makeCandidate(intent, 'aerodrome', { gasUsd: null });

  const result = await engine.evaluate({
    intent,
    walletAddress: WALLET,
    requestId: 'unpriced-third',
    now: NOW,
    adapters: [
      quotedAdapter('uniswap', uniswap),
      quotedAdapter('kyberswap', kyber),
      quotedAdapter('aerodrome', aerodrome),
    ],
  });

  assert.equal(result.outcome, 'ready');
  assert.equal(result.reason, 'multiple_routes_compared');
  assert.ok(result.recommendedCandidateHash, 'the two priced routes were compared');
  // All three still appear — the unscored one is reported, not hidden.
  assert.equal(result.candidates.length, 3);
  // And it is never the recommendation: it has no number to win on.
  assert.notEqual(result.recommendedCandidateHash, aerodrome.candidateHash);
});

test('with every route unpriced there is still nothing to compare', async () => {
  // The fallback must stay a fallback. Filtering is not a way to always
  // produce a ranking.
  const intent = makeIntent({ optimizationMode: 'best_net_result' });
  const uniswap = makeCandidate(intent, 'uniswap', { gasUsd: null });
  const kyber = makeCandidate(intent, 'kyberswap', { gasUsd: null });
  const result = await engine.evaluate({
    intent,
    walletAddress: WALLET,
    requestId: 'all-unpriced',
    now: NOW,
    adapters: [quotedAdapter('uniswap', uniswap), quotedAdapter('kyberswap', kyber)],
  });
  assert.equal(result.outcome, 'degraded');
  assert.equal(result.reason, 'insufficient_rankable_candidates');
  assert.equal(result.recommendedCandidateHash, null);
});
