import { decodeFunctionData, erc20Abi } from 'viem';
import type { BaseCall } from './baseGuards.js';

export const BALANCER_V2_VAULT_BASE_V1 = '0xba12222222228d8ba445958a75a0704d566bf2c8';
export const BALANCER_PERMIT2_BASE_V1 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
export const BALANCER_V3_ROUTER_BASE_V1 = '0x3f170631ed9821ca51a59d996ab095162438dc10';
export const BALANCER_V3_BATCH_ROUTER_BASE_V1 = '0x85a80afee867adf27b50bdb7b76da70f1e853062';

const permit2ApproveAbi = [{
  type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [
    { name: 'token', type: 'address' }, { name: 'spender', type: 'address' },
    { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' },
  ], outputs: [],
}] as const;
const routerV3Abi = [{
  type: 'function', name: 'swapSingleTokenExactIn', stateMutability: 'payable',
  inputs: [
    { name: 'pool', type: 'address' }, { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' }, { name: 'exactAmountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    { name: 'wethIsEth', type: 'bool' }, { name: 'userData', type: 'bytes' },
  ], outputs: [{ name: '', type: 'uint256' }],
}] as const;
const batchRouterV3Abi = [{
  type: 'function', name: 'swapExactIn', stateMutability: 'payable',
  inputs: [
    {
      name: 'paths', type: 'tuple[]', components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'steps', type: 'tuple[]', components: [
          { name: 'pool', type: 'address' }, { name: 'tokenOut', type: 'address' },
          { name: 'isBuffer', type: 'bool' },
        ] },
        { name: 'exactAmountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' },
      ],
    },
    { name: 'deadline', type: 'uint256' }, { name: 'wethIsEth', type: 'bool' },
    { name: 'userData', type: 'bytes' },
  ],
  outputs: [
    { name: 'pathAmountsOut', type: 'uint256[]' }, { name: 'tokensOut', type: 'address[]' },
    { name: 'amountsOut', type: 'uint256[]' },
  ],
}] as const;
const vaultV2Abi = [
  {
    type: 'function', name: 'swap', stateMutability: 'payable',
    inputs: [
      { name: 'singleSwap', type: 'tuple', components: [
        { name: 'poolId', type: 'bytes32' }, { name: 'kind', type: 'uint8' },
        { name: 'assetIn', type: 'address' }, { name: 'assetOut', type: 'address' },
        { name: 'amount', type: 'uint256' }, { name: 'userData', type: 'bytes' },
      ] },
      { name: 'funds', type: 'tuple', components: [
        { name: 'sender', type: 'address' }, { name: 'fromInternalBalance', type: 'bool' },
        { name: 'recipient', type: 'address' }, { name: 'toInternalBalance', type: 'bool' },
      ] },
      { name: 'limit', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ], outputs: [{ name: 'amountCalculated', type: 'uint256' }],
  },
  {
    type: 'function', name: 'batchSwap', stateMutability: 'payable',
    inputs: [
      { name: 'kind', type: 'uint8' },
      { name: 'swaps', type: 'tuple[]', components: [
        { name: 'poolId', type: 'bytes32' }, { name: 'assetInIndex', type: 'uint256' },
        { name: 'assetOutIndex', type: 'uint256' }, { name: 'amount', type: 'uint256' },
        { name: 'userData', type: 'bytes' },
      ] },
      { name: 'assets', type: 'address[]' },
      { name: 'funds', type: 'tuple', components: [
        { name: 'sender', type: 'address' }, { name: 'fromInternalBalance', type: 'bool' },
        { name: 'recipient', type: 'address' }, { name: 'toInternalBalance', type: 'bool' },
      ] },
      { name: 'limits', type: 'int256[]' }, { name: 'deadline', type: 'uint256' },
    ], outputs: [{ name: 'assetDeltas', type: 'int256[]' }],
  },
] as const;

export interface BalancerSwapContext {
  protocolVersion: 2 | 3;
  inputTokenAddress: string;
  outputTokenAddress: string;
  amountInAtomic: string;
  minimumOutputAtomic: string;
  walletAddress: string;
  routerAddress: string;
  sourceKeys: string[];
}

export type BalancerGuardResult =
  | { success: true; code: 'allowed'; checks: string[] }
  | { success: false; code: string; reason: string; checks: string[] };

function fail(code: string, reason: string, checks: string[]): BalancerGuardResult {
  return { success: false, code, reason, checks };
}
function poolsFromSources(sourceKeys: readonly string[]): Set<string> {
  return new Set(sourceKeys.map((key) => key.split(':')[2]?.toLowerCase()).filter((value): value is string => Boolean(value)));
}
function decodeExactErc20Approval(call: BaseCall): { spender: string; amount: bigint } | null {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: String(call.data) as `0x${string}` });
    if (decoded.functionName !== 'approve') return null;
    const [spender, amount] = decoded.args as readonly [string, bigint];
    return { spender: spender.toLowerCase(), amount };
  } catch { return null; }
}
function validDeadline(deadline: bigint, now: Date): boolean {
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  return deadline > nowSeconds && deadline <= nowSeconds + 300n;
}

export function validateBalancerSwap(input: {
  chain: string | number;
  calls: BaseCall[];
  context?: BalancerSwapContext;
  now?: Date;
}): BalancerGuardResult {
  const checks: string[] = [];
  const context = input.context;
  if (Number(input.chain) !== 8453) return fail('balancer_wrong_chain', 'Balancer swap must target Base mainnet', checks);
  if (!context) return fail('balancer_context_missing', 'Balancer swap context is required', checks);
  const amountIn = BigInt(context.amountInAtomic);
  const minimumOut = BigInt(context.minimumOutputAtomic);
  const tokenIn = context.inputTokenAddress.toLowerCase();
  const tokenOut = context.outputTokenAddress.toLowerCase();
  const wallet = context.walletAddress.toLowerCase();
  const router = context.routerAddress.toLowerCase();
  const pools = poolsFromSources(context.sourceKeys);
  if (amountIn <= 0n || minimumOut <= 0n || pools.size === 0) {
    return fail('balancer_context_invalid', 'Balancer amount or reviewed pools are invalid', checks);
  }
  const expectedRouter = context.protocolVersion === 2
    ? BALANCER_V2_VAULT_BASE_V1
    : router === BALANCER_V3_ROUTER_BASE_V1 || router === BALANCER_V3_BATCH_ROUTER_BASE_V1
      ? router : '';
  if (!expectedRouter || router !== expectedRouter) {
    return fail('balancer_router_not_pinned', 'Balancer router is not pinned for Base', checks);
  }
  const expectedCalls = context.protocolVersion === 2 ? 2 : 3;
  if (input.calls.length !== expectedCalls) {
    return fail('balancer_batch_size_invalid', `Balancer v${context.protocolVersion} requires ${expectedCalls} calls`, checks);
  }
  const erc20Approval = decodeExactErc20Approval(input.calls[0]!);
  const approvalSpender = context.protocolVersion === 2 ? BALANCER_V2_VAULT_BASE_V1 : BALANCER_PERMIT2_BASE_V1;
  if (
    input.calls[0]!.to.toLowerCase() !== tokenIn ||
    BigInt(String(input.calls[0]!.value ?? '0')) !== 0n ||
    !erc20Approval || erc20Approval.spender !== approvalSpender || erc20Approval.amount !== amountIn
  ) return fail('balancer_approval_invalid', 'Input token approval is not exact or targets an unpinned spender', checks);

  let swapIndex = 1;
  if (context.protocolVersion === 3) {
    swapIndex = 2;
    const permitCall = input.calls[1]!;
    try {
      const decoded = decodeFunctionData({ abi: permit2ApproveAbi, data: String(permitCall.data) as `0x${string}` });
      const [permitToken, spender, amount, expiration] = decoded.args as readonly [string, string, bigint, number];
      if (
        permitCall.to.toLowerCase() !== BALANCER_PERMIT2_BASE_V1 ||
        BigInt(String(permitCall.value ?? '0')) !== 0n ||
        permitToken.toLowerCase() !== tokenIn || spender.toLowerCase() !== router ||
        amount !== amountIn || !validDeadline(BigInt(expiration), input.now ?? new Date())
      ) return fail('balancer_permit2_invalid', 'Permit2 approval is not exact, bounded, and router-scoped', checks);
    } catch {
      return fail('balancer_permit2_invalid', 'Permit2 approval calldata is unreadable', checks);
    }
  }
  const swapCall = input.calls[swapIndex]!;
  if (swapCall.to.toLowerCase() !== router || BigInt(String(swapCall.value ?? '0')) !== 0n) {
    return fail('balancer_swap_target_invalid', 'Balancer swap target or native value is invalid', checks);
  }
  try {
    if (context.protocolVersion === 3 && router === BALANCER_V3_ROUTER_BASE_V1) {
      const decoded = decodeFunctionData({ abi: routerV3Abi, data: String(swapCall.data) as `0x${string}` });
      const [pool, inToken, outToken, exactIn, minOut, deadline, wethIsEth] =
        decoded.args as readonly [string, string, string, bigint, bigint, bigint, boolean, string];
      if (
        !pools.has(pool.toLowerCase()) || inToken.toLowerCase() !== tokenIn ||
        outToken.toLowerCase() !== tokenOut || exactIn !== amountIn || minOut < minimumOut ||
        wethIsEth || !validDeadline(deadline, input.now ?? new Date())
      ) return fail('balancer_swap_semantics_invalid', 'Balancer V3 swap differs from the reviewed route', checks);
    } else if (context.protocolVersion === 3) {
      const decoded = decodeFunctionData({ abi: batchRouterV3Abi, data: String(swapCall.data) as `0x${string}` });
      const [paths, deadline, wethIsEth] = decoded.args as readonly [
        readonly { tokenIn: string; steps: readonly { pool: string; tokenOut: string }[]; exactAmountIn: bigint; minAmountOut: bigint }[],
        bigint, boolean, string,
      ];
      const totalIn = paths.reduce((sum, path) => sum + path.exactAmountIn, 0n);
      const totalMin = paths.reduce((sum, path) => sum + path.minAmountOut, 0n);
      if (
        paths.length === 0 || totalIn !== amountIn || totalMin < minimumOut || wethIsEth ||
        !validDeadline(deadline, input.now ?? new Date()) ||
        paths.some((path) =>
          path.tokenIn.toLowerCase() !== tokenIn || path.steps.length === 0 ||
          path.steps.at(-1)!.tokenOut.toLowerCase() !== tokenOut ||
          path.steps.some((step) => !pools.has(step.pool.toLowerCase())))
      ) return fail('balancer_swap_semantics_invalid', 'Balancer V3 batch differs from the reviewed route', checks);
    } else {
      const decoded = decodeFunctionData({ abi: vaultV2Abi, data: String(swapCall.data) as `0x${string}` });
      if (decoded.functionName === 'swap') {
        const [swap, funds, limit, deadline] = decoded.args as readonly [
          { poolId: string; kind: number; assetIn: string; assetOut: string; amount: bigint },
          { sender: string; recipient: string; fromInternalBalance: boolean; toInternalBalance: boolean },
          bigint, bigint,
        ];
        if (
          swap.kind !== 0 || !pools.has(swap.poolId.toLowerCase()) ||
          swap.assetIn.toLowerCase() !== tokenIn || swap.assetOut.toLowerCase() !== tokenOut ||
          swap.amount !== amountIn || limit < minimumOut ||
          funds.sender.toLowerCase() !== wallet || funds.recipient.toLowerCase() !== wallet ||
          funds.fromInternalBalance || funds.toInternalBalance ||
          !validDeadline(deadline, input.now ?? new Date())
        ) return fail('balancer_swap_semantics_invalid', 'Balancer V2 swap differs from the reviewed route', checks);
      } else {
        const [kind, swaps, assets, funds, limits, deadline] = decoded.args as readonly [
          number,
          readonly { poolId: string; amount: bigint }[],
          readonly string[],
          { sender: string; recipient: string; fromInternalBalance: boolean; toInternalBalance: boolean },
          readonly bigint[], bigint,
        ];
        const inputIndex = assets.findIndex((asset) => asset.toLowerCase() === tokenIn);
        const outputIndex = assets.findIndex((asset) => asset.toLowerCase() === tokenOut);
        if (
          kind !== 0 || inputIndex < 0 || outputIndex < 0 ||
          limits[inputIndex] !== amountIn || (limits[outputIndex] ?? 0n) > -minimumOut ||
          funds.sender.toLowerCase() !== wallet || funds.recipient.toLowerCase() !== wallet ||
          funds.fromInternalBalance || funds.toInternalBalance ||
          swaps.some((swap) => !pools.has(swap.poolId.toLowerCase())) ||
          !validDeadline(deadline, input.now ?? new Date())
        ) return fail('balancer_swap_semantics_invalid', 'Balancer V2 batch differs from the reviewed route', checks);
      }
    }
  } catch {
    return fail('balancer_swap_calldata_unreadable', 'Balancer swap calldata is not a supported exact-input call', checks);
  }
  checks.push('Base chain and pinned Balancer contracts');
  checks.push('Exact bounded approvals');
  checks.push('Reviewed pools, assets, amount, minimum output and deadline');
  return { success: true, code: 'allowed', checks };
}
