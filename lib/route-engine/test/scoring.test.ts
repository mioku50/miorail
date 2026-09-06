import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssetRefV1 } from '@mioagent/route-domain';
import { createSwapRouteEngine } from '../src/index.js';
import {
  ETH,
  NOW,
  USDC,
  WALLET,
  makeCandidate,
  makeIntent,
  quotedAdapter,
} from './fixtures.js';

const engine = createSwapRouteEngine();
const UNPRICED_TOKEN: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0x3333333333333333333333333333333333333333',
  chainId: 8453,
  kind: 'erc20',
  address: '0x3333333333333333333333333333333333333333',
  symbol: 'UNPRICED',
  decimals: 18,
};

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

test('ETH to an unpriced token without a USDC anchor never invents net-result valuation', async () => {
  const intent = makeIntent({ fromAsset: ETH, toAsset: UNPRICED_TOKEN, protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] } });
  const candidate = makeCandidate(intent, 'uniswap', { outputAtomic: '99000000000000000' });
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'no-anchor', now: NOW, adapters: [quotedAdapter('uniswap', candidate)] });
  const net = result.pathScores[0]!.dimensions.find((item) => item.dimension === 'net_result')!;
  assert.equal(net.score, null);
  assert.equal(net.notScoredReason, 'insufficient_evidence');
  assert.equal(result.netResultMetrics[0]?.valuation, 'unsupported');
});

// 2026-09-06 — the first tokenized-stock BUY through the web console.
//
// The quote anchor was gated on the output symbol being ETH or WETH, a
// stand-in for "the two pairs this product traded" written on 2026-07-15.
// Buying NVDAc with USDC fell through to `unsupported`: three live quotes,
// every one `not_scored`, and the evaluation answered
// `degraded / insufficient_rankable_candidates` — no recommendation, no Route
// Card, and a Review button with nothing behind it. The SELL side worked the
// whole time, because its output IS USDC and it never needed an anchor.
test('USDC into ANY token anchors on the quote — the pair is not an allow-list', async () => {
  // The Coinbase NVDAc shape: 8 decimals, nothing like ETH.
  const NVDAC: AssetRefV1 = {
    assetId: 'eip155:8453/erc20:0xb20000000000000000000078ee7ce2fe4908108c',
    chainId: 8453,
    kind: 'erc20',
    address: '0xb20000000000000000000078ee7ce2fe4908108c',
    symbol: 'NVDAc',
    decimals: 8,
  };
  const intent = makeIntent({ fromAsset: USDC, toAsset: NVDAC });
  // 100 USDC in (the fixture's amount) for 0.43 NVDAc out.
  const uniswap = makeCandidate(intent, 'uniswap', { outputAtomic: '43000000', gasUsd: '0.10' });
  const kyber = makeCandidate(intent, 'kyberswap', { outputAtomic: '43100000', gasUsd: '0.10' });
  const result = await evaluatePair(intent, uniswap, kyber);

  assert.ok(
    result.netResultMetrics.every((metric) => metric.valuation === 'input_usdc_quote_anchor'),
    JSON.stringify(result.netResultMetrics.map((m) => [m.valuation, m.reason ?? null])),
  );
  assert.ok(result.netResultMetrics.every((metric) => metric.status === 'computed'));
  // Two rankable candidates, so the evaluation reaches a recommendation
  // instead of `insufficient_rankable_candidates`.
  assert.equal(result.recommendedCandidateHash, kyber.candidateHash);

  // The anchor is the quote itself: 0.10 USDC of gas out of 100 USDC in is
  // 1/1000 of the output, ceilinged. 43000000 - 43000 = 42957000.
  const uni = result.netResultMetrics.find((m) => m.candidateHash === uniswap.candidateHash)!;
  assert.equal(uni.gasCostOutputAtomic, '43000');
  assert.equal(uni.netOutputAtomic, '42957000');
});

test('a zero input never reaches the anchor, and could not divide by it if it did', async () => {
  // Division by the input is how the rate is read, so a zero there is not a
  // rate of zero — it is no rate. A candidate carrying one is refused before
  // scoring, which is why this asserts an EMPTY result rather than an
  // `unsupported` metric; the guard in `metricForCandidate` is the second
  // line, kept because a BigInt division by zero throws rather than degrades.
  const intent = makeIntent({ fromAsset: USDC, toAsset: UNPRICED_TOKEN, protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] } });
  const candidate = makeCandidate(intent, 'uniswap', { outputAtomic: '99000000000000000' });
  const zeroed = { ...candidate, inputAmount: { ...candidate.inputAmount, amountAtomic: '0', amountDecimal: '0' } };
  const result = await engine.evaluate({ intent, walletAddress: WALLET, requestId: 'zero-input', now: NOW, adapters: [quotedAdapter('uniswap', zeroed)] });
  assert.equal(result.netResultMetrics.length, 0, 'a zero-input candidate is refused before it is scored');
  assert.equal(result.outcome, 'failed');
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
