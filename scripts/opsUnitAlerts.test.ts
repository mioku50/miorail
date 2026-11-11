import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  OPS_ALERT_CHAT_CACHE_MAX_AGE_MS_V1,
  OPS_ALERT_QUIET_MS_V1,
  OPS_ALERT_REMIND_AFTER_MS_V1,
  deliveredOpsAlertsV1,
  opsAlertChatCacheStaleV1,
  opsAlertHtmlV1,
  opsDeadlineHtmlV1,
  opsDeadlinesV1,
  parseOpsDeadlineStateV1,
  planOpsDeadlinesV1,
  planOpsDiskV1,
  opsDiskHtmlV1,
  opsDiskReadingV1,
  parseOpsAlertStateV1,
  parseSystemctlShowV1,
  opsFailureReasonV1,
  planOpsAlertsV1,
  unheardOpsAlertsV1,
  type OpsAlertStateV1,
  type OpsUnitStateV1,
} from './opsUnitAlerts.js';

const T0 = Date.UTC(2026, 9, 7, 19, 54);
const MIN = 60_000;
const unit = (name: string, overrides: Partial<OpsUnitStateV1> = {}): OpsUnitStateV1 => ({
  unit: name, loaded: true, activeState: 'inactive', result: 'success', exitStatus: 0,
  changedAtMs: T0 - 60 * MIN, lastExitAtMs: T0 - 60 * MIN, ...overrides,
});
const failed = (name: string, at = T0, overrides: Partial<OpsUnitStateV1> = {}) =>
  unit(name, { activeState: 'failed', result: 'exit-code', exitStatus: 1, changedAtMs: at, lastExitAtMs: at, ...overrides });
const EMPTY: OpsAlertStateV1 = { episodes: [] };

test('a failure is announced once, then reminded once a day while it stays failed', () => {
  const first = planOpsAlertsV1({ units: [failed('miorail-rwa-official.service'), unit('miorail-api.service', { activeState: 'active' })], state: EMPTY, nowMs: T0 + MIN });
  assert.equal(first.failed.length, 1);
  const html = opsAlertHtmlV1(first, T0 + MIN)!;
  assert.match(html, /<b>Miorail: a service failed<\/b>/);
  assert.match(html, /<code>miorail-rwa-official\.service<\/code> — exit code 1, Oct 7 19:54 UTC/);
  assert.match(html, /journalctl -u miorail-rwa-official\.service -n 80/);
  let state = deliveredOpsAlertsV1(first, T0 + MIN);

  // The hourly pass fails again: nothing new to say.
  const again = planOpsAlertsV1({ units: [failed('miorail-rwa-official.service', T0 + 60 * MIN)], state, nowMs: T0 + 61 * MIN });
  assert.equal(opsAlertHtmlV1(again, T0 + 61 * MIN), null);
  state = deliveredOpsAlertsV1(again, T0 + 61 * MIN);

  const nextDay = T0 + MIN + OPS_ALERT_REMIND_AFTER_MS_V1;
  const reminder = planOpsAlertsV1({ units: [failed('miorail-rwa-official.service', nextDay - MIN)], state, nowMs: nextDay });
  assert.equal(reminder.stillFailing.length, 1);
  assert.match(opsAlertHtmlV1(reminder, nextDay)!, /<b>Still failing<\/b>\n<code>miorail-rwa-official\.service<\/code> — exit code 1, since Oct 7 19:54 UTC \(24 h\)/);
});

test('a recovery waits until the unit has settled and stayed out of failed, then closes the episode', () => {
  const opened = deliveredOpsAlertsV1(planOpsAlertsV1({ units: [failed('miorail-rwa-ratio.service')], state: EMPTY, nowMs: T0 }), T0);
  // Running again: neither failed nor recovered.
  const running = planOpsAlertsV1({ units: [unit('miorail-rwa-ratio.service', { activeState: 'activating' })], state: opened, nowMs: T0 + 30 * MIN });
  assert.equal(opsAlertHtmlV1(running, T0 + 30 * MIN), null);
  // Finished cleanly, but too soon after the failure to call it healed.
  const ran = unit('miorail-rwa-ratio.service', { lastExitAtMs: T0 + 5 * MIN });
  assert.equal(opsAlertHtmlV1(planOpsAlertsV1({ units: [ran], state: opened, nowMs: T0 + 5 * MIN }), T0 + 5 * MIN), null);
  const later = T0 + OPS_ALERT_QUIET_MS_V1 + MIN;
  const healed = planOpsAlertsV1({ units: [ran], state: opened, nowMs: later });
  assert.deepEqual(healed.recovered.map((row) => row.how), ['healthy']);
  assert.match(opsAlertHtmlV1(healed, later)!, /<b>Back to normal<\/b>\n<code>miorail-rwa-ratio\.service<\/code> runs cleanly again \(failed Oct 7 19:54 UTC, 11 min ago\)/);
  assert.deepEqual(deliveredOpsAlertsV1(healed, later), { episodes: [] });
});

test('a failed mark reset by hand, or a unit that is gone, is said as exactly that', () => {
  const opened = deliveredOpsAlertsV1(planOpsAlertsV1({
    units: [failed('miorail-new-stocks-ladder-20261002.service'), failed('miorail-rwa-pools.service')], state: EMPTY, nowMs: T0,
  }), T0);
  const later = T0 + OPS_ALERT_QUIET_MS_V1 + MIN;
  const pass = planOpsAlertsV1({
    units: [
      unit('miorail-new-stocks-ladder-20261002.service', { loaded: false, activeState: 'inactive' }),
      // reset-failed: nothing ran, the last exit is still the failed one.
      unit('miorail-rwa-pools.service', { lastExitAtMs: T0 }),
    ],
    state: opened, nowMs: later,
  });
  assert.deepEqual(pass.recovered.map((row) => [row.episode.unit, row.how]), [
    ['miorail-new-stocks-ladder-20261002.service', 'removed'], ['miorail-rwa-pools.service', 'cleared'],
  ]);
  const html = opsAlertHtmlV1(pass, later)!;
  assert.match(html, /no longer exists/);
  assert.match(html, /is no longer marked failed; nothing has run since/);
});

test('units that fail together are one message', () => {
  const pass = planOpsAlertsV1({
    units: [failed('miorail-rwa-official.service'), failed('miorail-rwa-pools.service', T0, { result: 'timeout', exitStatus: null }),
      failed('miorail-api.service', T0, { result: 'start-limit-hit', exitStatus: null })],
    state: EMPTY, nowMs: T0,
  });
  const html = opsAlertHtmlV1(pass, T0)!;
  assert.match(html, /^<b>Miorail: 3 services failed<\/b>/);
  assert.match(html, /miorail-rwa-pools\.service<\/code> — timed out/);
  assert.match(html, /miorail-api\.service<\/code> — restarted too often and gave up/);
});

test('a message that reached nobody is tried again; with no chat, a recovery is closed and a failure kept', () => {
  const pass = planOpsAlertsV1({ units: [failed('miorail-rwa-official.service')], state: EMPTY, nowMs: T0 });
  const retry = planOpsAlertsV1({ units: [failed('miorail-rwa-official.service')], state: pass.state, nowMs: T0 + 2 * MIN });
  assert.equal(retry.failed.length, 1, 'still unannounced');

  const opened = deliveredOpsAlertsV1(planOpsAlertsV1({ units: [failed('miorail-rwa-ratio.service')], state: EMPTY, nowMs: T0 }), T0);
  const mixed = planOpsAlertsV1({
    units: [failed('miorail-rwa-official.service'), unit('miorail-rwa-ratio.service', { lastExitAtMs: T0 + 20 * MIN })],
    state: opened, nowMs: T0 + 30 * MIN,
  });
  assert.deepEqual(unheardOpsAlertsV1(mixed).episodes.map((episode) => [episode.unit, episode.notifiedMs]), [
    ['miorail-rwa-official.service', null],
  ]);
});

test('systemctl show is read block by block; a state file that is not one starts over', () => {
  const units = parseSystemctlShowV1([
    'Id=miorail-rwa-official.service', 'LoadState=loaded', 'ActiveState=failed', 'Result=exit-code', 'ExecMainStatus=1',
    'ExecMainExitTimestamp=@1791402840', 'StateChangeTimestamp=@1791402841', '',
    'Id=miorail-gone.service', 'LoadState=not-found', 'ActiveState=inactive', 'Result=success', 'ExecMainStatus=0',
    'ExecMainExitTimestamp=', 'StateChangeTimestamp=', '',
  ].join('\n'));
  assert.deepEqual(units, [
    { unit: 'miorail-rwa-official.service', loaded: true, activeState: 'failed', result: 'exit-code', exitStatus: 1,
      changedAtMs: 1791402841000, lastExitAtMs: 1791402840000 },
    { unit: 'miorail-gone.service', loaded: false, activeState: 'inactive', result: 'success', exitStatus: 0,
      changedAtMs: null, lastExitAtMs: null },
  ]);
  assert.deepEqual(parseOpsAlertStateV1(null), { episodes: [] });
  assert.deepEqual(parseOpsAlertStateV1('{not json'), { episodes: [] });
  const episode = { unit: 'miorail-api.service', sinceMs: T0, lastSeenFailedMs: T0, result: 'exit-code', exitStatus: 1, notifiedMs: null };
  assert.deepEqual(parseOpsAlertStateV1(JSON.stringify({ episodes: [episode, { unit: '../etc', sinceMs: 1 }] })), { episodes: [episode] });
});

test('the copy of the chats is renewed when missing or six hours old, the age the unit starts Node at', () => {
  assert.equal(opsAlertChatCacheStaleV1(null, T0), true);
  assert.equal(opsAlertChatCacheStaleV1(T0 - 359 * MIN, T0), false);
  assert.equal(opsAlertChatCacheStaleV1(T0 - 360 * MIN, T0), true);
  // The unit decides in a shell whether Node starts at all: the same age, or
  // a stale copy would never be renewed (or Node would start every pass).
  const unitFile = readFileSync(new URL('../ops/systemd/miorail-ops-alerts.service', import.meta.url), 'utf8');
  const condition = unitFile.split('\n').find((line) => line.startsWith('ExecCondition=')) ?? '';
  assert.ok(
    condition.includes(`! find /var/lib/miorail-ops-alerts/chats.json -mmin -${OPS_ALERT_CHAT_CACHE_MAX_AGE_MS_V1 / MIN} `),
    condition,
  );
});

// Audit OPS-3 (2026-11-10): a pass its provider throttled out of most of its work exits 75, and the alert says what that is.
test('a pass that was rate limited out of its work is reported in words, not as a bare exit code', () => {
  assert.equal(opsFailureReasonV1('exit-code', 75), 'exit code 75: the provider it works through was rate limiting it');
  assert.equal(opsFailureReasonV1('exit-code', 1), 'exit code 1');
  const pass = planOpsAlertsV1({ units: [failed('miorail-rwa-cash-exit.service', T0, { exitStatus: 75 })], state: { episodes: [] }, nowMs: T0 });
  assert.match(opsAlertHtmlV1(pass, T0)!, /<code>miorail-rwa-cash-exit\.service<\/code> — exit code 75: the provider it works through was rate limiting it/);
});

// Audit SPEND-5 (2026-11-10): Still's client secret at Bitrefill expires on 2027-01-31, and the only record of
// that date was a note. Six hours after it Spend is off for everyone, and no unit fails.
test('a secret that expires is said at thirty days and five more times, each once, and starts over when renewed', () => {
  const env = { STILL_BITREFILL_CLIENT_SECRET: 'fixture-secret', STILL_BITREFILL_CLIENT_SECRET_EXPIRES_AT: '2027-01-31T09:21:00Z' } as NodeJS.ProcessEnv;
  const expires = Date.parse('2027-01-31T09:21:00Z'), DAY = 24 * 60 * MIN;
  const deadlines = opsDeadlinesV1(env);
  assert.deepEqual(deadlines.map((row) => [row.key, row.expiresAtMs]), [['bitrefill-client-secret', expires]]);
  // No date, a date that is not one, or no secret at all: nothing to say.
  for (const other of [{}, { ...env, STILL_BITREFILL_CLIENT_SECRET_EXPIRES_AT: 'January' }, { STILL_BITREFILL_CLIENT_SECRET_EXPIRES_AT: '2027-01-31' }]) {
    assert.deepEqual(opsDeadlinesV1(other as NodeJS.ProcessEnv), []);
  }
  let told: Record<string, number> = {};
  const said: Array<[number, number]> = [];
  // One pass every six hours from forty days before until three days after.
  for (let at = expires - 40 * DAY; at <= expires + 3 * DAY; at += 6 * 60 * MIN) {
    const plan = planOpsDeadlinesV1({ deadlines, told, nowMs: at });
    for (const due of plan.due) said.push([due.stage, Math.floor(due.daysLeft)]);
    told = plan.next;
  }
  // Each stage is said by the first pass that finds the date that near, and by no later one.
  assert.deepEqual(said, [[30, 30], [14, 14], [7, 7], [3, 3], [1, 1], [0, 0]]);
  // A message that reached no chat is said again by the next pass.
  const first = planOpsDeadlinesV1({ deadlines, told: {}, nowMs: expires - 10 * DAY });
  assert.deepEqual([first.due.length, first.kept, first.next], [1, {}, { 'bitrefill-client-secret': 14 }]);
  assert.equal(planOpsDeadlinesV1({ deadlines, told: first.kept, nowMs: expires - 10 * DAY }).due.length, 1);
  assert.equal(planOpsDeadlinesV1({ deadlines, told: first.next, nowMs: expires - 10 * DAY }).due.length, 0);
  // Renewed for another year: nothing is said, and what was said before is forgotten.
  const renewed = planOpsDeadlinesV1({ deadlines: opsDeadlinesV1({ ...env, STILL_BITREFILL_CLIENT_SECRET_EXPIRES_AT: '2028-01-31T09:21:00Z' } as NodeJS.ProcessEnv), told, nowMs: expires - DAY });
  assert.deepEqual([renewed.due, renewed.next, renewed.kept], [[], {}, {}]);
});

test('the date is said in words that name what stops and what to do, and its file holds nothing else', () => {
  const env = { STILL_BITREFILL_CLIENT_SECRET: 'fixture-secret', STILL_BITREFILL_CLIENT_SECRET_EXPIRES_AT: '2027-01-31T09:21:00Z' } as NodeJS.ProcessEnv;
  const expires = Date.parse('2027-01-31T09:21:00Z'), DAY = 24 * 60 * MIN;
  const html = opsDeadlineHtmlV1(planOpsDeadlinesV1({ deadlines: opsDeadlinesV1(env), told: {}, nowMs: expires - 29.5 * DAY }).due)!;
  assert.match(html, /^<b>Miorail: a date is coming<\/b>\nStill’s client secret at Bitrefill expires on Jan 31, 2027, in 29 days\. After that Still Spend can no longer read Bitrefill’s catalogue or open an invoice\. Register the client again at Bitrefill/);
  assert.equal(html.includes('fixture-secret'), false);
  assert.match(opsDeadlineHtmlV1(planOpsDeadlinesV1({ deadlines: opsDeadlinesV1(env), told: {}, nowMs: expires + DAY }).due)!, /expired on Jan 31, 2027\. Since then Still Spend/);
  assert.match(opsDeadlineHtmlV1(planOpsDeadlinesV1({ deadlines: opsDeadlinesV1(env), told: {}, nowMs: expires - 60 * MIN }).due)!, /in less than a day/);
  assert.equal(opsDeadlineHtmlV1([]), null);
  assert.deepEqual(parseOpsDeadlineStateV1(JSON.stringify({ 'bitrefill-client-secret': 14, '../etc': 1, other: 'soon', big: 9999 })), { 'bitrefill-client-secret': 14 });
  assert.deepEqual([parseOpsDeadlineStateV1(null), parseOpsDeadlineStateV1('{not json'), parseOpsDeadlineStateV1('[1]')], [{}, {}, {}]);
  // Kept apart from the episodes: the unit starts Node every two minutes while state.json exists.
  assert.match(readFileSync(new URL('./ops_unit_alerts.ts', import.meta.url), 'utf8'), /join\(dir, 'deadlines\.json'\)/);
});

// Audit OPS-7: two tables grow every day and a full disk stops PostgreSQL without any unit failing first.
test('the disk is read as df reads it, and an answer that is not a disk is nothing', () => {
  // 100 GB of 4 KiB blocks, 20% free of which 5% is root's own.
  const reading = opsDiskReadingV1({ bsize: 4096, blocks: 25_000_000, bfree: 5_000_000, bavail: 3_750_000 })!;
  assert.equal(Math.round(reading.usedPercent * 10) / 10, 84.2);
  assert.equal(reading.freeBytes, 3_750_000 * 4096);
  assert.equal(reading.totalBytes, 23_750_000 * 4096);
  assert.equal(opsDiskReadingV1(null), null);
  assert.equal(opsDiskReadingV1({ bsize: 0, blocks: 10, bfree: 1, bavail: 1 }), null);
  assert.equal(opsDiskReadingV1({ bsize: 4096, blocks: 10, bfree: 11, bavail: 1 }), null);
  assert.equal(opsDiskReadingV1({ bsize: 4096, blocks: Number.NaN, bfree: 1, bavail: 1 }), null);
});

test('each line is said once on the way up, and the disk is forgotten only clearly under the first', () => {
  const at = (usedPercent: number) => ({ usedPercent, freeBytes: 10_000_000_000, totalBytes: 100_000_000_000 });
  const plan = (usedPercent: number, told: number) => planOpsDiskV1({ reading: at(usedPercent), told });
  assert.deepEqual([plan(50, 0).say, plan(79.9, 0).say], [null, null]);
  // Crossing a line: said, and kept as said only once the message reached a chat.
  assert.deepEqual({ ...plan(80, 0), reading: undefined }, { say: 'filling', reading: undefined, next: 80, kept: 0 });
  assert.equal(plan(85, 80).say, null, 'the same line is not said twice');
  assert.deepEqual({ ...plan(91, 80), reading: undefined }, { say: 'filling', reading: undefined, next: 90, kept: 80 });
  assert.deepEqual({ ...plan(99, 0), reading: undefined }, { say: 'filling', reading: undefined, next: 95, kept: 0 }, 'the highest line reached');
  // On a line: neither taken back nor said again.
  assert.deepEqual({ ...plan(78, 80), reading: undefined }, { say: null, reading: undefined, next: 80, kept: 80 });
  assert.deepEqual({ ...plan(76.9, 80), reading: undefined }, { say: 'recovered', reading: undefined, next: 0, kept: 80 });
  // Down one line without a word, so that the higher one can be said again.
  assert.deepEqual({ ...plan(84, 90), reading: undefined }, { say: null, reading: undefined, next: 80, kept: 80 });
  assert.equal(plan(88, 90).say, null);
  assert.equal(plan(88, 90).next, 90);
  // Not read: nothing said, nothing forgotten. A number that is not a line is no line.
  assert.deepEqual(planOpsDiskV1({ reading: null, told: 90 }), { say: null, reading: null, next: 90, kept: 90 });
  assert.equal(planOpsDiskV1({ reading: at(50), told: 17 }).next, 0);
});

test('the disk message says how full, how much is left, and what a full disk does', () => {
  const reading = { usedPercent: 83.6, freeBytes: 16_400_000_000, totalBytes: 96_700_000_000 };
  const filling = opsDiskHtmlV1(planOpsDiskV1({ reading, told: 0 }))!;
  assert.match(filling, /^<b>Miorail: the server’s disk is filling<\/b>\nIt is 83% full: 16\.4 GB free of 96\.7 GB\. A full disk stops PostgreSQL/);
  assert.match(filling, /official_cash_exit_runs and market_venue_transfers/);
  const back = opsDiskHtmlV1(planOpsDiskV1({ reading: { ...reading, usedPercent: 71.2, freeBytes: 27_900_000_000 }, told: 80 }))!;
  assert.equal(back, '<b>Miorail: the server’s disk is back under 80%</b>\nIt is 71% full, with 27.9 GB free.');
  assert.equal(opsDiskHtmlV1(planOpsDiskV1({ reading, told: 80 })), null);
  assert.equal(opsDiskHtmlV1(planOpsDiskV1({ reading: null, told: 0 })), null);
});
