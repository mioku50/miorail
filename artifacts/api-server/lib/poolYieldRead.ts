import { client } from '@mioagent/db';
import { createDatabasePoolYieldReadingRepository, type PoolYieldReadingV1 } from '@mioagent/route-storage';
import { poolYieldV1, type PoolYieldResponseV1 } from '@mioagent/rwa-market-reality/pool-yield';

// ---------------------------------------------------------------------------
// What a stock's deepest Aerodrome pool pays: the pools worker's readings of
// the last eight days, the pool of the newest one, computed by `poolYieldV1`.
// A week of fees needs the readings that cover it, and a day more lets the
// oldest swaps in the window be found whole.
// ---------------------------------------------------------------------------

const LOOK_BACK_DAYS_V1 = 8;

export async function readPoolYieldV1(
  now: Date,
  tokenAddress: string,
  deps: {
    readings: (token: string, since: string) => Promise<readonly PoolYieldReadingV1[]>;
    /** The stock's market price on Base, or null where its market is thin,
     * unmeasured or unpriced; without one the pool gets no rate. */
    marketPrice?: (token: string) => Promise<number | null>;
  },
): Promise<PoolYieldResponseV1> {
  const token = tokenAddress.toLowerCase();
  const since = new Date(now.getTime() - LOOK_BACK_DAYS_V1 * 86_400_000).toISOString();
  const rows = await deps.readings(token, since);
  const newest = rows.reduce<PoolYieldReadingV1 | null>(
    (best, row) => (best === null || row.blockNumber > best.blockNumber ? row : best),
    null,
  );
  const ofPool = newest ? rows.filter((row) => row.poolAddress === newest.poolAddress) : [];
  return {
    schemaVersion: 'pool-yield-response/v1',
    tokenAddress: token,
    yield:
      ofPool.length > 0
        ? poolYieldV1({ readings: ofPool, now, marketPriceUsd: deps.marketPrice ? await deps.marketPrice(token).catch(() => null) : null })
        : null,
  };
}

/** The stored readings, over the production database. */
export function databasePoolYieldReadingsV1(token: string, since: string): Promise<PoolYieldReadingV1[]> {
  return createDatabasePoolYieldReadingRepository(client).readingsForTokenSince({
    chainId: 8453,
    tokenAddress: token,
    since,
  });
}
