import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// The public ladder, read as prices.
//
// One row per run: the mid of the best buy and best sell at the smallest size
// ($100), where a quote moves the price least, and the reference that stood
// beside them. The weekend card and the weekly summary both read this, so both
// see one computation of "what a token traded at".
//
// Every cast is guarded by a shape check, so one malformed snapshot drops out
// instead of failing the whole read.
// ---------------------------------------------------------------------------

export interface PublicLadderMidRowV1 {
  token: string;
  at: string;
  mid: number;
  reference: number;
  referenceUpdatedAt: string;
}

export async function readPublicLadderMidsV1(
  sql: SqlTemplateExecutor,
  input: { since: Date; until: Date },
): Promise<PublicLadderMidRowV1[]> {
  const rows = (await sql`
    WITH snaps AS (
      SELECT r.token_address AS token,
             r.started_at AS t,
             s->>'direction' AS dir,
             (s->>'effectivePriceAtomic')::numeric / power(10::numeric, (s->>'effectivePriceDecimals')::int) AS px,
             (s->'reference'->>'valueAtomic')::numeric / power(10::numeric, (s->'reference'->>'decimals')::int) AS ref,
             s->'reference'->>'referenceUpdatedAt' AS ref_at
      FROM official_cash_exit_runs r
      CROSS JOIN LATERAL jsonb_array_elements(r.market_reality_snapshots) s
      WHERE r.chain_id = 8453
        AND r.scope = 'public_ladder'
        AND r.market_reality_snapshots IS NOT NULL
        AND r.completed_at >= ${input.since}
        AND r.started_at <= ${input.until}
        AND s->>'requestedCashAtomic' = '100000000'
        AND s->>'effectivePriceAtomic' ~ '^[0-9]+$'
        AND s->>'effectivePriceDecimals' ~ '^[0-9]{1,2}$'
        AND s->'reference'->>'valueAtomic' ~ '^[0-9]+$'
        AND s->'reference'->>'decimals' ~ '^[0-9]{1,2}$'
        AND s->'reference'->>'referenceUpdatedAt' IS NOT NULL
    )
    SELECT token,
           t,
           ((min(px) FILTER (WHERE dir = 'buy') + max(px) FILTER (WHERE dir = 'sell')) / 2)::float8 AS mid,
           max(ref)::float8 AS ref,
           max(ref_at) AS ref_at
    FROM snaps
    GROUP BY token, t
    HAVING min(px) FILTER (WHERE dir = 'buy') IS NOT NULL
       AND max(px) FILTER (WHERE dir = 'sell') IS NOT NULL
    ORDER BY t`) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    token: String(row.token).toLowerCase(),
    at: new Date(row.t as string | Date).toISOString(),
    mid: Number(row.mid),
    reference: Number(row.ref),
    referenceUpdatedAt: String(row.ref_at),
  }));
}

/**
 * Tokens with no market on Base: the newest public run since `since` asked for $100 and every answer at
 * that size was no route at all, or a router that does not know or price the token; and no pool Miorail
 * has identified holds the token.
 *
 * Neither half is enough alone. A new pool reaches the venue index late: on 2026-11-19 KyberSwap quoted
 * ANTc, minted that afternoon, while no pool of it was indexed. And a router may not know a token yet that
 * has a pool. A throttled or failed answer says nothing either way, so one of those in the run leaves the
 * token out of this list.
 */
export async function readPublicLadderNoMarketTokensV1(sql: SqlTemplateExecutor, input: { since: Date }): Promise<string[]> {
  const rows = (await sql`
    WITH latest AS (
      SELECT DISTINCT ON (r.token_address) r.token_address AS token, r.observations
      FROM official_cash_exit_runs r
      WHERE r.chain_id = 8453
        AND r.scope = 'public_ladder'
        AND r.completed_at >= ${input.since}
      ORDER BY r.token_address, r.completed_at DESC
    ),
    pooled AS (
      SELECT token0 AS token FROM market_venues WHERE chain_id = 8453 AND kind = 'paired_pool'
      UNION
      SELECT token1 FROM market_venues WHERE chain_id = 8453 AND kind = 'paired_pool'
    )
    SELECT l.token
    FROM latest l
    WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(l.observations) o WHERE o->>'requestedCashAtomic' = '100000000'
      )
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(l.observations) o
        WHERE o->>'requestedCashAtomic' = '100000000'
          AND (jsonb_typeof(o->'buyQuote') = 'object'
            OR coalesce(o->>'errorCode', '') NOT IN ('cash_size_anchor_no_route', 'provider_unsupported_token', 'provider_token_unpriced'))
      )
      AND NOT EXISTS (SELECT 1 FROM pooled p WHERE p.token = l.token)
    ORDER BY l.token`) as Array<Record<string, unknown>>;
  return rows.map((row) => String(row.token).toLowerCase());
}

export interface PublicLadderPriceRowV1 {
  token: string;
  at: string;
  mid: number;
  /** The same run's best buy and best sell at $1,000, when both were
   * priced: how much of a real trade the $100 price survives. */
  buyAt1k?: number | null;
  sellAt1k?: number | null;
}

/**
 * The public ladder as plain prices: the same mid at $100, per run, whether or
 * not a reference feed stood beside it.
 *
 * `readPublicLadderMidsV1` keeps only runs that carried a Chainlink reference,
 * because the weekend card measures against the close at the bell. Ten stocks
 * have such a feed, and 38 of the 59 Coinbase stocks have a price on Base
 * (measured 2026-10-03), so a list of prices asks for the price alone.
 */
export async function readPublicLadderPricesV1(
  sql: SqlTemplateExecutor,
  input: { since: Date; until: Date },
): Promise<PublicLadderPriceRowV1[]> {
  const rows = (await sql`
    WITH snaps AS (
      SELECT r.token_address AS token,
             r.started_at AS t,
             s->>'direction' AS dir,
             s->>'requestedCashAtomic' AS size,
             (s->>'effectivePriceAtomic')::numeric / power(10::numeric, (s->>'effectivePriceDecimals')::int) AS px
      FROM official_cash_exit_runs r
      CROSS JOIN LATERAL jsonb_array_elements(r.market_reality_snapshots) s
      WHERE r.chain_id = 8453
        AND r.scope = 'public_ladder'
        AND r.market_reality_snapshots IS NOT NULL
        AND r.completed_at >= ${input.since}
        AND r.started_at <= ${input.until}
        AND s->>'requestedCashAtomic' IN ('100000000', '1000000000')
        AND s->>'effectivePriceAtomic' ~ '^[0-9]+$'
        AND s->>'effectivePriceDecimals' ~ '^[0-9]{1,2}$'
    )
    SELECT token,
           t,
           ((min(px) FILTER (WHERE dir = 'buy' AND size = '100000000')
             + max(px) FILTER (WHERE dir = 'sell' AND size = '100000000')) / 2)::float8 AS mid,
           (min(px) FILTER (WHERE dir = 'buy' AND size = '1000000000'))::float8 AS buy_1k,
           (max(px) FILTER (WHERE dir = 'sell' AND size = '1000000000'))::float8 AS sell_1k
    FROM snaps
    GROUP BY token, t
    HAVING min(px) FILTER (WHERE dir = 'buy' AND size = '100000000') IS NOT NULL
       AND max(px) FILTER (WHERE dir = 'sell' AND size = '100000000') IS NOT NULL
    ORDER BY t`) as Array<Record<string, unknown>>;
  return pricesFromRowsV1(rows);
}

/**
 * One token's plain prices over a window, for the week chart on its card.
 *
 * The same mid at $100 as `readPublicLadderPricesV1`, with the token in the
 * query, so it is served by `official_cash_exit_latest_public_idx` (chain,
 * token, completed_at). Measured 2026-10-04 for NVDAc over a week and three
 * hours: 769 priced runs in 172 distinct hours, read in 0.12 s.
 */
export async function readPublicLadderPricesOfTokenV1(
  sql: SqlTemplateExecutor,
  input: { token: string; since: Date; until: Date },
): Promise<PublicLadderPriceRowV1[]> {
  const rows = (await sql`
    WITH snaps AS (
      SELECT r.token_address AS token,
             r.started_at AS t,
             s->>'direction' AS dir,
             (s->>'effectivePriceAtomic')::numeric / power(10::numeric, (s->>'effectivePriceDecimals')::int) AS px
      FROM official_cash_exit_runs r
      CROSS JOIN LATERAL jsonb_array_elements(r.market_reality_snapshots) s
      WHERE r.chain_id = 8453
        AND r.scope = 'public_ladder'
        AND r.token_address = ${input.token.toLowerCase()}
        AND r.market_reality_snapshots IS NOT NULL
        AND r.completed_at >= ${input.since}
        AND r.started_at <= ${input.until}
        AND s->>'requestedCashAtomic' = '100000000'
        AND s->>'effectivePriceAtomic' ~ '^[0-9]+$'
        AND s->>'effectivePriceDecimals' ~ '^[0-9]{1,2}$'
    )
    SELECT token,
           t,
           ((min(px) FILTER (WHERE dir = 'buy') + max(px) FILTER (WHERE dir = 'sell')) / 2)::float8 AS mid
    FROM snaps
    GROUP BY token, t
    HAVING min(px) FILTER (WHERE dir = 'buy') IS NOT NULL
       AND max(px) FILTER (WHERE dir = 'sell') IS NOT NULL
    ORDER BY t`) as Array<Record<string, unknown>>;
  return pricesFromRowsV1(rows);
}

function pricesFromRowsV1(rows: readonly Record<string, unknown>[]): PublicLadderPriceRowV1[] {
  const price = (value: unknown): number | null => {
    const number = value === null || value === undefined ? Number.NaN : Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  return rows
    .map((row) => ({
      token: String(row.token).toLowerCase(),
      at: new Date(row.t as string | Date).toISOString(),
      mid: Number(row.mid),
      ...('buy_1k' in row ? { buyAt1k: price(row.buy_1k), sellAt1k: price(row.sell_1k) } : {}),
    }))
    .filter((row) => Number.isFinite(row.mid) && row.mid > 0);
}
