import { describe, test } from 'node:test';
import assert from 'node:assert';
import { ToolAggregator } from '../src/aggregator.js';
import {
  DynamicBaseMcpToolProvider,
  classifyDynamicBaseMcpTools,
} from '../src/dynamic_base_mcp.js';

function createMockClient() {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      getClient() {
        return {
          callTool: async (input: { name: string; arguments?: Record<string, unknown> }) => {
            calls.push(input);
            return {
              ok: true,
              tool: input.name,
              access_token: 'must-not-leak',
              content: [{ type: 'text', text: 'read-only result' }],
            };
          },
        };
      },
    },
  };
}

describe('DynamicBaseMcpToolProvider', () => {
  test('registers classified read-only tools and calls them through Base MCP client', async () => {
    const tools = classifyDynamicBaseMcpTools([
      {
        name: 'get_balance',
        description: 'Get wallet balance',
        inputSchema: { type: 'object', properties: { address: { type: 'string' } } },
      },
    ]);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].capability, 'read_only');

    const mockClient = createMockClient();
    const aggregator = new ToolAggregator();
    aggregator.registerProvider(new DynamicBaseMcpToolProvider(mockClient.client, tools));

    const listed = await aggregator.listTools();
    assert.deepStrictEqual(listed.map((tool) => tool.name), ['get_balance']);

    const result = await aggregator.callTool('get_balance', { address: '0xabc' });
    assert.strictEqual(result.isError, false);
    assert.strictEqual(mockClient.calls.length, 1);
    assert.strictEqual(mockClient.calls[0].name, 'get_balance');
    assert.strictEqual(result.content.includes('must-not-leak'), false);
  });

  test('does not register forbidden or unknown tools', async () => {
    const tools = classifyDynamicBaseMcpTools([
      { name: 'send_raw_transaction', description: 'Broadcast raw tx' },
      { name: 'mystery_plugin_action', description: 'Unknown action' },
    ]);
    const aggregator = new ToolAggregator();
    aggregator.registerProvider(new DynamicBaseMcpToolProvider(createMockClient().client, tools));

    const listed = await aggregator.listTools();
    assert.deepStrictEqual(listed, []);
    assert.strictEqual(aggregator.findTool('send_raw_transaction'), undefined);
    assert.strictEqual(aggregator.findTool('mystery_plugin_action'), undefined);
  });

  test('transaction-capable tools return controlled approval-required result without MCP call', async () => {
    const tools = classifyDynamicBaseMcpTools([
      { name: 'swap_tokens', description: 'Swap tokens', inputSchema: { type: 'object' } },
    ]);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].capability, 'user_confirmed_transaction');

    const mockClient = createMockClient();
    const provider = new DynamicBaseMcpToolProvider(mockClient.client, tools);
    const result = await provider.callTool('swap_tokens', { from: 'USDC', to: 'ETH' });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(JSON.parse(result.content).status, 'approval_required');
    assert.strictEqual(mockClient.calls.length, 0);
  });

  test('explicitly enabled Base MCP swap calls only the approval-mode tool', async () => {
    const tools = classifyDynamicBaseMcpTools([
      { name: 'swap', description: 'Swap tokens', inputSchema: { type: 'object' } },
    ]);
    const calls: string[] = [];
    const client = {
      getClient() {
        return {
          callTool: async ({ name }: { name: string }) => {
            calls.push(name);
            return { content: [{ type: 'text', text: JSON.stringify({ approvalUrl: 'https://wallet.base.org/approve', requestId: 'req-1' }) }] };
          },
        };
      },
    };
    const provider = new DynamicBaseMcpToolProvider(client, tools, { allowUserConfirmedSwap: true });
    const result = await provider.callTool('swap', { fromToken: 'USDC', toToken: 'ETH', amount: '1' });
    assert.equal(result.isError, false);
    assert.deepEqual(calls, ['swap']);
    assert.match(result.content, /approvalUrl/);
  });

  test('exact send_calls tools are not duplicated by dynamic provider', () => {
    const tools = classifyDynamicBaseMcpTools([
      { name: 'send_calls', description: 'Send calls' },
      { name: 'sepolia_send_calls', description: 'Send calls on Sepolia' },
      { name: 'wallet_sendCalls', description: 'Wallet sendCalls' },
    ]);
    assert.deepStrictEqual(tools, []);
  });

  test('per-user Base MCP toggles filter plugin groups', () => {
    const walletDisabled = classifyDynamicBaseMcpTools(
      [{ name: 'get_balance', description: 'Get wallet balance' }],
      { 'base_mcp:wallet': false },
    );
    assert.deepStrictEqual(walletDisabled, []);

    const allDisabled = classifyDynamicBaseMcpTools(
      [{ name: 'get_price', description: 'Get price' }],
      { base_mcp: false },
    );
    assert.deepStrictEqual(allDisabled, []);
  });
});
