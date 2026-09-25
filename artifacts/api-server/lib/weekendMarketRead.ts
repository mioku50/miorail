import { client } from '@mioagent/db';
import { readPublicLadderMidsV1 } from '@mioagent/route-storage';
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

/** The shared read, over the production database. */
export function databaseWeekendRunsV1(since: Date, until: Date): Promise<WeekendRunRowV1[]> {
  return readPublicLadderMidsV1(client, { since, until });
}
