import type { SqlTemplateExecutor } from './types.js';
import { rowToSignalV1 } from './rwaSignalsDatabase.js';
import {
  StockInboxIdsV1Schema,
  StockInboxWalletV1Schema,
  type StockInboxRepositoryV1,
  type StockInboxStateV1,
} from './stockInbox.js';

function state(row: Record<string, unknown>): StockInboxStateV1 {
  return {
    since: new Date(row.since_at as string).toISOString(),
    openedAt: new Date(row.opened_at as string).toISOString(),
    reviewedAt: row.reviewed_at == null ? null : new Date(row.reviewed_at as string).toISOString(),
  };
}
export function createDatabaseStockInboxRepositoryV1(
  sql: SqlTemplateExecutor,
): StockInboxRepositoryV1 {
  return {
    async open(wallet, now) {
      StockInboxWalletV1Schema.parse(wallet);
      await sql`INSERT INTO stock_inbox_state (wallet_address, since_at, opened_at)
        VALUES (${wallet}, ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
        ON CONFLICT (wallet_address) DO NOTHING`;
      const rows =
        await sql`SELECT since_at, opened_at, reviewed_at FROM stock_inbox_state WHERE wallet_address = ${wallet}`;
      return state(rows[0]!);
    },
    async page(input) {
      StockInboxWalletV1Schema.parse(input.wallet);
      const at = input.before?.at ?? null,
        id = input.before?.id ?? '0';
      const rows = await sql`SELECT s.id, s.chain_id, s.kind, s.subject_address, s.official_address,
        s.occurred_at, s.recorded_at, s.facts FROM rwa_signals s
        WHERE s.chain_id = 8453
          AND (s.subject_address = ANY(${[...input.addresses]}::text[]) OR s.official_address = ANY(${[...input.addresses]}::text[]))
          AND s.recorded_at >= ${input.since}::timestamptz AND s.recorded_at <= ${input.until}::timestamptz
          AND s.occurred_at <= ${input.until}::timestamptz
          AND (${input.view === 'history'} OR NOT EXISTS
            (SELECT 1 FROM stock_inbox_reads r WHERE r.wallet_address = ${input.wallet} AND r.signal_id = s.id))
          AND (${at}::timestamptz IS NULL OR (date_trunc('milliseconds', s.recorded_at), s.id) < (${at}::timestamptz, ${id}::bigint))
        ORDER BY date_trunc('milliseconds', s.recorded_at) DESC, s.id DESC LIMIT 51`;
      return rows.map(rowToSignalV1);
    },
    async acknowledge(wallet, ids, now) {
      StockInboxWalletV1Schema.parse(wallet);
      StockInboxIdsV1Schema.parse(ids);
      // One statement: either every receipt and its date commit, or none do.
      const rows = await sql`WITH written AS (
        INSERT INTO stock_inbox_reads (wallet_address, signal_id, read_at)
        SELECT ${wallet}, unnest(${[...new Set(ids)]}::bigint[]), ${now.toISOString()}::timestamptz
        ON CONFLICT (wallet_address, signal_id) DO NOTHING RETURNING signal_id
      ) UPDATE stock_inbox_state SET reviewed_at = GREATEST(reviewed_at, ${now.toISOString()}::timestamptz)
        WHERE wallet_address = ${wallet} RETURNING since_at, opened_at, reviewed_at`;
      if (!rows[0]) throw new Error('stock_inbox_not_opened');
      return state(rows[0]);
    },
  };
}
