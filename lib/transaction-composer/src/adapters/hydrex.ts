import { encodeFunctionData, erc20Abi } from 'viem';
import type { TokenAmountV1 } from '@mioagent/route-domain';
import {
  HYDREX_BASE_ROUTER_PROXY_V1,
  HydrexClientV1,
  atomicToHumanDecimal,
  canonicalRequestHash,
  canonicalResponseHash,
  createHydrexRouterPinReaderV1,
  hydrexQuoteRequestFromIntentV1,
  parseHydrexPrepareSwapV1,
  type HydrexClientV1Options,
  type HydrexRouterPinReaderV1,
  type HydrexSourceV1,
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
  return { outcome, provider: 'hydrex', errorCode, retryable };
}

export interface HydrexSwapBuildAdapterOptions extends HydrexClientV1Options {
  client?: HydrexClientV1;
  pinReader?: HydrexRouterPinReaderV1 | null;
  rpcUrl?: string;
}

function sourceFromCandidate(input: SwapBuildInput['selectedCandidate']): HydrexSourceV1 | null {
  if (input.liquiditySources.length !== 1) return null;
  const upstream = input.liquiditySources[0]!.upstreamProvider;
  return upstream === 'zerox' ? 'ZEROX' : upstream === 'kyberswap' ? 'KYBERSWAP' : null;
}

function sameSources(
  left: readonly { sourceKey: string }[],
  right: readonly { sourceKey: string }[],
): boolean {
  return left.length === right.length &&
    left.map((item) => item.sourceKey).sort().join('|') ===
      right.map((item) => item.sourceKey).sort().join('|');
}

export class HydrexSwapBuildAdapter implements SwapBuildAdapter {
  readonly id = 'hydrex' as const;
  private readonly client: HydrexClientV1;
  private readonly pinReader: HydrexRouterPinReaderV1 | null;

  constructor(options: HydrexSwapBuildAdapterOptions = {}) {
    this.client = options.client ?? new HydrexClientV1(options);
    this.pinReader = options.pinReader ??
      (options.rpcUrl?.trim() ? createHydrexRouterPinReaderV1({ rpcUrl: options.rpcUrl }) : null);
  }

  async build(input: SwapBuildInput): Promise<SwapBuildResultV1> {
    if (input.intent.chainId !== 8453 || input.walletAddress.toLowerCase() !== input.intent.walletAddress) {
      return failure('rejected', 'hydrex_wallet_or_chain_mismatch', false);
    }
    const quoteRequest = hydrexQuoteRequestFromIntentV1(input.intent, input.walletAddress);
    if (!quoteRequest) return failure('rejected', 'hydrex_pair_unsupported', false);
    const source = sourceFromCandidate(input.selectedCandidate);
    if (!source) return failure('rejected', 'hydrex_route_source_missing', false);
    if (!this.pinReader) return failure('not_configured', 'hydrex_contract_pin_not_configured', false);
    const outerPin = await this.pinReader.verify();
    if (!outerPin.ok) {
      return failure(
        outerPin.reason === 'not_configured' ? 'not_configured' : 'router_mismatch',
        outerPin.reason === 'mismatch' ? 'hydrex_contract_pin_mismatch' : 'hydrex_contract_pin_unavailable',
        outerPin.reason === 'unavailable',
      );
    }
    const request = {
      tokenIn: quoteRequest.tokenIn,
      tokenOut: quoteRequest.tokenOut,
      amount: input.intent.amount.amountDecimal,
      decimals: input.intent.fromAsset!.decimals,
      recipient: input.walletAddress,
      slippage: input.intent.slippageConstraint.maxBps,
      source,
    } as const;
    const transport = await this.client.prepareSwap(request);
    if (transport.outcome !== 'response') {
      return failure(
        transport.outcome === 'timeout' ? 'timeout' :
          transport.outcome === 'rate_limited' ? 'rate_limited' : 'unavailable',
        `hydrex_${transport.outcome}`,
        true,
      );
    }
    const parsed = parseHydrexPrepareSwapV1({
      payload: transport.payload,
      request,
      inputAsset: input.intent.fromAsset!,
      outputAsset: input.intent.toAsset!,
      amountInAtomic: input.intent.amount.amountAtomic,
      now: input.now,
    });
    if (!parsed.ok) return failure('invalid_response', parsed.errorCode, false);
    if (parsed.value.upstreamSource !== source ||
      !sameSources(parsed.value.liquiditySources, input.selectedCandidate.liquiditySources)) {
      return failure('rejected', 'hydrex_route_changed', true);
    }
    const routePin = await this.pinReader.verifyUpstream(parsed.value.upstreamRouter);
    if (!routePin.ok) {
      return failure(
        routePin.reason === 'mismatch' ? 'router_mismatch' : 'unavailable',
        routePin.reason === 'mismatch' ? 'hydrex_upstream_pin_mismatch' : 'hydrex_contract_pin_unavailable',
        routePin.reason === 'unavailable',
      );
    }
    const outputAsset = input.intent.toAsset!;
    const expectedDecimal = atomicToHumanDecimal(parsed.value.expectedOutputAtomic, outputAsset.decimals);
    const minimumDecimal = atomicToHumanDecimal(parsed.value.minimumOutputAtomic, outputAsset.decimals);
    if (expectedDecimal === null || minimumDecimal === null) {
      return failure('invalid_response', 'hydrex_output_undisplayable', false);
    }
    const expectedOutput: TokenAmountV1 = {
      asset: outputAsset,
      amountAtomic: parsed.value.expectedOutputAtomic,
      amountDecimal: expectedDecimal,
    };
    const minimumOutput: TokenAmountV1 = {
      asset: outputAsset,
      amountAtomic: parsed.value.minimumOutputAtomic,
      amountDecimal: minimumDecimal,
    };
    const inputToken = input.intent.fromAsset!.address!.toLowerCase() as `0x${string}`;
    const calls = [
      {
        to: inputToken,
        value: '0',
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [HYDREX_BASE_ROUTER_PROXY_V1, BigInt(input.intent.amount.amountAtomic)],
        }),
      },
      parsed.value.swapCall,
    ];
    return {
      outcome: 'built',
      provider: 'hydrex',
      routerAddress: HYDREX_BASE_ROUTER_PROXY_V1,
      calls,
      quoteExpiry: new Date(Number(BigInt(parsed.value.deadline) * 1000n)).toISOString(),
      requestId: input.requestId,
      requestHash: canonicalRequestHash('hydrex', transport.safeRequest),
      responseHash: canonicalResponseHash('hydrex', parsed.value.safeResponse),
      expectedOutput,
      minimumOutput,
      hydrex: {
        contractPinVerified: true,
        upstreamRouter: parsed.value.upstreamRouter,
        upstreamSource: parsed.value.upstreamSource,
      },
    };
  }
}
