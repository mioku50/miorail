import {
  RADAR_EVENT_KINDS_V1,
  assertBaseAppCursorIdV1,
  assertBaseAppDailyInputV1,
  assertBaseAppWeeklyInputV1,
  type BaseAppNotificationCursorV1,
  type BaseAppNotificationRepositoryV1,
  type BaseAppNotificationSourceV1,
  NOTIFICATION_CHANNELS_V1,
  type NotificationChannelV1,
  type RadarEventKindV1,
  type RadarEventNoticeRowV1,
} from './baseAppNotifications.js';
import { rowToSignalV1 } from './rwaSignalsDatabase.js';
import type { SqlTemplateExecutor } from './types.js';

const iso = (value: unknown): string => new Date(value as string).toISOString();

function rowToCursorV1(row: Record<string, unknown>): BaseAppNotificationCursorV1 {
  return {
    source: String(row.source) as BaseAppNotificationSourceV1,
    cursorAt: iso(row.cursor_at),
    cursorId: String(row.cursor_id),
    openedAt: iso(row.opened_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowToRadarNoticeV1(row: Record<string, unknown>): RadarEventNoticeRowV1 {
  const kind = String(row.kind) as RadarEventKindV1;
  if (!RADAR_EVENT_KINDS_V1.includes(kind)) {
    // The CHECK refuses it on write; reading one means a kind this build does
    // not know, and a notification about it would be a guess.
    throw new Error(`stored radar event has an unknown kind: ${kind}`);
  }
  return {
    eventId: String(row.event_id),
    recordedAt: iso(row.recorded_at),
    occurredAt: iso(row.occurred_at),
    kind,
    tokenAddress: String(row.token_address),
    facts: (row.facts ?? {}) as Record<string, unknown>,
    userId: String(row.user_id),
    direction: String(row.direction) as 'buy' | 'sell',
    requestedCashAtomic: String(row.requested_cash_atomic),
    destination: String(row.destination) as 'USDC' | 'ETH',
  };
}

/**
 * Positions are compared at millisecond precision on both sides. The cursor
 * is a JavaScript timestamp, and a stored microsecond past it would otherwise
 * read as "after the cursor" forever — the newest row delivered on every pass.
 */
export function createDatabaseBaseAppNotificationRepositoryV1(
  sql: SqlTemplateExecutor,
  options: { channel?: NotificationChannelV1 } = {},
): BaseAppNotificationRepositoryV1 {
  const channel = options.channel ?? 'base_app';
  if (!NOTIFICATION_CHANNELS_V1.includes(channel)) throw new Error(`unknown notification channel: ${String(channel)}`);
  async function newestPosition(source: BaseAppNotificationSourceV1): Promise<{ at: string; id: string } | null> {
    const rows =
      source === 'rwa_signal'
        ? ((await sql`
            SELECT recorded_at, id::text AS id FROM rwa_signals
             WHERE chain_id = 8453
             ORDER BY date_trunc('milliseconds', recorded_at) DESC, id DESC
             LIMIT 1`) as Record<string, unknown>[])
        : ((await sql`
            SELECT recorded_at, event_id AS id FROM market_reality_radar_events
             ORDER BY date_trunc('milliseconds', recorded_at) DESC, event_id DESC
             LIMIT 1`) as Record<string, unknown>[]);
    const row = rows[0];
    return row ? { at: iso(row.recorded_at), id: String(row.id) } : null;
  }

  return {
    async cursor(source) {
      const rows = (await sql`
        SELECT source, cursor_at, cursor_id, opened_at, updated_at
          FROM base_app_notification_cursor WHERE channel = ${channel} AND source = ${source}`) as Record<string, unknown>[];
      return rows[0] ? rowToCursorV1(rows[0]) : null;
    },

    async openCursor(input) {
      assertBaseAppCursorIdV1(input.source, '');
      const newest = await newestPosition(input.source);
      const at = newest?.at ?? input.at.toISOString();
      const id = newest?.id ?? '';
      assertBaseAppCursorIdV1(input.source, id);
      const inserted = (await sql`
        INSERT INTO base_app_notification_cursor (channel, source, cursor_at, cursor_id, opened_at, updated_at)
        VALUES (${channel}, ${input.source}, ${at}::timestamptz, ${id}, ${input.at.toISOString()}::timestamptz,
                ${input.at.toISOString()}::timestamptz)
        ON CONFLICT (channel, source) DO NOTHING
        RETURNING source`) as Record<string, unknown>[];
      const rows = (await sql`
        SELECT source, cursor_at, cursor_id, opened_at, updated_at
          FROM base_app_notification_cursor WHERE channel = ${channel} AND source = ${input.source}`) as Record<string, unknown>[];
      return { cursor: rowToCursorV1(rows[0]!), openedNow: inserted.length > 0 };
    },

    async advanceCursor(input) {
      assertBaseAppCursorIdV1(input.source, input.cursorId);
      await sql`
        UPDATE base_app_notification_cursor
           SET cursor_at = ${input.cursorAt}::timestamptz,
               cursor_id = ${input.cursorId},
               updated_at = ${input.at.toISOString()}::timestamptz
         WHERE channel = ${channel} AND source = ${input.source}`;
    },

    async signalsAfter(input) {
      const limit = Math.max(1, Math.min(500, input.limit));
      // An empty id opened on an empty table: every id is greater than zero.
      const afterId = input.cursor.cursorId === '' ? '0' : input.cursor.cursorId;
      const rows = (await sql`
        SELECT id, chain_id, kind, subject_address, official_address, occurred_at, recorded_at, facts
          FROM rwa_signals
         WHERE chain_id = 8453
           AND (date_trunc('milliseconds', recorded_at), id)
               > (${input.cursor.cursorAt}::timestamptz, ${afterId}::bigint)
         ORDER BY date_trunc('milliseconds', recorded_at) ASC, id ASC
         LIMIT ${limit}`) as Record<string, unknown>[];
      return rows.map(rowToSignalV1);
    },

    async radarEventsAfter(input) {
      const limit = Math.max(1, Math.min(500, input.limit));
      // '' sorts before every 0x id, so an empty cursor id needs no special case.
      const rows = (await sql`
        SELECT e.event_id, e.recorded_at, e.occurred_at, e.kind, e.token_address, e.facts,
               w.user_id, w.direction, w.requested_cash_atomic, w.destination
          FROM market_reality_radar_events e
          JOIN market_reality_radar_watches w ON w.watch_id = e.watch_id
         WHERE (date_trunc('milliseconds', e.recorded_at), e.event_id)
               > (${input.cursor.cursorAt}::timestamptz, ${input.cursor.cursorId})
         ORDER BY date_trunc('milliseconds', e.recorded_at) ASC, e.event_id ASC
         LIMIT ${limit}`) as Record<string, unknown>[];
      return rows.map(rowToRadarNoticeV1);
    },

    async watchersOf(input) {
      const addresses = [...new Set(input.tokenAddresses.map((address) => address.toLowerCase()))];
      if (addresses.length === 0) return [];
      const rows = (await sql`
        SELECT user_id, token_address FROM b20_watchlist
         WHERE chain_id = ${input.chainId} AND token_address = ANY(${addresses})
         ORDER BY token_address, user_id`) as Record<string, unknown>[];
      return rows.map((row) => ({ userId: String(row.user_id), tokenAddress: String(row.token_address) }));
    },

    async sentOn(input) {
      assertBaseAppDailyInputV1(input);
      const counts = new Map<string, number>();
      if (input.wallets.length === 0) return counts;
      const rows = (await sql`
        SELECT wallet_address, sent FROM base_app_notification_daily
         WHERE channel = ${channel} AND day = ${input.day}::date AND wallet_address = ANY(${[...input.wallets]})`) as Record<
        string,
        unknown
      >[];
      for (const row of rows) counts.set(String(row.wallet_address), Number(row.sent));
      return counts;
    },

    async recordSent(input) {
      assertBaseAppDailyInputV1(input);
      for (const wallet of new Set(input.wallets)) {
        await sql`
          INSERT INTO base_app_notification_daily (channel, wallet_address, day, sent)
          VALUES (${channel}, ${wallet}, ${input.day}::date, 1)
          ON CONFLICT (channel, wallet_address, day)
          DO UPDATE SET sent = base_app_notification_daily.sent + 1`;
      }
    },

    async pruneDaily(input) {
      assertBaseAppDailyInputV1({ day: input.before, wallets: [] });
      const rows = (await sql`
        DELETE FROM base_app_notification_daily WHERE channel = ${channel} AND day < ${input.before}::date
        RETURNING 1`) as Record<string, unknown>[];
      return rows.length;
    },

    async weeklySentTo(input) {
      assertBaseAppWeeklyInputV1(input);
      const sent = new Set<string>();
      if (input.wallets.length === 0) return sent;
      const rows = (await sql`
        SELECT wallet_address FROM base_app_weekly_summary
         WHERE channel = ${channel} AND week_close_at = ${input.weekCloseAt}::timestamptz
           AND wallet_address = ANY(${[...input.wallets]})`) as Record<string, unknown>[];
      for (const row of rows) sent.add(String(row.wallet_address));
      return sent;
    },

    async recordWeeklySent(input) {
      assertBaseAppWeeklyInputV1(input);
      for (const wallet of new Set(input.wallets)) {
        await sql`
          INSERT INTO base_app_weekly_summary (channel, week_close_at, wallet_address, sent_at)
          VALUES (${channel}, ${input.weekCloseAt}::timestamptz, ${wallet}, ${input.at.toISOString()}::timestamptz)
          ON CONFLICT (channel, week_close_at, wallet_address) DO NOTHING`;
      }
    },
  };
}
