import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { encodeFunctionData, erc20Abi, maxUint256, type Hex } from 'viem';
import {
  HYDREX_BASE_ROUTER_PROXY,
  HYDREX_KYBER_META_ROUTER,
  validateHydrexSwap,
  type HydrexSwapContext,
} from './hydrexGuard.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const WETH = '0x4200000000000000000000000000000000000006' as const;
const WALLET = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x4444444444444444444444444444444444444444' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const NOW = new Date('2026-08-12T21:00:00.000Z');
const DEADLINE = BigInt(Math.floor(NOW.getTime() / 1000) + 600);
const AMOUNT_IN = 100_000_000n;
const MINIMUM_OUT = 37_810_000_000_000_000n;

const ABI = [{
  type: 'function', name: 'executeSwaps', stateMutability: 'payable', inputs: [
    { name: 'swaps', type: 'tuple[]', components: [
      { name: 'router', type: 'address' }, { name: 'inputAsset', type: 'address' },
      { name: 'outputAsset', type: 'address' }, { name: 'inputAmount', type: 'uint256' },
      { name: 'minOutputAmount', type: 'uint256' }, { name: 'callData', type: 'bytes' },
      { name: 'recipient', type: 'address' }, { name: 'origin', type: 'string' },
      { name: 'referral', type: 'address' }, { name: 'referralFeeBps', type: 'uint256' },
    ] }, { name: 'deadline', type: 'uint256' },
  ], outputs: [],
}] as const;

function swapData(overrides: Partial<{
  router: `0x${string}`; outputAsset: `0x${string}`; inputAmount: bigint;
  minimum: bigint; recipient: `0x${string}`; referral: `0x${string}`;
  referralFeeBps: bigint; deadline: bigint;
  innerData: Hex;
}> = {}): Hex {
  return encodeFunctionData({ abi: ABI, functionName: 'executeSwaps', args: [[{
    router: overrides.router ?? HYDREX_KYBER_META_ROUTER,
    inputAsset: USDC,
    outputAsset: overrides.outputAsset ?? WETH,
    inputAmount: overrides.inputAmount ?? AMOUNT_IN,
    minOutputAmount: overrides.minimum ?? MINIMUM_OUT,
    callData: overrides.innerData ?? '0xe21fd0e90000',
    recipient: overrides.recipient ?? WALLET,
    origin: 'hydrex',
    referral: overrides.referral ?? ZERO,
    referralFeeBps: overrides.referralFeeBps ?? 0n,
  }], overrides.deadline ?? DEADLINE] });
}

function approval(amount = AMOUNT_IN, spender: `0x${string}` = HYDREX_BASE_ROUTER_PROXY) {
  return { to: USDC, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) };
}

function context(overrides: Partial<HydrexSwapContext> = {}): HydrexSwapContext {
  return {
    inputTokenAddress: USDC,
    outputTokenAddress: WETH,
    amountInAtomic: AMOUNT_IN.toString(),
    minimumOutputAtomic: MINIMUM_OUT.toString(),
    recipient: WALLET,
    routerAddress: HYDREX_BASE_ROUTER_PROXY,
    upstreamRouter: HYDREX_KYBER_META_ROUTER,
    expiresAt: new Date(Number(DEADLINE * 1000n)).toISOString(),
    ...overrides,
  };
}

function run(data = swapData(), ctx = context(), approve = approval()) {
  return validateHydrexSwap({
    chain: 8453,
    calls: [approve, { to: HYDREX_BASE_ROUTER_PROXY, value: '0', data }],
    context: ctx,
    now: NOW,
  });
}

describe('Hydrex Safety Kernel guard', () => {
  test('accepts only exact approval plus the reviewed outer and upstream route', () => {
    const result = run();
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.semantics.spendAmountRaw, AMOUNT_IN.toString());
      assert.equal(result.semantics.minimumOutputRaw, MINIMUM_OUT.toString());
      assert.deepEqual(result.semantics.recipients, [WALLET]);
    }
  });

  test('rejects unlimited or foreign approvals and extra calls', () => {
    assert.equal(run(swapData(), context(), approval(maxUint256)).success, false);
    assert.equal(run(swapData(), context(), approval(AMOUNT_IN, OTHER)).success, false);
    const extra = validateHydrexSwap({
      chain: 8453,
      calls: [approval(), { to: OTHER, value: '0', data: '0x' }, { to: HYDREX_BASE_ROUTER_PROXY, value: '0', data: swapData() }],
      context: context(), now: NOW,
    });
    assert.equal(extra.success, false);
  });

  test('rejects changed upstream, output, amount, minimum, recipient, referral and deadline', () => {
    for (const data of [
      swapData({ router: OTHER }), swapData({ outputAsset: OTHER }),
      swapData({ inputAmount: AMOUNT_IN + 1n }), swapData({ minimum: MINIMUM_OUT - 1n }),
      swapData({ recipient: OTHER }), swapData({ referral: OTHER }),
      swapData({ referralFeeBps: 1n }), swapData({ deadline: DEADLINE + 1n }),
      swapData({ innerData: '0x123456780000' }),
    ]) assert.equal(run(data).success, false);
  });

  test('rejects wrong target, native value, expired review and non-Base chain', () => {
    assert.equal(validateHydrexSwap({
      chain: 8453, calls: [approval(), { to: OTHER, value: '0', data: swapData() }], context: context(), now: NOW,
    }).success, false);
    assert.equal(validateHydrexSwap({
      chain: 8453, calls: [approval(), { to: HYDREX_BASE_ROUTER_PROXY, value: '1', data: swapData() }], context: context(), now: NOW,
    }).success, false);
    assert.equal(run(swapData(), context({ expiresAt: NOW.toISOString() })).success, false);
    assert.equal(validateHydrexSwap({
      chain: 84532, calls: [approval(), { to: HYDREX_BASE_ROUTER_PROXY, value: '0', data: swapData() }], context: context(), now: NOW,
    }).success, false);
  });
});
