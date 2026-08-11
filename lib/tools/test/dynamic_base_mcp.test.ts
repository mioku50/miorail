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

  test('protected transaction result stays successful and preserves sanitized request structure', async () => {
    const tools = classifyDynamicBaseMcpTools([
      { name: 'send', description: 'Send tokens', inputSchema: { type: 'object' } },
    ]);
    const client = {
      getClient() {
        return {
          callTool: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ request_id: 'send-1', access_token: 'secret-token', calldata: '0xdeadbeef' }) }],
          }),
        };
      },
    };
    const provider = new DynamicBaseMcpToolProvider(client, tools, { allowUserConfirmedSend: true });
    const result = await provider.callTool('send', { amount: '1', token: 'USDC' });
    assert.equal(result.isError, false);
    assert.match(result.content, /send-1/);
    assert.doesNotMatch(result.content, /secret-token|deadbeef/);
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

  test('T47 wallet mismatch disables wallet tools but preserves Moonwell and Morpho reads', async () => {
    const tools = classifyDynamicBaseMcpTools([
      { name: 'get_wallets', inputSchema: { type: 'object' } },
      { name: 'get_portfolio', inputSchema: { type: 'object' } },
      { name: 'get_transaction_history', inputSchema: { type: 'object' } },
      { name: 'send', inputSchema: { type: 'object' } },
      { name: 'swap', inputSchema: { type: 'object' } },
      { name: 'moonwell_get_markets', inputSchema: { type: 'object' } },
      { name: 'morpho_query_vaults', inputSchema: { type: 'object' } },
    ]);
    const mockClient = createMockClient();
    const aggregator = new ToolAggregator();
    aggregator.registerProvider(new DynamicBaseMcpToolProvider(mockClient.client, tools, {
      allowUserConfirmedSend: true,
      allowUserConfirmedSwap: true,
    }));
    aggregator.setBaseMcpWalletToolsEnabled(false);

    assert.deepStrictEqual((await aggregator.listTools()).map((tool) => tool.name), [
      'moonwell_get_markets',
      'morpho_query_vaults',
    ]);
    assert.equal((await aggregator.callTool('moonwell_get_markets', {})).isError, false);
    assert.equal((await aggregator.callTool('morpho_query_vaults', {})).isError, false);
    await assert.rejects(() => aggregator.callTool('get_portfolio', {}), /not found/);
    assert.deepStrictEqual(mockClient.calls.map((call) => call.name), ['moonwell_get_markets', 'morpho_query_vaults']);
  });
});

describe('a real result survives redaction', () => {
  function providerReturning(payload: unknown) {
    const tools = classifyDynamicBaseMcpTools([
      { name: 'get_transaction_history', description: 'History', inputSchema: { type: 'object' } },
    ]);
    const client = {
      getClient() {
        return {
          // The MCP envelope, with the payload double-encoded exactly as the
          // protocol sends it.
          callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
        };
      },
    };
    return new DynamicBaseMcpToolProvider(client, tools, {});
  }

  test('transaction fields reach the model instead of the word truncated', async () => {
    // Reported as "why is the answer so mangled": the console showed a table
    // of dots because every leaf arrived as the literal string "[truncated]".
    // The envelope plus the double-encoded text spent the whole depth budget
    // before the transactions began.
    const result = await providerReturning({
      address: '0x4de27ead5a3c9aeb58c7f812178ddde282670d70',
      transactions: [
        { hash: '0xaaa1', type: 'transfer', status: 'success', timestamp: '2026-08-11T18:00:00Z', fee: '0.000021' },
      ],
    }).callTool('get_transaction_history', { chain: 'base' });

    assert.equal(result.isError, false);
    assert.match(result.content, /0xaaa1/);
    assert.match(result.content, /transfer/);
    assert.match(result.content, /success/);
    assert.equal(result.content.includes('[truncated]'), false);
  });

  test('a secret nested below the old cutoff is still redacted, not merely hidden', async () => {
    // Raising the budget means these levels are now VISITED. They must be
    // redacted by name there, exactly as they are at the top.
    const result = await providerReturning({
      a: { b: { c: { d: { e: { access_token: 'secret-token', note: 'keep me' } } } } },
    }).callTool('get_transaction_history', {});
    assert.equal(result.content.includes('secret-token'), false);
    assert.match(result.content, /\[redacted\]/);
    assert.match(result.content, /keep me/);
  });

  test('pathological nesting still terminates', async () => {
    let deep: Record<string, unknown> = { leaf: 'bottom' };
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    const result = await providerReturning(deep).callTool('get_transaction_history', {});
    assert.equal(result.isError, false);
    assert.match(result.content, /\[truncated\]/);
    assert.equal(result.content.includes('bottom'), false);
  });
});
