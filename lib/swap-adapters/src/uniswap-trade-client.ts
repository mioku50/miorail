import { partnerFetch } from '@mioagent/security/httpAllowlist';

// T56: shared typed Uniswap trade client. It owns response-shape validation
// for the two Uniswap trade endpoints (quote + swap_5792) behind an
// injectable transport so both the legacy BaseApp-native prep path
// (artifacts/api-server/lib/streamBaseAppNativeRouting.ts, transport built on
// the constrained plugin_http_request gateway) and the T56 transaction
// composer's Uniswap build adapter (transport built on partnerFetch) can
// reuse the exact same validation instead of forking it.

export type UniswapTradePath = '/v1/quote' | '/v1/swap_5792';

export interface UniswapTradeTransportResult {
  status: number;
  payload: unknown;
}

export interface UniswapTradeTransport {
  post(path: UniswapTradePath, body: unknown): Promise<UniswapTradeTransportResult>;
}

export interface UniswapTradeQuoteResult {
  outcome: 'quote' | 'http_error' | 'invalid_response';
  status?: number;
  payload?: Record<string, unknown>;
  routing?: string;
}

const VALID_ROUTINGS = ['CLASSIC', 'WRAP', 'UNWRAP'];

export async function requestUniswapTradeQuote(
  transport: UniswapTradeTransport,
  body: unknown,
): Promise<UniswapTradeQuoteResult> {
  const result = await transport.post('/v1/quote', body);
  if (result.status < 200 || result.status >= 300) {
    return { outcome: 'http_error', status: result.status };
  }
  if (!result.payload || typeof result.payload !== 'object') return { outcome: 'invalid_response' };
  const record = result.payload as Record<string, unknown>;
  const quote = record.quote;
  const quoteRecord = quote && typeof quote === 'object' ? (quote as Record<string, unknown>) : null;
  const routing = String(record.routing ?? quoteRecord?.routing ?? '').toUpperCase();
  if (!quoteRecord || !VALID_ROUTINGS.includes(routing)) {
    return { outcome: 'invalid_response' };
  }
  return { outcome: 'quote', payload: record, routing };
}

export interface UniswapTradeSwapCall {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
}

export interface UniswapTradeSwapResult {
  outcome: 'prepared' | 'http_error' | 'invalid_response';
  status?: number;
  calls?: UniswapTradeSwapCall[];
  requestId?: string;
}

export async function requestUniswapTradeSwap5792(
  transport: UniswapTradeTransport,
  body: unknown,
  walletAddress: string,
): Promise<UniswapTradeSwapResult> {
  const result = await transport.post('/v1/swap_5792', body);
  if (result.status < 200 || result.status >= 300) {
    return { outcome: 'http_error', status: result.status };
  }
  if (!result.payload || typeof result.payload !== 'object') return { outcome: 'invalid_response' };
  const record = result.payload as Record<string, unknown>;
  if (
    String(record.from || '').toLowerCase() !== walletAddress.toLowerCase() ||
    Number(record.chainId) !== 8453 ||
    typeof record.requestId !== 'string' ||
    !Array.isArray(record.calls)
  ) {
    return { outcome: 'invalid_response' };
  }
  const calls: UniswapTradeSwapCall[] = [];
  for (const rawCall of record.calls) {
    if (!rawCall || typeof rawCall !== 'object') return { outcome: 'invalid_response' };
    const call = rawCall as Record<string, unknown>;
    const to = String(call.to || '').toLowerCase();
    const data = String(call.data ?? '0x').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(to) || !/^0x(?:[0-9a-f]{2})*$/.test(data)) {
      return { outcome: 'invalid_response' };
    }
    calls.push({ to: to as `0x${string}`, value: String(call.value ?? '0'), data: data as `0x${string}` });
  }
  return { outcome: 'prepared', calls, requestId: record.requestId.slice(0, 200) };
}

export class UniswapTradeClient {
  constructor(private readonly transport: UniswapTradeTransport) {}

  quote(body: unknown): Promise<UniswapTradeQuoteResult> {
    return requestUniswapTradeQuote(this.transport, body);
  }

  swap5792(body: unknown, walletAddress: string): Promise<UniswapTradeSwapResult> {
    return requestUniswapTradeSwap5792(this.transport, body, walletAddress);
  }
}

export interface PartnerFetchTradeTransportOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

/** Transport built directly on the already-allowlisted partnerFetch host. */
export function createPartnerFetchTradeTransport(
  options: PartnerFetchTradeTransportOptions,
): UniswapTradeTransport {
  return {
    async post(path, body) {
      const response = await partnerFetch(
        `https://trade-api.gateway.uniswap.org${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            ...(options.extraHeaders ?? {}),
          },
          body: JSON.stringify(body),
        },
        { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs },
      );
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      return { status: response.status, payload };
    },
  };
}
