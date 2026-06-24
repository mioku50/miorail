import test from 'node:test';
import assert from 'node:assert';
import { MockMcpToolProvider } from '../src/mock_mcp.js';

test('MockMcpToolProvider send_calls rejects unsupported chain', async () => {
  const provider = new MockMcpToolProvider();
  const res = await provider.callTool('send_calls', {
    chain: '1',
    calls: [{ to: '0x123' }]
  });
  assert.strictEqual(res.isError, true);
  assert.ok(res.content.includes('Unsupported chain'));
});

test('MockMcpToolProvider send_calls accepts Base Sepolia chain', async () => {
  const provider = new MockMcpToolProvider();
  const res = await provider.callTool('send_calls', {
    chain: '84532',
    calls: [{ to: '0x123' }]
  });
  assert.strictEqual(res.isError, false);
});

test('MockMcpToolProvider send_calls validates USDC for transfer', async () => {
  const provider = new MockMcpToolProvider();
  const res = await provider.callTool('send_calls', {
    chain: 'eip155:84532',
    calls: [{ to: '0xBAD', data: '0xa9059cbb000' }]
  });
  assert.strictEqual(res.isError, true);
  assert.ok(res.content.includes('Invalid token address'));
});

test('MockMcpToolProvider send_calls accepts USDC transfer', async () => {
  const provider = new MockMcpToolProvider();
  const res = await provider.callTool('send_calls', {
    chain: 'eip155:84532',
    calls: [{ to: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', data: '0xa9059cbb000' }]
  });
  assert.strictEqual(res.isError, false);
});

test('MockMcpToolProvider send_calls rejects empty calls array', async () => {
  const provider = new MockMcpToolProvider();
  const res = await provider.callTool('send_calls', {
    chain: '84532',
    calls: []
  });
  assert.strictEqual(res.isError, true);
  assert.ok(res.content.includes('Missing or empty calls array'));
});

test('MockMcpToolProvider send_calls rejects malformed call object (missing to)', async () => {
  const provider = new MockMcpToolProvider();
  const res = await provider.callTool('send_calls', {
    chain: '84532',
    calls: [{ data: '0xabc' }]
  });
  assert.strictEqual(res.isError, true);
  assert.ok(res.content.includes('Missing to address'));
});
