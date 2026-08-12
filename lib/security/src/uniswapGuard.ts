import { normalizeBaseChain, type BaseCall } from './baseGuards.js';
import {
  decimalAmountToRawV1,
  isCanonicalBaseUsdcV1,
  normalizeSwapAssetV1,
  type SwapGuardAssetV1,
} from './swapAsset.js';

export const BASE_UNISWAP_UNIVERSAL_ROUTER_2 = '0x6ff5693b99212da76ad316178a184ab56d299b43';
export const BASE_UNISWAP_UNIVERSAL_ROUTER_2_1_1 = '0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7';
export const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3';

const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
const PERMIT2_APPROVE_SELECTOR = '0x87517c45';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX_DATA = /^0x[0-9a-f]+$/;

export interface UniswapSwapContext {
  amountDecimal: string;
  /**
   * Was a symbol from a set of three. It is now the asset itself — address and
   * decimals — so the approval target, the base-unit scale and the
   * native-value rule are all derived from the token the intent carries
   * instead of from a name this guard happened to recognise.
   */
  inputAsset: SwapGuardAssetV1;
  outputAsset: SwapGuardAssetV1;
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
  /** False whenever the input is not canonical USDC: the figure above is then
   * 0, and a dollar budget must refuse rather than read that as free. */
  spendAmountIsUsd: boolean;
}

export type UniswapGuardResult =
  | { success: true; code: 'allowed'; checks: string[]; semantics: UniswapSwapSemantics }
  | { success: false; code: string; reason: string; checks: string[] };

function fail(code: string, reason: string, checks: string[]): UniswapGuardResult {
  return { success: false, code, reason, checks };
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
  const router = BASE_UNISWAP_UNIVERSAL_ROUTER_2;
  // A "token" claiming the router's or Permit2's address would make the loop
  // below read a router call as an approval, so those addresses can never be a
  // swap side.
  const reserved = [router, PERMIT2_ADDRESS];
  const inputAsset = normalizeSwapAssetV1(context?.inputAsset, reserved);
  const outputAsset = normalizeSwapAssetV1(context?.outputAsset, reserved);
  if (!context || !inputAsset || !outputAsset) {
    return fail(
      'uniswap_context_invalid',
      'Each swap side must be native ETH or a valid ERC-20 address with readable decimals',
      checks,
    );
  }
  // ETH↔WETH is a wrap, not a swap: there is no pool, and letting it through
  // would put the guard's name on a transaction it never checked a price for.
  if (inputAsset.side === outputAsset.side) {
    return fail('uniswap_context_invalid', 'Input and output must be different assets', checks);
  }
  if (context.routerVersion !== '2.0') return fail('uniswap_router_version_invalid', 'Uniswap router version is not pinned', checks);
  if (!ADDRESS.test(context.swapper.toLowerCase())) return fail('uniswap_swapper_invalid', 'Authenticated swapper is invalid', checks);
  const expiry = Date.parse(context.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= nowMs) return fail('uniswap_quote_expired', 'Prepared Uniswap quote expired', checks);
  const amountRaw = decimalAmountToRawV1(context.amountDecimal, inputAsset.decimals);
  if (!amountRaw) return fail('uniswap_amount_invalid', 'Input amount is invalid', checks);
  // The label is the ADDRESS, never the contract's own symbol: a symbol
  // rendered back to the user is a phishing surface, and this string is
  // evidence.
  const inputLabel = inputAsset.address ?? 'native ETH';
  checks.push(`Exact positive input (${inputLabel}) and unexpired quote`);

  if (!Array.isArray(input.calls) || input.calls.length < 1 || input.calls.length > 4) {
    return fail('uniswap_batch_size_invalid', 'Uniswap swap must contain one to four calls', checks);
  }
  const inputAddress = inputAsset.address;
  const inputIsNative = inputAddress === null;
  let routerCalls = 0;
  let attachedValue = 0n;
  const spenders = new Set<string>();

  for (const call of input.calls) {
    const to = String(call.to || '').toLowerCase();
    const data = String(call.data || '').toLowerCase();
    let value: bigint;
    try { value = BigInt(String(call.value || '0')); } catch { return fail('uniswap_value_invalid', 'Call value is invalid', checks); }
    // A native input MUST attach its amount, and only to the router. An ERC-20
    // input must attach nothing. Both are checked against the total below, so
    // the batch cannot smuggle value in through a second call.
    if (value < 0n) return fail('uniswap_value_invalid', 'Call value is invalid', checks);
    if (value !== 0n && (!inputIsNative || to !== router)) {
      return fail('uniswap_native_value_blocked', 'Only a native-input router call may carry value', checks);
    }
    attachedValue += value;
    if (!ADDRESS.test(to) || !HEX_DATA.test(data) || data.length < 10) {
      return fail('uniswap_call_malformed', 'Uniswap call target or calldata is malformed', checks);
    }

    if (to === router) {
      routerCalls += 1;
      continue;
    }

    if (inputAddress && to === inputAddress) {
      if (data.length !== 138 || data.slice(0, 10) !== ERC20_APPROVE_SELECTOR) {
        return fail('uniswap_approval_invalid', 'The input token call must be an exact approve', checks);
      }
      const spender = wordAddress(data.slice(10, 74));
      const approved = BigInt(`0x${data.slice(74, 138)}`);
      if (![PERMIT2_ADDRESS, router].includes(spender || '') || approved !== amountRaw) {
        return fail('uniswap_approval_not_exact', 'The input approval must be exact and limited to Permit2/router', checks);
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
      if (token !== inputAddress || spender !== router || approved !== amountRaw || permitExpiry > BigInt(Math.floor(expiry / 1000))) {
        return fail('uniswap_permit2_not_exact', 'Permit2 approval must match token, router, amount and expiry', checks);
      }
      spenders.add(router);
      continue;
    }

    return fail('uniswap_target_not_allowlisted', `Uniswap call target ${to} is not allowlisted`, checks);
  }

  if (routerCalls !== 1) return fail('uniswap_router_call_invalid', 'Exactly one pinned Universal Router call is required', checks);
  // The whole batch may move exactly the input amount in native value, and
  // only when the input IS native. Checked on the total so two calls cannot
  // each carry a "valid-looking" part.
  const expectedValue = inputIsNative ? amountRaw : 0n;
  if (attachedValue !== expectedValue) {
    return fail('uniswap_native_value_mismatch', 'Attached native value must equal the input amount exactly', checks);
  }
  // A native input has nothing to approve, so an approval in that batch is a
  // spend nobody asked for.
  if (inputIsNative && spenders.size > 0) {
    return fail('uniswap_native_input_approval', 'A native-input swap must contain no approval', checks);
  }
  checks.push('Pinned Universal Router target and exact bounded approvals');
  return {
    success: true,
    code: 'allowed',
    checks,
    semantics: {
      actionType: 'uniswap_swap',
      tokenAddresses: inputAddress ? [inputAddress] : [],
      recipients: [],
      spenders: [...spenders],
      spendAmountRaw: amountRaw.toString(),
      // Only meaningful for a canonical USDC input; any other input is not a
      // dollar figure and must not be reported as one. By address — a token
      // that calls itself USDC does not become dollars by saying so.
      spendAmountUsdc: isCanonicalBaseUsdcV1(inputAddress) ? Number(amountRaw) / 1_000_000 : 0,
      spendAmountIsUsd: isCanonicalBaseUsdcV1(inputAddress),
    },
  };
}
