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
  OPS_API_SETTLE_MS_V1,
  OPS_BACKUP_MAX_AGE_MS_V1,
  OPS_STOPPED_AFTER_MS_V1,
  OPS_TLS_STAGES_DAYS_V1,
  opsCheckOfV1,
  opsEpisodeUnitIsKnownV1,
  opsHealthIsAskedV1,
  opsTlsDeadlineV1,
  opsTlsHostsV1,
  opsWatchV1,
  parseOpsRestartsSeenV1,
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
    'ExecMainExitTimestamp=@1791402840', 'StateChangeTimestamp=@1791402841', 'NRestarts=0', '',
    'Id=miorail-gone.service', 'LoadState=not-found', 'ActiveState=inactive', 'Result=success', 'ExecMainStatus=0',
    'ExecMainExitTimestamp=', 'StateChangeTimestamp=', '',
  ].join('\n'));
  assert.deepEqual(units, [
    { unit: 'miorail-rwa-official.service', loaded: true, activeState: 'failed', result: 'exit-code', exitStatus: 1,
      changedAtMs: 1791402841000, lastExitAtMs: 1791402840000, restarts: 0 },
    { unit: 'miorail-gone.service', loaded: false, activeState: 'inactive', result: 'success', exitStatus: 0,
      changedAtMs: null, lastExitAtMs: null, restarts: null },
  ]);
  assert.deepEqual(parseOpsAlertStateV1(null), { episodes: [] });
  assert.deepEqual(parseOpsAlertStateV1('{not json'), { episodes: [] });
  const episode = { unit: 'miorail-api.service', sinceMs: T0, lastSeenFailedMs: T0, result: 'exit-code', exitStatus: 1, notifiedMs: null };
  assert.deepEqual(parseOpsAlertStateV1(JSON.stringify({ episodes: [episode, { unit: '../etc', sinceMs: 1 }] })), { episodes: [episode] });
});

test('the copy of the chats is renewed when missing or six hours old, and every pass starts Node', () => {
  assert.equal(opsAlertChatCacheStaleV1(null, T0), true);
  assert.equal(opsAlertChatCacheStaleV1(T0 - 359 * MIN, T0), false);
  assert.equal(opsAlertChatCacheStaleV1(T0 - 360 * MIN, T0), true);
  assert.equal(OPS_ALERT_CHAT_CACHE_MAX_AGE_MS_V1, 360 * MIN);
  // Audit OPS-5: the unit ended a pass in a shell unless a miorail-* unit was failed, so nothing that
  // is not `failed` was ever looked at. No condition stands between the timer and the pass now.
  const unitFile = readFileSync(new URL('../ops/systemd/miorail-ops-alerts.service', import.meta.url), 'utf8');
  assert.equal(unitFile.split('\n').some((line) => line.startsWith('ExecCondition=')), false);
  assert.match(unitFile, /^ExecStart=.+ scripts\/ops_unit_alerts\.ts$/m);
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
  // Kept apart from the episodes, in a file of its own.
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

// ---------------------------------------------------------------------------
// Audit OPS-5 (2026-11-10). Run against the real planner, each of these was announced to nobody:
// the API crashed three seconds ago and waits for its automatic restart; the API was killed for
// memory, restarted, and runs again; the API restarted 400 times today and runs at the moment of
// the pass; PostgreSQL stopped and took the API down into `inactive`.
// ---------------------------------------------------------------------------

const API = 'miorail-api.service';
const running = (name: string, overrides: Partial<OpsUnitStateV1> = {}) =>
  unit(name, { activeState: 'active', changedAtMs: T0 - 60 * MIN, lastExitAtMs: null, restarts: 0, ...overrides });
const watch = (units: OpsUnitStateV1[], over: Partial<Parameters<typeof opsWatchV1>[0]> = {}) =>
  opsWatchV1({ units, nowMs: T0, restartsSeen: {}, health: null, open: [], ...over });
/** One pass as the script runs it: the watch, then the plan, then the state a delivered message leaves. */
function passOf(units: OpsUnitStateV1[], state: OpsAlertStateV1, nowMs: number, over: Partial<Parameters<typeof opsWatchV1>[0]> = {}) {
  const watched = opsWatchV1({ units, nowMs, restartsSeen: {}, health: null, open: state.episodes.map((episode) => episode.unit), ...over });
  const pass = planOpsAlertsV1({ units: watched.units, state, nowMs });
  return { watched, pass, html: opsAlertHtmlV1(pass, nowMs), next: deliveredOpsAlertsV1(pass, nowMs) };
}

test('an API that systemd started again is said once, though it runs at the moment of the pass', () => {
  // Killed for memory or crashed, then started again: active, Result=success, never `failed`.
  const first = passOf([running(API, { restarts: 1 })], EMPTY, T0, { restartsSeen: { [API]: 0 } });
  assert.deepEqual(first.pass.failed.map((episode) => episode.unit), [`${API}#restarts`]);
  assert.match(first.html!, /^<b>Miorail: a service is in trouble<\/b>\n<code>miorail-api\.service<\/code> — its process ended and systemd started it again once since the last check, /);
  // The hint names the unit, not the check: there is no journal of `…#restarts`.
  assert.match(first.html!, /Why: <code>journalctl -u miorail-api\.service -n 80<\/code>/);
  assert.deepEqual(first.watched.restartsSeen, { [API]: 1 });

  // No restart since: nothing more is said, and after ten quiet minutes it is closed in words of its own.
  const quiet = passOf([running(API, { restarts: 1 })], first.next, T0 + 2 * MIN, { restartsSeen: { [API]: 1 } });
  assert.equal(quiet.html, null);
  const over = passOf([running(API, { restarts: 1 })], quiet.next, T0 + OPS_ALERT_QUIET_MS_V1, { restartsSeen: { [API]: 1 } });
  assert.match(over.html!, /^<b>Back to normal<\/b>\n<code>miorail-api\.service<\/code>: has not been started again since \(first seen /);
  assert.deepEqual(over.next, EMPTY);
});

test('a crash loop is one episode: said once, reminded once a day, however many restarts each pass sees', () => {
  let state = EMPTY;
  let seen = 0;
  const said: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    const now = T0 + i * 2 * MIN;
    const count = seen + 2; // twice between passes
    const step = passOf([running(API, { restarts: count })], state, now, { restartsSeen: { [API]: seen } });
    if (step.html) said.push(i);
    if (i === 0) assert.match(step.html!, /started it again 2 times since the last check/);
    state = step.next;
    seen = count;
  }
  assert.deepEqual(said, [0]);
  const nextDay = passOf([running(API, { restarts: seen + 2 })], state, T0 + OPS_ALERT_REMIND_AFTER_MS_V1, { restartsSeen: { [API]: seen } });
  assert.match(nextDay.html!, /^<b>Still failing<\/b>\n<code>miorail-api\.service<\/code> — its process ended and systemd started it again 2 times/);
});

test('a count seen for the first time, or one a start by hand reset, is not a restart', () => {
  assert.equal(passOf([running(API, { restarts: 400 })], EMPTY, T0).html, null, 'nothing to compare with');
  assert.deepEqual(watch([running(API, { restarts: 400 })]).restartsSeen, { [API]: 400 });
  assert.equal(passOf([running(API, { restarts: 0 })], EMPTY, T0, { restartsSeen: { [API]: 7 } }).html, null, 'a deploy started it by hand');
  assert.equal(passOf([running(API, { restarts: null })], EMPTY, T0, { restartsSeen: { [API]: 7 } }).html, null, 'not read');
  // A unit that is not loaded is not counted, and what was seen of it is forgotten.
  assert.deepEqual(watch([running(API, { loaded: false, restarts: 3 })], { restartsSeen: { [API]: 1 } }).restartsSeen, {});
});

test('PostgreSQL, nginx and the API stopped are said; a worker between its runs is not', () => {
  const stoppedFor = (ms: number) => ({ activeState: 'inactive', changedAtMs: T0 - ms, restarts: 0 });
  const postgres = passOf([unit('postgresql@18-main.service', stoppedFor(2 * MIN)), unit(API, stoppedFor(2 * MIN))], EMPTY, T0);
  assert.deepEqual(postgres.pass.failed.map((episode) => [episode.unit, episode.result]), [
    ['postgresql@18-main.service', 'stopped'],
    [API, 'stopped'],
  ]);
  assert.match(postgres.html!, /^<b>Miorail: 2 services are in trouble<\/b>\n<code>postgresql@18-main\.service<\/code> — is stopped, and nothing starts it again, /);
  // A restart in progress passes through `inactive` for a moment.
  assert.equal(passOf([unit('nginx.service', stoppedFor(OPS_STOPPED_AFTER_MS_V1 - 1))], EMPTY, T0).html, null);
  assert.notEqual(passOf([unit('nginx.service', stoppedFor(OPS_STOPPED_AFTER_MS_V1))], EMPTY, T0).html, null);
  // A timer's worker is inactive between its runs: that is its ordinary state. So is certbot.
  assert.equal(passOf([unit('miorail-rwa-official.service', stoppedFor(60 * MIN)), unit('certbot.service', stoppedFor(600 * MIN))], EMPTY, T0).html, null);
  // Started again: closed as a unit that runs.
  const back = passOf([running('postgresql@18-main.service'), running(API)], postgres.next, T0 + OPS_ALERT_QUIET_MS_V1);
  assert.match(back.html!, /<code>postgresql@18-main\.service<\/code> runs cleanly again/);
  assert.deepEqual(back.next, EMPTY);
});

test('an API that runs and does not answer is said; one that is down or just started is not asked', () => {
  const up = running(API, { changedAtMs: T0 - 5 * MIN });
  assert.equal(opsHealthIsAskedV1([up], T0), true);
  assert.equal(opsHealthIsAskedV1([running(API, { changedAtMs: T0 - OPS_API_SETTLE_MS_V1 + 1 })], T0), false, 'it listens a few seconds after it starts');
  assert.equal(opsHealthIsAskedV1([unit(API, { activeState: 'activating' })], T0), false);
  assert.equal(opsHealthIsAskedV1([failed(API)], T0), false, 'a failed unit is its own line');
  assert.equal(opsHealthIsAskedV1([], T0), false);

  const silent = passOf([up], EMPTY, T0, { health: { ok: false, detail: 'no answer in 5 s' } });
  assert.match(silent.html!, /<code>miorail-api\.service<\/code> — is running but does not answer on \/health \(no answer in 5 s\), /);
  assert.deepEqual(silent.pass.failed.map((episode) => episode.unit), [`${API}#health`]);
  // Not asked this pass (a deploy is restarting it): the episode waits, it is neither closed nor said again.
  const waiting = passOf([unit(API, { activeState: 'activating' })], silent.next, T0 + OPS_ALERT_QUIET_MS_V1, { health: null });
  assert.equal(waiting.html, null);
  assert.equal(waiting.next.episodes.length, 1);
  const answers = passOf([up], waiting.next, T0 + 2 * OPS_ALERT_QUIET_MS_V1, { health: { ok: true, detail: 'HTTP 200' } });
  assert.match(answers.html!, /<code>miorail-api\.service<\/code>: answers on \/health again \(first seen /);
  // An API that answers opens nothing.
  assert.equal(passOf([up], EMPTY, T0, { health: { ok: true, detail: 'HTTP 200' } }).html, null);
  assert.equal(watch([up], { health: { ok: true, detail: 'HTTP 200' } }).units.length, 1);
});

test('a backup that stopped being taken is said after a day and a half, and a failed one is its own line', () => {
  const backup = (ageMs: number, overrides: Partial<OpsUnitStateV1> = {}) =>
    unit('miorail-db-backup.service', { changedAtMs: T0 - ageMs, lastExitAtMs: T0 - ageMs, ...overrides });
  assert.equal(passOf([backup(OPS_BACKUP_MAX_AGE_MS_V1)], EMPTY, T0).html, null);
  const late = passOf([backup(OPS_BACKUP_MAX_AGE_MS_V1 + MIN)], EMPTY, T0);
  assert.match(late.html!, /<code>miorail-db-backup\.service<\/code> — no backup has finished for 36 h; it runs every night, /);
  assert.deepEqual(late.pass.failed.map((episode) => episode.unit), ['miorail-db-backup.service#age']);
  // The unit failed: one line, the unit's own.
  const broken = passOf([failed('miorail-db-backup.service', T0 - 40 * 60 * MIN)], EMPTY, T0);
  assert.deepEqual(broken.pass.failed.map((episode) => episode.unit), ['miorail-db-backup.service']);
  // Never run on this server: nothing to measure an age from.
  assert.equal(passOf([backup(0, { lastExitAtMs: null })], EMPTY, T0).html, null);
  // A night later one finished.
  const taken = passOf([backup(5 * MIN)], late.next, T0 + 24 * 60 * MIN);
  assert.match(taken.html!, /<code>miorail-db-backup\.service<\/code>: a backup has finished \(first seen /);
});

test('a state file keeps episodes of the system units and of the checks, and drops any other name', () => {
  const episode = (name: string) => ({ unit: name, sinceMs: T0, lastSeenFailedMs: T0, result: 'stopped', exitStatus: null, notifiedMs: T0 });
  const names = ['postgresql@18-main.service', 'nginx.service', 'certbot.service', `${API}#restarts`, `${API}#health`, 'miorail-db-backup.service#age'];
  assert.deepEqual(parseOpsAlertStateV1(JSON.stringify({ episodes: names.map(episode) })).episodes.map((row) => row.unit), names);
  // Dropped on the way back in, they would be opened and said again every two minutes.
  for (const name of ['sshd.service', `${API}#toString`, `${API}#constructor`, '../etc#health', 'nginx.service#restarts#x', 'postgresql@17-main.service']) {
    assert.equal(opsEpisodeUnitIsKnownV1(name), false, name);
    assert.deepEqual(parseOpsAlertStateV1(JSON.stringify({ episodes: [episode(name)] })), EMPTY, name);
  }
  assert.deepEqual(opsCheckOfV1(`${API}#health`), { unit: API, check: 'health' });
  assert.deepEqual(opsCheckOfV1(API), { unit: API, check: null });
});

test('systemctl show gives the automatic restarts, and the counts are kept between passes', () => {
  const [api] = parseSystemctlShowV1('Id=miorail-api.service\nLoadState=loaded\nActiveState=active\nResult=success\nExecMainStatus=0\nStateChangeTimestamp=@1791402840\nNRestarts=3\n');
  assert.equal(api!.restarts, 3);
  assert.equal(parseSystemctlShowV1('Id=x.service\nLoadState=loaded\nActiveState=active\n')[0]!.restarts, null);
  assert.deepEqual(parseOpsRestartsSeenV1(JSON.stringify({ [API]: 3, 'postgresql@18-main.service': 0, '../etc': 1, bad: -1, text: 'x' })), { [API]: 3, 'postgresql@18-main.service': 0 });
  assert.deepEqual([parseOpsRestartsSeenV1(null), parseOpsRestartsSeenV1('{'), parseOpsRestartsSeenV1('[1]')], [{}, {}, {}]);
  // The script asks systemd for the count, and never by a check's name.
  const script = readFileSync(new URL('./ops_unit_alerts.ts', import.meta.url), 'utf8');
  assert.match(script, /const SHOW_V1 = '[A-Za-z,]+,NRestarts';/);
  assert.match(script, /state\.episodes\.map\(\(episode\) => opsCheckOfV1\(episode\.unit\)\.unit\)/);
});

test('a certificate is said from two weeks before it ends, for the hosts this server names', () => {
  assert.deepEqual(opsTlsHostsV1({}), ['miorail.xyz', 'stills.lat']);
  assert.deepEqual(
    opsTlsHostsV1({ PUBLIC_API_BASE_URL: 'https://Miorail.xyz/api', MIORAIL_PUBLIC_ORIGIN: 'https://app.example.org', OPS_ALERT_TLS_HOSTS: ' www.miorail.xyz, stills.lat ,not a host,http://x,-bad.example,' }),
    ['miorail.xyz', 'stills.lat', 'app.example.org', 'www.miorail.xyz'],
  );
  // An origin that is not https has no certificate to ask about.
  assert.deepEqual(opsTlsHostsV1({ PUBLIC_API_BASE_URL: 'http://localhost:8080' }), ['miorail.xyz', 'stills.lat']);

  const DAY = 24 * 60 * MIN;
  const ends = T0 + 60 * DAY;
  const deadline = opsTlsDeadlineV1('www.miorail.xyz', ends);
  assert.equal(deadline.key, 'tls-www-miorail-xyz');
  assert.deepEqual(parseOpsDeadlineStateV1(JSON.stringify({ [deadline.key]: 7 })), { [deadline.key]: 7 }, 'its key is one the state file keeps');
  const at = (daysLeft: number, told: Record<string, number> = {}) => planOpsDeadlinesV1({ deadlines: [deadline], told, nowMs: ends - daysLeft * DAY });
  // certbot renews with thirty days left: thirty is every certificate's ordinary state.
  assert.deepEqual(at(29).due, []);
  assert.deepEqual(at(15).due, []);
  assert.deepEqual(at(14).due.map((row) => row.stage), [14]);
  assert.deepEqual(at(13, { [deadline.key]: 14 }).due, []);
  assert.deepEqual(at(7, { [deadline.key]: 14 }).due.map((row) => row.stage), [7]);
  assert.deepEqual(OPS_TLS_STAGES_DAYS_V1, [14, 7, 3, 1, 0]);
  assert.match(opsDeadlineHtmlV1(at(14).due)!, /The certificate of www\.miorail\.xyz expires on .+, in 14 days\. After that browsers and wallets refuse the site\. It renews by itself a month ahead, so it has not: run certbot renew/);
  // A secret keeps its own stages: said at thirty days.
  const secret = opsDeadlinesV1({ STILL_BITREFILL_CLIENT_SECRET: 'fixture-secret', STILL_BITREFILL_CLIENT_SECRET_EXPIRES_AT: new Date(ends).toISOString() });
  assert.deepEqual(planOpsDeadlinesV1({ deadlines: secret, told: {}, nowMs: ends - 29 * DAY }).due.map((row) => row.stage), [30]);
});

test('the heartbeat is asked only of an https address the environment names', () => {
  const script = readFileSync(new URL('./ops_unit_alerts.ts', import.meta.url), 'utf8');
  assert.match(script, /if \(!\/\^https:\\\/\\\/\/\.test\(target\)\) return 'off';/);
  assert.match(script, /beat\(process\.env\.OPS_ALERT_HEARTBEAT_URL\)/);
});
