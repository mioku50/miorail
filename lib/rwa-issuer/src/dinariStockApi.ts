import { z } from 'zod';

// ---------------------------------------------------------------------------
// Layer 9B.2: the stock identity Dinari publishes, and cannot be read here.
//
// The identity axis needs a stable key. Dinari has exactly one and says so in
// its own integration guide: "Key off `stock_id`, never the ticker symbol.
// Treat `symbol` as a display field you refresh from the API." A ticker change
// leaves the uuid alone and moves everything else, CUSIP included.
//
// That key lives behind `GET /api/v2/market_data/stocks/` on the enterprise
// API, authenticated with `X-API-Key-Id` and `X-API-Secret-Key` issued from
// the partners dashboard. Those credentials are ORGANIZATION-ONLY — there is
// no individual tier — and the endpoint answers 401 without them. So this
// adapter is written and left dormant, on purpose:
//
//   * the response contract is confirmed from the published OpenAPI document,
//     not guessed, so the day credentials exist the shape is already pinned;
//   * nothing calls it without both credentials present, and nothing infers a
//     stock identity in its absence. The absence of a mapping is `unknown`,
//     which in this codebase is the absence of a row.
//
// The one field that makes this worth having is `tokens`: a CAIP-10 array, so
// chain and address travel together and a Base representation cannot be
// silently attributed from an Arbitrum one.
//
// Read-only. No key is ever logged, hashed into evidence, or returned.
// ---------------------------------------------------------------------------

export const DINARI_STOCK_API_ENVIRONMENTS_V1 = {
  live: 'https://api-enterprise.sbt.dinari.com/api/v2',
  sandbox: 'https://api-enterprise.sandbox.dinari.com/api/v2',
} as const;
export type DinariStockApiEnvironmentV1 = keyof typeof DINARI_STOCK_API_ENVIRONMENTS_V1;

/** The stocks endpoint, relative to an environment's base URL. */
export const DINARI_STOCKS_PATH_V1 = '/market_data/stocks/' as const;

/**
 * One `Stock`, exactly as the published OpenAPI declares it.
 *
 * Six fields are required there and six are required here. The optional ones
 * are nullable rather than absent because the document types them as
 * `["string", "null"]` — a null CUSIP means Dinari holds one and we are not
 * licensed to receive it, which is different from the field not existing.
 *
 * There is no ISIN. That is a fact about the source, not an omission here.
 */
export const DinariStockV1Schema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    symbol: z.string().min(1),
    is_fractionable: z.boolean(),
    is_tradable: z.boolean(),
    /** CAIP-10, e.g. `eip155:8453:0x…`. Chain and address, together. */
    tokens: z.array(z.string()),
    composite_figi: z.string().nullable().optional(),
    cusip: z.string().nullable().optional(),
    cik: z.string().nullable().optional(),
    display_name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    logo_url: z.string().nullable().optional(),
  })
  .passthrough();

export type DinariStockV1 = z.infer<typeof DinariStockV1Schema>;

export const DinariStockPageV1Schema = z
  .object({
    data: z.array(DinariStockV1Schema),
    pagination_metadata: z.unknown().optional(),
  })
  .passthrough();

/** A CAIP-10 account id split into its parts, or null. */
export function parseCaip10V1(value: string): { chainId: number; address: string } | null {
  const match = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(value.trim());
  if (match === null) return null;
  return { chainId: Number(match[1]), address: match[2].toLowerCase() };
}

/**
 * The Base representations one `Stock` names, if any.
 *
 * Filtered by chain id from the CAIP-10 itself rather than by position or by
 * count. A stock with six chains has six entries and only one of them is ours;
 * taking `tokens[0]` would attribute an Arbitrum contract to Base.
 */
export function baseRepresentationsOfV1(stock: DinariStockV1, chainId = 8453): string[] {
  const found: string[] = [];
  for (const token of stock.tokens) {
    const parsed = parseCaip10V1(token);
    if (parsed !== null && parsed.chainId === chainId) found.push(parsed.address);
  }
  return [...new Set(found)].sort();
}

/** The namespaced underlying key this source issues. Never a bare ticker. */
export function dinariUnderlyingKeyV1(stockId: string): string {
  return `dinari:stock_id:${stockId.toLowerCase()}`;
}

export interface DinariStockApiCredentialsV1 {
  apiKeyId: string;
  apiSecretKey: string;
}

export const DINARI_SOURCE_STATES_V1 = [
  /** Both credentials present. The adapter may run. */
  'ready',
  /** Neither present. The ordinary state: keys are organization-only. */
  'credentials_absent',
  /** One of the two present. A misconfiguration, not a permission problem. */
  'credentials_incomplete',
] as const;
export type DinariSourceStateV1 = (typeof DINARI_SOURCE_STATES_V1)[number];

/**
 * Whether this source can be read at all, from an environment map.
 *
 * Deliberately a pure function over a plain record so a caller can ask without
 * touching `process.env`, and so nothing has to be logged to find out.
 */
export function dinariSourceStateV1(env: Record<string, string | undefined>): DinariSourceStateV1 {
  const keyId = (env.DINARI_API_KEY_ID ?? '').trim();
  const secret = (env.DINARI_API_SECRET_KEY ?? '').trim();
  if (keyId.length > 0 && secret.length > 0) return 'ready';
  if (keyId.length > 0 || secret.length > 0) return 'credentials_incomplete';
  return 'credentials_absent';
}

export type DinariStockFetchV1 =
  | { ok: true; stocks: DinariStockV1[] }
  | {
      ok: false;
      /** `credentials_absent` is not a failure of the source. It is the state
       * of this deployment, and it must never be rendered as Dinari being
       * unreachable — our own gap wearing the issuer's name is the bug class
       * this repository keeps re-shipping. */
      reason: 'credentials_absent' | 'credentials_incomplete' | 'unauthorized' | 'http_error' | 'unparsable' | 'transport';
      detail: string;
    };

/**
 * One page of stocks, if and only if both credentials are present.
 *
 * The credential check is inside this function rather than at the call site so
 * there is no path that reaches the network without it. On any failure the
 * detail is OUR words: no response body, no header, no URL with a key in it.
 */
export async function fetchDinariStocksV1(input: {
  credentials: DinariStockApiCredentialsV1 | null;
  environment?: DinariStockApiEnvironmentV1;
  pageSize?: number;
  page?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<DinariStockFetchV1> {
  const credentials = input.credentials;
  if (credentials === null) {
    return {
      ok: false,
      reason: 'credentials_absent',
      detail: 'Dinari partner credentials are issued to organizations only and none are configured here',
    };
  }
  if (credentials.apiKeyId.trim().length === 0 || credentials.apiSecretKey.trim().length === 0) {
    return { ok: false, reason: 'credentials_incomplete', detail: 'one of the two Dinari credentials is empty' };
  }

  const base = DINARI_STOCK_API_ENVIRONMENTS_V1[input.environment ?? 'live'];
  const pageSize = Math.max(1, Math.min(100, input.pageSize ?? 100));
  const page = Math.max(1, input.page ?? 1);
  const url = `${base}${DINARI_STOCKS_PATH_V1}?page=${page}&page_size=${pageSize}`;
  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, input.timeoutMs ?? 20_000));
  try {
    const response = await doFetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'X-API-Key-Id': credentials.apiKeyId,
        'X-API-Secret-Key': credentials.apiSecretKey,
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'unauthorized', detail: `the stocks endpoint answered ${response.status}` };
    }
    if (!response.ok) {
      return { ok: false, reason: 'http_error', detail: `the stocks endpoint answered ${response.status}` };
    }
    const parsed = DinariStockPageV1Schema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, reason: 'unparsable', detail: 'the stocks response did not match the published contract' };
    }
    return { ok: true, stocks: parsed.data.data };
  } catch (error) {
    const detail = error instanceof Error && error.name === 'AbortError' ? 'the stocks request timed out' : 'the stocks request did not complete';
    return { ok: false, reason: 'transport', detail };
  } finally {
    clearTimeout(timer);
  }
}
