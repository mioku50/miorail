import {
  atomicToHumanDecimal,
  canonicalRequestHash,
  canonicalResponseHash,
  minimumOutputAtomic,
  AERODROME_ROUTER_V1,
  AERODROME_MAX_HOPS_V1,
  AERODROME_WETH_V1,
  encodeExactApproveV1,
  encodeSwapExactEthForTokensV1,
  encodeSwapExactTokensForEthV1,
  encodeSwapExactTokensForTokensV1,
  parseAerodromeSourceKeyV1,
  sameAerodromeRouteV1,
  createAerodromeReaderV1,
  type AerodromeReaderV1,
  type AerodromeRouteLegV1,
} from '@mioagent/swap-adapters';
import type { AssetRefV1, RouteCandidateV1, TokenAmountV1 } from '@mioagent/route-domain';
import type {
  SwapBuildAdapter,
  SwapBuildCallV1,
  SwapBuildFailure,
  SwapBuildFailureOutcome,
  SwapBuildInput,
  SwapBuildResultV1,
} from '../types.js';

// ---------------------------------------------------------------------------
// T67B.1 — the Aerodrome build adapter.
//
// Unlike Uniswap and KyberSwap, nothing here asks a partner to produce
// calldata. The bytes are encoded locally from the route the user reviewed,
// which means this file — not a provider response — is where the recipient,
// the deadline, the minimum output and the pools are decided.
//
// Three rules follow from that, and every one of them is a refusal rather
// than a fallback:
//
//   1. THE REVIEWED ROUTE IS THE ONLY ROUTE. If a fresh search now prefers
//      different pools, this adapter does not take them. Executing a route the
//      user never saw is the failure mode the whole comparison exists to
//      prevent, so a moved route ends the preparation and asks for a refresh.
//
//   2. THE REVIEWED MINIMUM IS A FLOOR, NOT A STARTING POINT. Re-deriving a
//      minimum from a decayed fresh quote can land BELOW the number the user
//      approved even when the fresh expected output still clears it. The
//      encoded `amountOutMin` is therefore the stricter of the two.
//
//   3. AN ALLOWANCE IS READ, NEVER ASSUMED. The approval decision comes from
//      the allowance actually observed on chain during this preparation.
// ---------------------------------------------------------------------------

/** The window the encoded on-chain deadline allows. Price movement is bounded
 * by `amountOutMin`, not by this — the deadline exists so an abandoned
 * signature cannot be broadcast hours later, and so it has to be long enough
 * for a person to actually read a review screen. */
const BUILD_TTL_MS = 10 * 60_000;

function failure(outcome: SwapBuildFailureOutcome, errorCode: string, retryable: boolean): SwapBuildFailure {
  return { outcome, provider: 'aerodrome', errorCode, retryable };
}

export interface AerodromeSwapBuildAdapterOptions {
  /** Injected so unit tests never open a socket. */
  reader?: AerodromeReaderV1 | null;
  rpcUrl?: string;
}

/** Aerodrome pools hold WETH; a native-ETH leg is the same pool with a wrap in
 * front of it, which the Router's ETH entrypoints perform. */
function poolTokenV1(asset: AssetRefV1): `0x${string}` | null {
  if (asset.kind === 'native') return AERODROME_WETH_V1;
  return asset.address ? (asset.address.toLowerCase() as `0x${string}`) : null;
}

/**
 * Recovers the route legs a candidate was quoted over.
 *
 * The legs live in the candidate's liquidity source keys because that is the
 * only free-form field the frozen contract offers. Returning null — rather
 * than a partial route — is what makes an unparseable card refuse to prepare
 * instead of preparing something else.
 */
export function routeFromCandidateV1(candidate: RouteCandidateV1): AerodromeRouteLegV1[] | null {
  const sources = candidate.liquiditySources;
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > AERODROME_MAX_HOPS_V1) return null;
  const legs: AerodromeRouteLegV1[] = [];
  for (const source of sources) {
    const leg = parseAerodromeSourceKeyV1(source.sourceKey);
    if (!leg) return null;
    legs.push(leg);
  }
  // One factory for the whole route: the Router quotes each leg against the
  // factory named in that leg, so a route mixing factories is not a route this
  // integration built.
  const factory = legs[0]!.factory;
  if (legs.some((leg) => leg.factory !== factory)) return null;
  for (let index = 1; index < legs.length; index += 1) {
    if (legs[index]!.from !== legs[index - 1]!.to) return null;
  }
  return legs;
}

export class AerodromeSwapBuildAdapter implements SwapBuildAdapter {
  readonly id = 'aerodrome' as const;
  private readonly options: AerodromeSwapBuildAdapterOptions;

  constructor(options: AerodromeSwapBuildAdapterOptions = {}) {
    this.options = options;
  }

  async build(input: SwapBuildInput): Promise<SwapBuildResultV1> {
    const reader =
      this.options.reader ??
      (this.options.rpcUrl?.trim() ? createAerodromeReaderV1({ rpcUrl: this.options.rpcUrl }) : null);
    if (!reader) return failure('not_configured', 'aerodrome_not_configured', false);

    const { intent } = input;
    if (intent.chainId !== 8453) return failure('rejected', 'aerodrome_pair_unsupported', false);
    if (input.walletAddress.toLowerCase() !== intent.walletAddress.toLowerCase()) {
      return failure('rejected', 'aerodrome_wallet_mismatch', false);
    }
    const fromAsset = intent.fromAsset;
    const toAsset = intent.toAsset;
    if (!fromAsset || !toAsset) return failure('rejected', 'aerodrome_pair_unsupported', false);

    const inputToken = poolTokenV1(fromAsset);
    const outputToken = poolTokenV1(toAsset);
    // ETH -> WETH is a wrap, not a swap: there is no pool, so there is nothing
    // to encode.
    if (!inputToken || !outputToken || inputToken === outputToken) {
      return failure('rejected', 'aerodrome_pair_unsupported', false);
    }

    // --- The reviewed route ---------------------------------------------------
    const reviewed = input.reviewedCandidate;
    if (!reviewed) return failure('rejected', 'aerodrome_reviewed_candidate_missing', false);
    const reviewedRoute = routeFromCandidateV1(reviewed);
    if (!reviewedRoute) return failure('rejected', 'aerodrome_reviewed_route_unreadable', false);
    if (
      reviewedRoute[0]!.from !== inputToken ||
      reviewedRoute[reviewedRoute.length - 1]!.to !== outputToken
    ) {
      return failure('rejected', 'aerodrome_reviewed_route_mismatch', false);
    }

    // A fresh full search ran moments ago in the coordinator. If it now prefers
    // different pools, this preparation ends: the alternative may well be
    // better, but it is not the trade that was reviewed, and a better price
    // through pools nobody looked at is still a substitution.
    const freshRoute = routeFromCandidateV1(input.selectedCandidate);
    if (!freshRoute || !sameAerodromeRouteV1(freshRoute, reviewedRoute)) {
      return failure('rejected', 'aerodrome_route_changed', true);
    }

    // --- Fresh reads ----------------------------------------------------------
    const factory = await reader.readDefaultFactory();
    if (!factory.ok) {
      return factory.reason === 'not_configured'
        ? failure('not_configured', 'aerodrome_not_configured', false)
        : failure('unavailable', 'aerodrome_rpc_unavailable', true);
    }
    // The Router names its own factory, and it can change it. A route quoted
    // against the previous one prices pools that are no longer the Router's
    // default, so it is refused rather than re-pointed.
    if (factory.value.toLowerCase() !== reviewedRoute[0]!.factory.toLowerCase()) {
      return failure('rejected', 'aerodrome_factory_changed', true);
    }

    const amountIn = BigInt(intent.amount.amountAtomic);
    if (amountIn <= 0n) return failure('rejected', 'aerodrome_amount_invalid', false);

    const quoted = await reader.readAmountsOut({ amountIn, route: reviewedRoute });
    if (!quoted.ok) {
      if (quoted.reason === 'no_route') return failure('rejected', 'aerodrome_route_unavailable', true);
      return failure('unavailable', 'aerodrome_rpc_unavailable', true);
    }
    const expectedAtomic = (quoted.value[quoted.value.length - 1] ?? 0n).toString();
    const blockNumber = await reader.readBlockNumber();

    // --- Amounts ---------------------------------------------------------------
    const derivedMinimum = BigInt(minimumOutputAtomic(expectedAtomic, intent.slippageConstraint.maxBps));
    const reviewedMinimum = BigInt(reviewed.minimumOutput.amountAtomic);
    // Rule 2: the reviewed floor wins whenever it is stricter.
    const minimumRaw = derivedMinimum > reviewedMinimum ? derivedMinimum : reviewedMinimum;
    if (minimumRaw <= 0n) return failure('rejected', 'aerodrome_minimum_invalid', false);
    if (BigInt(expectedAtomic) < minimumRaw) {
      return failure('expired', 'aerodrome_output_below_minimum', true);
    }

    const expectedDecimal = atomicToHumanDecimal(expectedAtomic, toAsset.decimals);
    const minimumDecimal = atomicToHumanDecimal(minimumRaw.toString(), toAsset.decimals);
    if (expectedDecimal === null || minimumDecimal === null) {
      return failure('invalid_response', 'aerodrome_amount_undisplayable', false);
    }
    const expectedOutput: TokenAmountV1 = {
      asset: toAsset,
      amountAtomic: expectedAtomic,
      amountDecimal: expectedDecimal,
    };
    const minimumOutput: TokenAmountV1 = {
      asset: toAsset,
      amountAtomic: minimumRaw.toString(),
      amountDecimal: minimumDecimal,
    };

    // --- Calls -----------------------------------------------------------------
    const quoteExpiry = new Date(input.now.getTime() + BUILD_TTL_MS).toISOString();
    const deadline = BigInt(Math.floor(Date.parse(quoteExpiry) / 1000));
    const router = AERODROME_ROUTER_V1 as `0x${string}`;
    const calls: SwapBuildCallV1[] = [];

    const inputIsNative = fromAsset.kind === 'native';
    let observedAllowanceAtomic: string | null = null;
    if (!inputIsNative) {
      const allowance = await reader.readAllowance({
        token: inputToken,
        owner: input.walletAddress,
        spender: router,
      });
      if (!allowance.ok) return failure('unavailable', 'aerodrome_allowance_unreadable', true);
      observedAllowanceAtomic = allowance.value.toString();
      // Rule 3. The allowance is read, and then written down to exactly this
      // swap regardless of what it said — a leftover unlimited grant from
      // another app is reduced, not reused. The approval is always emitted,
      // never skipped on the strength of a read taken minutes before the
      // signature: the two calls are atomic, so it costs nothing that is not
      // already being spent, and the batch stops depending on state that a
      // concurrent transaction could change in between. USDC and WETH on Base
      // both permit a direct overwrite, so no approve-to-zero step is needed
      // for the canonical tokens this version supports.
      calls.push({ to: inputToken, value: '0', data: encodeExactApproveV1(router, amountIn) });
    }

    const swapArgs = {
      amountIn,
      amountOutMin: minimumRaw,
      routes: reviewedRoute,
      to: input.walletAddress,
      deadline,
    };
    const outputIsNative = toAsset.kind === 'native';
    let swapData: `0x${string}`;
    try {
      swapData = inputIsNative
        ? encodeSwapExactEthForTokensV1(swapArgs)
        : outputIsNative
          ? encodeSwapExactTokensForEthV1(swapArgs)
          : encodeSwapExactTokensForTokensV1(swapArgs);
    } catch {
      return failure('rejected', 'aerodrome_encode_refused', false);
    }
    calls.push({ to: router, value: inputIsNative ? amountIn.toString() : '0', data: swapData });

    const request = {
      router,
      chainId: 8453,
      amountIn: intent.amount.amountAtomic,
      route: reviewedRoute.map((leg) => ({
        from: leg.from,
        to: leg.to,
        stable: leg.stable,
        factory: leg.factory,
      })),
      // The recipient and the floor are part of what was asked for, so they
      // belong in the request hash — not only in the calldata.
      recipient: input.walletAddress.toLowerCase(),
      amountOutMin: minimumRaw.toString(),
      deadline: deadline.toString(),
    };
    const response = {
      amounts: quoted.value.map((amount) => amount.toString()),
      blockNumber,
      observedAllowanceAtomic,
    };

    return {
      outcome: 'built',
      provider: 'aerodrome',
      routerAddress: router,
      calls,
      quoteExpiry,
      requestId: input.requestId,
      requestHash: canonicalRequestHash('aerodrome', request),
      responseHash: canonicalResponseHash('aerodrome', response),
      expectedOutput,
      minimumOutput,
      aerodrome: {
        route: reviewedRoute,
        factory: factory.value,
        observedAllowanceAtomic,
        inputIsNative,
        outputIsNative,
        inputTokenAddress: inputIsNative ? null : inputToken,
      },
    };
  }
}
