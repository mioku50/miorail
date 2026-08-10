import {
  assertLaunchPoolV1,
  type B20LaunchPoolRepositoryV1,
  type B20LaunchPoolRowV1,
} from './b20LaunchPools.js';

/**
 * The in-memory twin of the Postgres launch-pool cache.
 *
 * It validates through `assertLaunchPoolV1`, the same gate the database path
 * uses, so it refuses exactly what the CHECK constraints refuse. A fake that
 * accepted a partial PoolKey or a lowercase-violating address would let a test
 * pass on a row production could never store — which is how three earlier bugs
 * reached production.
 */
export function createMemoryB20LaunchPoolRepository(): B20LaunchPoolRepositoryV1 {
  const rows = new Map<string, B20LaunchPoolRowV1>();
  return {
    async readLaunchPool(tokenAddress: string): Promise<B20LaunchPoolRowV1 | null> {
      return rows.get(tokenAddress.toLowerCase()) ?? null;
    },
    async upsertLaunchPool(row: B20LaunchPoolRowV1): Promise<B20LaunchPoolRowV1> {
      const parsed = assertLaunchPoolV1(row, 'write');
      rows.set(parsed.tokenAddress, parsed);
      return parsed;
    },
  };
}
