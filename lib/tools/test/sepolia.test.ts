import test from 'node:test';
import assert from 'node:assert';
import { SepoliaToolProvider } from '../src/sepolia.js';

test('SepoliaToolProvider lists tools', async () => {
  const provider = new SepoliaToolProvider();
  const tools = await provider.listTools();
  assert.strictEqual(tools.length, 4);
  assert.strictEqual(tools[0].name, 'sepolia_get_balance');
  assert.strictEqual(tools[1].name, 'sepolia_get_transaction');
  assert.strictEqual(tools[2].name, 'sepolia_send_calls');
  assert.strictEqual(tools[3].name, 'sepolia_get_request_status');
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
    } as any;
  };

  t.after(() => {
    global.fetch = originalFetch;
  });

  const provider = new SepoliaToolProvider();
  const res = await provider.callTool('sepolia_send_calls', { calls: [{ to: '0x123' }] });
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
