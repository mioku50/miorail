import {
  assertLaunchBuyersV1,
  type B20LaunchBuyersRepositoryV1,
  type B20LaunchBuyersRowV1,
} from './b20LaunchBuyers.js';

/**
 * The in-memory twin. Validates through the same gate the database path uses,
 * so it refuses exactly what the CHECK constraints refuse — a fake that
 * accepted "zero buyers with a 100% top share" would let a test pass on a row
 * production could never store.
 */
export function createMemoryB20LaunchBuyersRepository(): B20LaunchBuyersRepositoryV1 {
  const rows = new Map<string, B20LaunchBuyersRowV1>();
  return {
    async readLaunchBuyers(tokenAddress: string): Promise<B20LaunchBuyersRowV1 | null> {
      return rows.get(tokenAddress.toLowerCase()) ?? null;
    },
    async upsertLaunchBuyers(row: B20LaunchBuyersRowV1): Promise<B20LaunchBuyersRowV1> {
      const parsed = assertLaunchBuyersV1(row, 'write');
      rows.set(parsed.tokenAddress, parsed);
      return parsed;
    },
  };
}
