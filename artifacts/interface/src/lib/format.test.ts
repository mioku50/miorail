import test from 'node:test';
import assert from 'node:assert';
import { baseMcpHint, baseMcpState, formatBaseMcpStatus } from './format';

test('Base MCP UI helpers render optional missing state clearly', () => {
  const status = {
    status: 'missing',
    provider: 'base-mcp',
    configured: false,
    enabled: false,
  };

  assert.strictEqual(baseMcpState(status.status), 'missing');
  assert.strictEqual(formatBaseMcpStatus(status), 'missing');
  assert.strictEqual(baseMcpHint(status), 'Base MCP is optional. Configure BASE_MCP_SERVER_URL to enable tool status.');
});

test('Base MCP UI helpers classify connected and degraded states', () => {
  assert.strictEqual(baseMcpState('connected'), 'live');
  assert.strictEqual(formatBaseMcpStatus({ status: 'connected', endpointHost: 'mcp.example.test' }), 'connected (mcp.example.test)');

  assert.strictEqual(baseMcpState('degraded'), 'stale');
  assert.strictEqual(formatBaseMcpStatus({ status: 'degraded', errorCode: 'rate_limited' }), 'degraded (rate limited)');
  assert.strictEqual(baseMcpHint({ status: 'degraded' }), null);
});

test('Base MCP UI helpers classify needs_reauth as reconnectable stale state', () => {
  assert.strictEqual(baseMcpState('needs_reauth'), 'stale');
  assert.strictEqual(formatBaseMcpStatus({ status: 'needs_reauth' }), 'needs auth');
  assert.strictEqual(
    baseMcpHint({ status: 'needs_reauth' }),
    'Base MCP is configured. Connect Base MCP to authorize user-scoped tools.'
  );
});
