import { canonicalUsdcForBaseChain, normalizeBaseChain, type BaseCall } from './baseGuards.js';
import { BASE_WETH_ADDRESS } from './uniswapGuard.js';

// Pinned independently of @mioagent/swap-adapters (which depends on
// @mioagent/security, so the reverse dependency is not available here). Must
// stay equal to swap-adapters' KYBERSWAP_BASE_ROUTER constant.
export const KYBERSWAP_BASE_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';

const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX_DATA = /^0x[0-9a-f]+$/;

/** The canonical Base assets this guard will validate a swap between. */
export type KyberGuardAsset = 'USDC' | 'ETH' | 'WETH';

export interface KyberSwapContext {
  amountDecimal: string;
  /** Was fixed at 'USDC'. Widened so the same pinning rules cover the other
   * direction; decimals, the approval target and the native-value rule are all
   * derived from this rather than assumed. */
  inputToken: KyberGuardAsset;
  outputToken: KyberGuardAsset;
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
}

export type KyberGuardResult =
  | { success: true; code: 'allowed'; checks: string[]; semantics: KyberSwapSemantics }
  | { success: false; code: string; reason: string; checks: string[] };

function fail(code: string, reason: string, checks: string[]): KyberGuardResult {
  return { success: false, code, reason, checks };
}

/** Base units at the asset's OWN precision — six is USDC's, not everyone's. */
function decimalToRaw(value: string, decimals: number): bigint | null {
  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  try {
    const amount = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
}

function decimalsFor(asset: KyberGuardAsset): number {
  return asset === 'USDC' ? 6 : 18;
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
  const ASSETS: readonly KyberGuardAsset[] = ['USDC', 'ETH', 'WETH'];
  if (!context || !ASSETS.includes(context.inputToken) || !ASSETS.includes(context.outputToken)) {
    return fail('kyberswap_context_invalid', 'Only canonical Base USDC, ETH and WETH are supported', checks);
  }
  // ETH↔WETH is a wrap, not a routed swap.
  const sideOf = (asset: KyberGuardAsset) => (asset === 'USDC' ? 'usdc' : 'weth');
  if (sideOf(context.inputToken) === sideOf(context.outputToken)) {
    return fail('kyberswap_context_invalid', 'Input and output must be different canonical assets', checks);
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
  const amountRaw = decimalToRaw(context.amountDecimal, decimalsFor(context.inputToken));
  if (!amountRaw) return fail('kyberswap_amount_invalid', 'Input amount is invalid', checks);
  checks.push(`Exact positive ${context.inputToken} input, pinned router, and unexpired route`);

  if (!Array.isArray(input.calls) || input.calls.length < 1 || input.calls.length > 2) {
    return fail('kyberswap_batch_size_invalid', 'KyberSwap swap must contain one or two calls', checks);
  }
  const usdc = canonicalUsdcForBaseChain(8453).toLowerCase();
  const router = KYBERSWAP_BASE_ROUTER;
  const inputAddress =
    context.inputToken === 'ETH' ? null : context.inputToken === 'USDC' ? usdc : BASE_WETH_ADDRESS;
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
      spendAmountUsdc: context.inputToken === 'USDC' ? Number(amountRaw) / 1_000_000 : 0,
    },
  };
}
