import assert from 'node:assert/strict';
import test from 'node:test';
import { MorphoMcpToolProvider } from '../src/morpho_mcp.js';

test('Morpho provider exposes only the four approved read methods', async () => {
  const provider = new MorphoMcpToolProvider(async () => new Response('{}') as any);
  assert.deepEqual((await provider.listTools()).map((tool) => tool.name), [
    'morpho_query_vaults',
    'morpho_get_vault',
    'morpho_query_markets',
    'morpho_get_positions',
  ]);
  assert.equal(provider.findTool('morpho_prepare_deposit'), undefined);
  const denied = await provider.callTool('morpho_prepare_deposit', { chain: 'base' });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content).errorCode, 'morpho_tool_not_allowed');
});

test('Morpho provider sends fixed JSON-RPC tool calls and unwraps SSE results', async () => {
  let requestBody: any;
  const provider = new MorphoMcpToolProvider(async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      `event: message\ndata: ${JSON.stringify({
        result: { content: [{ type: 'text', text: JSON.stringify({ vaults: [{ name: 'USDC Prime', apyPct: 5.2 }] }) }] },
      })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  });

  const result = await provider.callTool('morpho_query_vaults', {
    chain: 'base',
    assetSymbol: 'USDC',
    sort: 'apy_desc',
    limit: 5,
  });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content).vaults[0].name, 'USDC Prime');
  assert.equal(requestBody.method, 'tools/call');
  assert.equal(requestBody.params.name, 'morpho_query_vaults');
  assert.deepEqual(requestBody.params.arguments, {
    chain: 'base', assetSymbol: 'USDC', sort: 'apy_desc', limit: 5,
  });
});

test('Morpho provider rejects non-Base calls before the network', async () => {
  let called = false;
  const provider = new MorphoMcpToolProvider(async () => {
    called = true;
    return new Response('{}');
  });
  const result = await provider.callTool('morpho_query_markets', { chain: 'ethereum' });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content).errorCode, 'morpho_base_only');
  assert.equal(called, false);
});
