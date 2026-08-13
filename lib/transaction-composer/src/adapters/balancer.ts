import type { TokenAmountV1 } from '@mioagent/route-domain';
import {
  BalancerClientV1,
  atomicToHumanDecimal,
  balancerQuotePairV1,
  balancerSourceKeysV1,
  buildBalancerSwapV1,
  canonicalRequestHash,
  canonicalResponseHash,
  type BalancerClientV1Options,
} from '@mioagent/swap-adapters';
import type {
  SwapBuildAdapter,
  SwapBuildFailure,
  SwapBuildFailureOutcome,
  SwapBuildInput,
  SwapBuildResultV1,
} from '../types.js';

function failure(
  outcome: SwapBuildFailureOutcome,
  errorCode: string,
  retryable: boolean,
): SwapBuildFailure {
  return { outcome, provider: 'balancer', errorCode, retryable };
}

function sameSources(left: readonly string[], right: readonly { sourceKey: string }[]): boolean {
  return left.slice().sort().join('|') === right.map((source) => source.sourceKey).sort().join('|');
}

export interface BalancerSwapBuildAdapterOptions extends BalancerClientV1Options {
  client?: BalancerClientV1;
  rpcUrl?: string;
  buildSwap?: typeof buildBalancerSwapV1;
}

export class BalancerSwapBuildAdapter implements SwapBuildAdapter {
  readonly id = 'balancer' as const;
  private readonly client: BalancerClientV1;
  private readonly rpcUrl: string | null;
  private readonly buildSwap: typeof buildBalancerSwapV1;

  constructor(options: BalancerSwapBuildAdapterOptions = {}) {
    this.client = options.client ?? new BalancerClientV1(options);
    this.rpcUrl = options.rpcUrl?.trim() || null;
    this.buildSwap = options.buildSwap ?? buildBalancerSwapV1;
  }

  async build(input: SwapBuildInput): Promise<SwapBuildResultV1> {
    if (
      input.intent.chainId !== 8453 ||
      input.walletAddress.toLowerCase() !== input.intent.walletAddress
    ) return failure('rejected', 'balancer_wallet_or_chain_mismatch', false);
    const pair = balancerQuotePairV1(input.intent);
    if (!pair) return failure('rejected', 'balancer_pair_unsupported', false);
    if (!this.rpcUrl) return failure('not_configured', 'balancer_rpc_not_configured', false);

    const transport = await this.client.quoteExactIn({
      tokenIn: pair.tokenIn,
      tokenOut: pair.tokenOut,
      amountHuman: input.intent.amount.amountDecimal,
      amountAtomic: input.intent.amount.amountAtomic,
    });
    if (!transport.ok) {
      return failure(
        transport.reason === 'timeout' ? 'timeout' :
          transport.reason === 'rate_limited' ? 'rate_limited' :
            transport.reason === 'invalid_response' ? 'invalid_response' : 'unavailable',
        `balancer_${transport.reason}`,
        transport.reason !== 'invalid_response',
      );
    }
    const sourceKeys = balancerSourceKeysV1(transport.quote.paths);
    if (!sameSources(sourceKeys, input.selectedCandidate.liquiditySources)) {
      return failure('rejected', 'balancer_route_changed', true);
    }

    let built;
    try {
      built = await this.buildSwap({
        paths: transport.quote.paths,
        rpcUrl: this.rpcUrl,
        walletAddress: input.walletAddress,
        inputToken: pair.tokenIn,
        inputAmountAtomic: input.intent.amount.amountAtomic,
        slippageBps: input.intent.slippageConstraint.maxBps,
        minimumFloorAtomic:
          input.reviewedCandidate?.minimumOutput.amountAtomic ??
          input.selectedCandidate.minimumOutput.amountAtomic,
        now: input.now,
      });
    } catch {
      return failure('unavailable', 'balancer_onchain_query_failed', true);
    }
    const expectedDecimal = atomicToHumanDecimal(built.expectedOutputAtomic, pair.toAsset.decimals);
    const minimumDecimal = atomicToHumanDecimal(built.minimumOutputAtomic, pair.toAsset.decimals);
    if (expectedDecimal === null || minimumDecimal === null) {
      return failure('invalid_response', 'balancer_output_undisplayable', false);
    }
    const expectedOutput: TokenAmountV1 = {
      asset: pair.toAsset,
      amountAtomic: built.expectedOutputAtomic,
      amountDecimal: expectedDecimal,
    };
    const minimumOutput: TokenAmountV1 = {
      asset: pair.toAsset,
      amountAtomic: built.minimumOutputAtomic,
      amountDecimal: minimumDecimal,
    };
    return {
      outcome: 'built',
      provider: 'balancer',
      routerAddress: built.routerAddress,
      calls: built.calls,
      quoteExpiry: built.quoteExpiry,
      requestId: input.requestId,
      requestHash: canonicalRequestHash('balancer', {
        chain: 'BASE',
        tokenIn: pair.tokenIn,
        tokenOut: pair.tokenOut,
        swapType: 'EXACT_IN',
        swapAmount: input.intent.amount.amountDecimal,
      }),
      responseHash: canonicalResponseHash('balancer', transport.quote.safeResponse),
      expectedOutput,
      minimumOutput,
      balancer: {
        protocolVersion: built.protocolVersion,
        sourceKeys,
      },
    };
  }
}
