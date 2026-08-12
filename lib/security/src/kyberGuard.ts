import { normalizeBaseChain, type BaseCall } from './baseGuards.js';
import {
  decimalAmountToRawV1,
  isCanonicalBaseUsdcV1,
  normalizeSwapAssetV1,
  type SwapGuardAssetV1,
} from './swapAsset.js';

// Pinned independently of @mioagent/swap-adapters (which depends on
// @mioagent/security, so the reverse dependency is not available here). Must
// stay equal to swap-adapters' KYBERSWAP_BASE_ROUTER constant.
export const KYBERSWAP_BASE_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';

const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX_DATA = /^0x[0-9a-f]+$/;

export interface KyberSwapContext {
  amountDecimal: string;
  /**
   * The asset itself — address and decimals — not a symbol out of a set of
   * three. Decimals, the approval target and the native-value rule are all
   * derived from it.
   */
  inputAsset: SwapGuardAssetV1;
  outputAsset: SwapGuardAssetV1;
  swapper: string;
  recipient: string;
  routerAddress: string;
  expiresAt: string;
}

export interface KyberSwapSemantics {
  actionType: 'kyberswap_swap';
  tokenAddresses: string[];
  recipients: string[];
  spenders: string[];
  spendAmountRaw: string;
  spendAmountUsdc: number;
  /** False whenever the input is not canonical USDC: the figure above is then
   * 0, and a dollar budget must refuse rather than read that as free. */
  spendAmountIsUsd: boolean;
}

export type KyberGuardResult =
  | { success: true; code: 'allowed'; checks: string[]; semantics: KyberSwapSemantics }
  | { success: false; code: string; reason: string; checks: string[] };

function fail(code: string, reason: string, checks: string[]): KyberGuardResult {
  return { success: false, code, reason, checks };
}

function wordAddress(word: string): string | null {
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) return null;
  return `0x${word.slice(24)}`;
}

/** Strict validation for server-built, Base-only KyberSwap route/build batches. */
export function validateKyberSwap(input: {
  chain: string | number;
  calls: BaseCall[];
  context?: KyberSwapContext;
  /** Injectable clock for deterministic expiry checks; defaults to wall time. */
  now?: Date;
}): KyberGuardResult {
  const nowMs = (input.now ?? new Date()).getTime();
  const checks: string[] = [];
  let chain;
  try {
    chain = normalizeBaseChain(input.chain);
  } catch {
    return fail('kyberswap_wrong_chain', 'KyberSwap swap must target Base mainnet', checks);
  }
  if (chain.chainId !== 8453) {
    return fail('kyberswap_wrong_chain', 'KyberSwap swap must target Base mainnet', checks);
  }
  checks.push('Base mainnet chain');

  const context = input.context;
  // The pinned router can never also be a swap side: the loop below decides
  // what a call means by comparing its target against both.
  const inputAsset = normalizeSwapAssetV1(context?.inputAsset, [KYBERSWAP_BASE_ROUTER]);
  const outputAsset = normalizeSwapAssetV1(context?.outputAsset, [KYBERSWAP_BASE_ROUTER]);
  if (!context || !inputAsset || !outputAsset) {
    return fail(
      'kyberswap_context_invalid',
      'Each swap side must be native ETH or a valid ERC-20 address with readable decimals',
      checks,
    );
  }
  // ETH↔WETH is a wrap, not a routed swap.
  if (inputAsset.side === outputAsset.side) {
    return fail('kyberswap_context_invalid', 'Input and output must be different assets', checks);
  }
  if (context.routerAddress.toLowerCase() !== KYBERSWAP_BASE_ROUTER) {
    return fail('kyberswap_router_not_pinned', 'KyberSwap router is not the pinned Base router', checks);
  }
  const swapper = context.swapper.toLowerCase();
  const recipient = context.recipient.toLowerCase();
  if (!ADDRESS.test(swapper) || !ADDRESS.test(recipient) || swapper !== recipient) {
    return fail(
      'kyberswap_wallet_binding_invalid',
      'KyberSwap swap sender and recipient must both equal the authenticated wallet',
      checks,
    );
  }
  const expiry = Date.parse(context.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= nowMs) {
    return fail('kyberswap_quote_expired', 'Prepared KyberSwap route expired', checks);
  }
  const amountRaw = decimalAmountToRawV1(context.amountDecimal, inputAsset.decimals);
  if (!amountRaw) return fail('kyberswap_amount_invalid', 'Input amount is invalid', checks);
  // Named by ADDRESS, never by the contract's own symbol — this string is
  // evidence, and a symbol is whatever the token says it is.
  const inputLabel = inputAsset.address ?? 'native ETH';
  checks.push(`Exact positive input (${inputLabel}), pinned router, and unexpired route`);

  if (!Array.isArray(input.calls) || input.calls.length < 1 || input.calls.length > 2) {
    return fail('kyberswap_batch_size_invalid', 'KyberSwap swap must contain one or two calls', checks);
  }
  const router = KYBERSWAP_BASE_ROUTER;
  const inputAddress = inputAsset.address;
  const inputIsNative = inputAddress === null;
  let routerCalls = 0;
  let approvalCalls = 0;
  let attachedValue = 0n;
  const spenders = new Set<string>();

  for (const call of input.calls) {
    const to = String(call.to || '').toLowerCase();
    const data = String(call.data || '').toLowerCase();
    let value: bigint;
    try {
      value = BigInt(String(call.value || '0'));
    } catch {
      return fail('kyberswap_value_invalid', 'Call value is invalid', checks);
    }
    // A native input attaches its amount to the router call and nowhere else.
    if (value < 0n) return fail('kyberswap_value_invalid', 'Call value is invalid', checks);
    if (value !== 0n && (!inputIsNative || to !== router)) {
      return fail('kyberswap_native_value_blocked', 'Only a native-input router call may carry value', checks);
    }
    attachedValue += value;
    if (!ADDRESS.test(to) || !HEX_DATA.test(data) || data.length < 10) {
      return fail('kyberswap_call_malformed', 'KyberSwap call target or calldata is malformed', checks);
    }

    if (to === router) {
      routerCalls += 1;
      continue;
    }

    if (inputAddress && to === inputAddress) {
      if (data.length !== 138 || data.slice(0, 10) !== ERC20_APPROVE_SELECTOR) {
        return fail('kyberswap_approval_invalid', 'The input token call must be an exact approve', checks);
      }
      const spender = wordAddress(data.slice(10, 74));
      const approved = BigInt(`0x${data.slice(74, 138)}`);
      if (spender !== router || approved !== amountRaw) {
        return fail(
          'kyberswap_approval_not_exact',
          'The input approval must be exact and limited to the pinned router',
          checks,
        );
      }
      approvalCalls += 1;
      spenders.add(spender);
      continue;
    }

    return fail('kyberswap_target_not_allowlisted', `KyberSwap call target ${to} is not allowlisted`, checks);
  }

  if (routerCalls !== 1) {
    return fail('kyberswap_router_call_invalid', 'Exactly one pinned KyberSwap router call is required', checks);
  }
  if (approvalCalls > 1) {
    return fail('kyberswap_approval_count_invalid', 'At most one exact input approval is allowed', checks);
  }
  const expectedValue = inputIsNative ? amountRaw : 0n;
  if (attachedValue !== expectedValue) {
    return fail('kyberswap_native_value_mismatch', 'Attached native value must equal the input amount exactly', checks);
  }
  if (inputIsNative && approvalCalls > 0) {
    return fail('kyberswap_native_input_approval', 'A native-input swap must contain no approval', checks);
  }
  checks.push('Pinned KyberSwap router target and at most one exact approval');
  return {
    success: true,
    code: 'allowed',
    checks,
    semantics: {
      actionType: 'kyberswap_swap',
      tokenAddresses: inputAddress ? [inputAddress] : [],
      recipients: [recipient],
      spenders: [...spenders],
      spendAmountRaw: amountRaw.toString(),
      spendAmountUsdc: isCanonicalBaseUsdcV1(inputAddress) ? Number(amountRaw) / 1_000_000 : 0,
      spendAmountIsUsd: isCanonicalBaseUsdcV1(inputAddress),
    },
  };
}
