import type { ToolDef, ToolProvider } from './provider.js';
import {
  UniswapQuoteClient,
  percentageToBasisPoints,
  type UniswapQuoteClientFailure,
} from '@mioagent/swap-adapters';

const QUOTE_ENDPOINT = 'https://trade-api.gateway.uniswap.org/v1/quote';
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const TOKENS = {
  USDC: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  ETH: { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', decimals: 18 },
  WETH: { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
} as const;

type TokenSymbol = keyof typeof TOKENS;
type FetchLike = typeof fetch;

const TOOL: ToolDef = {
  name: 'uniswap_quote',
  description: 'Get a screened read-only Uniswap quote on Base. Returns no calldata, approval, signature, or transaction preparation.',
  inputSchema: {
    type: 'object',
    properties: {
      chain: { type: 'string', enum: ['base'] },
      amountIn: { type: 'string', pattern: '^[0-9]+(?:\\.[0-9]+)?$' },
      tokenIn: { type: 'string', enum: ['USDC', 'ETH', 'WETH'] },
      tokenOut: { type: 'string', enum: ['USDC', 'ETH', 'WETH'] },
      swapper: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
      slippageTolerance: { type: 'number', minimum: 0, maximum: 20 },
      quoteOnly: { type: 'boolean', const: true },
    },
    required: ['chain', 'amountIn', 'tokenIn', 'tokenOut', 'swapper', 'quoteOnly'],
    additionalProperties: false,
  },
};

function timeoutMs(): number {
  const parsed = Number(process.env.UNISWAP_QUOTE_TIMEOUT_MS || 8_000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30_000) : 8_000;
}

function legacyErrorCode(error: UniswapQuoteClientFailure): string {
  if (error.errorCode === 'provider_not_configured') return 'uniswap_quote_not_configured';
  if (error.errorCode === 'provider_timeout') return 'uniswap_quote_timeout';
  if (error.errorCode === 'provider_rate_limited') return 'uniswap_quote_rate_limited';
  if (error.errorCode === 'provider_no_route') return 'uniswap_quote_unavailable';
  if (error.errorCode === 'provider_unreachable') return 'uniswap_quote_unreachable';
  if (error.errorCode === 'provider_invalid_schema') return 'uniswap_quote_invalid_response';
  if (error.errorCode === 'provider_http_error' && [401, 403].includes(error.httpStatus ?? 0)) {
    return 'uniswap_quote_authorization_failed';
  }
  return 'uniswap_quote_failed';
}

function token(value: unknown): typeof TOKENS[TokenSymbol] | null {
  const symbol = String(value || '').toUpperCase() as TokenSymbol;
  return TOKENS[symbol] || null;
}

function toBaseUnits(value: string, decimals: number): string | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) return null;
  const units = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  try {
    const amount = BigInt(units || '0');
    return amount > 0n ? amount.toString() : null;
  } catch {
    return null;
  }
}

function fromBaseUnits(value: unknown, decimals: number): string | null {
  try {
    const amount = BigInt(String(value));
    const raw = amount.toString().padStart(decimals + 1, '0');
    const whole = raw.slice(0, -decimals) || '0';
    const fraction = raw.slice(-decimals).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeQuoteResponse(input: {
  payload: Record<string, any>;
  amountInRaw: string;
  tokenIn: typeof TOKENS[TokenSymbol];
  tokenOut: typeof TOKENS[TokenSymbol];
  requestedSlippage?: number;
}): Record<string, unknown> | null {
  const quote = input.payload.quote;
  if (!quote || typeof quote !== 'object') return null;
  const outputRaw = quote.output?.amount ?? quote.amountOut ?? quote.outputAmount ?? input.payload.amountOut;
  const amountOut = fromBaseUnits(outputRaw, input.tokenOut.decimals);
  if (!amountOut || BigInt(String(outputRaw)) <= 0n) return null;
  const priceImpact = finiteNumber(quote.priceImpact ?? quote.priceImpactPct ?? input.payload.priceImpact);
  const priceImpactBps = finiteNumber(quote.priceImpactBps ?? input.payload.priceImpactBps);
  const slippage = finiteNumber(quote.slippageTolerance ?? input.payload.slippageTolerance ?? input.requestedSlippage);
  const gasUsd = quote.classicGasUseEstimateUSD ?? input.payload.classicGasUseEstimateUSD;
  const gasRaw = quote.gasFee ?? quote.gasUseEstimate ?? input.payload.gasFee ?? input.payload.permitGasFee;
  const routing = String(input.payload.routing || quote.routing || 'UNISWAP').slice(0, 80);

  return {
    quoteOnly: true,
    chainId: 8453,
    amountIn: fromBaseUnits(input.amountInRaw, input.tokenIn.decimals),
    amountOut,
    tokenIn: { symbol: input.tokenIn.symbol, address: input.tokenIn.address, decimals: input.tokenIn.decimals },
    tokenOut: { symbol: input.tokenOut.symbol, address: input.tokenOut.address, decimals: input.tokenOut.decimals },
    route: { provider: 'Uniswap', routing, path: [input.tokenIn.symbol, input.tokenOut.symbol] },
    priceImpactPct: priceImpact ?? (priceImpactBps === null ? null : priceImpactBps / 100),
    slippagePct: slippage ?? 'auto',
    gasEstimate: gasUsd !== undefined
      ? { value: String(gasUsd).slice(0, 80), unit: 'USD' }
      : gasRaw !== undefined
        ? { value: String(gasRaw).slice(0, 80), unit: 'chain-base-units' }
        : { value: null, unit: 'unavailable' },
    transactionPrepared: false,
  };
}

export class UniswapQuoteToolProvider implements ToolProvider {
  id = 'uniswap-quote';

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly apiKey: string | undefined = process.env.UNISWAP_API_KEY,
    private readonly endpoint = QUOTE_ENDPOINT,
  ) {}

  async listTools(): Promise<ToolDef[]> {
    return this.apiKey?.trim() ? [TOOL] : [];
  }

  findTool(name: string): ToolDef | undefined {
    return name === TOOL.name && this.apiKey?.trim() ? TOOL : undefined;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    if (name !== TOOL.name) return { content: JSON.stringify({ errorCode: 'uniswap_quote_tool_not_allowed' }), isError: true };
    if (!this.apiKey?.trim()) return { content: JSON.stringify({ errorCode: 'uniswap_quote_not_configured' }), isError: true };
    if (args.chain !== 'base' || args.quoteOnly !== true) {
      return { content: JSON.stringify({ errorCode: 'uniswap_quote_read_only_required' }), isError: true };
    }
    const tokenIn = token(args.tokenIn);
    const tokenOut = token(args.tokenOut);
    const swapper = String(args.swapper || '');
    const amountIn = String(args.amountIn || '');
    if (!tokenIn || !tokenOut || tokenIn.symbol === tokenOut.symbol || !ADDRESS_PATTERN.test(swapper)) {
      return { content: JSON.stringify({ errorCode: 'uniswap_quote_invalid_args' }), isError: true };
    }
    const amountInRaw = toBaseUnits(amountIn, tokenIn.decimals);
    if (!amountInRaw) return { content: JSON.stringify({ errorCode: 'uniswap_quote_invalid_amount' }), isError: true };
    const requestedSlippage = args.slippageTolerance === undefined ? undefined : finiteNumber(args.slippageTolerance);
    if (requestedSlippage !== undefined && (requestedSlippage === null || requestedSlippage < 0 || requestedSlippage > 20)) {
      return { content: JSON.stringify({ errorCode: 'uniswap_quote_invalid_slippage' }), isError: true };
    }

    const slippageBps =
      requestedSlippage === undefined ? null : percentageToBasisPoints(String(requestedSlippage));
    if (requestedSlippage !== undefined && slippageBps === null) {
      return { content: JSON.stringify({ errorCode: 'uniswap_quote_invalid_slippage' }), isError: true };
    }
    const client = new UniswapQuoteClient({
      fetchImpl: this.fetchImpl,
      apiKey: this.apiKey,
      endpoint: this.endpoint,
      timeoutMs: timeoutMs(),
    });
    const response = await client.quote({
      chainId: 8453,
      amountInAtomic: amountInRaw,
      tokenIn: tokenIn.address.toLowerCase() as `0x${string}`,
      tokenOut: tokenOut.address.toLowerCase() as `0x${string}`,
      swapper: swapper.toLowerCase() as `0x${string}`,
      slippageBps,
    });
    if (response.outcome !== 'response') {
      return { content: JSON.stringify({ errorCode: legacyErrorCode(response) }), isError: true };
    }
    const payload = response.payload as Record<string, any>;
    const normalized = normalizeQuoteResponse({
      payload,
      amountInRaw,
      tokenIn,
      tokenOut,
      requestedSlippage: requestedSlippage ?? undefined,
    });
    if (!normalized) {
      return { content: JSON.stringify({ errorCode: 'uniswap_quote_invalid_response' }), isError: true };
    }
    return { content: JSON.stringify(normalized), isError: false };
  }
}
