import type { RwaSignalRowV1 } from './rwaSignals.js';
import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// What the Base App notifier reads and what it remembers.
//
// It reads two sources that already exist — rwa_signals (market-wide
// transitions) and market_reality_radar_events (one person's watch) — each
// after a cursor, in the order the source is written. It remembers only that
// cursor and a per-wallet count per UTC day. Who pinned Miorail and turned
// notifications on is Base's list, asked for on every pass and never copied.
// ---------------------------------------------------------------------------

/**
 * Where a notice is delivered. Each channel keeps its own cursors, daily
 * counts and weekly record in the same three tables (migration 0074 added the
 * column; the `base_app_` in their names is where they started), so a wallet
 * told something in Base App is still told it in Telegram, and neither
 * channel's cap spends the other's.
 */
export const NOTIFICATION_CHANNELS_V1 = ['base_app', 'telegram'] as const;
export type NotificationChannelV1 = (typeof NOTIFICATION_CHANNELS_V1)[number];

export const BASE_APP_NOTIFICATION_SOURCES_V1 = ['rwa_signal', 'radar_event'] as const;
export type BaseAppNotificationSourceV1 = (typeof BASE_APP_NOTIFICATION_SOURCES_V1)[number];

/** The Radar kinds, as migration 0062 allows them. */
export const RADAR_EVENT_KINDS_V1 = [
  'sell_exit_cost_changed',
  'buy_effective_price_changed',
  'route_became_unavailable',
  'route_became_available',
  'market_session_changed',
  'reference_became_stale',
  'representation_ratio_changed',
] as const;
export type RadarEventKindV1 = (typeof RADAR_EVENT_KINDS_V1)[number];

export interface BaseAppNotificationCursorV1 {
  source: BaseAppNotificationSourceV1;
  /** `recorded_at` of the newest row handled. */
  cursorAt: string;
  /** That row's id — a bigserial for signals, a 0x hash for Radar events — or
   * '' when the source had no rows when the cursor opened. */
  cursorId: string;
  openedAt: string;
  updatedAt: string;
}

/** A Radar event, with the watch it answers: whose it is and the exact question. */
export interface RadarEventNoticeRowV1 {
  eventId: string;
  recordedAt: string;
  occurredAt: string;
  kind: RadarEventKindV1;
  tokenAddress: string;
  facts: Record<string, unknown>;
  userId: string;
  direction: 'buy' | 'sell';
  requestedCashAtomic: string;
  destination: 'USDC' | 'ETH';
}

export interface BaseAppNotificationRepositoryV1 {
  cursor(source: BaseAppNotificationSourceV1): Promise<BaseAppNotificationCursorV1 | null>;
  /**
   * Opens the source's cursor at its newest row — or at `at` with an empty id
   * when it has none — unless one is already open. `openedNow` is true only
   * for the call that created it: that pass announces nothing.
   */
  openCursor(input: {
    source: BaseAppNotificationSourceV1;
    at: Date;
  }): Promise<{ cursor: BaseAppNotificationCursorV1; openedNow: boolean }>;
  advanceCursor(input: {
    source: BaseAppNotificationSourceV1;
    cursorAt: string;
    cursorId: string;
    at: Date;
  }): Promise<void>;
  /** Signals written after the cursor, oldest first, ids compared as numbers. */
  signalsAfter(input: { cursor: BaseAppNotificationCursorV1; limit: number }): Promise<RwaSignalRowV1[]>;
  /** Radar events written after the cursor, oldest first. */
  radarEventsAfter(input: { cursor: BaseAppNotificationCursorV1; limit: number }): Promise<RadarEventNoticeRowV1[]>;
  /** Who watches any of these tokens in the watchlist. */
  watchersOf(input: {
    chainId: 8453;
    tokenAddresses: readonly string[];
  }): Promise<{ userId: string; tokenAddress: string }[]>;
  /** Pushes already counted today, per wallet; a wallet with none is absent. */
  sentOn(input: { day: string; wallets: readonly string[] }): Promise<Map<string, number>>;
  /** One more push for each of these wallets on this day. */
  recordSent(input: { day: string; wallets: readonly string[] }): Promise<void>;
  /** Deletes the counts of days before `before`; returns how many rows went. */
  pruneDaily(input: { before: string }): Promise<number>;
  /** The wallets among these that already had the summary for the week that
   * closed at `weekCloseAt`. */
  weeklySentTo(input: { weekCloseAt: string; wallets: readonly string[] }): Promise<Set<string>>;
  /** Marks these wallets as having had that week's summary. Idempotent. */
  recordWeeklySent(input: { weekCloseAt: string; wallets: readonly string[]; at: Date }): Promise<void>;
}

/** A week is named by the instant its last close happened, and a wallet by its
 * lowercase address: the same shapes the table checks. */
export function assertBaseAppWeeklyInputV1(input: { weekCloseAt: string; wallets: readonly string[] }): void {
  if (!Number.isFinite(Date.parse(input.weekCloseAt)) || !/Z$|[+-]\d{2}:\d{2}$/.test(input.weekCloseAt)) {
    throw new RouteStorageIntegrityError(`expected an ISO instant for the week's close: ${input.weekCloseAt}`);
  }
  for (const wallet of input.wallets) {
    if (!WALLET_V1.test(wallet)) {
      throw new RouteStorageIntegrityError('expected a lowercase 20-byte wallet address');
    }
  }
}

const WALLET_V1 = /^0x[0-9a-f]{40}$/;
const DAY_V1 = /^\d{4}-\d{2}-\d{2}$/;

/** The id shapes the cursor table allows, per source. */
export function assertBaseAppCursorIdV1(source: BaseAppNotificationSourceV1, cursorId: string): void {
  if (!BASE_APP_NOTIFICATION_SOURCES_V1.includes(source)) {
    throw new RouteStorageIntegrityError(`unknown notification source: ${String(source)}`);
  }
  if (cursorId === '') return;
  const ok = source === 'rwa_signal' ? /^[1-9][0-9]*$/.test(cursorId) : /^0x[0-9a-f]{64}$/.test(cursorId);
  if (!ok) throw new RouteStorageIntegrityError(`cursor id does not fit ${source}: ${cursorId}`);
}

export function assertBaseAppDailyInputV1(input: { day: string; wallets: readonly string[] }): void {
  if (!DAY_V1.test(input.day)) throw new RouteStorageIntegrityError(`expected a YYYY-MM-DD day: ${input.day}`);
  for (const wallet of input.wallets) {
    if (!WALLET_V1.test(wallet)) {
      throw new RouteStorageIntegrityError('expected a lowercase 20-byte wallet address');
    }
  }
}

/** Orders two source positions the way the SQL does: time first, then id. */
export function compareBaseAppPositionV1(
  source: BaseAppNotificationSourceV1,
  a: { at: string; id: string },
  b: { at: string; id: string },
): number {
  const time = Date.parse(a.at) - Date.parse(b.at);
  if (time !== 0) return time < 0 ? -1 : 1;
  if (source === 'rwa_signal') {
    const left = a.id === '' ? 0n : BigInt(a.id);
    const right = b.id === '' ? 0n : BigInt(b.id);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}
