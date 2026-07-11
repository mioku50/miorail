import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolAggregator, type ToolDef, type ToolProvider } from '@mioagent/tools';
import { detectDirectStreamRead, runDirectStreamRead, shouldPreferPartnerRuntimeRead } from './streamReadRouting.js';

class ReadProvider implements ToolProvider {
  id = 'base-mcp-dynamic';
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  tools: ToolDef[] = [
    { name: 'get_wallets', description: 'wallets', inputSchema: { type: 'object' } },
    {
      name: 'get_portfolio',
      description: 'portfolio',
      inputSchema: { type: 'object', properties: { address: { type: 'string' }, chain: { enum: ['base'] } } },
    },
    { name: 'morpho_query_vaults', description: 'vaults', inputSchema: { type: 'object' } },
  ];
  async listTools() { return this.tools; }
  findTool(name: string) { return this.tools.find((tool) => tool.name === name); }
  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    if (name === 'get_wallets') return { content: '{"wallet":"0x1111111111111111111111111111111111111111"}', isError: false };
    if (name === 'get_portfolio') return { content: '{"tokens":[{"symbol":"USDC","balance":"42.5"}]}', isError: false };
    return {
      content: JSON.stringify({
        chain: 'base',
        vaults: [{
          address: '0x3333333333333333333333333333333333333333',
          name: 'USDC Prime',
          asset: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC' },
          curator: '0x4444444444444444444444444444444444444444',
          apyPct: 5.1,
          feePct: 5,
          tvlUsd: 10_000_000,
        }],
      }),
      isError: false,
    };
  }
}

test('simple balance reads route to Base MCP and do not match recommendation language', async () => {
  assert.equal(detectDirectStreamRead('check my balance'), 'base_portfolio');
  assert.equal(detectDirectStreamRead('show my portfolio'), 'base_portfolio');
  assert.equal(detectDirectStreamRead('how much USDC do I have'), 'base_portfolio');
  assert.equal(detectDirectStreamRead('review my portfolio'), null);

  const provider = new ReadProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectStreamRead({
    message: 'how much USDC do I have',
    walletAddress: '0x2222222222222222222222222222222222222222',
    tools,
  });
  assert.equal(result?.kind, 'base_portfolio');
  assert.deepEqual(provider.calls.map((call) => call.name), ['get_portfolio']);
  assert.match(result?.content || '', /42\.5/);
  assert.deepEqual(result?.toolCalls[0].result, { status: 'success' });
});

test('Morpho USDC opportunity request uses the dedicated read-only tool', async () => {
  const provider = new ReadProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectStreamRead({
    message: 'Show available USDC vault opportunities on Morpho Base',
    tools,
  });
  assert.equal(result?.kind, 'morpho_usdc_vaults');
  assert.deepEqual(provider.calls[0], {
    name: 'morpho_query_vaults',
    args: { chain: 'base', assetSymbol: 'USDC', sort: 'tvl_desc', limit: 50 },
  });
  assert.match(result?.content || '', /USDC Prime/);
  assert.match(result?.content || '', /no deposit or transaction was prepared/i);
  assert.doesNotMatch(result?.content || '', /best|safe/i);
});

test('Moonwell read never substitutes Morpho when Moonwell tools are unavailable', async () => {
  const provider = new ReadProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);

  const result = await runDirectStreamRead({
    message: 'Show available Moonwell USDC markets on Base',
    tools,
  });

  assert.equal(result?.kind, 'partner_provider_unavailable');
  assert.equal(result?.errorCode, 'moonwell_tools_unavailable');
  assert.match(result?.content || '', /Moonwell read tools are currently unavailable/);
  assert.match(result?.content || '', /No data from another protocol was substituted/);
  assert.deepEqual(provider.calls, []);
});

test('other Base MCP partner reads prefer runtime tools while writes stay gated', () => {
  const inventory: ToolDef[] = [
    { name: 'moonwell_get_markets', description: 'markets', inputSchema: { type: 'object' } },
    { name: 'aerodrome_list_pools', description: 'pools', inputSchema: { type: 'object' } },
  ];
  assert.equal(shouldPreferPartnerRuntimeRead('Show available Moonwell markets on Base', inventory), true);
  assert.equal(shouldPreferPartnerRuntimeRead('List Aerodrome pools', inventory), true);
  assert.equal(shouldPreferPartnerRuntimeRead('Deposit 100 USDC into Moonwell', inventory), false);
});
