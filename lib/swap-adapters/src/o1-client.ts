import { z } from 'zod';

export const O1_API_ORIGIN_V1 = 'https://api.o1.exchange' as const;
export const O1_ORDER_PATH_V1 = '/api/v2/order' as const;

const O1TransactionSchema = z
  .object({
    id: z.string().min(1).max(200),
    unsigned: z.string().regex(/^0x[0-9a-fA-F]+$/),
    description: z.string().min(1).max(100).optional(),
    pool: z.string().optional(),
    exchange: z.string().optional(),
    token: z.unknown().optional(),
    quoteToken: z.unknown().optional(),
    permit2: z.unknown().optional(),
  })
  .passthrough();

export const O1OrderResponseV1Schema = z
  .object({
    success: z.literal(true),
    id: z.string().min(1).max(200),
    order: z
      .object({
        networkId: z.number().int(),
        signerAddress: z.string(),
        tokenAddress: z.string(),
        quoteTokenAddress: z.string(),
        uiAmount: z.string(),
        direction: z.enum(['buy', 'sell']),
        slippageBps: z.number().int(),
        mevProtection: z.boolean(),
      })
      .passthrough(),
    transactions: z.array(O1TransactionSchema).min(1).max(4),
  })
  .passthrough();
export type O1OrderResponseV1 = z.infer<typeof O1OrderResponseV1Schema>;

export interface O1OrderRequestV1 {
  networkId: 8453;
  signerAddress: `0x${string}`;
  tokenAddress: `0x${string}`;
  quoteTokenAddress: `0x${string}`;
  uiAmount: string;
  direction: 'buy' | 'sell';
  slippageBps: number;
  mevProtection: false;
}

export type O1OrderTransportResultV1 =
  | { outcome: 'response'; status: number; payload: unknown; safeRequest: O1OrderRequestV1 }
  | {
      outcome: 'not_configured' | 'timeout' | 'rate_limited' | 'unavailable';
      status: number | null;
    };

export interface O1OrderClientV1Options {
  sharedToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class O1OrderClientV1 {
  private readonly sharedToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: O1OrderClientV1Options = {}) {
    this.sharedToken = options.sharedToken ?? process.env.BASE_MCP_O1_SHARED_TOKEN ?? '';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  async order(request: O1OrderRequestV1): Promise<O1OrderTransportResultV1> {
    if (!this.sharedToken.trim()) {
      return { outcome: 'not_configured', status: null };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${O1_API_ORIGIN_V1}${O1_ORDER_PATH_V1}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.sharedToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        // The caller maps an unreadable success/error body to invalid response.
      }
      if (response.status === 429) return { outcome: 'rate_limited', status: 429 };
      if (response.status < 200 || response.status >= 300) {
        return { outcome: 'unavailable', status: response.status };
      }
      return { outcome: 'response', status: response.status, payload, safeRequest: request };
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
