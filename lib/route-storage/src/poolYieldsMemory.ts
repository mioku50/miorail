import {
  assertPoolYieldReadingV1,
  type PoolYieldReadingRepositoryV1,
  type PoolYieldReadingV1,
} from './poolYields.js';

/**
 * The in-memory store refuses what Postgres refuses: it validates on write,
 * keys on the same (chain, pool, block) triple and keeps the first reading
 * at a block, as ON CONFLICT DO NOTHING does.
 */
export function createMemoryPoolYieldReadingRepository(): PoolYieldReadingRepositoryV1 {
  const rows = new Map<string, PoolYieldReadingV1>();
  const key = (chainId: number, pool: string, block: number) => `${chainId}:${pool}:${block}`;
  const ofPool = (chainId: number, pool: string) =>
    [...rows.values()]
      .filter((row) => row.chainId === chainId && row.poolAddress === pool.toLowerCase())
      .sort((a, b) => a.blockNumber - b.blockNumber);

  return {
    async record(input) {
      const reading = assertPoolYieldReadingV1(input, 'write');
      const id = key(reading.chainId, reading.poolAddress, reading.blockNumber);
      if (rows.has(id)) return 'duplicate';
      rows.set(id, reading);
      return 'recorded';
    },

    async readingsForTokenSince(input) {
      const since = Date.parse(input.since);
      const token = input.tokenAddress.toLowerCase();
      return [...rows.values()]
        .filter((row) => row.chainId === input.chainId && row.tokenAddress === token && Date.parse(row.readAt) >= since)
        .sort((a, b) => a.blockNumber - b.blockNumber || a.poolAddress.localeCompare(b.poolAddress))
        .slice(0, 2000);
    },

    async readingsSince(input) {
      const since = Date.parse(input.since);
      return ofPool(input.chainId, input.poolAddress)
        .filter((row) => Date.parse(row.readAt) >= since)
        .slice(0, 2000);
    },

    async latestWithSwaps(input) {
      const withSwaps = ofPool(input.chainId, input.poolAddress).filter((row) => row.swaps !== null);
      return withSwaps[withSwaps.length - 1] ?? null;
    },

    async prune(input) {
      const before = Date.parse(input.before);
      let removed = 0;
      for (const [id, row] of rows) {
        if (Date.parse(row.readAt) < before) {
          rows.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
