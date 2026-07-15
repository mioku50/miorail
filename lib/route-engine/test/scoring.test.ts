import assert from 'node:assert/strict';
import test from 'node:test';
import { createSwapRouteEngine } from '../src/index.js';
import {
  ETH,
  EXPIRES,
  NOW,
  USDC,
  WALLET,
  WETH,
  makeCandidate,
  makeIntent,
  quotedAdapter,
} from './fixtures.js';

const engine = createSwapRouteEngine();

async function evaluatePair(
  intent = makeIntent(),
  uniswap = makeCandidate(intent, 'uniswap'),
  kyber = makeCandidate(intent, 'kyberswap'),
) {
  return engine.evaluate({
    intent,
    walletAddress: WALLET,
    requestId: 'score-pair',
    now: NOW,
    adapters: [quotedAdapter('uniswap', uniswap), quotedAdapter('kyberswap', kyber)],
  });
}

test('net-result uses integer quote-anchored costs and deterministically recommends the winner', async () => {
  const intent = makeIntent();
  const uniswap = makeCandidate(intent, 'uniswap', { outputAtomic: '40000000000000000', gasUsd: '0.10' });
  const kyber = makeCandidate(intent, 'kyberswap', { outputAtomic: '40500000000000000', gasUsd: '0.50' });
  const result = await evaluatePair(intent, uniswap, kyber);
  assert.equal(result.recommendedCandidateHash, kyber.candidateHash);
  assert.ok(result.netResultMetrics.every((metric) => metric.status === 'computed'));
  assert.equal(result.pathScores.flatMap((score) => score.dimensions).some((dimension) => 'overallScore' in dimension), false);
});

test('gas changes can change the net-result winner', async () => {
  const intent = makeIntent();
  const uniswap = makeCandidate(intent, 'uniswap', { outputAtomic: '40000000000000000', gasUsd: '0.10' });
  const kyber = makeCandidate(intent, 'kyberswap', { outputAtomic: '40100000000000000', gasUsd: '5.00' });
  const result = await evaluatePair(intent, uniswap, kyber);
  assert.equal(result.recommendedCandidateHash, uniswap.candidateHash);
});

test('exact net tie uses deterministic provider/hash tie-breaks', async () => {
  const intent = makeIntent();
  const uniswap = makeCandidate(intent, 'uniswap', { outputAtomic: '40000000000000000', gasUsd: '0.50' });
  const kyber = makeCandidate(intent, 'kyberswap', { outputAtomic: '40000000000000000', gasUsd: '0.50' });
  const result = await evaluatePair(intent, uniswap, kyber);
  assert.equal(result.recommendedCandidateHash, kyber.candidateHash);
  assert.equal(result.pathScores.flatMap((score) => score.dimensions).filter((dimension) => dimension.dimension === 'net_result').every((dimension) => dimension.score === 100), true);
});

test('freshness and simplicity formulas are exact and safety is not requested at standard depth', async () => {
  const intent = makeIntent({ protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] } });
  const candidate = makeCandidate(intent, 'uniswap', { callCount: 3, approvalCount: 1 });
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'formulas', now: NOW, adapters: [quotedAdapter('uniswap', candidate)] });
  const dimensions = result.pathScores[0]!.dimensions;
  assert.equal(dimensions.find((item) => item.dimension === 'quote_freshness')?.score, 80);
  assert.equal(dimensions.find((item) => item.dimension === 'route_simplicity')?.score, 50);
  const safety = dimensions.find((item) => item.dimension === 'transaction_safety')!;
  assert.equal(safety.status, 'not_scored');
  assert.equal(safety.notScoredReason, 'not_requested');
  assert.deepEqual(safety.missingEvidence, []);
});

for (const verificationDepth of ['enhanced', 'maximum'] as const) {
  test(`${verificationDepth} verification exposes all safety evidence gaps`, async () => {
    const intent = makeIntent({ verificationDepth, protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] } });
    const candidate = makeCandidate(intent, 'uniswap');
    const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: verificationDepth, now: NOW, adapters: [quotedAdapter('uniswap', candidate)] });
    const set = result.evidenceSets[0]!;
    const safety = result.pathScores[0]!.dimensions.find((item) => item.dimension === 'transaction_safety')!;
    assert.equal(set.status, 'partial');
    assert.equal(safety.notScoredReason, 'insufficient_evidence');
    assert.ok(safety.missingEvidence.includes('simulation'));
    assert.ok(safety.missingEvidence.includes('contract_risk'));
    if (verificationDepth === 'maximum') assert.ok(safety.missingEvidence.includes('mev_protection'));
  });
}

test('missing gas USD produces unavailable derived evidence and Not scored net result', async () => {
  const intent = makeIntent({ protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] } });
  const candidate = makeCandidate(intent, 'uniswap', { gasUsd: null });
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'missing-gas', now: NOW, adapters: [quotedAdapter('uniswap', candidate)] });
  const gas = result.evidenceSets[0]!.records.find((record) => record.evidenceType === 'gas')!;
  const net = result.pathScores[0]!.dimensions.find((item) => item.dimension === 'net_result')!;
  assert.equal(gas.validationStatus, 'unavailable');
  assert.equal(net.score, null);
  assert.equal(net.notScoredReason, 'insufficient_evidence');
});

test('ETH to WETH without a USDC anchor never invents net-result valuation', async () => {
  const intent = makeIntent({ fromAsset: ETH, toAsset: WETH, protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] } });
  const candidate = makeCandidate(intent, 'uniswap', { outputAtomic: '99000000000000000' });
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'no-anchor', now: NOW, adapters: [quotedAdapter('uniswap', candidate)] });
  const net = result.pathScores[0]!.dimensions.find((item) => item.dimension === 'net_result')!;
  assert.equal(net.score, null);
  assert.equal(net.notScoredReason, 'insufficient_evidence');
  assert.equal(result.netResultMetrics[0]?.valuation, 'unsupported');
});

test('output USDC valuation subtracts gas USD directly in six-decimal atomic units', async () => {
  const intent = makeIntent({ fromAsset: ETH, toAsset: USDC, protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] } });
  const candidate = makeCandidate(intent, 'uniswap', { outputAtomic: '250000000', gasUsd: '0.50' });
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'output-usdc', now: NOW, adapters: [quotedAdapter('uniswap', candidate)] });
  assert.equal(result.netResultMetrics[0]?.netOutputAtomic, '249500000');
});

test('uncertain execution counts make simplicity Not scored', async () => {
  const intent = makeIntent({ protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] } });
  const candidate = makeCandidate(intent, 'uniswap', { riskFlags: ['call-count-uncertain'] });
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'uncertain', now: NOW, adapters: [quotedAdapter('uniswap', candidate)] });
  const simplicity = result.pathScores[0]!.dimensions.find((item) => item.dimension === 'route_simplicity')!;
  assert.equal(simplicity.score, null);
  assert.equal(simplicity.notScoredReason, 'insufficient_evidence');
});
