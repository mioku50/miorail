import { partnerFetch } from '@mioagent/security/httpAllowlist';
import {
  basisPointsToPercentage,
  normalizeCaughtProviderError,
  providerFailure,
  type BASE_MAINNET_CHAIN_ID,
} from './normalization.js';
import type { SwapAdapterFailure } from './types.js';

export const UNISWAP_QUOTE_ENDPOINT = 'https://trade-api.gateway.uniswap.org/v1/quote';

export interface UniswapQuoteClientRequest {
  chainId: typeof BASE_MAINNET_CHAIN_ID;
  amountInAtomic: string;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  swapper: `0x${string}`;
  slippageBps: number | null;
}

export type UniswapQuoteClientFailure = SwapAdapterFailure & { httpStatus?: number };

export type UniswapQuoteClientResult =
  | {
      outcome: 'response';
      status: number;
      payload: unknown;
      safeRequest: Record<string, unknown>;
    }
  | UniswapQuoteClientFailure;

export interface UniswapQuoteClientOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
}

export class UniswapQuoteClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(options: UniswapQuoteClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey ?? process.env.UNISWAP_API_KEY;
    this.endpoint = options.endpoint ?? UNISWAP_QUOTE_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  configured(): boolean {
    return Boolean(this.apiKey?.trim());
  }

  async quote(request: UniswapQuoteClientRequest): Promise<UniswapQuoteClientResult> {
    if (!this.configured()) return providerFailure('uniswap', 'provider_not_configured');
    const safeRequest: Record<string, unknown> = {
      path: '/v1/quote',
      chainId: request.chainId,
      type: 'EXACT_INPUT',
      amount: request.amountInAtomic,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      tokenInChainId: request.chainId,
      tokenOutChainId: request.chainId,
      swapper: request.swapper,
      protocols: ['V4', 'V3', 'V2'],
      routingPreference: 'BEST_PRICE',
      ...(request.slippageBps === null
        ? { autoSlippage: 'DEFAULT' }
        : { slippageTolerance: basisPointsToPercentage(request.slippageBps) }),
    };

    try {
      const response = await partnerFetch(
        this.endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey!,
            'x-permit2-disabled': 'true',
          },
          body: JSON.stringify(Object.fromEntries(Object.entries(safeRequest).filter(([key]) => key !== 'path'))),
        },
        { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs },
      );
      if (!response.ok) {
        if (response.status === 404) return providerFailure('uniswap', 'provider_no_route', 404);
        return {
          ...providerFailure('uniswap', 'provider_http_error', response.status),
          httpStatus: response.status,
        };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return providerFailure('uniswap', 'provider_invalid_schema');
      }
      return { outcome: 'response', status: response.status, payload, safeRequest };
    } catch (error) {
      return normalizeCaughtProviderError('uniswap', error);
    }
  }
}
