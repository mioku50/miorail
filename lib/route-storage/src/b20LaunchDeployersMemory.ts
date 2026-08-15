import {
  assertLaunchDeployerV1,
  type B20DeployerCountsV1,
  type B20LaunchDeployerRepositoryV1,
  type B20LaunchDeployerRowV1,
} from './b20LaunchDeployers.js';

/** One launch, as much of it as the counting reads need. */
export interface MemoryB20LaunchSeedV1 {
  launchId: string;
  transactionHash: string;
  tokenAddress: string;
  symbol: string;
  canonical: boolean;
  blockNumber: string;
  observation?: { state: string; reasonCode: string | null; exitRouteFound: boolean } | null;
}

/**
 * The in-memory twin.
 *
 * It validates through `assertLaunchDeployerV1`, the same gate the database
 * path uses, so it refuses exactly what the CHECK constraints refuse — a
 * checksummed address, an absent transaction carrying a block, a source that
 * is not a known family. A fake that accepted any of those would let a test
 * pass on a row production could never store, which is how three earlier bugs
 * in this package reached production.
 *
 * The counting reads are held to the same rules as the SQL: canonical launches
 * only, and the coverage denominator counts every canonical launch rather than
 * every seeded one.
 */
export function createMemoryB20LaunchDeployerRepository(
  launches: readonly MemoryB20LaunchSeedV1[] = [],
): B20LaunchDeployerRepositoryV1 & { seedLaunches(rows: readonly MemoryB20LaunchSeedV1[]): void } {
  const rows = new Map<string, B20LaunchDeployerRowV1>();
  let seeded = [...launches];

  return {
    seedLaunches(next) {
      seeded = [...next];
    },

    async readDeployer(launchId: string): Promise<B20LaunchDeployerRowV1 | null> {
      return rows.get(launchId) ?? null;
    },

    async upsertDeployer(row: B20LaunchDeployerRowV1): Promise<B20LaunchDeployerRowV1> {
      const parsed = assertLaunchDeployerV1(row, 'write');
      rows.set(parsed.launchId, parsed);
      return parsed;
    },

    async selectLaunchesWithoutDeployer(input: { limit: number }) {
      return seeded
        .filter((launch) => launch.canonical && !rows.has(launch.launchId))
        .sort((left, right) => (BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1 : 1))
        .slice(0, input.limit)
        .map((launch) => ({ launchId: launch.launchId, transactionHash: launch.transactionHash }));
    },

    async countsForDeployer(input: { deployerAddress: string; limit: number }): Promise<B20DeployerCountsV1> {
      const address = input.deployerAddress.toLowerCase();
      const matched = seeded.filter((launch) => {
        if (!launch.canonical) return false;
        return rows.get(launch.launchId)?.deployerAddress === address;
      });
      return {
        launchCount: matched.length,
        launches: matched.slice(0, input.limit).map((launch) => ({
          launchId: launch.launchId,
          tokenAddress: launch.tokenAddress,
          symbol: launch.symbol,
          state: launch.observation?.state ?? null,
          reasonCode: launch.observation?.reasonCode ?? null,
          exitRouteFound: launch.observation?.exitRouteFound ?? null,
        })),
      };
    },

    async deployerCoverage() {
      const canonical = seeded.filter((launch) => launch.canonical);
      return {
        launchesRead: canonical.filter((launch) => rows.has(launch.launchId)).length,
        launchesTotal: canonical.length,
      };
    },
  };
}
