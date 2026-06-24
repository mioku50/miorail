import test from 'node:test';
import assert from 'node:assert';
import { SepoliaToolProvider } from '../src/sepolia.js';

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
  assert.strictEqual(tool?.name, 'sepolia_get_balance');
});

test('SepoliaToolProvider calls sepolia_send_calls', async (t) => {
  // Mock fetch to avoid real network requests in tests
  const originalFetch = global.fetch;
  global.fetch = async () => {
    return {
      json: async () => ({
        result: '0x123'
      })
    } as unknown;
  };

  t.after(() => {
    global.fetch = originalFetch;
  });

  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_send_calls', { chain: '84532', calls: [{ to: '0x123' }] });
  assert.strictEqual(res.isError, false);
  const data = JSON.parse(res.content);
  assert.ok(data.approvalUrl);
  assert.ok(data.requestId);
});

test('SepoliaToolProvider calls sepolia_get_request_status', async () => {
  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_get_request_status', { requestId: 'req-123' });
  assert.strictEqual(res.isError, false);
  const data = JSON.parse(res.content);
  assert.strictEqual(data.status, 'confirmed');
});

test('SepoliaToolProvider calls sepolia_simulate_transaction', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const reqData = JSON.parse((options as unknown).body);
    if (reqData.method === 'eth_call') {
      return {
        json: async () => ({
          result: '0x1337'
        })
      } as unknown;
    }
    return { json: async () => ({}) } as unknown;
  };
  t.after(() => { global.fetch = originalFetch; });

  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_simulate_transaction', { to: '0xabc' });
  assert.strictEqual(res.isError, false);
  const data = JSON.parse(res.content);
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.result, '0x1337');
});

test('SepoliaToolProvider sepolia_send_calls validates USDC for approve', async () => {
  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_send_calls', {
    chain: '84532',
    calls: [{ to: '0xBAD', data: '0x095ea7b30000' }]
  });
  assert.strictEqual(res.isError, true);
  assert.ok(res.content.includes('Invalid token address'));
});

test('SepoliaToolProvider sepolia_send_calls accepts USDC for approve', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ json: async () => ({}) }) as unknown;
  t.after(() => { global.fetch = originalFetch; });

  const provider = new SepoliaToolProvider();
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
  assert.ok(res.content.includes('Unsupported chain'));
});

test('SepoliaToolProvider sepolia_send_calls rejects empty calls array', async () => {
  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_send_calls', {
    chain: '84532',
    calls: []
  });
  assert.strictEqual(res.isError, true);
  assert.ok(res.content.includes('Missing or empty calls array'));
});

test('SepoliaToolProvider sepolia_send_calls rejects malformed call object (missing to)', async () => {
  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_send_calls', {
    chain: '84532',
    calls: [{ data: '0xabc' }]
  });
  assert.strictEqual(res.isError, true);
  assert.ok(res.content.includes('Missing to address'));
});
