import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { ToolAggregator, type ToolDef, type ToolProvider } from '@mioagent/tools';
import {
  baseMcpApprovalRuntime,
  extractBaseMcpApprovalSnapshot,
  normalizeBaseMcpApprovalState,
  sanitizedBaseMcpResponseShape,
  resolveBaseMcpApprovalLifecycle,
} from './baseMcpApprovalLifecycle.js';

const originalWait = baseMcpApprovalRuntime.wait;
afterEach(() => { baseMcpApprovalRuntime.wait = originalWait; });

class StatusProvider implements ToolProvider {
  id = 'base-mcp-dynamic';
  calls = 0;
  private readonly tool: ToolDef = {
    name: 'get_request_status',
    description: 'Get Base MCP request status',
    inputSchema: { type: 'object', properties: { request_id: { type: 'string' } } },
  };
  async listTools() { return [this.tool]; }
  findTool(name: string) { return name === this.tool.name ? this.tool : undefined; }
  async callTool() {
    this.calls += 1;
    return this.calls === 1
      ? { content: JSON.stringify({ request_id: 'req-1', status: 'pending' }), isError: false }
      : { content: JSON.stringify({ result: { status: 'approval_required', links: { approval_url: 'https://wallet.base.org/approve/req-1' } } }), isError: false };
  }
}

test('requestId-only result polls get_request_status until an approval link is available', async () => {
  baseMcpApprovalRuntime.wait = async () => undefined;
  const provider = new StatusProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await resolveBaseMcpApprovalLifecycle({
    initialResult: JSON.stringify({ requestId: 'req-1' }),
    tools,
  });
  assert.equal(result.requestId, 'req-1');
  assert.equal(result.approvalUrl, 'https://wallet.base.org/approve/req-1');
  assert.equal(result.state, 'approval_required');
  assert.equal(provider.calls, 2);
  assert.deepEqual(result.toolCalls.map((call) => call.toolName), ['get_request_status', 'get_request_status']);
});

test('approval status aliases cover completed, rejected and failed terminal states', () => {
  assert.equal(normalizeBaseMcpApprovalState('confirmed'), 'completed');
  assert.equal(normalizeBaseMcpApprovalState('signed'), 'completed');
  assert.equal(normalizeBaseMcpApprovalState('rejected'), 'rejected');
  assert.equal(normalizeBaseMcpApprovalState('error'), 'failed');
  assert.equal(normalizeBaseMcpApprovalState('processing'), 'pending');
});

test('approvalUrl-only result produces approval_required without requiring a request ID', async () => {
  const tools = new ToolAggregator();
  const result = await resolveBaseMcpApprovalLifecycle({
    initialResult: JSON.stringify({ approval_url: 'https://wallet.base.org/approve/url-only' }),
    tools,
  });
  assert.equal(result.approvalUrl, 'https://wallet.base.org/approve/url-only');
  assert.equal(result.requestId, undefined);
  assert.equal(result.state, 'approval_required');
});

test('nested approval link aliases are recognized and an unconfirmed response is never completed', () => {
  const result = extractBaseMcpApprovalSnapshot({
    content: [{ type: 'text', text: JSON.stringify({ result: { links: [{ link: 'https://wallet.base.org/approve/nested' }] } }) }],
  });
  assert.equal(result.approvalUrl, 'https://wallet.base.org/approve/nested');
  assert.equal(result.state, undefined);
});

test('durable transaction proof aliases are extracted without treating requestId as proof', () => {
  const txHash = `0x${'c'.repeat(64)}`;
  const completed = extractBaseMcpApprovalSnapshot({ status: 'completed', requestId: 'request-1', transaction_hash: txHash });
  assert.equal(completed.proof?.txHash, txHash);
  const requestOnly = extractBaseMcpApprovalSnapshot({ status: 'completed', requestId: 'request-1' });
  assert.equal(requestOnly.proof, undefined);
});

test('sanitized response diagnostics expose shape and keys but never secret values', () => {
  const shape = sanitizedBaseMcpResponseShape(JSON.stringify({ result: { access_token: 'never-log-me', nested: { id: 'request-1' } } }));
  const serialized = JSON.stringify(shape);
  assert.match(serialized, /access_token|nested|id/);
  assert.doesNotMatch(serialized, /never-log-me|request-1/);
});
