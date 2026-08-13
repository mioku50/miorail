import { z } from 'zod';

export const BALANCER_API_V1 = 'https://api-v3.balancer.fi/';
export const BALANCER_QUOTE_TTL_MS_V1 = 20_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POOL_ID = /^0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/;
const UINT = /^(0|[1-9][0-9]*)$/;

const BalancerPathSchemaV1 = z.object({
  protocolVersion: z.union([z.literal(2), z.literal(3)]),
  pools: z.array(z.string().regex(POOL_ID)).min(1).max(8),
  isBuffer: z.array(z.boolean()).max(8),
  inputAmountRaw: z.string().regex(UINT),
  outputAmountRaw: z.string().regex(UINT),
  tokens: z.array(z.object({ address: z.string().regex(ADDRESS), decimals: z.number().int().min(0).max(36) })).min(2).max(9),
}).strict();

const BalancerResponseSchemaV1 = z.object({
  data: z.object({
    sorGetSwapPaths: z.object({
      returnAmount: z.string().min(1),
      priceImpact: z.object({
        priceImpact: z.string().nullable(),
        error: z.string().nullable().optional(),
      }).nullable(),
      paths: z.array(BalancerPathSchemaV1).min(1).max(12),
    }).strict(),
  }).strict(),
}).strict();

export type BalancerPathV1 = z.infer<typeof BalancerPathSchemaV1>;

export interface BalancerQuoteV1 {
  expectedOutputAtomic: string;
  protocolVersion: 2 | 3;
  paths: BalancerPathV1[];
  rawPriceImpact: string | null;
  priceImpactError: string | null;
  safeResponse: unknown;
}

export type BalancerQuoteResultV1 =
  | { ok: true; quote: BalancerQuoteV1 }
  | { ok: false; reason: 'timeout' | 'rate_limited' | 'unavailable' | 'invalid_response' | 'no_route' };

export interface BalancerClientV1Options {
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const SWAP_PATHS_QUERY_V1 = `query SwapPaths($chain:GqlChain!,$tokenIn:String!,$tokenOut:String!,$swapType:GqlSorSwapType!,$swapAmount:AmountHumanReadable!){sorGetSwapPaths(chain:$chain tokenIn:$tokenIn tokenOut:$tokenOut swapType:$swapType swapAmount:$swapAmount){returnAmount priceImpact{priceImpact error} paths{protocolVersion pools isBuffer inputAmountRaw outputAmountRaw tokens{address decimals}}}}`;

export class BalancerClientV1 {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BalancerClientV1Options = {}) {
    this.endpoint = options.endpoint ?? BALANCER_API_V1;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async quoteExactIn(input: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountHuman: string;
    amountAtomic: string;
  }): Promise<BalancerQuoteResultV1> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          query: SWAP_PATHS_QUERY_V1,
          variables: {
            chain: 'BASE', tokenIn: input.tokenIn, tokenOut: input.tokenOut,
            swapType: 'EXACT_IN', swapAmount: input.amountHuman,
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable' };
    }
    if (response.status === 429) return { ok: false, reason: 'rate_limited' };
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    let payload: unknown;
    try { payload = await response.json(); } catch { return { ok: false, reason: 'invalid_response' }; }
    const parsed = BalancerResponseSchemaV1.safeParse(payload);
    if (!parsed.success) return { ok: false, reason: 'invalid_response' };
    const quote = parsed.data.data.sorGetSwapPaths;
    const versions = new Set(quote.paths.map((path) => path.protocolVersion));
    if (versions.size !== 1) return { ok: false, reason: 'invalid_response' };
    const tokenIn = input.tokenIn.toLowerCase();
    const tokenOut = input.tokenOut.toLowerCase();
    let totalIn = 0n;
    let totalOut = 0n;
    for (const path of quote.paths) {
      if (path.tokens.length !== path.pools.length + 1 || path.isBuffer.length !== path.pools.length) {
        return { ok: false, reason: 'invalid_response' };
      }
      if (path.tokens[0]!.address.toLowerCase() !== tokenIn || path.tokens.at(-1)!.address.toLowerCase() !== tokenOut) {
        return { ok: false, reason: 'invalid_response' };
      }
      totalIn += BigInt(path.inputAmountRaw);
      totalOut += BigInt(path.outputAmountRaw);
    }
    if (totalIn !== BigInt(input.amountAtomic) || totalOut <= 0n) return { ok: false, reason: 'no_route' };
    return {
      ok: true,
      quote: {
        expectedOutputAtomic: totalOut.toString(),
        protocolVersion: quote.paths[0]!.protocolVersion,
        paths: quote.paths,
        rawPriceImpact: quote.priceImpact?.priceImpact ?? null,
        priceImpactError: quote.priceImpact?.error ?? null,
        safeResponse: quote,
      },
    };
  }
}

export function balancerSourceKeysV1(paths: readonly BalancerPathV1[]): string[] {
  return paths.flatMap((path) => path.pools.map((pool, index) => {
    const tokenIn = path.tokens[index]!.address.toLowerCase();
    const tokenOut = path.tokens[index + 1]!.address.toLowerCase();
    return `balancer:v${path.protocolVersion}:${pool.toLowerCase()}:${tokenIn}:${tokenOut}:${path.isBuffer[index] ? 'buffer' : 'pool'}`;
  }));
}
