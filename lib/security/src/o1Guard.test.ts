import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { encodeFunctionData, erc20Abi, parseAbi, zeroHash, type Hex } from 'viem';

import { O1_ZEROX_ALLOWANCE_HOLDER, O1_ZEROX_SETTLER_EXECUTE_SELECTOR, validateO1Swap } from './o1Guard.js';

// 2026-11-11: an o1 order is an `exec` on 0x's AllowanceHolder running the
// Settler 0x's registry names. The guard holds the two calls against what the
// build read from the chain, never against what the order says about itself.

const WALLET = '0x1111111111111111111111111111111111111111';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const SETTLER = '0x2222222222222222222222222222222222222222';
const PREVIOUS_SETTLER = '0x3333333333333333333333333333333333333333';
const OTHER = '0x4444444444444444444444444444444444444444';
const OLD_O1_ROUTER = '0x7293d41c28e5fc2292e62d26fec60e22a145d1a5';
const AMOUNT_IN = 100_000_000n;
const MINIMUM_OUT = 37_810_000_000_000_000n;
const NOW = new Date('2026-11-11T12:00:00.000Z');
const EXPIRES = '2026-11-11T12:10:00.000Z';

const EXEC_ABI = parseAbi([
  'function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes)',
]);
const SETTLER_ABI = parseAbi([
  'function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zid) payable returns (bool)',
  'function executeWithPermit((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zid, bytes permitData) payable returns (bool)',
]);

type OverridesV1 = {
  approval?: bigint;
  spender?: string;
  operator?: string;
  target?: string;
  token?: string;
  amount?: bigint;
  recipient?: string;
  buyToken?: string;
  minimum?: bigint;
  withPermit?: boolean;
  swapTo?: string;
  swapValue?: string;
  trailing?: string;
};

function calls(overrides: OverridesV1 = {}) {
  const slippage = {
    recipient: (overrides.recipient ?? WALLET) as `0x${string}`,
    buyToken: (overrides.buyToken ?? WETH) as `0x${string}`,
    minAmountOut: overrides.minimum ?? MINIMUM_OUT,
  };
  const actions = ['0xc1fb425eaa', '0x38c9c147bb'] as Hex[];
  const inner = overrides.withPermit
    ? encodeFunctionData({ abi: SETTLER_ABI, functionName: 'executeWithPermit', args: [slippage, actions, zeroHash, '0x01'] })
    : encodeFunctionData({ abi: SETTLER_ABI, functionName: 'execute', args: [slippage, actions, zeroHash] });
  const operator = (overrides.operator ?? SETTLER) as `0x${string}`;
  const exec = encodeFunctionData({
    abi: EXEC_ABI,
    functionName: 'exec',
    args: [operator, (overrides.token ?? USDC) as `0x${string}`, overrides.amount ?? AMOUNT_IN, (overrides.target ?? operator) as `0x${string}`, inner],
  });
  return [
    {
      to: USDC,
      value: '0',
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [(overrides.spender ?? O1_ZEROX_ALLOWANCE_HOLDER) as `0x${string}`, overrides.approval ?? AMOUNT_IN],
      }),
    },
    { to: overrides.swapTo ?? O1_ZEROX_ALLOWANCE_HOLDER, value: overrides.swapValue ?? '0', data: `${exec}${overrides.trailing ?? ''}` },
  ];
}

function run(
  batch = calls(),
  overrides: Partial<{ expiresAt: string; settlers: readonly string[]; routerAddress: string }> = {},
) {
  return validateO1Swap({
    chain: 8453,
    calls: batch,
    now: NOW,
    context: {
      inputTokenAddress: USDC,
      outputTokenAddress: WETH,
      amountInAtomic: AMOUNT_IN.toString(),
      minimumOutputAtomic: MINIMUM_OUT.toString(),
      swapper: WALLET,
      routerAddress: overrides.routerAddress ?? O1_ZEROX_ALLOWANCE_HOLDER,
      settlers: overrides.settlers ?? [SETTLER, PREVIOUS_SETTLER],
      expiresAt: overrides.expiresAt ?? EXPIRES,
    },
  });
}

function refused(result: ReturnType<typeof run>, code: string, label = code): void {
  assert.equal(result.success, false, label);
  if (!result.success) assert.equal(result.code, code, label);
}

describe('o1 Safety Kernel guard', () => {
  test('accepts the exact approval and the reviewed swap through the registry’s Settler', () => {
    const result = run();
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.semantics.spendAmountRaw, AMOUNT_IN.toString());
    assert.equal(result.semantics.minimumOutputRaw, MINIMUM_OUT.toString());
    assert.deepEqual(result.semantics.recipients, [WALLET]);
    assert.deepEqual(result.semantics.spenders, [O1_ZEROX_ALLOWANCE_HOLDER]);
    assert.equal(result.semantics.settler, SETTLER);
    assert.equal(run(calls({ operator: PREVIOUS_SETTLER })).success, true, 'the Settler before the current one');
    assert.equal(run(calls({ minimum: MINIMUM_OUT + 1n })).success, true, 'a stricter floor than the reviewed one');
  });

  test('rejects an unlimited approval and an approval for anybody else', () => {
    refused(run(calls({ approval: (1n << 256n) - 1n })), 'o1_approval_not_exact');
    refused(run(calls({ spender: OTHER })), 'o1_approval_not_exact');
  });

  test('the allowance goes only to a Settler the registry named', () => {
    refused(run(calls({ operator: OTHER })), 'o1_settler_not_in_registry');
    // Nothing read from the registry is not a registry that names everything.
    refused(run(calls(), { settlers: [] }), 'o1_settler_unverified');
    refused(run(calls(), { settlers: [SETTLER, PREVIOUS_SETTLER, OTHER] }), 'o1_settler_unverified');
    refused(run(calls(), { settlers: ['not an address'] }), 'o1_settler_unverified');
  });

  test('the allowance is the reviewed input exactly, and the Settler alone is run', () => {
    refused(run(calls({ target: OTHER })), 'o1_swap_bounds_invalid', 'another target');
    refused(run(calls({ token: OTHER })), 'o1_swap_bounds_invalid', 'another token');
    refused(run(calls({ amount: AMOUNT_IN + 1n })), 'o1_swap_bounds_invalid', 'a larger allowance');
    refused(run(calls({ trailing: '00'.repeat(32) })), 'o1_swap_bounds_invalid', 'bytes behind the arguments');
  });

  test('o1’s Builder Code suffix behind the arguments is accepted, and nothing else is', () => {
    // The 29 bytes o1 appended to every order on 2026-11-11: "bc_4raffiaj", its length, schema 0, the marker.
    const suffix = `62635f347261666669616a0b00${'8021'.repeat(8)}`;
    assert.equal(run(calls({ trailing: suffix })).success, true);
    for (const trailing of [`${suffix}00`, `${'ab'.repeat(20)}${suffix}`, `62635f340c00${'8021'.repeat(8)}`, '8021'.repeat(8)]) {
      refused(run(calls({ trailing })), 'o1_swap_bounds_invalid', trailing);
    }
  });

  test('rejects output substitution, another recipient and a weaker minimum', () => {
    refused(run(calls({ buyToken: OTHER })), 'o1_route_asset_mismatch');
    refused(run(calls({ recipient: OTHER })), 'o1_route_asset_mismatch');
    refused(run(calls({ minimum: MINIMUM_OUT - 1n })), 'o1_swap_bounds_invalid');
    refused(run(calls({ minimum: 0n })), 'o1_swap_bounds_invalid');
  });

  test('only execute is run: a call that would spend a permit is refused', () => {
    assert.equal(O1_ZEROX_SETTLER_EXECUTE_SELECTOR, '0x1fff991f');
    refused(run(calls({ withPermit: true })), 'o1_settler_call_invalid');
  });

  test('rejects another router, ETH sent along, expired calls and any extra target', () => {
    refused(run(calls({ swapTo: OLD_O1_ROUTER })), 'o1_swap_target_invalid', 'o1’s own router is no longer the boundary');
    refused(run(calls(), { routerAddress: OLD_O1_ROUTER }), 'o1_context_invalid');
    refused(run(calls({ swapValue: '1' })), 'o1_swap_target_invalid', 'value');
    refused(run(calls(), { expiresAt: NOW.toISOString() }), 'o1_quote_expired');
    refused(run([...calls(), { to: OTHER, value: '0', data: '0x' }]), 'o1_batch_size_invalid');
  });
});
