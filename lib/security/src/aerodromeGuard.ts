import { normalizeBaseChain, type BaseCall } from './baseGuards.js';

// ---------------------------------------------------------------------------
// T67B.1 — the Aerodrome Safety Kernel.
//
// This guard reads CALLDATA, not a Blueprint. Every field it checks is decoded
// out of the bytes a wallet is about to be handed: the recipient, the minimum
// output, the deadline, each route leg, each leg's curve, each leg's factory,
// and the approval amount. A Blueprint field that disagrees with its own
// calldata is exactly the failure this exists to catch, so believing the field
// would defeat the purpose.
//
// The Router address and the selectors are pinned INDEPENDENTLY of
// @mioagent/swap-adapters, which depends on this package and therefore cannot
// be imported from it. `lib/swap-adapters/test/aerodrome.test.ts` asserts the
// two constants are equal, so the duplication cannot silently drift — this is
// the same arrangement kyberGuard uses for KYBERSWAP_BASE_ROUTER.
// ---------------------------------------------------------------------------

/** Must stay equal to swap-adapters' AERODROME_ROUTER_V1. */
export const AERODROME_BASE_ROUTER = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43';

/** Must stay equal to swap-adapters' AERODROME_MAX_HOPS_V1. */
export const AERODROME_MAX_HOPS = 2;

/** keccak256 of each signature, first four bytes. Asserted against the
 * independently computed selectors in swap-adapters' test suite. */
const SELECTOR_SWAP_TOKENS_FOR_TOKENS = '0xcac88ea9';
const SELECTOR_SWAP_ETH_FOR_TOKENS = '0x903638a4';
const SELECTOR_SWAP_TOKENS_FOR_ETH = '0xc6b7f1b6';
const SELECTOR_ERC20_APPROVE = '0x095ea7b3';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX_DATA = /^0x[0-9a-f]*$/;
const WORD = 64;

export interface AerodromeRouteLeg {
  from: string;
  to: string;
  stable: boolean;
  factory: string;
}

export interface AerodromeSwapContext {
  /** The ERC-20 being spent, or null when the input is native ETH. */
  inputTokenAddress: string | null;
  inputIsNative: boolean;
  outputIsNative: boolean;
  /** Exactly the stored intent's input amount, in base units. */
  amountInAtomic: string;
  /**
   * The floor the USER reviewed, in base units. Calldata may promise more,
   * never less — a build that re-derived a weaker minimum from a decayed fresh
   * quote is the case this catches.
   */
  minimumOutputAtomic: string;
  /** The authenticated wallet. Sender and recipient must both equal it. */
  swapper: string;
  recipient: string;
  routerAddress: string;
  /** Read from Router.defaultFactory() during this same preparation. */
  factory: string;
  /** The legs the fresh re-quote priced, in order. */
  route: AerodromeRouteLeg[];
  /** ISO timestamp; the quote window, checked separately from the on-chain
   * deadline encoded in the calldata. */
  expiresAt: string;
}

export interface AerodromeSwapSemantics {
  actionType: 'aerodrome_swap';
  tokenAddresses: string[];
  recipients: string[];
  spenders: string[];
  spendAmountRaw: string;
  minimumOutputRaw: string;
  hops: number;
  curves: ('stable' | 'volatile')[];
  deadlineUnix: string;
}

export type AerodromeGuardResult =
  | { success: true; code: 'allowed'; checks: string[]; semantics: AerodromeSwapSemantics }
  | { success: false; code: string; reason: string; checks: string[] };

function fail(code: string, reason: string, checks: string[]): AerodromeGuardResult {
  return { success: false, code, reason, checks };
}

function word(data: string, index: number): string {
  // `data` is calldata WITHOUT the 0x prefix and WITHOUT the selector.
  return data.slice(index * WORD, index * WORD + WORD);
}

function wordAddress(value: string): string | null {
  if (!/^0{24}[0-9a-f]{40}$/.test(value)) return null;
  return `0x${value.slice(24)}`;
}

function wordUint(value: string): bigint | null {
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  return BigInt(`0x${value}`);
}

function parseAtomic(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return BigInt(value);
}

interface DecodedSwap {
  kind: 'tokens_for_tokens' | 'eth_for_tokens' | 'tokens_for_eth';
  /** Null for the ETH-input entrypoint, where the amount is msg.value. */
  amountIn: bigint | null;
  amountOutMin: bigint;
  route: AerodromeRouteLeg[];
  to: string;
  deadline: bigint;
}

/**
 * Decodes one Aerodrome Router swap call.
 *
 * Returns null for anything it does not recognise byte for byte. There is no
 * partial or best-effort decode: a call this function cannot fully read is a
 * call the Safety Kernel refuses, not one it guesses about.
 */
export function decodeAerodromeSwapCalldata(data: string): DecodedSwap | null {
  const hex = data.toLowerCase();
  if (!HEX_DATA.test(hex) || hex.length < 10) return null;
  const selector = hex.slice(0, 10);
  const body = hex.slice(10);
  if (body.length % WORD !== 0) return null;

  let kind: DecodedSwap['kind'];
  let headWords: number;
  if (selector === SELECTOR_SWAP_TOKENS_FOR_TOKENS) {
    kind = 'tokens_for_tokens';
    headWords = 5;
  } else if (selector === SELECTOR_SWAP_TOKENS_FOR_ETH) {
    kind = 'tokens_for_eth';
    headWords = 5;
  } else if (selector === SELECTOR_SWAP_ETH_FOR_TOKENS) {
    kind = 'eth_for_tokens';
    headWords = 4;
  } else {
    return null;
  }
  if (body.length < headWords * WORD) return null;

  const ethInput = kind === 'eth_for_tokens';
  const amountIn = ethInput ? null : wordUint(word(body, 0));
  const amountOutMin = wordUint(word(body, ethInput ? 0 : 1));
  const routesOffset = wordUint(word(body, ethInput ? 1 : 2));
  const to = wordAddress(word(body, ethInput ? 2 : 3));
  const deadline = wordUint(word(body, ethInput ? 3 : 4));
  if (amountOutMin === null || routesOffset === null || to === null || deadline === null) return null;
  if (!ethInput && amountIn === null) return null;

  // The offset must point exactly past the head. Anything else is a layout
  // this encoder never produces, so it is refused rather than followed.
  if (routesOffset !== BigInt(headWords * 32)) return null;
  const lengthValue = wordUint(word(body, headWords));
  if (lengthValue === null || lengthValue === 0n || lengthValue > BigInt(AERODROME_MAX_HOPS)) return null;
  const legCount = Number(lengthValue);
  // Four words per leg, and NOTHING after them. Trailing bytes would be a
  // second argument the decode did not account for.
  if (body.length !== (headWords + 1 + legCount * 4) * WORD) return null;

  const route: AerodromeRouteLeg[] = [];
  for (let index = 0; index < legCount; index += 1) {
    const base = headWords + 1 + index * 4;
    const from = wordAddress(word(body, base));
    const target = wordAddress(word(body, base + 1));
    const stableWord = wordUint(word(body, base + 2));
    const factory = wordAddress(word(body, base + 3));
    if (from === null || target === null || factory === null) return null;
    // A bool word is 0 or 1. Any other value is not a bool this decoder read
    // correctly, and "truthy" is not a safe reading of a curve selector.
    if (stableWord !== 0n && stableWord !== 1n) return null;
    route.push({ from, to: target, stable: stableWord === 1n, factory });
  }

  return { kind, amountIn, amountOutMin, route, to, deadline };
}

interface DecodedApproval {
  spender: string;
  amount: bigint;
}

function decodeExactApproval(data: string): DecodedApproval | null {
  const hex = data.toLowerCase();
  // Selector plus exactly two words. A longer approve call carries arguments
  // this integration never encodes.
  if (hex.length !== 10 + WORD * 2 || hex.slice(0, 10) !== SELECTOR_ERC20_APPROVE) return null;
  const body = hex.slice(10);
  const spender = wordAddress(word(body, 0));
  const amount = wordUint(word(body, 1));
  if (spender === null || amount === null) return null;
  return { spender, amount };
}

function sameLeg(left: AerodromeRouteLeg, right: AerodromeRouteLeg): boolean {
  return (
    left.from.toLowerCase() === right.from.toLowerCase() &&
    left.to.toLowerCase() === right.to.toLowerCase() &&
    left.stable === right.stable &&
    left.factory.toLowerCase() === right.factory.toLowerCase()
  );
}

/**
 * Strict validation for a server-built, Base-only Aerodrome batch.
 *
 * The batch is at most two calls: an optional exact ERC-20 approval to the
 * pinned Router, then exactly one Router swap.
 */
export function validateAerodromeSwap(input: {
  chain: string | number;
  calls: BaseCall[];
  context?: AerodromeSwapContext;
  /** Injectable clock for deterministic expiry checks; defaults to wall time. */
  now?: Date;
}): AerodromeGuardResult {
  const nowMs = (input.now ?? new Date()).getTime();
  const checks: string[] = [];

  let chain;
  try {
    chain = normalizeBaseChain(input.chain);
  } catch {
    return fail('aerodrome_wrong_chain', 'Aerodrome swap must target Base mainnet', checks);
  }
  if (chain.chainId !== 8453) {
    return fail('aerodrome_wrong_chain', 'Aerodrome swap must target Base mainnet', checks);
  }
  checks.push('Base mainnet chain');

  const context = input.context;
  if (!context) return fail('aerodrome_context_missing', 'Aerodrome swap context is required', checks);

  const router = context.routerAddress.toLowerCase();
  if (router !== AERODROME_BASE_ROUTER) {
    return fail('aerodrome_router_not_pinned', 'Aerodrome router is not the pinned Base router', checks);
  }
  const swapper = context.swapper.toLowerCase();
  const recipient = context.recipient.toLowerCase();
  if (!ADDRESS.test(swapper) || !ADDRESS.test(recipient) || swapper !== recipient) {
    return fail(
      'aerodrome_wallet_binding_invalid',
      'Aerodrome sender and recipient must both equal the authenticated wallet',
      checks,
    );
  }

  const amountIn = parseAtomic(context.amountInAtomic);
  if (amountIn === null || amountIn <= 0n) {
    return fail('aerodrome_amount_invalid', 'Aerodrome input amount is invalid', checks);
  }
  const minimumOut = parseAtomic(context.minimumOutputAtomic);
  if (minimumOut === null || minimumOut <= 0n) {
    return fail('aerodrome_minimum_invalid', 'Aerodrome reviewed minimum output is invalid', checks);
  }

  const expiry = Date.parse(context.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= nowMs) {
    return fail('aerodrome_quote_expired', 'Prepared Aerodrome route expired', checks);
  }

  const factory = context.factory.toLowerCase();
  if (!ADDRESS.test(factory)) {
    return fail('aerodrome_factory_invalid', 'Aerodrome pool factory is invalid', checks);
  }
  if (context.route.length === 0 || context.route.length > AERODROME_MAX_HOPS) {
    return fail('aerodrome_route_length_invalid', `Aerodrome routes are limited to ${AERODROME_MAX_HOPS} hops`, checks);
  }
  if (context.route.some((leg) => leg.factory.toLowerCase() !== factory)) {
    return fail('aerodrome_route_factory_mismatch', 'A reviewed route leg uses a different factory', checks);
  }
  const inputToken = context.inputIsNative ? null : (context.inputTokenAddress ?? '').toLowerCase();
  if (!context.inputIsNative && (inputToken === null || !ADDRESS.test(inputToken))) {
    return fail('aerodrome_input_token_invalid', 'Aerodrome ERC-20 input token address is invalid', checks);
  }
  checks.push('Pinned router, bound wallet, positive amounts, unexpired quote');

  if (!Array.isArray(input.calls) || input.calls.length < 1 || input.calls.length > 2) {
    return fail('aerodrome_batch_size_invalid', 'Aerodrome swap must contain one or two calls', checks);
  }

  let swapCall: BaseCall | null = null;
  let approval: DecodedApproval | null = null;
  const spenders = new Set<string>();

  for (const call of input.calls) {
    const to = String(call.to || '').toLowerCase();
    const data = String(call.data || '').toLowerCase();
    let value: bigint;
    try {
      value = BigInt(String(call.value || '0'));
    } catch {
      return fail('aerodrome_value_invalid', 'Call value is invalid', checks);
    }
    if (value < 0n) return fail('aerodrome_value_invalid', 'Call value is invalid', checks);
    if (!ADDRESS.test(to) || !HEX_DATA.test(data) || data.length < 10) {
      return fail('aerodrome_call_malformed', 'Aerodrome call target or calldata is malformed', checks);
    }

    if (to === router) {
      if (swapCall) {
        return fail('aerodrome_router_call_invalid', 'Exactly one pinned Aerodrome router call is required', checks);
      }
      // Native value belongs to the ETH-input entrypoint and nowhere else.
      if (context.inputIsNative) {
        if (value !== amountIn) {
          return fail('aerodrome_native_value_mismatch', 'Native value does not equal the stored input amount', checks);
        }
      } else if (value !== 0n) {
        return fail('aerodrome_native_value_blocked', 'An ERC-20 input swap cannot transfer native value', checks);
      }
      swapCall = call;
      continue;
    }

    if (!context.inputIsNative && to === inputToken) {
      if (value !== 0n) {
        return fail('aerodrome_native_value_blocked', 'An approval cannot transfer native value', checks);
      }
      if (approval) {
        return fail('aerodrome_approval_count_invalid', 'At most one exact approval is allowed', checks);
      }
      const decoded = decodeExactApproval(data);
      if (!decoded) {
        return fail('aerodrome_approval_invalid', 'The input token call must be an exact approve', checks);
      }
      if (decoded.spender.toLowerCase() !== router) {
        return fail(
          'aerodrome_approval_spender_invalid',
          'An approval may only name the pinned Aerodrome router as spender',
          checks,
        );
      }
      if (decoded.amount !== amountIn) {
        // Covers unlimited (2^256-1), any padded allowance, and any amount
        // smaller than the swap needs.
        return fail(
          'aerodrome_approval_not_exact',
          'The approval amount must exactly equal the stored input amount',
          checks,
        );
      }
      approval = decoded;
      spenders.add(decoded.spender);
      continue;
    }

    return fail('aerodrome_target_not_allowlisted', `Aerodrome call target ${to} is not allowlisted`, checks);
  }

  if (!swapCall) {
    return fail('aerodrome_router_call_invalid', 'Exactly one pinned Aerodrome router call is required', checks);
  }
  if (context.inputIsNative && approval) {
    return fail('aerodrome_approval_unexpected', 'A native-ETH input swap requires no approval', checks);
  }
  if (!context.inputIsNative) {
    // An ERC-20 input ALWAYS carries its own exact approval, even when the
    // wallet already has one standing. Skipping it would make the batch's
    // validity depend on chain state read minutes before the signature — and
    // that state is precisely what a concurrent transaction can change in
    // between. Both calls are atomic, so the approval costs nothing that is
    // not already being spent.
    if (!approval) {
      return fail('aerodrome_approval_missing', 'An ERC-20 input swap must carry its own exact approval', checks);
    }
  }

  const decoded = decodeAerodromeSwapCalldata(String(swapCall.data || ''));
  if (!decoded) {
    return fail('aerodrome_swap_calldata_unreadable', 'Aerodrome swap calldata is not a recognised exact-input swap', checks);
  }

  const expectedKind: DecodedSwap['kind'] = context.inputIsNative
    ? 'eth_for_tokens'
    : context.outputIsNative
      ? 'tokens_for_eth'
      : 'tokens_for_tokens';
  if (decoded.kind !== expectedKind) {
    return fail('aerodrome_swap_function_mismatch', 'Aerodrome swap calldata calls the wrong entrypoint', checks);
  }
  if (decoded.amountIn !== null && decoded.amountIn !== amountIn) {
    return fail('aerodrome_amount_mismatch', 'Aerodrome calldata input amount does not match the stored intent', checks);
  }
  if (decoded.to.toLowerCase() !== recipient) {
    return fail('aerodrome_recipient_mismatch', 'Aerodrome calldata recipient is not the authenticated wallet', checks);
  }
  if (decoded.amountOutMin < minimumOut) {
    return fail(
      'aerodrome_minimum_output_weakened',
      'Aerodrome calldata accepts less than the reviewed minimum output',
      checks,
    );
  }
  // Seconds, and it has to outlive the moment it is signed. A deadline in the
  // past would be a swap that can only ever revert.
  const deadlineMs = Number(decoded.deadline) * 1000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) {
    return fail('aerodrome_deadline_expired', 'Aerodrome calldata deadline has already passed', checks);
  }
  if (decoded.route.length !== context.route.length) {
    return fail('aerodrome_route_mismatch', 'Aerodrome calldata route is not the reviewed route', checks);
  }
  for (const [index, leg] of decoded.route.entries()) {
    if (!sameLeg(leg, context.route[index]!)) {
      return fail('aerodrome_route_mismatch', 'Aerodrome calldata route is not the reviewed route', checks);
    }
    if (leg.factory.toLowerCase() !== factory) {
      return fail('aerodrome_route_factory_mismatch', 'Aerodrome calldata routes through a different factory', checks);
    }
  }
  // The route has to actually start where the money leaves and end where it
  // arrives. Matching legs pairwise is not enough on its own: a reviewed route
  // that itself started at the wrong token would pass that check.
  const firstLeg = decoded.route[0]!;
  if (!context.inputIsNative && firstLeg.from.toLowerCase() !== inputToken) {
    return fail('aerodrome_route_input_mismatch', 'Aerodrome route does not start at the input token', checks);
  }
  for (let index = 1; index < decoded.route.length; index += 1) {
    if (decoded.route[index]!.from.toLowerCase() !== decoded.route[index - 1]!.to.toLowerCase()) {
      return fail('aerodrome_route_discontinuous', 'Aerodrome route legs do not connect', checks);
    }
  }
  checks.push('Decoded calldata: recipient, amounts, minimum output, deadline, route and factory');

  return {
    success: true,
    code: 'allowed',
    checks,
    semantics: {
      actionType: 'aerodrome_swap',
      tokenAddresses: [
        ...(context.inputIsNative ? [] : [inputToken!]),
        ...decoded.route.map((leg) => leg.to.toLowerCase()),
      ],
      recipients: [recipient],
      spenders: [...spenders],
      spendAmountRaw: amountIn.toString(),
      minimumOutputRaw: decoded.amountOutMin.toString(),
      hops: decoded.route.length,
      curves: decoded.route.map((leg) => (leg.stable ? 'stable' : 'volatile')),
      deadlineUnix: decoded.deadline.toString(),
    },
  };
}
