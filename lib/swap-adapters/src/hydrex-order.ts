import { decodeFunctionData, erc20Abi, keccak256, type Hex } from 'viem';
import type { AssetRefV1, LiquiditySourceRefV1 } from '@mioagent/route-domain';
import {
  HYDREX_BASE_ROUTER_PROXY_V1,
  HYDREX_EXECUTE_SWAPS_ABI_V1,
  hydrexInnerSelectorForSourceV1,
  hydrexSourceForRouterV1,
  type HydrexPinnedSourceV1,
} from './hydrex-pinned.js';
import {
  HydrexPrepareSwapResponseV1Schema,
  HydrexQuoteResponseV1Schema,
  type HydrexPrepareSwapRequestV1,
  type HydrexQuoteRequestV1,
} from './hydrex-client.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_INNER_CALLDATA_CHARS = 32_770;

export interface ParsedHydrexSwapV1 {
  amountInAtomic: string;
  expectedOutputAtomic: string;
  minimumOutputAtomic: string;
  recipient: `0x${string}`;
  routerAddress: typeof HYDREX_BASE_ROUTER_PROXY_V1;
  upstreamRouter: `0x${string}`;
  upstreamSource: HydrexPinnedSourceV1;
  deadline: string;
  swapCall: { to: `0x${string}`; value: string; data: `0x${string}` };
  liquiditySources: LiquiditySourceRefV1[];
  safeResponse: Record<string, unknown>;
}

export type ParseHydrexSwapResultV1 =
  | { ok: true; value: ParsedHydrexSwapV1 }
  | { ok: false; errorCode: string };

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseOuter(input: {
  data: string;
  to: string;
  value: string;
  inputAsset: AssetRefV1;
  outputAsset: AssetRefV1;
  amountInAtomic: string;
  expectedOutputAtomic: string;
  slippageBps: number;
  responseMinimumOutputAtomic?: string;
  recipient: string;
  now: Date;
}): ParseHydrexSwapResultV1 {
  if (
    !input.inputAsset.address ||
    !input.outputAsset.address ||
    !sameAddress(input.to, HYDREX_BASE_ROUTER_PROXY_V1)
  ) return { ok: false, errorCode: 'hydrex_target_or_asset_mismatch' };
  let value: bigint;
  try {
    value = BigInt(input.value);
  } catch {
    return { ok: false, errorCode: 'hydrex_transaction_value_invalid' };
  }
  if (value !== 0n) return { ok: false, errorCode: 'hydrex_native_value_unsupported' };
  let decoded: ReturnType<typeof decodeFunctionData<typeof HYDREX_EXECUTE_SWAPS_ABI_V1>>;
  try {
    decoded = decodeFunctionData({ abi: HYDREX_EXECUTE_SWAPS_ABI_V1, data: input.data.toLowerCase() as Hex });
  } catch {
    return { ok: false, errorCode: 'hydrex_swap_calldata_invalid' };
  }
  if (decoded.functionName !== 'executeSwaps' || decoded.args[0].length !== 1) {
    return { ok: false, errorCode: 'hydrex_swap_count_invalid' };
  }
  const swap = decoded.args[0][0]!;
  const deadline = decoded.args[1];
  const source = hydrexSourceForRouterV1(swap.router);
  if (!source) return { ok: false, errorCode: 'hydrex_upstream_router_not_allowlisted' };
  if (
    !sameAddress(swap.inputAsset, input.inputAsset.address) ||
    !sameAddress(swap.outputAsset, input.outputAsset.address) ||
    swap.inputAmount.toString() !== input.amountInAtomic ||
    !sameAddress(swap.recipient, input.recipient) ||
    swap.origin.toLowerCase() !== 'hydrex' ||
    !sameAddress(swap.referral, ZERO_ADDRESS) ||
    swap.referralFeeBps !== 0n
  ) return { ok: false, errorCode: 'hydrex_swap_semantics_mismatch' };
  const expected = BigInt(input.expectedOutputAtomic);
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 10_000) {
    return { ok: false, errorCode: 'hydrex_output_bounds_invalid' };
  }
  const requestedMinimum = expected * BigInt(10_000 - input.slippageBps) / 10_000n;
  if (
    expected <= 0n || swap.minOutputAmount <= 0n || swap.minOutputAmount > expected ||
    swap.minOutputAmount < requestedMinimum
  ) {
    return { ok: false, errorCode: 'hydrex_output_bounds_invalid' };
  }
  if (
    input.responseMinimumOutputAtomic !== undefined &&
    swap.minOutputAmount.toString() !== input.responseMinimumOutputAtomic
  ) return { ok: false, errorCode: 'hydrex_minimum_echo_mismatch' };
  if (
    deadline * 1000n <= BigInt(input.now.getTime()) ||
    deadline * 1000n > BigInt(input.now.getTime() + 30 * 60_000)
  ) return { ok: false, errorCode: 'hydrex_deadline_invalid' };
  if (
    !/^0x[0-9a-fA-F]+$/.test(swap.callData) ||
    swap.callData.length < 10 ||
    swap.callData.length > MAX_INNER_CALLDATA_CHARS ||
    swap.callData.slice(0, 10).toLowerCase() !== hydrexInnerSelectorForSourceV1(source)
  ) return { ok: false, errorCode: 'hydrex_inner_calldata_invalid' };
  const upstream = swap.router.toLowerCase() as `0x${string}`;
  const upstreamProvider = source === 'ZEROX' ? 'zerox' : 'kyberswap';
  const sourceKey = `eip155:8453/hydrex:${upstreamProvider}:${upstream}`;
  return {
    ok: true,
    value: {
      amountInAtomic: input.amountInAtomic,
      expectedOutputAtomic: input.expectedOutputAtomic,
      minimumOutputAtomic: swap.minOutputAmount.toString(),
      recipient: input.recipient.toLowerCase() as `0x${string}`,
      routerAddress: HYDREX_BASE_ROUTER_PROXY_V1,
      upstreamRouter: upstream,
      upstreamSource: source,
      deadline: deadline.toString(),
      swapCall: { to: HYDREX_BASE_ROUTER_PROXY_V1, value: '0', data: input.data.toLowerCase() as `0x${string}` },
      liquiditySources: [{
        sourceKey,
        chainId: 8453,
        protocol: 'hydrex',
        poolAddress: null,
        assets: [input.inputAsset, input.outputAsset],
        upstreamProvider,
      }],
      safeResponse: {
        amountIn: input.amountInAtomic,
        amountOut: input.expectedOutputAtomic,
        minOutputAmount: swap.minOutputAmount.toString(),
        recipient: input.recipient.toLowerCase(),
        transaction: {
          to: HYDREX_BASE_ROUTER_PROXY_V1,
          value: '0',
          dataHash: keccak256(input.data.toLowerCase() as Hex),
          upstreamRouter: upstream,
          upstreamSource: source,
          innerSelector: swap.callData.slice(0, 10).toLowerCase(),
          innerDataHash: keccak256(swap.callData.toLowerCase() as Hex),
          deadline: deadline.toString(),
        },
      },
    },
  };
}

export function parseHydrexQuoteV1(input: {
  payload: unknown;
  request: HydrexQuoteRequestV1;
  inputAsset: AssetRefV1;
  outputAsset: AssetRefV1;
  now: Date;
}): ParseHydrexSwapResultV1 {
  const parsed = HydrexQuoteResponseV1Schema.safeParse(input.payload);
  if (!parsed.success) return { ok: false, errorCode: 'hydrex_quote_invalid_schema' };
  const response = parsed.data.data;
  if (response.amountIn !== input.request.amount || !sameAddress(response.recipient, input.request.recipient)) {
    return { ok: false, errorCode: 'hydrex_quote_echo_mismatch' };
  }
  return parseOuter({
    data: response.transaction.data,
    to: response.transaction.to,
    value: response.transaction.value,
    inputAsset: input.inputAsset,
    outputAsset: input.outputAsset,
    amountInAtomic: response.amountIn,
    expectedOutputAtomic: response.amountOut,
    slippageBps: input.request.slippage,
    responseMinimumOutputAtomic: response.minOutputAmount,
    recipient: response.recipient,
    now: input.now,
  });
}

export function parseHydrexPrepareSwapV1(input: {
  payload: unknown;
  request: HydrexPrepareSwapRequestV1;
  inputAsset: AssetRefV1;
  outputAsset: AssetRefV1;
  amountInAtomic: string;
  now: Date;
}): ParseHydrexSwapResultV1 {
  const parsed = HydrexPrepareSwapResponseV1Schema.safeParse(input.payload);
  if (!parsed.success) return { ok: false, errorCode: 'hydrex_prepare_invalid_schema' };
  const response = parsed.data;
  if (
    !sameAddress(response.quote.tokenIn, input.request.tokenIn) ||
    !sameAddress(response.quote.tokenOut, input.request.tokenOut) ||
    response.quote.amountIn !== input.amountInAtomic ||
    !sameAddress(response.approval.token, input.request.tokenIn) ||
    !sameAddress(response.approval.spender, HYDREX_BASE_ROUTER_PROXY_V1) ||
    response.approval.amount !== input.amountInAtomic
  ) return { ok: false, errorCode: 'hydrex_prepare_echo_mismatch' };
  const swapTransactions = response.transactions.filter((transaction) => transaction.step === 'swap');
  const approvalTransactions = response.transactions.filter((transaction) => transaction.step === 'approve-tokenIn');
  if (swapTransactions.length !== 1 || approvalTransactions.length > 1) {
    return { ok: false, errorCode: 'hydrex_prepare_call_count_invalid' };
  }
  if (response.approval.required !== (approvalTransactions.length === 1)) {
    return { ok: false, errorCode: 'hydrex_prepare_approval_mismatch' };
  }
  if (approvalTransactions.length === 1) {
    const approval = approvalTransactions[0]!;
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: approval.data.toLowerCase() as Hex });
      if (
        decoded.functionName !== 'approve' ||
        !sameAddress(decoded.args[0], HYDREX_BASE_ROUTER_PROXY_V1) ||
        decoded.args[1].toString() !== input.amountInAtomic ||
        !sameAddress(approval.to, input.request.tokenIn) ||
        BigInt(approval.value) !== 0n
      ) return { ok: false, errorCode: 'hydrex_provider_approval_invalid' };
    } catch {
      return { ok: false, errorCode: 'hydrex_provider_approval_invalid' };
    }
  }
  const swap = swapTransactions[0]!;
  return parseOuter({
    data: swap.data,
    to: swap.to,
    value: swap.value,
    inputAsset: input.inputAsset,
    outputAsset: input.outputAsset,
    amountInAtomic: input.amountInAtomic,
    expectedOutputAtomic: response.quote.amountOut,
    slippageBps: input.request.slippage,
    recipient: input.request.recipient,
    now: input.now,
  });
}
