import test from 'node:test';
import assert from 'node:assert';
import {
  approvalProviderHint,
  approvalProviderState,
  baseMcpConnectHref,
  baseMcpConnectLabel,
  baseMcpHint,
  baseMcpNeedsAuth,
  baseMcpOAuthResultMessage,
  baseMcpState,
  formatApprovalProviderStatus,
  formatBaseMcpStatus,
} from './format';

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
  assert.strictEqual(baseMcpNeedsAuth({ status: 'needs_reauth', configured: true, enabled: true }), true);
  assert.strictEqual(baseMcpNeedsAuth({ status: 'needs_auth', configured: true, enabled: true }), true);
  assert.strictEqual(baseMcpNeedsAuth({ status: 'connected', configured: true, enabled: true, auth: { connected: true } }), false);
  assert.strictEqual(baseMcpConnectLabel({ auth: { connected: false } }), 'Connect Base MCP');
  assert.strictEqual(baseMcpConnectLabel({ auth: { connected: true } }), 'Reconnect Base MCP');
  assert.strictEqual(baseMcpConnectHref('/configure'), '/api/mcp/base/connect?returnTo=%2Fconfigure');
  assert.strictEqual(baseMcpConnectHref('https://evil.test/callback'), '/api/mcp/base/connect?returnTo=%2Fbase-mcp');
});

test('Base MCP OAuth result messages are explicit and non-crashing', () => {
  assert.deepStrictEqual(baseMcpOAuthResultMessage('connected'), {
    kind: 'success',
    text: 'Base MCP connected. User-scoped tools are authorized.',
  });
  assert.deepStrictEqual(baseMcpOAuthResultMessage('cancelled'), {
    kind: 'warn',
    text: 'Base MCP connection was cancelled. Connect again when ready.',
  });
  assert.deepStrictEqual(baseMcpOAuthResultMessage('error'), {
    kind: 'error',
    text: 'Base MCP connection failed. Connect again to reauthorize.',
  });
  assert.strictEqual(baseMcpOAuthResultMessage('unknown'), null);
});

test('Approval provider UI helpers render Moralis budget exhaustion truthfully', () => {
  const approvals = { status: 'budget_exhausted', provider: 'moralis' };
  const budgets = { moralis: { status: 'budget_exhausted', budgetExhausted: true, lastErrorCode: 'moralis_auth_or_budget' } };

  assert.strictEqual(approvalProviderState(approvals.status), 'stale');
  assert.strictEqual(formatApprovalProviderStatus(approvals, budgets), 'moralis budget exhausted');
  assert.strictEqual(
    approvalProviderHint(approvals, budgets),
    'Approval scanner unavailable — Moralis CU limit reached. Try after reset or upgrade provider.'
  );
});
