import assert from 'node:assert/strict';
import test from 'node:test';
import { UniswapQuoteToolProvider } from '../src/uniswap_quote.js';

test('Uniswap quote provider returns screened quote fields without calldata or transaction preparation', async () => {
  let requestBody: any;
  const provider = new UniswapQuoteToolProvider(async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      routing: 'CLASSIC',
      quote: {
        input: { amount: '100000', token: '0xusdc' },
        output: { amount: '25000000000000', token: '0xeth' },
        slippageTolerance: 0.5,
        priceImpact: 0.02,
        classicGasUseEstimateUSD: '0.0031',
        transaction: { data: '0xshould-never-leak' },
      },
      permitData: { signature: 'never-leak' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, 'test-api-key');

  const result = await provider.callTool('uniswap_quote', {
    chain: 'base', amountIn: '0.1', tokenIn: 'USDC', tokenOut: 'ETH',
    swapper: '0x1111111111111111111111111111111111111111', quoteOnly: true,
  });
  assert.equal(result.isError, false);
  const quote = JSON.parse(result.content);
  assert.equal(quote.amountIn, '0.1');
  assert.equal(quote.amountOut, '0.000025');
  assert.equal(quote.tokenIn.decimals, 6);
  assert.equal(quote.tokenOut.decimals, 18);
  assert.equal(quote.route.routing, 'CLASSIC');
  assert.equal(quote.priceImpactPct, 0.02);
  assert.equal(quote.slippagePct, 0.5);
  assert.deepEqual(quote.gasEstimate, { value: '0.0031', unit: 'USD' });
  assert.equal(quote.transactionPrepared, false);
  assert.equal(JSON.stringify(quote).includes('calldata'), false);
  assert.equal(JSON.stringify(quote).includes('should-never-leak'), false);
  assert.equal(requestBody.amount, '100000');
  assert.equal(requestBody.type, 'EXACT_INPUT');
});

test('Uniswap quote provider is unavailable without runtime API configuration', async () => {
  const provider = new UniswapQuoteToolProvider(async () => new Response(), undefined);
  assert.deepEqual(await provider.listTools(), []);
  const result = await provider.callTool('uniswap_quote', {});
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content), { errorCode: 'uniswap_quote_not_configured' });
});

test('Uniswap quote provider preserves the legacy authorization failure code', async () => {
  const provider = new UniswapQuoteToolProvider(
    async () => new Response('{}', { status: 401 }),
    'invalid-api-key',
  );
  const result = await provider.callTool('uniswap_quote', {
    chain: 'base',
    amountIn: '1',
    tokenIn: 'USDC',
    tokenOut: 'ETH',
    swapper: '0x1111111111111111111111111111111111111111',
    quoteOnly: true,
  });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content), {
    errorCode: 'uniswap_quote_authorization_failed',
  });
});
