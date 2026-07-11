import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolAggregator, type ToolDef, type ToolProvider } from '@mioagent/tools';
import { detectQuoteIntent, runDirectQuoteRead } from './streamQuoteRouting.js';

class QuoteProvider implements ToolProvider {
  id = 'uniswap-quote';
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  async listTools(): Promise<ToolDef[]> {
    return [{ name: 'uniswap_quote', description: 'quote', inputSchema: { type: 'object' } }];
  }
  findTool(name: string) { return name === 'uniswap_quote' ? { name, description: 'quote', inputSchema: { type: 'object' } } : undefined; }
  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    return {
      content: JSON.stringify({
        quoteOnly: true,
        chainId: 8453,
        amountIn: '0.1', amountOut: '0.000025',
        tokenIn: { symbol: 'USDC', decimals: 6 },
        tokenOut: { symbol: 'ETH', decimals: 18 },
        route: { provider: 'Uniswap', routing: 'CLASSIC', path: ['USDC', 'ETH'] },
        priceImpactPct: 0.02, slippagePct: 0.5,
        gasEstimate: { value: '0.0031', unit: 'USD' },
        transactionPrepared: false,
      }),
      isError: false,
    };
  }
}

test('quote intent is read-only and parses amount, pair, and optional slippage', () => {
  assert.deepEqual(detectQuoteIntent('quote 0.1 USDC to ETH'), {
    quoteOnly: true, amountIn: '0.1', tokenIn: 'USDC', tokenOut: 'ETH',
  });
  assert.equal(detectQuoteIntent('show route/slippage/gas for 0.1 USDC to ETH')?.quoteOnly, true);
  assert.equal(detectQuoteIntent('swap 0.1 USDC to ETH'), null);
});

test('direct Uniswap quote returns screened fields and no transaction material', async () => {
  const provider = new QuoteProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectQuoteRead({
    message: 'quote 0.1 USDC to ETH with slippage 0.5%',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tools,
  });
  assert.equal(result?.kind, 'uniswap_quote');
  assert.equal(result?.errorCode, undefined);
  assert.deepEqual(provider.calls[0], {
    name: 'uniswap_quote',
    args: {
      chain: 'base', amountIn: '0.1', tokenIn: 'USDC', tokenOut: 'ETH',
      swapper: '0x1111111111111111111111111111111111111111', slippageTolerance: 0.5, quoteOnly: true,
    },
  });
  assert.match(result?.content || '', /amount|0\.1 USDC/i);
  assert.match(result?.content || '', /No calldata, approval, or transaction was prepared/);
});
