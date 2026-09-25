import { client } from '@mioagent/db';
import {
  weekendMarketV1,
  weekendWindowV1,
  type WeekendMarketResponseV1,
  type WeekendMarketStockInputV1,
} from '@mioagent/rwa-market-reality/weekend-market';

// ---------------------------------------------------------------------------
// The weekend card's read: the public ladder's runs across one quiet period,
// named by the reviewed corpus.
//
// The computation lives in `weekendMarketV1`; this only fetches. It reads the
// smallest ladder size ($100), where a quote moves the price least. It reads
// from four hours before the bell, so the close has a print to come from. And it
// reads nothing at all outside a quiet period.
// ---------------------------------------------------------------------------

export interface WeekendRunRowV1 {
  token: string;
  at: string;
  mid: number;
  reference: number;
  referenceUpdatedAt: string;
}

export interface WeekendMarketReadDepsV1 {
  runs: (since: Date, until: Date) => Promise<readonly WeekendRunRowV1[]>;
  /** The company a token stands for, or null for an address the reviewed
   * corpus does not bind. An unbound address is left out, never guessed at. */
  identify: (tokenAddress: string) => Promise<{ symbol: string; name: string } | null>;
}

export async function readWeekendMarketV1(now: Date, deps: WeekendMarketReadDepsV1): Promise<WeekendMarketResponseV1> {
  const window = weekendWindowV1(now);
  const nowMs = now.getTime();
  if (!window || nowMs < Date.parse(window.darkStartAt) || nowMs >= Date.parse(window.nextSessionCloseAt)) {
    return weekendMarketV1({ now, stocks: [] });
  }
  const since = new Date(Date.parse(window.closeAt) - 4 * 3_600_000);
  const rows = await deps.runs(since, now);
  const byToken = new Map<string, WeekendRunRowV1[]>();
  for (const row of rows) {
    const token = row.token.toLowerCase();
    byToken.set(token, [...(byToken.get(token) ?? []), row]);
  }
  const stocks: WeekendMarketStockInputV1[] = [];
  for (const [token, runs] of byToken) {
    const identity = await deps.identify(token);
    if (!identity) continue;
    stocks.push({
      tokenAddress: token,
      symbol: identity.symbol,
      name: identity.name,
      runs: runs.map(({ at, mid, reference, referenceUpdatedAt }) => ({ at, mid, reference, referenceUpdatedAt })),
    });
  }
  return weekendMarketV1({ now, stocks });
}

/**
 * One row per run: the mid of the best buy and best sell at $100, and the
 * reference that stood beside them.
 *
 * Every cast is guarded by a shape check, so one malformed snapshot drops out
 * instead of failing the whole read.
 */
export async function databaseWeekendRunsV1(since: Date, until: Date): Promise<WeekendRunRowV1[]> {
  const rows = await client`
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
        AND r.completed_at >= ${since}
        AND r.started_at <= ${until}
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
    ORDER BY t`;
  return rows.map((row) => ({
    token: String(row.token),
    at: new Date(row.t as string | Date).toISOString(),
    mid: Number(row.mid),
    reference: Number(row.ref),
    referenceUpdatedAt: String(row.ref_at),
  }));
}
