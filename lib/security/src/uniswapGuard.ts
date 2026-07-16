import { canonicalUsdcForBaseChain, normalizeBaseChain, type BaseCall } from './baseGuards.js';

export const BASE_UNISWAP_UNIVERSAL_ROUTER_2 = '0x6ff5693b99212da76ad316178a184ab56d299b43';
export const BASE_UNISWAP_UNIVERSAL_ROUTER_2_1_1 = '0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7';
export const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3';
export const BASE_WETH_ADDRESS = '0x4200000000000000000000000000000000000006';

const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
const PERMIT2_APPROVE_SELECTOR = '0x87517c45';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX_DATA = /^0x[0-9a-f]+$/;

export interface UniswapSwapContext {
  amountDecimal: string;
  inputToken: 'USDC';
  outputToken: 'ETH' | 'WETH';
  swapper: string;
  routerVersion: '2.0';
  expiresAt: string;
}

export interface UniswapSwapSemantics {
  actionType: 'uniswap_swap';
  tokenAddresses: string[];
  recipients: string[];
  spenders: string[];
  spendAmountRaw: string;
  spendAmountUsdc: number;
}

export type UniswapGuardResult =
  | { success: true; code: 'allowed'; checks: string[]; semantics: UniswapSwapSemantics }
  | { success: false; code: string; reason: string; checks: string[] };

function fail(code: string, reason: string, checks: string[]): UniswapGuardResult {
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

/** Strict validation for server-prepared, Base-only Uniswap 5792 batches. */
export function validateUniswapSwap(input: {
  chain: string | number;
  calls: BaseCall[];
  context?: UniswapSwapContext;
  /** Injectable clock for deterministic expiry checks; defaults to wall time. */
  now?: Date;
}): UniswapGuardResult {
  const nowMs = (input.now ?? new Date()).getTime();
  const checks: string[] = [];
  let chain;
  try { chain = normalizeBaseChain(input.chain); } catch { return fail('uniswap_wrong_chain', 'Uniswap swap must target Base mainnet', checks); }
  if (chain.chainId !== 8453) return fail('uniswap_wrong_chain', 'Uniswap swap must target Base mainnet', checks);
  checks.push('Base mainnet chain');

  const context = input.context;
  if (!context || context.inputToken !== 'USDC' || !['ETH', 'WETH'].includes(context.outputToken)) {
    return fail('uniswap_context_invalid', 'Only canonical Base USDC to ETH/WETH is supported', checks);
  }
  if (context.routerVersion !== '2.0') return fail('uniswap_router_version_invalid', 'Uniswap router version is not pinned', checks);
  if (!ADDRESS.test(context.swapper.toLowerCase())) return fail('uniswap_swapper_invalid', 'Authenticated swapper is invalid', checks);
  const expiry = Date.parse(context.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= nowMs) return fail('uniswap_quote_expired', 'Prepared Uniswap quote expired', checks);
  const amountRaw = decimalUsdc(context.amountDecimal);
  if (!amountRaw) return fail('uniswap_amount_invalid', 'USDC input amount is invalid', checks);
  checks.push('Exact positive USDC input and unexpired quote');

  if (!Array.isArray(input.calls) || input.calls.length < 1 || input.calls.length > 4) {
    return fail('uniswap_batch_size_invalid', 'Uniswap swap must contain one to four calls', checks);
  }
  const usdc = canonicalUsdcForBaseChain(8453).toLowerCase();
  const router = BASE_UNISWAP_UNIVERSAL_ROUTER_2;
  let routerCalls = 0;
  const spenders = new Set<string>();

  for (const call of input.calls) {
    const to = String(call.to || '').toLowerCase();
    const data = String(call.data || '').toLowerCase();
    let value: bigint;
    try { value = BigInt(String(call.value || '0')); } catch { return fail('uniswap_value_invalid', 'Call value is invalid', checks); }
    // USDC is always the input asset in the bounded policy, so no native value
    // may be attached to any approval or router call.
    if (value !== 0n) return fail('uniswap_native_value_blocked', 'USDC-input swaps cannot transfer native value', checks);
    if (!ADDRESS.test(to) || !HEX_DATA.test(data) || data.length < 10) {
      return fail('uniswap_call_malformed', 'Uniswap call target or calldata is malformed', checks);
    }

    if (to === router) {
      routerCalls += 1;
      continue;
    }

    if (to === usdc) {
      if (data.length !== 138 || data.slice(0, 10) !== ERC20_APPROVE_SELECTOR) {
        return fail('uniswap_approval_invalid', 'USDC call must be an exact approve', checks);
      }
      const spender = wordAddress(data.slice(10, 74));
      const approved = BigInt(`0x${data.slice(74, 138)}`);
      if (![PERMIT2_ADDRESS, router].includes(spender || '') || approved !== amountRaw) {
        return fail('uniswap_approval_not_exact', 'USDC approval must be exact and limited to Permit2/router', checks);
      }
      spenders.add(spender!);
      continue;
    }

    if (to === PERMIT2_ADDRESS) {
      // Permit2 approve(token, spender, uint160 amount, uint48 expiration).
      if (data.length !== 266 || data.slice(0, 10) !== PERMIT2_APPROVE_SELECTOR) {
        return fail('uniswap_permit2_call_invalid', 'Only exact Permit2 approval is allowed', checks);
      }
      const token = wordAddress(data.slice(10, 74));
      const spender = wordAddress(data.slice(74, 138));
      const approved = BigInt(`0x${data.slice(138, 202)}`);
      const permitExpiry = BigInt(`0x${data.slice(202, 266)}`);
      if (token !== usdc || spender !== router || approved !== amountRaw || permitExpiry > BigInt(Math.floor(expiry / 1000))) {
        return fail('uniswap_permit2_not_exact', 'Permit2 approval must match token, router, amount and expiry', checks);
      }
      spenders.add(router);
      continue;
    }

    return fail('uniswap_target_not_allowlisted', `Uniswap call target ${to} is not allowlisted`, checks);
  }

  if (routerCalls !== 1) return fail('uniswap_router_call_invalid', 'Exactly one pinned Universal Router call is required', checks);
  checks.push('Pinned Universal Router target and exact bounded approvals');
  return {
    success: true,
    code: 'allowed',
    checks,
    semantics: {
      actionType: 'uniswap_swap',
      tokenAddresses: [usdc],
      recipients: [],
      spenders: [...spenders],
      spendAmountRaw: amountRaw.toString(),
      spendAmountUsdc: Number(amountRaw) / 1_000_000,
    },
  };
}
