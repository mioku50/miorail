import { z } from 'zod';

export const HYDREX_API_ORIGIN_V1 = 'https://hydrex-agent.com' as const;
export const HYDREX_QUOTE_PATH_V1 = '/state/quote' as const;
export const HYDREX_PREPARE_SWAP_PATH_V1 = '/prepare/swap' as const;

const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const AtomicSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const HexDataSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

const HydrexTransactionSchema = z
  .object({
    to: AddressSchema,
    data: HexDataSchema,
    value: z.union([AtomicSchema, z.string().regex(/^0x[0-9a-fA-F]+$/)]),
  })
  .strict();

export const HydrexQuoteResponseV1Schema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        amountIn: AtomicSchema,
        amountOut: AtomicSchema,
        minOutputAmount: AtomicSchema,
        recipient: AddressSchema,
        transaction: HydrexTransactionSchema,
      })
      .passthrough(),
  })
  .passthrough();
export type HydrexQuoteResponseV1 = z.infer<typeof HydrexQuoteResponseV1Schema>;

const HydrexPreparedTransactionSchema = HydrexTransactionSchema.extend({
  step: z.enum(['approve-tokenIn', 'swap']),
  chainId: z.literal(8453),
}).strict();

export const HydrexPrepareSwapResponseV1Schema = z
  .object({
    ok: z.literal(true),
    quote: z
      .object({
        tokenIn: AddressSchema,
        tokenOut: AddressSchema,
        amountIn: AtomicSchema,
        amountOut: AtomicSchema,
      })
      .strict(),
    approval: z
      .object({
        required: z.boolean(),
        token: AddressSchema,
        spender: AddressSchema,
        amount: AtomicSchema,
      })
      .strict(),
    transactions: z.array(HydrexPreparedTransactionSchema).min(1).max(2),
  })
  .passthrough();
export type HydrexPrepareSwapResponseV1 = z.infer<typeof HydrexPrepareSwapResponseV1Schema>;

export type HydrexSourceV1 = 'ZEROX' | 'KYBERSWAP';

export interface HydrexQuoteRequestV1 {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amount: string;
  recipient: `0x${string}`;
  slippage: number;
  source?: HydrexSourceV1;
}

export interface HydrexPrepareSwapRequestV1 {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amount: string;
  decimals: number;
  recipient: `0x${string}`;
  slippage: number;
  source: HydrexSourceV1;
}

export type HydrexTransportResultV1<TRequest> =
  | { outcome: 'response'; status: number; payload: unknown; safeRequest: TRequest }
  | { outcome: 'timeout' | 'rate_limited' | 'unavailable'; status: number | null };

export interface HydrexClientV1Options {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function query(input: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

export class HydrexClientV1 {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HydrexClientV1Options = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  quote(request: HydrexQuoteRequestV1): Promise<HydrexTransportResultV1<HydrexQuoteRequestV1>> {
    return this.get(HYDREX_QUOTE_PATH_V1, request, {
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amount: request.amount,
      recipient: request.recipient,
      slippage: request.slippage,
      source: request.source,
    });
  }

  prepareSwap(
    request: HydrexPrepareSwapRequestV1,
  ): Promise<HydrexTransportResultV1<HydrexPrepareSwapRequestV1>> {
    return this.get(HYDREX_PREPARE_SWAP_PATH_V1, request, {
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amount: request.amount,
      decimals: request.decimals,
      recipient: request.recipient,
      slippage: request.slippage,
      source: request.source,
    });
  }

  private async get<TRequest>(
    path: string,
    safeRequest: TRequest,
    parameters: Record<string, string | number | undefined>,
  ): Promise<HydrexTransportResultV1<TRequest>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${HYDREX_API_ORIGIN_V1}${path}?${query(parameters)}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        // The typed parser rejects an unreadable response.
      }
      if (response.status === 429) return { outcome: 'rate_limited', status: 429 };
      if (response.status < 200 || response.status >= 300) {
        return { outcome: 'unavailable', status: response.status };
      }
      return { outcome: 'response', status: response.status, payload, safeRequest };
    } catch (error) {
      return {
        outcome:
          error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`)
            ? 'timeout'
            : 'unavailable',
        status: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
