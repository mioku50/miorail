import test from 'node:test';
import assert from 'node:assert';
import { SepoliaToolProvider } from '../src/sepolia.js';
import { McpSendCallsClient } from '@mioagent/mcp';

test('SepoliaToolProvider lists tools', async () => {
  const provider = new SepoliaToolProvider();
  const tools = await provider.listTools();
  assert.strictEqual(tools.length, 5);
  assert.strictEqual(tools[0].name, 'sepolia_get_balance');
  assert.strictEqual(tools[1].name, 'sepolia_get_transaction');
  assert.strictEqual(tools[2].name, 'sepolia_send_calls');
  assert.strictEqual(tools[3].name, 'sepolia_get_request_status');
  assert.strictEqual(tools[4].name, 'sepolia_simulate_transaction');
});

test('SepoliaToolProvider finds tool', () => {
  const provider = new SepoliaToolProvider();
  const tool = provider.findTool('sepolia_get_balance');
  assert.ok(tool);
  assert.strictEqual(tool.name, 'sepolia_get_balance');

  const missing = provider.findTool('unknown');
  assert.strictEqual(missing, undefined);
});

test('SepoliaToolProvider calls sepolia_send_calls with mock mcpClient', async (t) => {
  let fetchedUrl = '';
  t.mock.method(global, 'fetch', async (url: string) => {
    fetchedUrl = url;
    return { json: async () => ({ result: '0x123' }) };
  });

  const mockMcpClient = {
    sendCalls: async () => ({
      approvalUrl: 'https://mcp.base.org/approve/mcp-req-mock',
      requestId: 'mcp-req-mock'
    })
  } as unknown as McpSendCallsClient;

  const provider = new SepoliaToolProvider(mockMcpClient);
  const res = await provider.callTool('sepolia_send_calls', { chain: '84532', calls: [{ to: '0x123' }] });
  assert.strictEqual(res.isError, false);
  const parsed = JSON.parse(res.content);
  assert.strictEqual(parsed.approvalUrl, 'https://mcp.base.org/approve/mcp-req-mock');
  assert.strictEqual(parsed.requestId, 'mcp-req-mock');
  assert.strictEqual(fetchedUrl, 'https://sepolia.base.org');
});

test('SepoliaToolProvider calls sepolia_get_request_status', async () => {
  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_get_request_status', { requestId: 'req-123' });
  assert.strictEqual(res.isError, false);
  const parsed = JSON.parse(res.content);
  assert.strictEqual(parsed.status, 'confirmed');
  assert.strictEqual(parsed.requestId, 'req-123');
});

test('SepoliaToolProvider calls sepolia_simulate_transaction', async (t) => {
  t.mock.method(global, 'fetch', async () => ({ json: async () => ({ result: '0xabc' }) }));
  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_simulate_transaction', { to: '0x123' });
  assert.strictEqual(res.isError, false);
  const parsed = JSON.parse(res.content);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.result, '0xabc');
});

test('SepoliaToolProvider sepolia_send_calls validates USDC for approve', async () => {
  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_send_calls', {
    chain: '84532',
    calls: [{ to: '0xevil', data: '0x095ea7b30000' }]
  });
  assert.strictEqual(res.isError, true);
  assert.match(res.content, /Only canonical USDC on Base Sepolia is supported/);
});

test('SepoliaToolProvider sepolia_send_calls accepts USDC for approve', async (t) => {
  t.mock.method(global, 'fetch', async () => ({ json: async () => ({ result: '0x123' }) }));

  const mockMcpClient = {
    sendCalls: async () => ({
      approvalUrl: 'https://mcp.base.org/approve/mcp-req-mock',
      requestId: 'mcp-req-mock'
    })
  } as unknown as McpSendCallsClient;

  const provider = new SepoliaToolProvider(mockMcpClient);
  const res = await provider.callTool('sepolia_send_calls', {
    chain: '84532',
    calls: [{ to: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', data: '0x095ea7b30000' }]
  });
  assert.strictEqual(res.isError, false);
});

test('SepoliaToolProvider sepolia_send_calls rejects unsupported chain', async () => {
  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_send_calls', {
    chain: '1',
    calls: [{ to: '0x123' }]
  });
  assert.strictEqual(res.isError, true);
  assert.match(res.content, /Unsupported Base chain/);
});

test('SepoliaToolProvider sepolia_send_calls rejects empty calls array', async () => {
  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_send_calls', {
    chain: '84532',
    calls: []
  });
  assert.strictEqual(res.isError, true);
  assert.match(res.content, /Missing or empty calls array/);
});

test('SepoliaToolProvider sepolia_send_calls rejects malformed call object (missing to)', async () => {
  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_send_calls', {
    chain: '84532',
    calls: [{ value: '0x0' }]
  });
  assert.strictEqual(res.isError, true);
  assert.match(res.content, /Missing to address in call/);
});

test('SepoliaToolProvider sepolia_send_calls rejects when mcpClient is absent', async (t) => {
  t.mock.method(global, 'fetch', async () => ({ json: async () => ({ result: '0x123' }) }));

  const provider = new SepoliaToolProvider(); // no mcpClient passed
  const res = await provider.callTool('sepolia_send_calls', { chain: '84532', calls: [{ to: '0x123' }] });
  assert.strictEqual(res.isError, true);
  assert.strictEqual(res.content, 'Base MCP is not configured/connected. Real execution is unavailable.');
});

test('SepoliaToolProvider sepolia_send_calls fails if MCP client throws', async (t) => {
  t.mock.method(global, 'fetch', async () => ({ json: async () => ({ result: '0x123' }) }));

  const mockMcpClient = {
    sendCalls: async () => { throw new Error('MCP server down'); }
  } as unknown as McpSendCallsClient;

  const provider = new SepoliaToolProvider(mockMcpClient);
  const res = await provider.callTool('sepolia_send_calls', { chain: '84532', calls: [{ to: '0x123' }] });
  assert.strictEqual(res.isError, true);
  assert.strictEqual(res.content, 'MCP server down');
});
