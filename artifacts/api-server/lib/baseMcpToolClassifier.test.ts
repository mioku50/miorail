import test, { afterEach } from 'node:test';
import assert from 'node:assert';
import { classifyBaseMcpTools } from './baseMcpToolClassifier.js';

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
    enabled: false,
    reason: 'unknown_tool_disabled_by_default',
  });
});

test('explicit denylist overrides read-only allowlist', () => {
  process.env.BASE_MCP_READ_ONLY_TOOLS_ALLOWLIST = 'custom_report';
  process.env.BASE_MCP_FORBIDDEN_TOOLS_DENYLIST = 'custom_report';

  const result = classifyBaseMcpTools([{ name: 'custom_report' }]);

  assert.strictEqual(result.tools[0].capability, 'forbidden');
  assert.strictEqual(result.tools[0].enabled, false);
  assert.strictEqual(result.tools[0].reason, 'forbidden_by_denylist');
});

test('signature and broadcast tools are forbidden', () => {
  const result = classifyBaseMcpTools([
    { name: 'personal_sign' },
    { name: 'broadcast_transaction' },
  ]);

  assert.deepStrictEqual(result.capabilities, {
    readOnly: 0,
    userConfirmedTransaction: 0,
    forbidden: 2,
    unknown: 0,
  });
  assert.strictEqual(result.tools.every((tool) => tool.capability === 'forbidden'), true);
});
