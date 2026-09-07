import {
  assertMarketPoolReadingV1,
  type MarketPoolReadingRepositoryV1,
  type MarketPoolReadingV1,
} from './poolReadings.js';

/**
 * The in-memory repository refuses exactly what Postgres refuses.
 *
 * A fake that accepts a row the database would reject turns a schema violation
 * into a production-only failure, which is how a unit-green change reaches a
 * 500. So this validates on write, keys on the same unique triple, and applies
 * the same never-move-backwards rule as the ON CONFLICT clause.
 */
/** True when `next` would drop something `stored` already knows. */
function losesAFactV1(stored: MarketPoolReadingV1, next: MarketPoolReadingV1): boolean {
  if (stored.pairedBalanceAtomic !== null && next.pairedBalanceAtomic === null) return true;
  if (stored.factoryAddress !== null && next.factoryAddress === null) return true;
  if (stored.venueId !== null && next.venueId === null) return true;
  return false;
}

export function createMemoryMarketPoolReadingRepository(): MarketPoolReadingRepositoryV1 {
  const rows = new Map<string, MarketPoolReadingV1>();
  const key = (reading: Pick<MarketPoolReadingV1, 'chainId' | 'poolAddress' | 'tokenAddress'>) =>
    `${reading.chainId}:${reading.poolAddress}:${reading.tokenAddress}`;

  return {
    async recordReadings(input) {
      // Validate all, then write all — the database validates the batch before
      // its first insert too, so a bad row leaves the store untouched here as
      // well rather than half-applied.
      const readings = input.readings.map((reading) => assertMarketPoolReadingV1(reading, 'write'));
      let written = 0;
      for (const reading of readings) {
        const existing = rows.get(key(reading));
        if (existing && existing.blockNumber > reading.blockNumber) continue;
        // Never LOSES a fact, matching the ON CONFLICT clause: a throttled pass
        // that dropped the pair, the factory or the venue must not replace a
        // reading that has it just because its block is newer.
        if (existing && losesAFactV1(existing, reading)) continue;
        rows.set(key(reading), reading);
        written += 1;
      }
      return { written };
    },

    async readingsForToken(input) {
      const token = input.tokenAddress.toLowerCase();
      return [...rows.values()]
        .filter((row) => row.chainId === input.chainId && row.tokenAddress === token)
        .sort((a, b) => {
          const left = BigInt(a.tokenBalanceAtomic);
          const right = BigInt(b.tokenBalanceAtomic);
          if (left !== right) return right > left ? 1 : -1;
          return a.poolAddress.localeCompare(b.poolAddress);
        })
        .slice(0, Math.max(1, Math.min(500, input.limit)));
    },
  };
}
