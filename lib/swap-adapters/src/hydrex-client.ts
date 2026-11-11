import { z } from 'zod';

/**
 * Hydrex's own router API. Until 2026-11-11 this client asked
 * `hydrex-agent.com`, the host Hydrex's Wallet MCP plugin names; from the
 * evening of 2026-11-09 that host accepted no connection, from the server or
 * from anywhere else, and every comparison waited out its timeout for a
 * router that could not answer. That host was a wrapper: its `/state/quote`
 * returned, inside `{ ok, data }`, exactly what this API's `/quote` returns,
 * a call on the same pinned Hydrex router. The reviewed parser reads the
 * answer unchanged (checked against live answers the same day).
 *
 * The host is not what is trusted. The call it returns is decoded and held
 * against the pinned router, the pinned upstream and the intent, whichever
 * host sent it. This API is not described in Hydrex's public documents, so a
 * change in it will show as a refusal by the parser, not as a wrong swap.
 */
export const HYDREX_API_ORIGIN_V1 = 'https://router.api.hydrex.fi' as const;
export const HYDREX_QUOTE_PATH_V1 = '/quote' as const;

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

export type HydrexSourceV1 = 'ZEROX' | 'KYBERSWAP';

export interface HydrexQuoteRequestV1 {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amount: string;
  recipient: `0x${string}`;
  slippage: number;
  source?: HydrexSourceV1;
}

export type HydrexTransportResultV1<TRequest> =
  | { outcome: 'response'; status: number; payload: unknown; safeRequest: TRequest }
  /** The API answered that none of its sources has a quote for this pair and
   * amount. It is an answer about the route, not a failure to reach Hydrex. */
  | { outcome: 'no_route'; status: number }
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

/** The API's own words for "no source quoted this": HTTP 400 with a message
 * that begins this way (seen 2026-11-11). Any other 400 is our request being
 * wrong, and stays a failure. */
function noQuoteAnswerV1(payload: unknown): boolean {
  const message = (payload as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.startsWith('No valid quotes');
}

export class HydrexClientV1 {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HydrexClientV1Options = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  /** One quote, with the call that would execute it. A build asks again with
   * the `source` the reviewed route used; there is no separate prepare step. */
  quote(request: HydrexQuoteRequestV1): Promise<HydrexTransportResultV1<HydrexQuoteRequestV1>> {
    return this.get(HYDREX_QUOTE_PATH_V1, request, {
      fromTokenAddress: request.tokenIn,
      toTokenAddress: request.tokenOut,
      amount: request.amount,
      // The API calls the final recipient the taker.
      taker: request.recipient,
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
      if (response.status === 400 && noQuoteAnswerV1(payload)) return { outcome: 'no_route', status: 400 };
      if (response.status < 200 || response.status >= 300) {
        return { outcome: 'unavailable', status: response.status };
      }
      // The reviewed parser reads the shape the first host wrapped this
      // answer in, so the same wrapper is put back around it here.
      return { outcome: 'response', status: response.status, payload: { ok: true, data: payload }, safeRequest };
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
