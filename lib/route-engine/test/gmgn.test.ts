import assert from 'node:assert/strict';
import test from 'node:test';
import { GmgnQuoteRouteAdapter } from '@mioagent/swap-adapters';
import { createSwapRouteEngine } from '../src/index.js';
import { makeIntent, NOW, WALLET, WETH, makeCandidate, quotedAdapter } from './fixtures.js';

function reader(status = 200) {
  const tokenIn = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const tokenOut = '0x4200000000000000000000000000000000000006';
  return new GmgnQuoteRouteAdapter({ fetchImpl: (async () => new Response(JSON.stringify({ code: 0, data: {
    input_token: tokenIn, output_token: tokenOut, input_amount: '100000000', output_amount: '38000000000000000',
    min_output_amount: '38000000000000000', slippage: 0, tx: { chain_id: 8453, from_address: WALLET,
      input_token_address: tokenIn, output_token_address: tokenOut, amount_in: '100000000', amount_out: '38000000000000000',
      amount_min_out: '38000000000000000', amount_in_decimals: 6, amount_out_decimals: 18, slippage: 0,
      deadline: NOW.getTime() / 1000 + 60 },
  } }), { status })) as typeof fetch });
}

test('GMGN reaches the quote projection through the engine and its failure keeps the provider name', async () => {
  const intent = makeIntent({ toAsset: WETH, protocolConstraint: { mode: 'include_only', protocols: ['gmgn'] } });
  const engine = createSwapRouteEngine();
  const input = { intent, walletAddress: WALLET, requestId: 'gmgn-engine', now: NOW };
  const quote = await engine.evaluate({ ...input, adapters: [reader()] });
  assert.equal(quote.outcome, 'constrained');
  assert.equal(quote.candidates.length, 1);
  assert.equal(quote.candidates[0]!.provider.id, 'gmgn');
  assert.ok(quote.candidates[0]!.trustMetadata.riskFlags.includes('quote_only'));
  const refused = await engine.evaluate({ ...input, adapters: [reader(403)] });
  assert.equal(refused.outcome, 'failed');
  assert.deepEqual(refused.candidates, []);
  assert.equal(refused.adapterFailures[0]!.provider, 'gmgn');
  assert.equal(refused.adapterFailures[0]!.errorCode, 'gmgn_http_403');
});

test('a GMGN price and an executable route cannot form an execution recommendation', async () => {
  const intent = makeIntent({ toAsset: WETH, protocolConstraint: { mode: 'include_only', protocols: ['gmgn', 'kyberswap'] } });
  const result = await createSwapRouteEngine().evaluate({ intent, walletAddress: WALLET, requestId: 'mixed-price', now: NOW,
    adapters: [reader(), quotedAdapter('kyberswap', makeCandidate(intent, 'kyberswap'))] });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.recommendedCandidateHash, null);
  assert.equal(result.outcome, 'degraded');
});
