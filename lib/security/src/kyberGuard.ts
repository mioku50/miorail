import { canonicalUsdcForBaseChain, normalizeBaseChain, type BaseCall } from './baseGuards.js';

// Pinned independently of @mioagent/swap-adapters (which depends on
// @mioagent/security, so the reverse dependency is not available here). Must
// stay equal to swap-adapters' KYBERSWAP_BASE_ROUTER constant.
export const KYBERSWAP_BASE_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';

const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX_DATA = /^0x[0-9a-f]+$/;

export interface KyberSwapContext {
  amountDecimal: string;
  inputToken: 'USDC';
  outputToken: 'ETH' | 'WETH';
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

function decimalUsdc(value: string): bigint | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  try {
    const amount = BigInt(`${whole}${fraction.padEnd(6, '0')}`);
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
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
  if (!context || context.inputToken !== 'USDC' || !['ETH', 'WETH'].includes(context.outputToken)) {
    return fail('kyberswap_context_invalid', 'Only canonical Base USDC to ETH/WETH is supported', checks);
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
  const amountRaw = decimalUsdc(context.amountDecimal);
  if (!amountRaw) return fail('kyberswap_amount_invalid', 'USDC input amount is invalid', checks);
  checks.push('Exact positive USDC input, pinned router, and unexpired route');

  if (!Array.isArray(input.calls) || input.calls.length < 1 || input.calls.length > 2) {
    return fail('kyberswap_batch_size_invalid', 'KyberSwap swap must contain one or two calls', checks);
  }
  const usdc = canonicalUsdcForBaseChain(8453).toLowerCase();
  const router = KYBERSWAP_BASE_ROUTER;
  let routerCalls = 0;
  let approvalCalls = 0;
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
    if (value !== 0n) {
      return fail('kyberswap_native_value_blocked', 'USDC-input swaps cannot transfer native value', checks);
    }
    if (!ADDRESS.test(to) || !HEX_DATA.test(data) || data.length < 10) {
      return fail('kyberswap_call_malformed', 'KyberSwap call target or calldata is malformed', checks);
    }

    if (to === router) {
      routerCalls += 1;
      continue;
    }

    if (to === usdc) {
      if (data.length !== 138 || data.slice(0, 10) !== ERC20_APPROVE_SELECTOR) {
        return fail('kyberswap_approval_invalid', 'USDC call must be an exact approve', checks);
      }
      const spender = wordAddress(data.slice(10, 74));
      const approved = BigInt(`0x${data.slice(74, 138)}`);
      if (spender !== router || approved !== amountRaw) {
        return fail(
          'kyberswap_approval_not_exact',
          'USDC approval must be exact and limited to the pinned router',
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
    return fail('kyberswap_approval_count_invalid', 'At most one exact USDC approval is allowed', checks);
  }
  checks.push('Pinned KyberSwap router target and at most one exact approval');
  return {
    success: true,
    code: 'allowed',
    checks,
    semantics: {
      actionType: 'kyberswap_swap',
      tokenAddresses: [usdc],
      recipients: [recipient],
      spenders: [...spenders],
      spendAmountRaw: amountRaw.toString(),
      spendAmountUsdc: Number(amountRaw) / 1_000_000,
    },
  };
}
