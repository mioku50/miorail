import { decodeFunctionData, erc20Abi, type Hex } from 'viem';
import { normalizeBaseChain, type BaseCall } from './baseGuards.js';

/** Duplicated independently from swap-adapters to prevent a reverse package
 * dependency. Cross-package tests assert these bytes stay equal. */
export const O1_BASE_ROUTER_PROXY = '0x7293d41c28e5fc2292e62d26fec60e22a145d1a5';
export const O1_MAX_HOPS = 8;

const O1_SWAP_ABI = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'swaps',
        type: 'tuple[]',
        components: [
          { name: 'dexType', type: 'uint8' },
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'pool', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'exchange', type: 'address' },
          { name: 'extraData', type: 'bytes' },
        ],
      },
      { name: 'settlementToken', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface O1SwapContext {
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountInAtomic: string;
  minimumOutputAtomic: string;
  swapper: string;
  routerAddress: string;
  expiresAt: string;
}

export type O1GuardResult =
  | {
      success: true;
      code: 'allowed';
      checks: string[];
      semantics: {
        actionType: 'o1_exchange_swap';
        tokenAddresses: string[];
        recipients: string[];
        spenders: string[];
        spendAmountRaw: string;
        minimumOutputRaw: string;
        hops: number;
      };
    }
  | { success: false; code: string; reason: string; checks: string[] };

function fail(code: string, reason: string, checks: string[]): O1GuardResult {
  return { success: false, code, reason, checks };
}

function atomic(value: string): bigint | null {
  return /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
}

/** Strict decoder/guard for the exact two-call o1 standard swap batch. */
export function validateO1Swap(input: {
  chain: string | number;
  calls: BaseCall[];
  context?: O1SwapContext;
  now?: Date;
}): O1GuardResult {
  const checks: string[] = [];
  let chain;
  try {
    chain = normalizeBaseChain(input.chain);
  } catch {
    return fail('o1_wrong_chain', 'o1.exchange swap must target Base mainnet', checks);
  }
  if (chain.chainId !== 8453) {
    return fail('o1_wrong_chain', 'o1.exchange swap must target Base mainnet', checks);
  }
  checks.push('Base mainnet chain');

  const context = input.context;
  if (!context) return fail('o1_context_missing', 'o1.exchange context is required', checks);
  const router = context.routerAddress.toLowerCase();
  const inputToken = context.inputTokenAddress.toLowerCase();
  const outputToken = context.outputTokenAddress.toLowerCase();
  const swapper = context.swapper.toLowerCase();
  if (
    router !== O1_BASE_ROUTER_PROXY ||
    !ADDRESS.test(inputToken) ||
    !ADDRESS.test(outputToken) ||
    inputToken === outputToken ||
    !ADDRESS.test(swapper)
  ) {
    return fail('o1_context_invalid', 'o1.exchange assets, router, or wallet are invalid', checks);
  }
  const amountIn = atomic(context.amountInAtomic);
  const reviewedMinimum = atomic(context.minimumOutputAtomic);
  if (!amountIn || !reviewedMinimum || amountIn <= 0n || reviewedMinimum <= 0n) {
    return fail('o1_amount_invalid', 'o1.exchange amounts are invalid', checks);
  }
  const expiry = Date.parse(context.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= (input.now ?? new Date()).getTime()) {
    return fail('o1_quote_expired', 'Prepared o1.exchange route expired', checks);
  }
  if (!Array.isArray(input.calls) || input.calls.length !== 2) {
    return fail(
      'o1_batch_size_invalid',
      'o1.exchange requires one exact approval and one swap',
      checks,
    );
  }

  const [approvalCall, swapCall] = input.calls;
  let approvalValue: bigint;
  let swapValue: bigint;
  try {
    approvalValue = BigInt(String(approvalCall!.value ?? '0'));
    swapValue = BigInt(String(swapCall!.value ?? '0'));
  } catch {
    return fail('o1_value_invalid', 'o1.exchange call value is invalid', checks);
  }
  if (String(approvalCall!.to).toLowerCase() !== inputToken || approvalValue !== 0n) {
    return fail(
      'o1_approval_target_invalid',
      'o1.exchange approval must target only the input token',
      checks,
    );
  }
  try {
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: String(approvalCall!.data).toLowerCase() as Hex,
    });
    if (decoded.functionName !== 'approve') throw new TypeError('not approve');
    const [spender, amount] = decoded.args;
    if (spender.toLowerCase() !== router || amount !== amountIn) {
      return fail(
        'o1_approval_not_exact',
        'o1.exchange approval must be exact and router-bound',
        checks,
      );
    }
  } catch {
    return fail('o1_approval_invalid', 'o1.exchange approval calldata is invalid', checks);
  }
  checks.push('Exact input-token approval to pinned o1 router');

  if (String(swapCall!.to).toLowerCase() !== router || swapValue !== 0n) {
    return fail(
      'o1_swap_target_invalid',
      'o1.exchange swap must target only the pinned router',
      checks,
    );
  }
  let decodedSwap: ReturnType<typeof decodeFunctionData<typeof O1_SWAP_ABI>>;
  try {
    decodedSwap = decodeFunctionData({
      abi: O1_SWAP_ABI,
      data: String(swapCall!.data).toLowerCase() as Hex,
    });
  } catch {
    return fail('o1_swap_calldata_invalid', 'o1.exchange swap calldata is invalid', checks);
  }
  if (decodedSwap.functionName !== 'swap') {
    return fail('o1_swap_calldata_invalid', 'o1.exchange swap calldata is invalid', checks);
  }
  const [route, rawSettlementToken, decodedAmountIn, minimumOut] = decodedSwap.args;
  const settlementToken = rawSettlementToken.toLowerCase();
  if (
    route.length === 0 ||
    route.length > O1_MAX_HOPS ||
    (settlementToken !== inputToken && settlementToken !== outputToken) ||
    decodedAmountIn !== amountIn ||
    minimumOut < reviewedMinimum
  ) {
    return fail(
      'o1_swap_bounds_invalid',
      'o1.exchange route amounts or hop count exceed the review',
      checks,
    );
  }
  for (const [index, leg] of route.entries()) {
    const from = leg.tokenIn.toLowerCase();
    const to = leg.tokenOut.toLowerCase();
    const pool = leg.pool.toLowerCase();
    if (
      pool === ZERO_ADDRESS ||
      (index === 0 && from !== inputToken) ||
      (index === route.length - 1 && to !== outputToken) ||
      (index > 0 && from !== route[index - 1]!.tokenOut.toLowerCase())
    ) {
      return fail(
        'o1_route_asset_mismatch',
        'o1.exchange route does not match the reviewed assets',
        checks,
      );
    }
  }
  checks.push('Decoded route, exact input, reviewed minimum, and pinned router');
  return {
    success: true,
    code: 'allowed',
    checks,
    semantics: {
      actionType: 'o1_exchange_swap',
      tokenAddresses: [inputToken, outputToken],
      // The pinned o1 router settles to msg.sender; Base Account is the caller.
      recipients: [swapper],
      spenders: [router],
      spendAmountRaw: amountIn.toString(),
      minimumOutputRaw: minimumOut.toString(),
      hops: route.length,
    },
  };
}
