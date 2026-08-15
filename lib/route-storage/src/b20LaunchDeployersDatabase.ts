import {
  assertLaunchDeployerV1,
  type B20DeployerCountsV1,
  type B20LaunchDeployerRepositoryV1,
  type B20LaunchDeployerRowV1,
} from './b20LaunchDeployers.js';
import type { SqlTemplateExecutor } from './types.js';

function rowToDeployerV1(row: Record<string, unknown>): B20LaunchDeployerRowV1 {
  return assertLaunchDeployerV1(
    {
      launchId: row.launch_id,
      chainId: Number(row.chain_id),
      deployerAddress: row.deployer_address ?? null,
      transactionTo: row.transaction_to ?? null,
      transactionBlockNumber:
        row.transaction_block_number === null || row.transaction_block_number === undefined
          ? null
          : String(row.transaction_block_number),
      readAt: new Date(row.read_at as string).toISOString(),
      source: row.source,
    },
    'read',
  );
}

export function createDatabaseB20LaunchDeployerRepository(
  sql: SqlTemplateExecutor,
): B20LaunchDeployerRepositoryV1 {
  return {
    async readDeployer(launchId: string): Promise<B20LaunchDeployerRowV1 | null> {
      const rows = await sql`
        SELECT * FROM b20_launch_deployers WHERE launch_id = ${launchId} LIMIT 1`;
      const row = rows[0] as Record<string, unknown> | undefined;
      return row ? rowToDeployerV1(row) : null;
    },

    async upsertDeployer(row: B20LaunchDeployerRowV1): Promise<B20LaunchDeployerRowV1> {
      const parsed = assertLaunchDeployerV1(row, 'write');
      const written = await sql`
        INSERT INTO b20_launch_deployers (
          launch_id, chain_id, deployer_address, transaction_to,
          transaction_block_number, read_at, source
        ) VALUES (
          ${parsed.launchId}, ${parsed.chainId}, ${parsed.deployerAddress}, ${parsed.transactionTo},
          ${parsed.transactionBlockNumber}, ${parsed.readAt}, ${parsed.source}
        )
        ON CONFLICT (launch_id) DO UPDATE SET
          deployer_address = EXCLUDED.deployer_address,
          transaction_to = EXCLUDED.transaction_to,
          transaction_block_number = EXCLUDED.transaction_block_number,
          read_at = EXCLUDED.read_at,
          source = EXCLUDED.source
        RETURNING *`;
      return rowToDeployerV1(written[0] as Record<string, unknown>);
    },

    async selectLaunchesWithoutDeployer(input: { limit: number }) {
      // Canonical only. A launch the chain took back is not something to spend
      // a metered read on, and its sender would be a fact about a rolled-back
      // transaction.
      const rows = await sql`
        SELECT l.id AS launch_id, l.transaction_hash
        FROM b20_launches l
        LEFT JOIN b20_launch_deployers d ON d.launch_id = l.id
        WHERE l.canonical = true AND d.launch_id IS NULL
        ORDER BY l.block_number ASC, l.log_index ASC
        LIMIT ${input.limit}`;
      return (rows as Record<string, unknown>[]).map((row) => ({
        launchId: String(row.launch_id),
        transactionHash: String(row.transaction_hash),
      }));
    },

    async countsForDeployer(input: { deployerAddress: string; limit: number }): Promise<B20DeployerCountsV1> {
      const address = input.deployerAddress.toLowerCase();
      const counted = await sql`
        SELECT COUNT(*)::int AS launch_count
        FROM b20_launch_deployers d
        JOIN b20_launches l ON l.id = d.launch_id
        WHERE d.deployer_address = ${address} AND l.canonical = true`;
      // The LATEST observation per launch, the same "one launch, one current
      // conclusion" the feed reads. DISTINCT ON rather than a window function
      // so the ordering that picks the row is visible in one place.
      const rows = await sql`
        SELECT DISTINCT ON (l.id)
          l.id AS launch_id, l.token_address, l.symbol,
          o.state, o.reason_code, o.exit_route_found
        FROM b20_launch_deployers d
        JOIN b20_launches l ON l.id = d.launch_id
        LEFT JOIN b20_opportunity_observations o ON o.launch_id = l.id
        WHERE d.deployer_address = ${address} AND l.canonical = true
        ORDER BY l.id, o.measured_at DESC NULLS LAST
        LIMIT ${input.limit}`;
      return {
        launchCount: Number((counted[0] as Record<string, unknown>)?.launch_count ?? 0),
        launches: (rows as Record<string, unknown>[]).map((row) => ({
          launchId: String(row.launch_id),
          tokenAddress: String(row.token_address),
          symbol: String(row.symbol),
          state: row.state === null || row.state === undefined ? null : String(row.state),
          reasonCode: row.reason_code === null || row.reason_code === undefined ? null : String(row.reason_code),
          exitRouteFound:
            row.exit_route_found === null || row.exit_route_found === undefined
              ? null
              : Boolean(row.exit_route_found),
        })),
      };
    },

    async deployerCoverage(): Promise<{ launchesRead: number; launchesTotal: number }> {
      const rows = await sql`
        SELECT
          COUNT(*) FILTER (WHERE d.launch_id IS NOT NULL)::int AS launches_read,
          COUNT(*)::int AS launches_total
        FROM b20_launches l
        LEFT JOIN b20_launch_deployers d ON d.launch_id = l.id
        WHERE l.canonical = true`;
      const row = rows[0] as Record<string, unknown> | undefined;
      return {
        launchesRead: Number(row?.launches_read ?? 0),
        launchesTotal: Number(row?.launches_total ?? 0),
      };
    },
  };
}
