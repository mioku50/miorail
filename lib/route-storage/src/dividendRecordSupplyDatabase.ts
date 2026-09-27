import {
  assertDividendRecordSupplyV1,
  type DividendRecordSupplyRepositoryV1,
  type DividendRecordSupplyV1,
} from './dividendRecordSupply.js';
import type { SqlTemplateExecutor } from './types.js';

function isoV1(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function dateV1(value: unknown): string {
  // A `date` column comes back as a Date at local midnight or as a string,
  // depending on the driver's parsers. Either way it is a calendar date.
  if (value instanceof Date) {
    const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

export function createDatabaseDividendRecordSupplyRepositoryV1(sql: SqlTemplateExecutor): DividendRecordSupplyRepositoryV1 {
  return {
    async record(input) {
      assertDividendRecordSupplyV1(input);
      const rows = (await sql`
        INSERT INTO dividend_record_supply (
          chain_id, token_address, record_date, record_close_at, block_number, block_time,
          total_supply_atomic, decimals, read_at
        ) VALUES (
          ${input.chainId}, ${input.tokenAddress}, ${input.recordDate}::date, ${input.recordCloseAt},
          ${input.blockNumber}, ${input.blockTime}, ${input.totalSupplyAtomic}, ${input.decimals}, ${input.readAt}
        )
        ON CONFLICT (chain_id, token_address, record_date) DO NOTHING
        RETURNING token_address`) as unknown[];
      return rows.length > 0 ? 'recorded' : 'already_recorded';
    },

    async supplies(input) {
      if (input.tokenAddresses.length === 0) return [];
      const rows = (await sql`
        SELECT token_address, record_date::text AS record_date, record_close_at, block_number, block_time,
               total_supply_atomic, decimals, read_at
        FROM dividend_record_supply
        WHERE chain_id = ${input.chainId} AND token_address = ANY(${[...input.tokenAddresses]}::text[])
        ORDER BY token_address, record_date`) as Array<Record<string, unknown>>;
      return rows.map(
        (row): DividendRecordSupplyV1 => ({
          chainId: 8453,
          tokenAddress: String(row.token_address),
          recordDate: dateV1(row.record_date),
          recordCloseAt: isoV1(row.record_close_at),
          blockNumber: Number(row.block_number),
          blockTime: isoV1(row.block_time),
          totalSupplyAtomic: String(row.total_supply_atomic),
          decimals: Number(row.decimals),
          readAt: isoV1(row.read_at),
        }),
      );
    },
  };
}
