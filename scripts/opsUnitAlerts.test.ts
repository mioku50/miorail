import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPS_ALERT_QUIET_MS_V1,
  OPS_ALERT_REMIND_AFTER_MS_V1,
  deliveredOpsAlertsV1,
  opsAlertHtmlV1,
  parseOpsAlertStateV1,
  parseSystemctlShowV1,
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
