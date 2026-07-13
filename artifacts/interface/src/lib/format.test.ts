import test from 'node:test';
import assert from 'node:assert';
import {
  approvalProviderHint,
  approvalProviderState,
  baseMcpCapabilityBreakdown,
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
  assert.strictEqual(baseMcpHint({ status: 'degraded', readiness: 'degraded', errorCode: 'tool_probe_failed' }), 'Base MCP is degraded (tool_probe_failed).');
  assert.strictEqual(formatBaseMcpStatus({ status: 'connected', readiness: 'tools_available', toolsCount: 14 }), '14 tools available');
  assert.strictEqual(formatBaseMcpStatus({ status: 'degraded', readiness: 'oauth_connected', toolsCount: 0 }), 'OAuth connected · tools unavailable');
});

test('Base MCP UI helpers classify needs_reauth as reconnectable stale state', () => {
  assert.strictEqual(baseMcpState('needs_reauth'), 'stale');
  assert.strictEqual(formatBaseMcpStatus({ status: 'needs_reauth' }), 'needs auth');
  assert.strictEqual(
    baseMcpHint({ status: 'needs_reauth' }),
    'Optional: connect Base MCP to enable portfolio, send and swap via Base.'
  );
  assert.strictEqual(baseMcpNeedsAuth({ status: 'needs_reauth', configured: true, enabled: true }), true);
  assert.strictEqual(baseMcpNeedsAuth({ status: 'needs_auth', configured: true, enabled: true }), true);
  assert.strictEqual(baseMcpNeedsAuth({ status: 'connected', configured: true, enabled: true, auth: { connected: true } }), false);
  assert.strictEqual(baseMcpNeedsAuth({ status: 'degraded', configured: true, enabled: true, usable: false, auth: { connected: true } }), true);
  assert.strictEqual(baseMcpNeedsAuth({ status: 'connected', configured: true, enabled: true, auth: { connected: true, expired: true } }), true);
  assert.strictEqual(baseMcpConnectLabel({ auth: { connected: false } }), 'Connect Base MCP');
  assert.strictEqual(baseMcpConnectLabel({ auth: { connected: true } }), 'Reconnect Base MCP');
  assert.strictEqual(baseMcpConnectHref('/configure'), '/api/mcp/base/connect?returnTo=%2Fconfigure&popup=1');
  assert.strictEqual(baseMcpConnectHref('https://evil.test/callback'), '/api/mcp/base/connect?returnTo=%2Fbase-mcp&popup=1');
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
  assert.deepStrictEqual(baseMcpOAuthResultMessage('error', 'refresh_failed'), {
    kind: 'error',
    text: 'Base MCP token refresh failed. Reconnect to start a clean authorization flow.',
  });
  assert.deepStrictEqual(baseMcpOAuthResultMessage('error', 'credentials_invalid'), {
    kind: 'error',
    text: 'Stored Base MCP credentials cannot be opened. Reconnect to replace them safely.',
  });
  assert.strictEqual(baseMcpOAuthResultMessage('unknown'), null);
  assert.deepStrictEqual(baseMcpOAuthResultMessage('connected', null, 'mismatch'), {
    kind: 'warn',
    text: 'Base MCP connected to a different wallet than your session wallet. Reconnect Base MCP with the same account to enable send and swap.',
  });
});

test('Base MCP capability breakdown renders disabled unknown tools safely', () => {
  assert.deepStrictEqual(
    baseMcpCapabilityBreakdown({
      toolsCount: 4,
      capabilities: {
        readOnly: 1,
        userConfirmedTransaction: 1,
        forbidden: 1,
        unknown: 1,
      },
    }),
    {
      toolsCount: 4,
      readOnly: 1,
      userConfirmedTransaction: 1,
      disabledOrUnknown: 2,
      unknown: 1,
    },
  );

  assert.deepStrictEqual(
    baseMcpCapabilityBreakdown({
      toolsCount: 3,
      readOnlyToolsCount: 2,
      transactionToolsCount: 1,
      forbiddenToolsCount: 0,
      unknownToolsCount: 0,
    }),
    {
      toolsCount: 3,
      readOnly: 2,
      userConfirmedTransaction: 1,
      disabledOrUnknown: 0,
      unknown: 0,
    },
  );
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
