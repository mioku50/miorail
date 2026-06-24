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
    calls: [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0xa9059cbb000' }]
  });
  assert.strictEqual(res.isError, false);
});
