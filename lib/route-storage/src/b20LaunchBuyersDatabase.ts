import {
  assertLaunchBuyersV1,
  type B20LaunchBuyersRepositoryV1,
  type B20LaunchBuyersRowV1,
} from './b20LaunchBuyers.js';
import type { SqlTemplateExecutor } from './types.js';

function rowToLaunchBuyersV1(row: Record<string, unknown>): B20LaunchBuyersRowV1 {
  const count = Number(row.buyer_count);
  const shares = count > 0
    ? { topBuyerShareBps: Number(row.top_buyer_share_bps), topThreeShareBps: Number(row.top_three_share_bps) }
    : { topBuyerShareBps: null, topThreeShareBps: null };
  return assertLaunchBuyersV1({
    tokenAddress: row.token_address,
    searchFromBlock: String(row.search_from_block),
    searchToBlock: String(row.search_to_block),
    measuredAt: new Date(row.measured_at as string).toISOString(),
    buyerCount: count,
    totalBoughtAtomic: String(row.total_bought_atomic),
    ...shares,
  }, 'read');
}

export function createDatabaseB20LaunchBuyersRepository(
  sql: SqlTemplateExecutor,
): B20LaunchBuyersRepositoryV1 {
  return {
    async readLaunchBuyers(tokenAddress: string): Promise<B20LaunchBuyersRowV1 | null> {
      const rows = await sql`
        SELECT * FROM b20_launch_buyers WHERE token_address = ${tokenAddress.toLowerCase()} LIMIT 1`;
      const row = rows[0] as Record<string, unknown> | undefined;
      return row ? rowToLaunchBuyersV1(row) : null;
    },

    async upsertLaunchBuyers(row: B20LaunchBuyersRowV1): Promise<B20LaunchBuyersRowV1> {
      const parsed = assertLaunchBuyersV1(row, 'write');
      await sql`
        INSERT INTO b20_launch_buyers (
          token_address, search_from_block, search_to_block,
          buyer_count, total_bought_atomic,
          top_buyer_share_bps, top_three_share_bps, measured_at
        ) VALUES (
          ${parsed.tokenAddress},
          ${parsed.searchFromBlock}::numeric(78,0), ${parsed.searchToBlock}::numeric(78,0),
          ${parsed.buyerCount}, ${parsed.totalBoughtAtomic}::numeric(78,0),
          ${parsed.topBuyerShareBps}, ${parsed.topThreeShareBps},
          ${parsed.measuredAt}::timestamptz
        )
        ON CONFLICT (token_address) DO UPDATE SET
          search_from_block = EXCLUDED.search_from_block,
          search_to_block = EXCLUDED.search_to_block,
          buyer_count = EXCLUDED.buyer_count,
          total_bought_atomic = EXCLUDED.total_bought_atomic,
          top_buyer_share_bps = EXCLUDED.top_buyer_share_bps,
          top_three_share_bps = EXCLUDED.top_three_share_bps,
          measured_at = EXCLUDED.measured_at`;
      const stored = await this.readLaunchBuyers(parsed.tokenAddress);
      if (!stored) throw new Error('The launch buyers row vanished immediately after being written');
      return stored;
    },
  };
}
