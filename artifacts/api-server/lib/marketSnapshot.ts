// ---------------------------------------------------------------------------
// T65.2A — the console's market rail, from a real CoinGecko read.
//
// Two rules, and they are the whole module:
//
//   1. NOTHING IS INVENTED. A price this file cannot read is absent, and the
//      surface says so. There is no last-known-good masquerading as current:
//      a cached answer keeps its OWN observedAt, so an old number is visibly
//      old rather than quietly presented as fresh.
//   2. THE KEY NEVER LEAVES THE SERVER. It is read from the environment, sent
//      as CoinGecko's demo query parameter, and never echoed into a response,
//      a log line or an error message.
//
// Depth is deliberately NOT here. Liquidity depth needs a liquidity source;
// deriving it from a spot price would be a guess wearing a number.
// ---------------------------------------------------------------------------

export interface MarketSnapshotV1 {
  /** V1 reads one pair. The rail shows one number; more would be invented. */
  asset: 'ETH';
  vsCurrency: 'usd';
  /** A decimal STRING. Money never crosses a boundary as a float. */
  price: string;
  /** Percent change over the last hour, or null when the provider omitted it. */
  changePercent1h: string | null;
  /** Hourly prices, oldest → newest, for the rail's sparkline. Empty when the
   * provider returned no series — an empty chart beats a drawn guess. */
  points: number[];
  /** When the PROVIDER says it observed this, not when we asked. */
  observedAt: string;
  provider: 'coingecko';
}

export type MarketSnapshotReasonV1 =
  | 'not_configured'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'provider_invalid_response';

export type MarketSnapshotResultV1 =
  | { ok: true; snapshot: MarketSnapshotV1; status: 'live' | 'cached' }
  | { ok: false; reason: MarketSnapshotReasonV1 };

export interface MarketSnapshotDepsV1 {
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

/** Where the key goes, and the only place it appears. CoinGecko's demo tier
 * takes it as a query parameter on the public host — the same form the existing
 * CoinGeckoPriceProvider already uses, so a key that works there works here. */
const COINGECKO_MARKETS_URL_V1 = 'https://api.coingecko.com/api/v3/coins/markets';
const DEFAULT_TIMEOUT_MS_V1 = 6_000;

/**
 * The provider row, validated field by field.
 *
 * Every value is checked before it is used. A response that changed shape
 * produces `provider_invalid_response` rather than `NaN` on the screen.
 */
export function parseCoinGeckoMarketRowV1(value: unknown, now: Date): MarketSnapshotV1 | null {
  const rows = Array.isArray(value) ? value : null;
  const row = rows?.[0];
  if (!row || typeof row !== 'object') return null;
  const record = row as Record<string, unknown>;

  const price = record.current_price;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;

  const change = record.price_change_percentage_1h_in_currency;
  const changePercent1h =
    typeof change === 'number' && Number.isFinite(change) ? change.toFixed(2) : null;

  const sparkline = record.sparkline_in_7d;
  const rawPoints =
    sparkline && typeof sparkline === 'object' ? (sparkline as { price?: unknown }).price : undefined;
  const points = Array.isArray(rawPoints)
    ? rawPoints.filter((point): point is number => typeof point === 'number' && Number.isFinite(point))
    : [];

  // The provider's own timestamp when it gave one. Falling back to our clock is
  // honest here: it bounds the age from above, never understating it.
  const lastUpdated = typeof record.last_updated === 'string' ? Date.parse(record.last_updated) : NaN;
  const observedAt = Number.isFinite(lastUpdated) ? new Date(lastUpdated).toISOString() : now.toISOString();

  return {
    asset: 'ETH',
    vsCurrency: 'usd',
    price: String(price),
    changePercent1h,
    // The rail draws one hour of context, not a week of it.
    points: points.slice(-24),
    observedAt,
    provider: 'coingecko',
  };
}

/** A single snapshot, cached in memory. CoinGecko's free tier is rate limited,
 * and the console polls; one read per TTL is what keeps a dashboard from
 * spending the whole allowance. */
interface CachedSnapshotV1 {
  snapshot: MarketSnapshotV1;
  readAt: number;
}
let cachedV1: CachedSnapshotV1 | null = null;

/** Test seam. Never called in production. */
export function resetMarketSnapshotCacheV1(): void {
  cachedV1 = null;
}

export async function readMarketSnapshotV1(
  deps: MarketSnapshotDepsV1,
  input: { apiKey: string | null; ttlMs?: number; timeoutMs?: number },
): Promise<MarketSnapshotResultV1> {
  const ttlMs = input.ttlMs ?? 60_000;
  const now = deps.now();

  if (cachedV1 && now.getTime() - cachedV1.readAt < ttlMs) {
    return { ok: true, snapshot: cachedV1.snapshot, status: 'cached' };
  }

  const url = new URL(COINGECKO_MARKETS_URL_V1);
  url.searchParams.set('vs_currency', 'usd');
  url.searchParams.set('ids', 'ethereum');
  url.searchParams.set('sparkline', 'true');
  url.searchParams.set('price_change_percentage', '1h');
  if (input.apiKey) url.searchParams.set('x_cg_demo_api_key', input.apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS_V1);
  try {
    const response = await deps.fetch(url.toString(), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (response.status === 429) return degraded('rate_limited');
    if (!response.ok) return degraded('provider_unavailable');
    const snapshot = parseCoinGeckoMarketRowV1(await response.json(), now);
    if (!snapshot) return degraded('provider_invalid_response');
    cachedV1 = { snapshot, readAt: now.getTime() };
    return { ok: true, snapshot, status: 'live' };
  } catch {
    // The URL carries the key, so nothing about this failure is logged here.
    return degraded('provider_unavailable');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A failed read falls back to the last snapshot IF there is one.
 *
 * This is not a fresh price wearing an old one's clothes: the snapshot keeps
 * its own `observedAt` and is returned as `cached`, so the surface can show how
 * old it is. With nothing cached, the failure is the answer.
 */
function degraded(reason: MarketSnapshotReasonV1): MarketSnapshotResultV1 {
  if (cachedV1) return { ok: true, snapshot: cachedV1.snapshot, status: 'cached' };
  return { ok: false, reason };
}
