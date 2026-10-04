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

export interface PublicLadderPriceRowV1 {
  token: string;
  at: string;
  mid: number;
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
             (s->>'effectivePriceAtomic')::numeric / power(10::numeric, (s->>'effectivePriceDecimals')::int) AS px
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
  return rows
    .map((row) => ({
      token: String(row.token).toLowerCase(),
      at: new Date(row.t as string | Date).toISOString(),
      mid: Number(row.mid),
    }))
    .filter((row) => Number.isFinite(row.mid) && row.mid > 0);
}
