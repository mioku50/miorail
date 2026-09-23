import {
  BASE_UNISWAP_UNIVERSAL_ROUTER_2,
  BASE_UNISWAP_UNIVERSAL_ROUTER_2_VERSION,
  PERMIT2_ADDRESS,
} from '@mioagent/security/uniswapGuard';
import {
  atomicToHumanDecimal,
  canonicalRequestHash,
  canonicalResponseHash,
  minimumOutputAtomic,
  parsePositiveAtomic,
  parseUnsignedAtomic,
  providerTokenAddress,
  routablePairV1,
  createPartnerFetchTradeTransport,
  uniswapSlippageToleranceV1,
  UniswapTradeClient,
  type UniswapTradeTransport,
} from '@mioagent/swap-adapters';
import type { TokenAmountV1 } from '@mioagent/route-domain';
import type {
  SwapBuildAdapter,
  SwapBuildFailure,
  SwapBuildFailureOutcome,
  SwapBuildInput,
  SwapBuildResultV1,
} from '../types.js';

const ROUTER = BASE_UNISWAP_UNIVERSAL_ROUTER_2 as `0x${string}`;

function failure(outcome: SwapBuildFailureOutcome, errorCode: string, retryable: boolean): SwapBuildFailure {
  return { outcome, provider: 'uniswap', errorCode, retryable };
}

const ERC20_APPROVE_SELECTOR_V1 = '0x095ea7b3';
const PERMIT2_APPROVE_SELECTOR_V1 = '0x87517c45';

function wordV1(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

/** The address in one ABI word, or null when the word is not an address. */
function wordAddressV1(word: string): string | null {
  return /^0{24}[0-9a-f]{40}$/.test(word) ? `0x${word.slice(24)}` : null;
}

/**
 * The two approvals Uniswap writes, narrowed to this one swap.
 *
 * Measured 2026-09-23 with swap_5792 for 0.1 USDC → NVDAc: a wallet with no
 * Permit2 allowance is given `approve(Permit2, 2^256-1)` on the input token,
 * and every wallet is given `Permit2.approve(token, router, amount, now + 30
 * days)`. The Safety Kernel refuses both — an approval must be the exact input,
 * and a Permit2 allowance may not outlive the quote — so every Uniswap route
 * the web chose as best was refused after it had been chosen.
 *
 * Only these two call shapes are rewritten, and only when they already name
 * the input token and a spender the guard accepts (Permit2 or the pinned
 * router): the amount becomes exactly the input, the expiry no later than the
 * quote's. Anything else is left exactly as Uniswap wrote it, for the kernel
 * to refuse. The router's calldata is never touched, and the kernel and the
 * simulation both run on these calls, not on Uniswap's.
 */
export function narrowUniswapApprovalsV1<T extends { to: string; data: string }>(
  calls: readonly T[],
  input: { inputToken: string | null; amountAtomic: string; expiresAtSec: number },
): T[] {
  // A native input has nothing to approve; any approval there is refused as is.
  if (!input.inputToken) return [...calls];
  const token = input.inputToken.toLowerCase();
  const router = ROUTER.toLowerCase();
  const amount = BigInt(input.amountAtomic);
  const expiry = BigInt(input.expiresAtSec);
  return calls.map((call) => {
    const to = call.to.toLowerCase();
    const data = call.data.toLowerCase();
    if (to === token && data.length === 138 && data.startsWith(ERC20_APPROVE_SELECTOR_V1)) {
      const spender = wordAddressV1(data.slice(10, 74));
      if (spender !== PERMIT2_ADDRESS && spender !== router) return call;
      return { ...call, data: `${data.slice(0, 74)}${wordV1(amount)}` };
    }
    if (to === PERMIT2_ADDRESS && data.length === 266 && data.startsWith(PERMIT2_APPROVE_SELECTOR_V1)) {
      if (wordAddressV1(data.slice(10, 74)) !== token || wordAddressV1(data.slice(74, 138)) !== router) return call;
      const expiration = BigInt(`0x${data.slice(202, 266)}`);
      const bounded = expiration < expiry ? expiration : expiry;
      return { ...call, data: `${data.slice(0, 138)}${wordV1(amount)}${wordV1(bounded)}` };
    }
    return call;
  });
}

export interface UniswapSwapBuildAdapterOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  transport?: UniswapTradeTransport;
}

/** T56: builds exact unsigned Uniswap 5792 calls for an explicitly selected candidate. */
export class UniswapSwapBuildAdapter implements SwapBuildAdapter {
  readonly id = 'uniswap' as const;
  private readonly client: UniswapTradeClient;
  private readonly configured: boolean;

  constructor(options: UniswapSwapBuildAdapterOptions = {}) {
    const apiKey = options.apiKey ?? process.env.UNISWAP_API_KEY;
    this.configured = Boolean(apiKey?.trim()) || Boolean(options.transport);
    this.client = new UniswapTradeClient(
      options.transport ??
        createPartnerFetchTradeTransport({
          apiKey: apiKey ?? '',
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          // Ask for the router this adapter pins, on both requests. The Base
          // App's Uniswap path always sent it; this one did not, and when the
          // API's default moved to a newer router every build was refused.
          extraHeaders: { 'x-universal-router-version': BASE_UNISWAP_UNIVERSAL_ROUTER_2_VERSION },
        }),
    );
  }

  async build(input: SwapBuildInput): Promise<SwapBuildResultV1> {
    if (!this.configured) return failure('not_configured', 'uniswap_not_configured', false);
    const { intent } = input;
    // Any well-formed Base pair, both directions. This adapter carried its own
    // copy of the pair rule three times over — USDC-in only, then the
    // canonical three — and each copy had to be found and fixed separately.
    // `routablePairV1` is now the single statement of it, shared with the
    // quote adapters. ETH↔WETH is still excluded there: a wrap is not a trade.
    if (intent.chainId !== 8453 || !routablePairV1(intent.fromAsset, intent.toAsset)) {
      return failure('rejected', 'uniswap_pair_unsupported', false);
    }
    if (input.walletAddress.toLowerCase() !== intent.walletAddress.toLowerCase()) {
      return failure('rejected', 'uniswap_wallet_mismatch', false);
    }
    const tokenIn = providerTokenAddress(intent.fromAsset!, 'uniswap');
    const tokenOut = providerTokenAddress(intent.toAsset!, 'uniswap');
    if (!tokenIn || !tokenOut) return failure('rejected', 'uniswap_asset_untrusted', false);

    const quoteBody = {
      type: 'EXACT_INPUT',
      amount: intent.amount.amountAtomic,
      tokenIn,
      tokenOut,
      tokenInChainId: 8453,
      tokenOutChainId: 8453,
      swapper: input.walletAddress,
      recipient: input.walletAddress,
      protocols: ['V2', 'V3', 'V4'],
      routingPreference: 'BEST_PRICE',
      // Slippage is ALWAYS the stored intent constraint — including an
      // explicit 0 — mirroring UniswapQuoteClient's strict handling. Auto
      // slippage would let the provider pick a value the user never approved.
      // It goes as a JSON number: the decimal string is a 400 here, which is
      // why this build path never once produced a transaction.
      slippageTolerance: uniswapSlippageToleranceV1(intent.slippageConstraint.maxBps),
      // `permitAmount: 'EXACT'` and NOT `generatePermitAsTransaction`.
      //
      // The flag reads as "give me the permit as a transaction". On the QUOTE
      // request it does the opposite: it suppresses the permit entirely. Sent
      // here it returned `permitData: false` and a batch of exactly one call —
      // the bare `execute(V3_SWAP_EXACT_IN)` — which can only work while a
      // standing Permit2 allowance happens to be alive.
      //
      // Measured 2026-09-06 against the live API, same body, four ways: with
      // the flag, 1 call; without it, 2 — `Permit2.approve` then the swap.
      // The operator's own allowance had expired on 09-01 (amount still
      // unlimited, EXPIRATION lapsed), so every Uniswap route from that wallet
      // reverted inside `Permit2.transferFrom`. The bundler reported that as
      // "failed to estimate gas for user operation", and the holder read a
      // wallet with 0.0007 ETH in it and concluded they were out of gas.
      //
      // `permitAmount: 'EXACT'` is what keeps the approval equal to the input:
      // without it the permit is written for 2^160-1, and the Safety Kernel
      // rejects any approval that is not exactly the stored intent amount.
      permitAmount: 'EXACT',
    };
    // `partnerFetch` THROWS on a transport failure — DNS, reset connection, or
    // its own 10s AbortSignal — and nothing above this line catches: not the
    // transport, not the client, not the composer. One transient network blip
    // therefore left the user a bare 500 with no line in the log, while the
    // quote-side client has normalised caught errors all along. KyberSwap's
    // build adapter already answers `kyberswap_routes_unreachable` here; this
    // is the same contract for the twin that was missed.
    let quoteResult: Awaited<ReturnType<UniswapTradeClient['quote']>>;
    try {
      quoteResult = await this.client.quote(quoteBody);
    } catch {
      return failure('unavailable', 'uniswap_quote_unreachable', true);
    }
    // The phase is part of the code. Both calls used to report the same
    // `uniswap_http_400`, so the string the user was shown could not say which
    // of the two requests had been refused — and finding out cost a live probe.
    if (quoteResult.outcome === 'http_error') {
      return failure('unavailable', `uniswap_quote_http_${quoteResult.status}`, true);
    }
    if (quoteResult.outcome !== 'quote') return failure('invalid_response', 'uniswap_quote_invalid', false);

    // Build-side outputs come from the exact quote object that is fed into
    // /swap_5792 below — the same response the calldata is generated from.
    const quoteRecord = quoteResult.payload!.quote as Record<string, unknown>;
    const quoteOutput =
      quoteRecord.output && typeof quoteRecord.output === 'object'
        ? (quoteRecord.output as Record<string, unknown>)
        : null;
    const expectedAtomic = parsePositiveAtomic(quoteOutput?.amount);
    if (!expectedAtomic) return failure('invalid_response', 'uniswap_quote_output_invalid', false);
    const providerMinimum = parseUnsignedAtomic(
      quoteRecord.minimumOutput ?? quoteRecord.amountOutMinimum ?? quoteOutput?.minimumAmount,
    );
    if (providerMinimum !== null && BigInt(providerMinimum) > BigInt(expectedAtomic)) {
      return failure('invalid_response', 'uniswap_quote_output_invalid', false);
    }
    const derivedMinimum = minimumOutputAtomic(expectedAtomic, intent.slippageConstraint.maxBps);
    const minimumAtomic =
      providerMinimum !== null && BigInt(providerMinimum) > BigInt(derivedMinimum)
        ? providerMinimum
        : derivedMinimum;
    const expectedDecimal = atomicToHumanDecimal(expectedAtomic, intent.toAsset!.decimals);
    const minimumDecimal = atomicToHumanDecimal(minimumAtomic, intent.toAsset!.decimals);
    if (expectedDecimal === null || minimumDecimal === null) {
      return failure('invalid_response', 'uniswap_quote_output_invalid', false);
    }
    const expectedOutput: TokenAmountV1 = {
      asset: intent.toAsset!,
      amountAtomic: expectedAtomic,
      amountDecimal: expectedDecimal,
    };
    const minimumOutput: TokenAmountV1 = {
      asset: intent.toAsset!,
      amountAtomic: minimumAtomic,
      amountDecimal: minimumDecimal,
    };

    const requestId = input.requestId;
    const quoteExpiry = new Date(input.now.getTime() + 10 * 60_000).toISOString();
    const swapBody = {
      quote: quoteResult.payload!.quote,
      ...(quoteResult.payload!.permitData ? { permitData: quoteResult.payload!.permitData } : {}),
      deadline: Math.floor(Date.parse(quoteExpiry) / 1000),
      urgency: 'normal',
    };
    let swapResult: Awaited<ReturnType<UniswapTradeClient['swap5792']>>;
    try {
      swapResult = await this.client.swap5792(swapBody, input.walletAddress);
    } catch {
      return failure('unavailable', 'uniswap_swap_unreachable', true);
    }
    if (swapResult.outcome === 'http_error') {
      return failure('unavailable', `uniswap_swap_http_${swapResult.status}`, true);
    }
    if (swapResult.outcome !== 'prepared') return failure('invalid_response', 'uniswap_5792_invalid', false);

    const routerCalls = swapResult.calls!.filter((call) => call.to.toLowerCase() === ROUTER.toLowerCase());
    if (routerCalls.length !== 1) return failure('router_mismatch', 'uniswap_router_not_pinned', false);
    const calls = narrowUniswapApprovalsV1(swapResult.calls!, {
      inputToken: intent.fromAsset!.kind === 'native' ? null : tokenIn,
      amountAtomic: intent.amount.amountAtomic,
      expiresAtSec: swapBody.deadline,
    });

    const requestHash = canonicalRequestHash('uniswap', { path: '/v1/quote', ...quoteBody });
    const responseHash = canonicalResponseHash('uniswap', {
      quote: { requestId: swapResult.requestId, calls: swapResult.calls },
    });
    return {
      outcome: 'built',
      provider: 'uniswap',
      routerAddress: ROUTER,
      calls,
      quoteExpiry,
      requestId,
      requestHash,
      responseHash,
      expectedOutput,
      minimumOutput,
    };
  }
}
