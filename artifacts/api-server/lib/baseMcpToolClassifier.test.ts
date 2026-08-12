import test, { afterEach } from 'node:test';
import assert from 'node:assert';
import { baseMcpSurfaceVerdictV1, classifyBaseMcpTools } from './baseMcpToolClassifier.js';

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const originalReadOnlyAllowlist = process.env.BASE_MCP_READ_ONLY_TOOLS_ALLOWLIST;
const originalForbiddenDenylist = process.env.BASE_MCP_FORBIDDEN_TOOLS_DENYLIST;

afterEach(() => {
  restoreEnv('BASE_MCP_READ_ONLY_TOOLS_ALLOWLIST', originalReadOnlyAllowlist);
  restoreEnv('BASE_MCP_FORBIDDEN_TOOLS_DENYLIST', originalForbiddenDenylist);
});

test('known safe read-only Base MCP tool is enabled as read_only', () => {
  const result = classifyBaseMcpTools([{ name: 'get_wallets', description: 'Wallet inventory' }]);

  assert.deepStrictEqual(result.capabilities, {
    readOnly: 1,
    userConfirmedTransaction: 0,
    forbidden: 0,
    unknown: 0,
  });
  assert.deepStrictEqual(result.tools[0], {
    name: 'get_wallets',
    description: 'Wallet inventory',
    capability: 'read_only',
    scope: 'wallet',
    enabled: true,
    reason: 'read_only_allowlist',
  });
});

test('safe namespaced partner reads are enabled without allowing partner writes', () => {
  const result = classifyBaseMcpTools([
    { name: 'morpho_query_vaults' },
    { name: 'moonwell_get_markets' },
    { name: 'aerodrome_list_pools' },
    { name: 'morpho_prepare_deposit' },
    { name: 'uniswap_swap_tokens' },
  ]);

  assert.deepStrictEqual(result.tools.map((tool) => [tool.name, tool.capability, tool.enabled]), [
    ['morpho_query_vaults', 'read_only', true],
    ['moonwell_get_markets', 'read_only', true],
    ['aerodrome_list_pools', 'read_only', true],
    ['morpho_prepare_deposit', 'user_confirmed_transaction', false],
    ['uniswap_swap_tokens', 'user_confirmed_transaction', false],
  ]);
});

test('send_calls and sepolia_send_calls are never classified read_only', () => {
  const result = classifyBaseMcpTools([
    { name: 'send_calls' },
    { name: 'wallet_sendCalls' },
    { name: 'sepolia_send_calls' },
  ]);

  assert.deepStrictEqual(result.capabilities, {
    readOnly: 0,
    userConfirmedTransaction: 3,
    forbidden: 0,
    unknown: 0,
  });
  for (const tool of result.tools) {
    assert.strictEqual(tool.capability, 'user_confirmed_transaction');
    assert.strictEqual(tool.enabled, false);
    assert.notStrictEqual(tool.capability, 'read_only');
  }
});

test('exact Base MCP send is user_confirmed_transaction', () => {
  const result = classifyBaseMcpTools([{ name: 'send', description: 'Send a token through Base Account' }]);
  assert.equal(result.tools[0].capability, 'user_confirmed_transaction');
  assert.equal(result.tools[0].enabled, false);
});

test('unknown tools are classified unknown and disabled by default', () => {
  const result = classifyBaseMcpTools([{ name: 'mystery_plugin_magic' }]);

  assert.deepStrictEqual(result.capabilities, {
    readOnly: 0,
    userConfirmedTransaction: 0,
    forbidden: 0,
    unknown: 1,
  });
  assert.deepStrictEqual(result.tools[0], {
    name: 'mystery_plugin_magic',
    capability: 'unknown',
    scope: 'protocol',
    enabled: false,
    reason: 'unknown_tool_disabled_by_default',
  });
});

test('T47 separates OAuth-wallet capabilities from protocol/data tools', () => {
  const result = classifyBaseMcpTools([
    { name: 'get_wallets' },
    { name: 'get_portfolio' },
    { name: 'get_transaction_history' },
    { name: 'send' },
    { name: 'swap' },
    { name: 'send_calls' },
    { name: 'moonwell_get_markets' },
    { name: 'morpho_query_vaults' },
  ]);
  assert.deepStrictEqual(result.tools.map((tool) => [tool.name, tool.scope]), [
    ['get_wallets', 'wallet'],
    ['get_portfolio', 'wallet'],
    ['get_transaction_history', 'wallet'],
    ['send', 'wallet'],
    ['swap', 'wallet'],
    ['send_calls', 'wallet'],
    ['moonwell_get_markets', 'protocol'],
    ['morpho_query_vaults', 'protocol'],
  ]);
  assert.equal(result.tools.find((tool) => tool.name === 'get_transaction_history')?.capability, 'read_only');
});

test('explicit denylist overrides read-only allowlist', () => {
  process.env.BASE_MCP_READ_ONLY_TOOLS_ALLOWLIST = 'custom_report';
  process.env.BASE_MCP_FORBIDDEN_TOOLS_DENYLIST = 'custom_report';

  const result = classifyBaseMcpTools([{ name: 'custom_report' }]);

  assert.strictEqual(result.tools[0].capability, 'forbidden');
  assert.strictEqual(result.tools[0].enabled, false);
  assert.strictEqual(result.tools[0].reason, 'forbidden_by_denylist');
});

test('signing is user-confirmed; broadcasting and key export stay forbidden', () => {
  // `sign` returns an approvalUrl like every other write tool, and Base Account
  // shows the full message before the user approves. Forbidding it blocked the
  // native plugins that use signing as their core tool while adding nothing —
  // the protection already exists one layer below, outside our control.
  //
  // What has no approval step still cannot run: an exported key is gone the
  // moment it is returned, and a raw broadcast has nothing left to approve.
  const result = classifyBaseMcpTools([
    { name: 'personal_sign' },
    { name: 'sign_typed_data' },
    { name: 'broadcast_transaction' },
    { name: 'export_private_key' },
    { name: 'sign_transaction' },
  ]);

  assert.deepStrictEqual(result.capabilities, {
    readOnly: 0,
    userConfirmedTransaction: 2,
    forbidden: 3,
    unknown: 0,
  });

  const byName = new Map(result.tools.map((tool) => [tool.name, tool]));
  assert.strictEqual(byName.get('personal_sign')?.capability, 'user_confirmed_transaction');
  assert.strictEqual(byName.get('sign_typed_data')?.capability, 'user_confirmed_transaction');
  assert.strictEqual(byName.get('personal_sign')?.reason, 'signature_requires_base_account_approval');

  // `signTransaction` is NOT `sign`: it hands back a signed transaction ready
  // to broadcast, which is the one artefact Miorail must never hold.
  assert.strictEqual(byName.get('sign_transaction')?.capability, 'forbidden');
  assert.strictEqual(byName.get('broadcast_transaction')?.capability, 'forbidden');
  assert.strictEqual(byName.get('export_private_key')?.capability, 'forbidden');
});

test('product surface routing separates READ, ACTION and ROUTABLE without granting arbitrary writes', () => {
  const classified = classifyBaseMcpTools([
    { name: 'get_portfolio' },
    { name: 'send' },
    { name: 'sign' },
    { name: 'initiate_x402_request' },
    { name: 'swap' },
    { name: 'send_calls' },
    { name: 'mystery_plugin_magic' },
  ]).tools;
  const verdicts = Object.fromEntries(classified.map((tool) => [tool.name, baseMcpSurfaceVerdictV1(tool)]));

  assert.deepEqual(verdicts.get_portfolio, { route: 'read', enabled: true, reason: 'read_in_extensions' });
  assert.deepEqual(verdicts.send, { route: 'action', enabled: true, reason: 'base_mcp_send_action_v1' });
  assert.deepEqual(verdicts.sign, { route: 'action', enabled: false, reason: 'action_vertical_not_released' });
  assert.deepEqual(verdicts.initiate_x402_request, { route: 'action', enabled: true, reason: 'base_mcp_x402_action_v1' });
  assert.deepEqual(verdicts.swap, { route: 'routable', enabled: true, reason: 'handoff_to_routes_ai' });
  assert.deepEqual(verdicts.send_calls, { route: 'blocked', enabled: false, reason: 'explicit_extension_adapter_required' });
  assert.equal(verdicts.mystery_plugin_magic.route, 'blocked');
});
