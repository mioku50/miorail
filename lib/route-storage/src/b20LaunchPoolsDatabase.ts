import {
  assertLaunchPoolV1,
  type B20LaunchPoolRepositoryV1,
  type B20LaunchPoolRowV1,
} from './b20LaunchPools.js';
import type { SqlTemplateExecutor } from './types.js';

function rowToLaunchPoolV1(row: Record<string, unknown>): B20LaunchPoolRowV1 {
  const resolved = row.outcome === 'resolved';
  return assertLaunchPoolV1({
    tokenAddress: row.token_address,
    searchFromBlock: String(row.search_from_block),
    searchToBlock: String(row.search_to_block),
    resolvedAt: new Date(row.resolved_at as string).toISOString(),
    outcome: resolved ? 'resolved' : 'absent',
    poolId: row.pool_id ?? null,
    currency0: row.currency0 ?? null,
    currency1: row.currency1 ?? null,
    // Numbers, not strings: a fee read back as text would be encoded into a
    // PoolKey as the wrong type and hash to a pool that does not exist.
    fee: resolved ? Number(row.fee) : null,
    tickSpacing: resolved ? Number(row.tick_spacing) : null,
    hooks: row.hooks ?? null,
    quoteAsset: row.quote_asset ?? null,
    tokenIsCurrency0: resolved ? Boolean(row.token_is_currency0) : null,
    poolBlockNumber: resolved ? String(row.pool_block_number) : null,
  }, 'read');
}

export function createDatabaseB20LaunchPoolRepository(
  sql: SqlTemplateExecutor,
): B20LaunchPoolRepositoryV1 {
  return {
    async readLaunchPool(tokenAddress: string): Promise<B20LaunchPoolRowV1 | null> {
      const rows = await sql`
        SELECT * FROM b20_launch_pools WHERE token_address = ${tokenAddress.toLowerCase()} LIMIT 1`;
      const row = rows[0] as Record<string, unknown> | undefined;
      return row ? rowToLaunchPoolV1(row) : null;
    },

    async upsertLaunchPool(row: B20LaunchPoolRowV1): Promise<B20LaunchPoolRowV1> {
      const parsed = assertLaunchPoolV1(row, 'write');
      await sql`
        INSERT INTO b20_launch_pools (
          token_address, search_from_block, search_to_block, outcome,
          pool_id, currency0, currency1, fee, tick_spacing, hooks,
          quote_asset, token_is_currency0, pool_block_number, resolved_at
        ) VALUES (
          ${parsed.tokenAddress},
          ${parsed.searchFromBlock}::numeric(78,0), ${parsed.searchToBlock}::numeric(78,0),
          ${parsed.outcome},
          ${parsed.poolId}, ${parsed.currency0}, ${parsed.currency1},
          ${parsed.fee}, ${parsed.tickSpacing}, ${parsed.hooks},
          ${parsed.quoteAsset}, ${parsed.tokenIsCurrency0},
          ${parsed.poolBlockNumber}::numeric(78,0),
          ${parsed.resolvedAt}::timestamptz
        )
        ON CONFLICT (token_address) DO UPDATE SET
          search_from_block = EXCLUDED.search_from_block,
          search_to_block = EXCLUDED.search_to_block,
          outcome = EXCLUDED.outcome,
          pool_id = EXCLUDED.pool_id,
          currency0 = EXCLUDED.currency0,
          currency1 = EXCLUDED.currency1,
          fee = EXCLUDED.fee,
          tick_spacing = EXCLUDED.tick_spacing,
          hooks = EXCLUDED.hooks,
          quote_asset = EXCLUDED.quote_asset,
          token_is_currency0 = EXCLUDED.token_is_currency0,
          pool_block_number = EXCLUDED.pool_block_number,
          resolved_at = EXCLUDED.resolved_at`;
      const stored = await this.readLaunchPool(parsed.tokenAddress);
      if (!stored) throw new Error('The launch pool vanished immediately after being written');
      return stored;
    },
  };
}
