import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { describe } from 'node:test';

import { InMemoryBaseAppNotificationRepositoryV1 } from '../src/baseAppNotificationsMemory.js';
import { createDatabaseBaseAppNotificationRepositoryV1 } from '../src/baseAppNotificationsDatabase.js';
import type { RadarEventNoticeRowV1 } from '../src/baseAppNotifications.js';
import type { RwaSignalRowV1 } from '../src/rwaSignals.js';

// ---------------------------------------------------------------------------
// The notifier's store: a cursor that walks each source in the order Postgres
// does, and a per-wallet count per day.
// ---------------------------------------------------------------------------

const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const WALLET = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const OPEN = new Date('2026-09-23T18:00:00.000Z');

function signal(id: string, recordedAt: string, over: Partial<RwaSignalRowV1> = {}): RwaSignalRowV1 {
  return {
    signalId: id,
    kind: 'official_asset_cash_exit_changed',
    chainId: 8453,
    subjectAddress: NVDA,
    officialAddress: null,
    occurredAt: recordedAt,
    recordedAt,
    facts: {},
    ...over,
  };
}

function radar(eventId: string, recordedAt: string): RadarEventNoticeRowV1 {
  return {
    eventId,
    recordedAt,
    occurredAt: recordedAt,
    kind: 'sell_exit_cost_changed',
    tokenAddress: NVDA,
    facts: {},
    userId: `eip155:8453:${WALLET}`,
    direction: 'sell',
    requestedCashAtomic: '1000000000',
    destination: 'USDC',
  };
}

describe('the cursor', () => {
  test('opens at the newest row, so the first pass announces nothing old', async () => {
    const store = new InMemoryBaseAppNotificationRepositoryV1();
    store.seedSignal(signal('9', '2026-09-23T10:00:00.000Z'));
    store.seedSignal(signal('10', '2026-09-23T10:00:00.000Z'));
    const opened = await store.openCursor({ source: 'rwa_signal', at: OPEN });
    assert.equal(opened.openedNow, true);
    // 10 is newer than 9 at the same instant: ids compare as numbers.
    assert.deepEqual([opened.cursor.cursorAt, opened.cursor.cursorId], ['2026-09-23T10:00:00.000Z', '10']);
    assert.deepEqual(await store.signalsAfter({ cursor: opened.cursor, limit: 50 }), []);
    const again = await store.openCursor({ source: 'rwa_signal', at: new Date(OPEN.getTime() + 60_000) });
    assert.equal(again.openedNow, false, 'only the pass that opened it is silent');
    assert.deepEqual(again.cursor, opened.cursor);
  });

  test('an empty source opens at the clock with an empty id, and then reads what comes', async () => {
    const store = new InMemoryBaseAppNotificationRepositoryV1();
    const { cursor } = await store.openCursor({ source: 'radar_event', at: OPEN });
    assert.deepEqual([cursor.cursorAt, cursor.cursorId], [OPEN.toISOString(), '']);
    const id = `0x${'a'.repeat(64)}`;
    store.seedRadarEvent(radar(id, '2026-09-23T18:05:00.000Z'));
    assert.deepEqual((await store.radarEventsAfter({ cursor, limit: 50 })).map((row) => row.eventId), [id]);
  });

  test('walks in time order, then id order, and stops at the limit', async () => {
    const store = new InMemoryBaseAppNotificationRepositoryV1();
    const { cursor } = await store.openCursor({ source: 'rwa_signal', at: OPEN });
    store.seedSignal(signal('12', '2026-09-23T18:02:00.000Z'));
    store.seedSignal(signal('11', '2026-09-23T18:01:00.000Z'));
    store.seedSignal(signal('9', '2026-09-23T18:03:00.000Z'));
    store.seedSignal(signal('10', '2026-09-23T18:03:00.000Z'));
    assert.deepEqual((await store.signalsAfter({ cursor, limit: 3 })).map((row) => row.signalId), ['11', '12', '9']);
    await store.advanceCursor({ source: 'rwa_signal', cursorAt: '2026-09-23T18:03:00.000Z', cursorId: '9', at: OPEN });
    const moved = (await store.cursor('rwa_signal'))!;
    assert.deepEqual((await store.signalsAfter({ cursor: moved, limit: 50 })).map((row) => row.signalId), ['10']);
  });

  test('refuses an id that does not fit its source, as the CHECK does', async () => {
    const store = new InMemoryBaseAppNotificationRepositoryV1();
    await store.openCursor({ source: 'rwa_signal', at: OPEN });
    await assert.rejects(
      store.advanceCursor({ source: 'rwa_signal', cursorAt: OPEN.toISOString(), cursorId: `0x${'a'.repeat(64)}`, at: OPEN }),
      /does not fit/,
    );
    await assert.rejects(
      store.advanceCursor({ source: 'radar_event', cursorAt: OPEN.toISOString(), cursorId: '12', at: OPEN }),
      /does not fit/,
    );
  });
});

describe('who watches, and how many pushes a wallet got today', () => {
  test('watchers are found by token, whatever the case the caller used', async () => {
    const store = new InMemoryBaseAppNotificationRepositoryV1();
    store.seedWatch({ userId: 'u1', tokenAddress: NVDA });
    store.seedWatch({ userId: 'u2', tokenAddress: AAPL });
    assert.deepEqual(await store.watchersOf({ chainId: 8453, tokenAddresses: [NVDA.toUpperCase().replace('0X', '0x')] }), [
      { userId: 'u1', tokenAddress: NVDA },
    ]);
  });

  test('counts per wallet per day, and prunes old days', async () => {
    const store = new InMemoryBaseAppNotificationRepositoryV1();
    await store.recordSent({ day: '2026-09-23', wallets: [WALLET] });
    await store.recordSent({ day: '2026-09-23', wallets: [WALLET, WALLET] });
    await store.recordSent({ day: '2026-09-15', wallets: [WALLET] });
    assert.equal((await store.sentOn({ day: '2026-09-23', wallets: [WALLET] })).get(WALLET), 2, 'a wallet twice in one call is one push');
    assert.equal(await store.pruneDaily({ before: '2026-09-16' }), 1);
    assert.equal((await store.sentOn({ day: '2026-09-15', wallets: [WALLET] })).size, 0);
  });

  test('refuses a wallet that is not a lowercase address', async () => {
    const store = new InMemoryBaseAppNotificationRepositoryV1();
    await assert.rejects(store.recordSent({ day: '2026-09-23', wallets: ['0x4DE27EAD5A3C9AEB58C7F812178DDDE282670D70'] }), /wallet/);
    await assert.rejects(store.sentOn({ day: '23.09.2026', wallets: [] }), /YYYY-MM-DD/);
  });
});

test('the migration holds the same rules the store enforces', () => {
  const cwd = process.cwd();
  const dir = cwd.endsWith('lib/route-storage') ? resolve(cwd, '..', 'db', 'drizzle') : resolve(cwd, 'lib', 'db', 'drizzle');
  const sql = readFileSync(resolve(dir, '0071_base_app_notifications.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS base_app_notification_cursor/);
  assert.match(sql, /source IN \('rwa_signal', 'radar_event'\)/);
  assert.match(sql, /cursor_id = '' OR cursor_id ~ '\^\[1-9\]\[0-9\]\*\$' OR cursor_id ~ '\^0x\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS base_app_notification_daily/);
  assert.match(sql, /PRIMARY KEY \(wallet_address, day\)/);
  assert.match(sql, /wallet_address ~ '\^0x\[0-9a-f\]\{40\}\$'/);
  // Two tables and no third: who opted in is Base's list, never copied here.
  assert.equal(sql.match(/CREATE TABLE/g)?.length, 2);
});

describe('the weekly summary is recorded once per wallet per week', () => {
  const WEEK = '2026-09-25T20:00:00.000Z';
  const ME = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
  const YOU = '0x1111111111111111111111111111111111111111';

  test('a wallet marked for one week is not marked for the next, and marking twice is harmless', async () => {
    const repository = new InMemoryBaseAppNotificationRepositoryV1();
    assert.deepEqual([...(await repository.weeklySentTo({ weekCloseAt: WEEK, wallets: [ME, YOU] }))], []);
    await repository.recordWeeklySent({ weekCloseAt: WEEK, wallets: [ME], at: new Date('2026-09-26T00:45:00.000Z') });
    await repository.recordWeeklySent({ weekCloseAt: WEEK, wallets: [ME], at: new Date('2026-09-26T00:50:00.000Z') });
    assert.deepEqual([...(await repository.weeklySentTo({ weekCloseAt: WEEK, wallets: [ME, YOU] }))], [ME]);
    // The same instant written another way is the same week.
    assert.deepEqual([...(await repository.weeklySentTo({ weekCloseAt: '2026-09-25T16:00:00-04:00', wallets: [ME] }))], [ME]);
    assert.deepEqual([...(await repository.weeklySentTo({ weekCloseAt: '2026-10-02T20:00:00.000Z', wallets: [ME] }))], []);
  });

  test('the fake refuses what the table refuses', async () => {
    const repository = new InMemoryBaseAppNotificationRepositoryV1();
    await assert.rejects(() => repository.weeklySentTo({ weekCloseAt: 'friday', wallets: [ME] }), /ISO instant/);
    await assert.rejects(
      () => repository.recordWeeklySent({ weekCloseAt: WEEK, wallets: ['0xABC'], at: new Date() }),
      /lowercase 20-byte wallet/,
    );
  });

  test('the database writes one row per channel, week and wallet, and reads by the same key', () => {
    const source = readFileSync(resolve(process.cwd(), process.cwd().endsWith('route-storage') ? 'src' : 'lib/route-storage/src', 'baseAppNotificationsDatabase.ts'), 'utf8');
    assert.match(source, /ON CONFLICT \(channel, week_close_at, wallet_address\) DO NOTHING/);
    assert.match(source, /WHERE channel = \$\{channel\} AND week_close_at = \$\{input\.weekCloseAt\}::timestamptz/);
  });
});

describe('each channel keeps its own memory', () => {
  const WEEK = '2026-09-25T20:00:00.000Z';
  const ME = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';

  function recordingSql() {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('$'), values });
      return /INSERT INTO base_app_notification_cursor|FROM base_app_notification_cursor/.test(strings.join('$'))
        ? [{ source: 'rwa_signal', cursor_at: WEEK, cursor_id: '', opened_at: WEEK, updated_at: WEEK }]
        : [];
    }) as unknown as Parameters<typeof createDatabaseBaseAppNotificationRepositoryV1>[0];
    return { calls, sql };
  }

  test('every read and write of the three tables names the channel it is for', async () => {
    const { calls, sql } = recordingSql();
    const repository = createDatabaseBaseAppNotificationRepositoryV1(sql, { channel: 'telegram' });
    await repository.cursor('rwa_signal');
    await repository.openCursor({ source: 'rwa_signal', at: new Date(WEEK) });
    await repository.advanceCursor({ source: 'rwa_signal', cursorAt: WEEK, cursorId: '7', at: new Date(WEEK) });
    await repository.sentOn({ day: '2026-09-26', wallets: [ME] });
    await repository.recordSent({ day: '2026-09-26', wallets: [ME] });
    await repository.pruneDaily({ before: '2026-09-19' });
    await repository.weeklySentTo({ weekCloseAt: WEEK, wallets: [ME] });
    await repository.recordWeeklySent({ weekCloseAt: WEEK, wallets: [ME], at: new Date(WEEK) });
    const ours = calls.filter((call) => /base_app_(notification_cursor|notification_daily|weekly_summary)/.test(call.text));
    assert.ok(ours.length >= 9, String(ours.length));
    for (const call of ours) {
      assert.match(call.text, /channel/, call.text);
      assert.ok(call.values.includes('telegram'), call.text);
      assert.ok(!call.values.includes('base_app'), call.text);
    }
  });

  test('Base App stays the default, and an unknown channel is refused', () => {
    const { calls, sql } = recordingSql();
    void createDatabaseBaseAppNotificationRepositoryV1(sql).cursor('radar_event');
    assert.ok(calls[0]?.values.includes('base_app'));
    assert.throws(() => createDatabaseBaseAppNotificationRepositoryV1(sql, { channel: 'email' as never }), /unknown notification channel/);
  });
});
