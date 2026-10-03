import type { SqlTemplateExecutor } from './types.js';
import { rowToSignalV1 } from './rwaSignalsDatabase.js';
import {
  StockInboxIdsV1Schema,
  StockInboxWalletV1Schema,
  STOCK_INBOX_ISSUER_KINDS_V1,
  STOCK_INBOX_SIZED_KINDS_V1,
  stockInboxPageV1,
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
      const caps = (input.sizeCaps ?? []).filter(
        (cap) => /^0x[0-9a-f]{40}$/.test(cap.address) && /^[0-9]{1,30}$/.test(cap.maxCashAtomic),
      );
      const capAddresses = caps.map((cap) => cap.address),
        capSizes = caps.map((cap) => cap.maxCashAtomic);
      const rows = await sql`WITH eligible AS (
        SELECT s.*, r.signal_id AS read_id,
          CASE WHEN s.kind = ANY(${[...STOCK_INBOX_ISSUER_KINDS_V1]}::text[])
            AND s.facts->>'transactionHash' ~ '^0x[0-9a-fA-F]{64}$'
          THEN s.chain_id::text || ':' || s.subject_address || ':' || lower(s.facts->>'transactionHash')
          ELSE 'signal:' || s.id::text END AS group_key
        FROM rwa_signals s LEFT JOIN stock_inbox_reads r ON r.wallet_address = ${input.wallet} AND r.signal_id = s.id
        WHERE s.chain_id = 8453
          AND (s.subject_address = ANY(${[...input.addresses]}::text[]) OR s.official_address = ANY(${[...input.addresses]}::text[]))
          AND s.recorded_at >= ${input.since}::timestamptz AND s.recorded_at <= ${input.until}::timestamptz
          AND s.occurred_at <= ${input.until}::timestamptz
          AND NOT (
            s.kind = ANY(${[...STOCK_INBOX_SIZED_KINDS_V1]}::text[])
            AND s.facts->>'requestedCashAtomic' ~ '^[0-9]{1,30}$'
            AND EXISTS (
              -- text[] and a cast here: the app's driver cannot bind a numeric[]
              -- parameter ("Received an instance of Array"), so production
              -- read every overview as unavailable while a test client passed.
              SELECT 1 FROM unnest(${capAddresses}::text[], ${capSizes}::text[]) AS cap(address, max_cash)
              WHERE cap.address = s.subject_address
                AND (s.facts->>'requestedCashAtomic')::numeric > cap.max_cash::numeric
            )
          )
      ), grouped AS (
        SELECT group_key, max(date_trunc('milliseconds', recorded_at)) AS anchor_at,
          (array_agg(id ORDER BY date_trunc('milliseconds', recorded_at) DESC, id DESC))[1] AS anchor_id,
          count(*) AS member_count, bool_or(read_id IS NULL) AS unread
        FROM eligible GROUP BY group_key
      ), selected AS (
        SELECT * FROM grouped WHERE (${input.view === 'history'} OR unread)
          AND (${at}::timestamptz IS NULL OR (anchor_at, anchor_id) < (${at}::timestamptz, ${id}::bigint))
        ORDER BY anchor_at DESC, anchor_id DESC LIMIT 51
      ) SELECT g.anchor_at, g.anchor_id::text AS anchor_id, g.member_count,
        CASE WHEN g.member_count <= 50 THEN (
          SELECT jsonb_agg(jsonb_build_object('id', e.id::text, 'chain_id', e.chain_id,
            'kind', e.kind, 'subject_address', e.subject_address, 'official_address', e.official_address,
            'occurred_at', e.occurred_at, 'recorded_at', e.recorded_at, 'facts', e.facts)
            ORDER BY date_trunc('milliseconds', e.recorded_at) DESC, e.id DESC)
          FROM eligible e WHERE e.group_key = g.group_key
        ) ELSE NULL END AS members
      FROM selected g ORDER BY g.anchor_at DESC, g.anchor_id DESC`;
      return stockInboxPageV1(
        rows.map((row) => ({
          anchor: {
            at: new Date(row.anchor_at as string).toISOString(),
            id: String(row.anchor_id),
          },
          rows:
            row.members === null
              ? []
              : (row.members as Record<string, unknown>[]).map(rowToSignalV1),
        })),
      );
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
