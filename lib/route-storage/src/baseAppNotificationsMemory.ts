import {
  assertBaseAppCursorIdV1,
  assertBaseAppDailyInputV1,
  assertBaseAppWeeklyInputV1,
  compareBaseAppPositionV1,
  type BaseAppNotificationCursorV1,
  type BaseAppNotificationRepositoryV1,
  type BaseAppNotificationSourceV1,
  type RadarEventNoticeRowV1,
} from './baseAppNotifications.js';
import type { RwaSignalRowV1 } from './rwaSignals.js';

/**
 * The in-memory notifier store.
 *
 * Same ordering as Postgres — time, then id, and a signal id compared as a
 * NUMBER — because the cursor is only as good as the order it walks: a fake
 * that sorted "10" before "9" would pass a test that production fails.
 * Timestamps are compared at millisecond precision, as the SQL truncates them.
 */
export class InMemoryBaseAppNotificationRepositoryV1 implements BaseAppNotificationRepositoryV1 {
  private readonly cursors = new Map<BaseAppNotificationSourceV1, BaseAppNotificationCursorV1>();
  private readonly signals: RwaSignalRowV1[] = [];
  private readonly radarEvents: RadarEventNoticeRowV1[] = [];
  private readonly watches: { userId: string; tokenAddress: string }[] = [];
  private readonly daily = new Map<string, number>();
  private readonly weekly = new Set<string>();

  /** Test seams: rows the other workers would have written. */
  seedSignal(row: RwaSignalRowV1): void {
    this.signals.push(row);
  }

  seedRadarEvent(row: RadarEventNoticeRowV1): void {
    this.radarEvents.push(row);
  }

  seedWatch(row: { userId: string; tokenAddress: string }): void {
    this.watches.push({ userId: row.userId, tokenAddress: row.tokenAddress.toLowerCase() });
  }

  private newest(source: BaseAppNotificationSourceV1): { at: string; id: string } | null {
    const positions =
      source === 'rwa_signal'
        ? this.signals.filter((row) => row.chainId === 8453).map((row) => ({ at: row.recordedAt, id: row.signalId }))
        : this.radarEvents.map((row) => ({ at: row.recordedAt, id: row.eventId }));
    positions.sort((a, b) => compareBaseAppPositionV1(source, a, b));
    return positions.at(-1) ?? null;
  }

  async cursor(source: BaseAppNotificationSourceV1): Promise<BaseAppNotificationCursorV1 | null> {
    return this.cursors.get(source) ?? null;
  }

  async openCursor(input: { source: BaseAppNotificationSourceV1; at: Date }) {
    assertBaseAppCursorIdV1(input.source, '');
    const existing = this.cursors.get(input.source);
    if (existing) return { cursor: existing, openedNow: false };
    const newest = this.newest(input.source);
    const cursorId = newest?.id ?? '';
    assertBaseAppCursorIdV1(input.source, cursorId);
    const cursor: BaseAppNotificationCursorV1 = {
      source: input.source,
      cursorAt: new Date(newest?.at ?? input.at.toISOString()).toISOString(),
      cursorId,
      openedAt: input.at.toISOString(),
      updatedAt: input.at.toISOString(),
    };
    this.cursors.set(input.source, cursor);
    return { cursor, openedNow: true };
  }

  async advanceCursor(input: {
    source: BaseAppNotificationSourceV1;
    cursorAt: string;
    cursorId: string;
    at: Date;
  }): Promise<void> {
    assertBaseAppCursorIdV1(input.source, input.cursorId);
    const existing = this.cursors.get(input.source);
    // UPDATE of a row that is not there changes nothing, as in SQL.
    if (!existing) return;
    this.cursors.set(input.source, {
      ...existing,
      cursorAt: new Date(input.cursorAt).toISOString(),
      cursorId: input.cursorId,
      updatedAt: input.at.toISOString(),
    });
  }

  async signalsAfter(input: { cursor: BaseAppNotificationCursorV1; limit: number }): Promise<RwaSignalRowV1[]> {
    const limit = Math.max(1, Math.min(500, input.limit));
    const after = { at: input.cursor.cursorAt, id: input.cursor.cursorId };
    return this.signals
      .filter((row) => row.chainId === 8453)
      .filter((row) => compareBaseAppPositionV1('rwa_signal', { at: row.recordedAt, id: row.signalId }, after) > 0)
      .sort((a, b) =>
        compareBaseAppPositionV1('rwa_signal', { at: a.recordedAt, id: a.signalId }, { at: b.recordedAt, id: b.signalId }),
      )
      .slice(0, limit);
  }

  async radarEventsAfter(input: {
    cursor: BaseAppNotificationCursorV1;
    limit: number;
  }): Promise<RadarEventNoticeRowV1[]> {
    const limit = Math.max(1, Math.min(500, input.limit));
    const after = { at: input.cursor.cursorAt, id: input.cursor.cursorId };
    return this.radarEvents
      .filter((row) => compareBaseAppPositionV1('radar_event', { at: row.recordedAt, id: row.eventId }, after) > 0)
      .sort((a, b) =>
        compareBaseAppPositionV1('radar_event', { at: a.recordedAt, id: a.eventId }, { at: b.recordedAt, id: b.eventId }),
      )
      .slice(0, limit);
  }

  async watchersOf(input: { chainId: 8453; tokenAddresses: readonly string[] }) {
    const wanted = new Set(input.tokenAddresses.map((address) => address.toLowerCase()));
    return this.watches
      .filter((row) => wanted.has(row.tokenAddress))
      .sort((a, b) => (a.tokenAddress + a.userId).localeCompare(b.tokenAddress + b.userId))
      .map((row) => ({ ...row }));
  }

  async sentOn(input: { day: string; wallets: readonly string[] }): Promise<Map<string, number>> {
    assertBaseAppDailyInputV1(input);
    const counts = new Map<string, number>();
    for (const wallet of input.wallets) {
      const sent = this.daily.get(`${wallet}|${input.day}`);
      if (sent) counts.set(wallet, sent);
    }
    return counts;
  }

  async recordSent(input: { day: string; wallets: readonly string[] }): Promise<void> {
    assertBaseAppDailyInputV1(input);
    for (const wallet of new Set(input.wallets)) {
      const key = `${wallet}|${input.day}`;
      this.daily.set(key, (this.daily.get(key) ?? 0) + 1);
    }
  }

  async weeklySentTo(input: { weekCloseAt: string; wallets: readonly string[] }): Promise<Set<string>> {
    assertBaseAppWeeklyInputV1(input);
    const week = new Date(input.weekCloseAt).toISOString();
    return new Set(input.wallets.filter((wallet) => this.weekly.has(`${week}|${wallet}`)));
  }

  async recordWeeklySent(input: { weekCloseAt: string; wallets: readonly string[]; at: Date }): Promise<void> {
    assertBaseAppWeeklyInputV1(input);
    const week = new Date(input.weekCloseAt).toISOString();
    for (const wallet of input.wallets) this.weekly.add(`${week}|${wallet}`);
  }

  async pruneDaily(input: { before: string }): Promise<number> {
    assertBaseAppDailyInputV1({ day: input.before, wallets: [] });
    let removed = 0;
    for (const key of [...this.daily.keys()]) {
      if (key.split('|')[1]! < input.before) {
        this.daily.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
