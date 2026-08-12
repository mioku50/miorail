import { encodeFunctionData, erc20Abi } from 'viem';
import type { TokenAmountV1 } from '@mioagent/route-domain';
import {
  O1OrderClientV1,
  O1_BASE_ROUTER_PROXY_V1,
  atomicToHumanDecimal,
  canonicalRequestHash,
  canonicalResponseHash,
  createO1RouterPinReaderV1,
  o1OrderRequestFromIntentV1,
  parseO1OrderV1,
  type O1OrderClientV1Options,
  type O1RouterPinReaderV1,
} from '@mioagent/swap-adapters';
import type {
  SwapBuildAdapter,
  SwapBuildFailure,
  SwapBuildFailureOutcome,
  SwapBuildInput,
  SwapBuildResultV1,
} from '../types.js';

const BUILD_TTL_MS = 10 * 60_000;

function failure(
  outcome: SwapBuildFailureOutcome,
  errorCode: string,
  retryable: boolean,
): SwapBuildFailure {
  return { outcome, provider: 'o1-exchange', errorCode, retryable };
}

export interface O1SwapBuildAdapterOptions extends O1OrderClientV1Options {
  client?: O1OrderClientV1;
  pinReader?: O1RouterPinReaderV1 | null;
  rpcUrl?: string;
}

function sameSources(
  left: readonly { sourceKey: string }[],
  right: readonly { sourceKey: string }[],
): boolean {
  return (
    left.length === right.length &&
    left
      .map((item) => item.sourceKey)
      .sort()
      .join('|') ===
      right
        .map((item) => item.sourceKey)
        .sort()
        .join('|')
  );
}

export class O1SwapBuildAdapter implements SwapBuildAdapter {
  readonly id = 'o1-exchange' as const;
  private readonly client: O1OrderClientV1;
  private readonly pinReader: O1RouterPinReaderV1 | null;

  constructor(options: O1SwapBuildAdapterOptions = {}) {
    this.client = options.client ?? new O1OrderClientV1(options);
    this.pinReader =
      options.pinReader ??
      (options.rpcUrl?.trim() ? createO1RouterPinReaderV1({ rpcUrl: options.rpcUrl }) : null);
  }

  async build(input: SwapBuildInput): Promise<SwapBuildResultV1> {
    if (
      input.intent.chainId !== 8453 ||
      input.walletAddress.toLowerCase() !== input.intent.walletAddress
    ) {
      return failure('rejected', 'o1_wallet_or_chain_mismatch', false);
    }
    const request = o1OrderRequestFromIntentV1(input.intent, input.walletAddress);
    if (!request) return failure('rejected', 'o1_pair_unsupported', false);
    if (!this.pinReader) return failure('not_configured', 'o1_contract_pin_not_configured', false);
    const pin = await this.pinReader.verify();
    if (!pin.ok) {
      return failure(
        pin.reason === 'not_configured' ? 'not_configured' : 'router_mismatch',
        pin.reason === 'mismatch' ? 'o1_contract_pin_mismatch' : 'o1_contract_pin_unavailable',
        pin.reason === 'unavailable',
      );
    }
    const transport = await this.client.order(request);
    if (transport.outcome !== 'response') {
      return failure(
        transport.outcome === 'not_configured'
          ? 'not_configured'
          : transport.outcome === 'timeout'
            ? 'timeout'
            : transport.outcome === 'rate_limited'
              ? 'rate_limited'
              : 'unavailable',
        `o1_${transport.outcome}`,
        transport.outcome !== 'not_configured',
      );
    }
    const parsed = parseO1OrderV1({
      payload: transport.payload,
      request,
      inputAsset: input.intent.fromAsset!,
      outputAsset: input.intent.toAsset!,
      amountInAtomic: input.intent.amount.amountAtomic,
    });
    if (!parsed.ok) return failure('invalid_response', parsed.errorCode, false);
    if (!sameSources(parsed.value.liquiditySources, input.selectedCandidate.liquiditySources)) {
      return failure('rejected', 'o1_route_changed', true);
    }

    const outputAsset = input.intent.toAsset!;
    const expectedDecimal = atomicToHumanDecimal(
      parsed.value.expectedOutputAtomic,
      outputAsset.decimals,
    );
    const minimumDecimal = atomicToHumanDecimal(
      parsed.value.minimumOutputAtomic,
      outputAsset.decimals,
    );
    if (expectedDecimal === null || minimumDecimal === null) {
      return failure('invalid_response', 'o1_output_undisplayable', false);
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

    // o1 currently returns an unlimited approval. Provider approval bytes are
    // deliberately discarded and replaced with an exact atomic approval.
    const inputToken = input.intent.fromAsset!.address!.toLowerCase() as `0x${string}`;
    const calls = [
      {
        to: inputToken,
        value: '0',
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [O1_BASE_ROUTER_PROXY_V1, BigInt(input.intent.amount.amountAtomic)],
        }),
      },
      parsed.value.swapCall,
    ];
    const quoteExpiry = new Date(input.now.getTime() + BUILD_TTL_MS).toISOString();
    return {
      outcome: 'built',
      provider: 'o1-exchange',
      routerAddress: O1_BASE_ROUTER_PROXY_V1,
      calls,
      quoteExpiry,
      requestId: input.requestId,
      requestHash: canonicalRequestHash('o1-exchange', transport.safeRequest),
      responseHash: canonicalResponseHash('o1-exchange', parsed.value.safeResponse),
      expectedOutput,
      minimumOutput,
      o1: { contractPinVerified: true },
    };
  }
}
