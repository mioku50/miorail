import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { baseMcpReadOnlyArgumentGuardV1 } from '@mioagent/mcp';

import { classifyBaseMcpTools } from './baseMcpToolClassifier.js';

// ---------------------------------------------------------------------------
// The seven tools mcp.base.org publishes that this classifier could not name.
//
// `unknown` is treated as forbidden, so the whole set was uncallable — which
// looked like a safe default and was in fact three different mistakes wearing
// one label: reads we refused for no reason, payments we refused for the right
// reason but recorded as a mystery, and `sign`, which the classifier had
// already decided in a twenty-line comment and then failed to match.
//
// The live inventory on 2026-08-10, read from the production probe: 15 tools,
// 5 read_only, 3 user_confirmed_transaction, 0 forbidden, 7 unknown.
// ---------------------------------------------------------------------------

const LIVE_INVENTORY_V1 = [
  { name: 'chain_rpc_request' },
  { name: 'complete_x402_request' },
  { name: 'fund' },
  { name: 'get_portfolio' },
  { name: 'get_request_status' },
  { name: 'get_transaction_history' },
  { name: 'get_wallets' },
  { name: 'help' },
  { name: 'initiate_x402_request' },
  { name: 'search_tokens' },
  { name: 'send' },
  { name: 'send_calls' },
  { name: 'sign' },
  { name: 'swap' },
  { name: 'web_request' },
];

function capabilityOf(name: string): string {
  return classifyBaseMcpTools(LIVE_INVENTORY_V1).tools.find((tool) => tool.name === name)!.capability;
}

describe('every tool Base MCP publishes today has a verdict', () => {
  test('nothing in the live inventory is unknown', () => {
    const result = classifyBaseMcpTools(LIVE_INVENTORY_V1);
    const unresolved = result.tools.filter((tool) => tool.capability === 'unknown').map((tool) => tool.name);
    assert.deepEqual(unresolved, [], 'an unclassified tool is an uncallable tool');
    assert.equal(result.capabilities.unknown, 0);
  });

  test('a tool nobody has classified is still refused', () => {
    // The default must not have loosened on the way past.
    assert.equal(capabilityOf('help'), 'read_only');
    const result = classifyBaseMcpTools([{ name: 'mystery_plugin_magic' }]);
    assert.equal(result.tools[0].capability, 'unknown');
    assert.equal(result.tools[0].enabled, false);
  });
});

describe('signing is a user-confirmed action, and `sign` is its name', () => {
  test('the bare tool name matches', () => {
    // The substring markers were `personalsign`, `signmessage`, `signtypeddata`
    // — none of them a substring of `sign`. The rule described a tool Base MCP
    // does not publish.
    assert.equal(capabilityOf('sign'), 'user_confirmed_transaction');
  });

  test('it is wallet-scoped, so a mismatched Base MCP wallet disables it', () => {
    const tool = classifyBaseMcpTools([{ name: 'sign' }]).tools[0];
    assert.equal(tool.scope, 'wallet');
    assert.equal(tool.reason, 'signature_requires_base_account_approval');
  });

  test('a bare `sign` rule does not swallow unrelated names', () => {
    for (const name of ['design_token', 'assign_role', 'redesign_vault']) {
      assert.equal(classifyBaseMcpTools([{ name }]).tools[0].capability, 'unknown', name);
    }
  });

  test('signTransaction stays forbidden — it is not a signature request', () => {
    const tool = classifyBaseMcpTools([{ name: 'sign_transaction' }]).tools[0];
    assert.equal(tool.capability, 'forbidden');
  });
});

describe('anything that spends the user’s money is not a read', () => {
  test('both x402 tools are user-confirmed, not read-only', () => {
    assert.equal(capabilityOf('initiate_x402_request'), 'user_confirmed_transaction');
    assert.equal(capabilityOf('complete_x402_request'), 'user_confirmed_transaction');
  });

  test('a future x402 tool arrives classified rather than unknown', () => {
    // Matching the protocol rather than the two current names. Miorail already
    // has one x402 spend path; a second one must never appear by default.
    assert.equal(
      classifyBaseMcpTools([{ name: 'refund_x402_payment' }]).tools[0].capability,
      'user_confirmed_transaction',
    );
  });

  test('`fund` emits a payment instruction, so it is not filed with the reads', () => {
    const tool = classifyBaseMcpTools([{ name: 'fund' }]).tools[0];
    assert.equal(tool.capability, 'user_confirmed_transaction');
    assert.equal(tool.enabled, false);
    assert.equal(tool.scope, 'wallet');
  });
});

describe('a dispatcher tool is read-only per call, never per name', () => {
  test('chain_rpc_request passes an ordinary read', () => {
    for (const method of ['eth_call', 'eth_getBalance', 'eth_blockNumber', 'eth_getLogs', 'eth_chainId']) {
      assert.equal(baseMcpReadOnlyArgumentGuardV1('chain_rpc_request', { method }).allowed, true, method);
    }
  });

  test('it refuses a write even though Base says it would refuse it too', () => {
    // The point is not that Base is wrong. It is that a boundary we describe as
    // structural cannot rest on somebody else's enforcement of it.
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign']) {
      const verdict = baseMcpReadOnlyArgumentGuardV1('chain_rpc_request', { method });
      assert.equal(verdict.allowed, false, method);
      assert.equal(verdict.errorCode, 'base_mcp_rpc_method_not_read_only');
    }
  });

  test('an unrecognised method is refused rather than allowed', () => {
    // Fail closed: a denylist is wrong the day a new method ships.
    assert.equal(baseMcpReadOnlyArgumentGuardV1('chain_rpc_request', { method: 'debug_traceCall' }).allowed, false);
    assert.equal(baseMcpReadOnlyArgumentGuardV1('chain_rpc_request', { method: 'miner_start' }).allowed, false);
    assert.equal(baseMcpReadOnlyArgumentGuardV1('chain_rpc_request', {}).errorCode, 'base_mcp_rpc_method_missing');
  });

  test('web_request is GET-only here', () => {
    assert.equal(baseMcpReadOnlyArgumentGuardV1('web_request', { method: 'GET' }).allowed, true);
    assert.equal(baseMcpReadOnlyArgumentGuardV1('web_request', {}).allowed, true, 'GET is the default');
    const post = baseMcpReadOnlyArgumentGuardV1('web_request', { method: 'post' });
    assert.equal(post.allowed, false);
    assert.equal(post.errorCode, 'base_mcp_web_request_not_get');
  });

  test('the guard leaves ordinary read tools alone', () => {
    assert.equal(baseMcpReadOnlyArgumentGuardV1('get_portfolio', { limit: 20 }).allowed, true);
    assert.equal(baseMcpReadOnlyArgumentGuardV1('search_tokens', undefined).allowed, true);
  });
});
