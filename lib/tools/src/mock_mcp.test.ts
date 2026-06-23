import test from 'node:test';
import assert from 'node:assert';
import { MockMcpToolProvider } from './mock_mcp.js';

test('MockMcpToolProvider send_calls returns approvalUrl and requestId', async () => {
  const provider = new MockMcpToolProvider();
  const result = await provider.callTool('send_calls', { chain: 'base', calls: [{ to: '0x123' }] });
  assert.strictEqual(result.isError, false);
  const parsed = JSON.parse(result.content);
  assert.ok(parsed.approvalUrl.startsWith('https://mock.base.org/approve/'));
  assert.ok(parsed.requestId.startsWith('mock-req-'));
});

test('MockMcpToolProvider get_request_status returns confirmed', async () => {
  const provider = new MockMcpToolProvider();
  const result = await provider.callTool('get_request_status', { requestId: 'mock-123' });
  assert.strictEqual(result.isError, false);
  const parsed = JSON.parse(result.content);
  assert.strictEqual(parsed.status, 'confirmed');
});
