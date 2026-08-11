import assert from 'node:assert/strict';
import test from 'node:test';
import { UniswapSwapRouteAdapter } from '../src/index.js';
import {
  EXPIRES,
  NOW,
  WALLET,
  makeIntent,
  responseFetch,
  uniswapResponse,
} from './fixtures.js';

function adapterFor(payload: unknown, observe?: (url: string, init?: RequestInit) => void) {
  return new UniswapSwapRouteAdapter({
    apiKey: 'fixture-key',
    fetchImpl: responseFetch(payload, 200, observe),
    fallbackTtlMs: 30_000,
  });
}

test('Uniswap normalizes a USDC to ETH exact-input quote', async () => {
  const intent = makeIntent();
  const result = await adapterFor(uniswapResponse(intent)).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'request-uniswap-usdc-eth',
    now: NOW,
  });
  assert.equal(result.outcome, 'quoted');
  if (result.outcome !== 'quoted') return;
  assert.equal(result.candidate.provider.id, 'uniswap');
  assert.equal(result.candidate.expectedOutput.amountAtomic, '38000000000000000');
  assert.equal(result.candidate.minimumOutput.amountAtomic, '37810000000000000');
  assert.equal(result.candidate.callCount, 2);
  assert.equal(result.candidate.approvalCount, 1);
  assert.equal(result.candidate.quoteExpiresAt, EXPIRES);
  assert.equal(result.evidence[0].validationStatus, 'valid');
});

test('Uniswap normalizes an ETH to USDC quote with no approval', async () => {
  const intent = makeIntent({ from: 'ETH', to: 'USDC', amount: '0.5' });
  const result = await adapterFor(uniswapResponse(intent)).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'request-uniswap-eth-usdc',
    now: NOW,
  });
  assert.equal(result.outcome, 'quoted');
  if (result.outcome !== 'quoted') return;
  assert.equal(result.candidate.expectedOutput.amountDecimal, '1250');
  assert.equal(result.candidate.callCount, 1);
  assert.equal(result.candidate.approvalCount, 0);
});

test('Uniswap sends explicit intent slippage and derives minimum output from it', async () => {
  const intent = makeIntent({ slippageConstraint: { maxBps: 125, source: 'user' } });
  let body: Record<string, unknown> = {};
  const result = await adapterFor(uniswapResponse(intent), (_url, init) => {
    body = JSON.parse(String(init?.body));
  }).quote({ intent, walletAddress: WALLET, requestId: 'request-slippage', now: NOW });
  assert.equal(result.outcome, 'quoted');
  // A NUMBER on the wire. The string '1.25' is what this asserted before, and
  // the trade API answers 400 RequestValidationError: "slippageTolerance" must
  // be a number — so this test was pinning the exact shape that made every
  // production Uniswap quote fail.
  assert.equal(body.slippageTolerance, 1.25);
  assert.equal(typeof body.slippageTolerance, 'number');
  assert.equal(body.swapper, WALLET);
  assert.equal(body.type, 'EXACT_INPUT');
  assert.equal('apiKey' in body, false);
  if (result.outcome === 'quoted') assert.equal(result.candidate.slippage.bps, 125);
});

test('Uniswap chooses the stricter validated provider minimum output', async () => {
  const intent = makeIntent();
  const result = await adapterFor(uniswapResponse(intent, {
    minimumOutput: '37900000000000000',
  })).quote({ intent, walletAddress: WALLET, requestId: 'provider-minimum', now: NOW });
  assert.equal(result.outcome, 'quoted');
  if (result.outcome === 'quoted') {
    assert.equal(result.candidate.minimumOutput.amountAtomic, '37900000000000000');
  }
});

test('Uniswap returns not_configured when the API key is missing', async () => {
  const intent = makeIntent();
  const result = await new UniswapSwapRouteAdapter({ apiKey: '' }).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'request-no-key',
    now: NOW,
  });
  assert.deepEqual(result, {
    outcome: 'not_configured',
    provider: 'uniswap',
    errorCode: 'provider_not_configured',
    retryable: false,
  });
});

test('Uniswap timeout is normalized and never throws', async () => {
  const intent = makeIntent();
  const adapter = new UniswapSwapRouteAdapter({
    apiKey: 'fixture-key',
    fetchImpl: (async () => {
      throw new DOMException('timed out', 'AbortError');
    }) as typeof fetch,
  });
  const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'timeout', now: NOW });
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.errorCode, 'provider_timeout');
});

test('Uniswap rate limiting is normalized', async () => {
  const intent = makeIntent();
  const adapter = new UniswapSwapRouteAdapter({
    apiKey: 'fixture-key',
    fetchImpl: responseFetch({ error: 'rate limited' }, 429),
  });
  const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'rate', now: NOW });
  assert.equal(result.outcome, 'rate_limited');
  assert.equal(result.errorCode, 'provider_rate_limited');
});

test('Uniswap rejects a non-positive output without creating a candidate', async () => {
  const intent = makeIntent();
  const result = await adapterFor(uniswapResponse(intent, {
    output: { amount: '0', token: '0x0000000000000000000000000000000000000000' },
  })).quote({ intent, walletAddress: WALLET, requestId: 'invalid-output', now: NOW });
  assert.equal(result.outcome, 'invalid_response');
  // Its own code now: this refusal used to share `provider_invalid_schema`
  // with five unrelated causes, so an intermittent production refusal could
  // not be attributed. The OUTCOME is unchanged, which is what matters to the
  // engine.
  assert.equal(result.errorCode, 'provider_output_not_positive');
});

test('Uniswap rejects mismatched response assets', async () => {
  const intent = makeIntent();
  const result = await adapterFor(uniswapResponse(intent, {
    output: { amount: '1', token: '0x3333333333333333333333333333333333333333' },
  })).quote({ intent, walletAddress: WALLET, requestId: 'asset-mismatch', now: NOW });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.errorCode, 'provider_asset_mismatch');
});

test('Uniswap quote output contains no calldata, approval URL, or wallet call', async () => {
  const intent = makeIntent();
  const result = await adapterFor(uniswapResponse(intent)).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'read-only-boundary',
    now: NOW,
  });
  assert.equal(result.outcome, 'quoted');
  const serialized = JSON.stringify(result);
  assert.equal(/calldata|approvalUrl|send_calls|should-not-leak|signature/i.test(serialized), false);
});

test('Uniswap request and response hashes exclude API keys and stripped execution fields', async () => {
  const intent = makeIntent();
  const firstPayload = uniswapResponse(intent, { transaction: { data: '0xsecret-one' } });
  const secondPayload = uniswapResponse(intent, { transaction: { data: '0xsecret-two' } });
  const first = await new UniswapSwapRouteAdapter({
    apiKey: 'api-key-one',
    fetchImpl: responseFetch(firstPayload),
  }).quote({ intent, walletAddress: WALLET, requestId: 'hash-test', now: NOW });
  const second = await new UniswapSwapRouteAdapter({
    apiKey: 'api-key-two',
    fetchImpl: responseFetch(secondPayload),
  }).quote({ intent, walletAddress: WALLET, requestId: 'hash-test', now: NOW });
  assert.equal(first.outcome, 'quoted');
  assert.equal(second.outcome, 'quoted');
  if (first.outcome !== 'quoted' || second.outcome !== 'quoted') return;
  assert.equal(first.evidence[0].requestHash, second.evidence[0].requestHash);
  assert.equal(first.evidence[0].responseHash, second.evidence[0].responseHash);
});

test('Uniswap quote artifacts are deterministic with injected clock and response', async () => {
  const intent = makeIntent();
  const adapter = adapterFor(uniswapResponse(intent));
  const input = { intent, walletAddress: WALLET, requestId: 'deterministic-uniswap', now: NOW } as const;
  const first = await adapter.quote(input);
  const second = await adapter.quote(input);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// The gas field the trade API actually sends, captured live on 2026-08-08.
//
// Every fixture states `classicGasUseEstimateUSD`. The response does not
// contain it — it carries `gasFeeUSD` — so estimatedCostUsd came back null,
// the scorer marked the route `gas_usd_valuation_unavailable`, and an unscored
// route cannot be ranked. With Aerodrome unscored for the same reason that
// left one rankable candidate out of three: too few to compare, so no
// recommendation, no Route Card, and nothing to review.
//
// The suite never saw it because the fixture describes a shape that is no
// longer served.
// ---------------------------------------------------------------------------

test('Uniswap reads gasFeeUSD, the field the live response carries', async () => {
  const intent = makeIntent();
  const payload = uniswapResponse(intent) as { quote: Record<string, unknown> };
  delete payload.quote.classicGasUseEstimateUSD;
  payload.quote.gasFeeUSD = '0.0011195776733684418';

  const result = await adapterFor(payload).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'uniswap-live-gas',
    now: NOW,
  });
  assert.equal(result.outcome, 'quoted');
  if (result.outcome !== 'quoted') return;
  // Not null — a null here is what silently removed Uniswap from every
  // comparison.
  assert.equal(result.candidate.estimatedGas.estimatedCostUsd, '0.0011195776733684418');
});

test('the older field still works where a provider sends it', async () => {
  const intent = makeIntent();
  const payload = uniswapResponse(intent) as { quote: Record<string, unknown> };
  delete payload.quote.gasFeeUSD;
  payload.quote.classicGasUseEstimateUSD = '0.71';
  const result = await adapterFor(payload).quote({
    intent, walletAddress: WALLET, requestId: 'uniswap-old-gas', now: NOW,
  });
  assert.equal(result.outcome, 'quoted');
  if (result.outcome !== 'quoted') return;
  assert.equal(result.candidate.estimatedGas.estimatedCostUsd, '0.71');
});

test('with neither gas-USD field the route still quotes, unscored rather than refused', async () => {
  // A missing valuation is a scoring question, not a malformed response. The
  // adapter must not turn it into a refusal — the engine decides what an
  // unpriced route is worth.
  const intent = makeIntent();
  const payload = uniswapResponse(intent) as { quote: Record<string, unknown> };
  delete payload.quote.classicGasUseEstimateUSD;
  delete payload.quote.gasFeeUSD;
  const result = await adapterFor(payload).quote({
    intent, walletAddress: WALLET, requestId: 'uniswap-no-gas-usd', now: NOW,
  });
  assert.equal(result.outcome, 'quoted');
  if (result.outcome !== 'quoted') return;
  assert.equal(result.candidate.estimatedGas.estimatedCostUsd, null);
});
