import { BASE_UNISWAP_UNIVERSAL_ROUTER_2 } from '@mioagent/security/uniswapGuard';
import {
  atomicToHumanDecimal,
  canonicalRequestHash,
  canonicalResponseHash,
  minimumOutputAtomic,
  parsePositiveAtomic,
  parseUnsignedAtomic,
  providerTokenAddress,
  createPartnerFetchTradeTransport,
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
        }),
    );
  }

  async build(input: SwapBuildInput): Promise<SwapBuildResultV1> {
    if (!this.configured) return failure('not_configured', 'uniswap_not_configured', false);
    const { intent } = input;
    if (
      intent.fromAsset?.symbol !== 'USDC' ||
      !['ETH', 'WETH'].includes(intent.toAsset?.symbol ?? '') ||
      intent.chainId !== 8453
    ) {
      return failure('rejected', 'uniswap_pair_unsupported', false);
    }
    if (input.walletAddress.toLowerCase() !== intent.walletAddress.toLowerCase()) {
      return failure('rejected', 'uniswap_wallet_mismatch', false);
    }
    const tokenIn = providerTokenAddress(intent.fromAsset, 'uniswap');
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
      ...(intent.slippageConstraint.maxBps > 0
        ? { slippageTolerance: (intent.slippageConstraint.maxBps / 100).toString() }
        : { autoSlippage: 'DEFAULT' }),
      generatePermitAsTransaction: true,
      permitAmount: 'EXACT',
    };
    const quoteResult = await this.client.quote(quoteBody);
    if (quoteResult.outcome === 'http_error') return failure('unavailable', `uniswap_http_${quoteResult.status}`, true);
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
    const swapResult = await this.client.swap5792(swapBody, input.walletAddress);
    if (swapResult.outcome === 'http_error') return failure('unavailable', `uniswap_http_${swapResult.status}`, true);
    if (swapResult.outcome !== 'prepared') return failure('invalid_response', 'uniswap_5792_invalid', false);

    const routerCalls = swapResult.calls!.filter((call) => call.to.toLowerCase() === ROUTER.toLowerCase());
    if (routerCalls.length !== 1) return failure('router_mismatch', 'uniswap_router_not_pinned', false);

    const requestHash = canonicalRequestHash('uniswap', { path: '/v1/quote', ...quoteBody });
    const responseHash = canonicalResponseHash('uniswap', {
      quote: { requestId: swapResult.requestId, calls: swapResult.calls },
    });
    return {
      outcome: 'built',
      provider: 'uniswap',
      routerAddress: ROUTER,
      calls: swapResult.calls!,
      quoteExpiry,
      requestId,
      requestHash,
      responseHash,
      expectedOutput,
      minimumOutput,
    };
  }
}
