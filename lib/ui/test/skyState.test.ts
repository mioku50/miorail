import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { skyCaptionV1, skyStateV1, type SkyPhaseV1 } from '../src/still/skyState';
import { StillClockPill, StillFrame } from '../src/still/StillFrame';

void React;

describe('Still visual time follows Europe/Berlin without changing financial windows', () => {
  for (const [at, phase, clock] of [
    ['2026-01-05T04:59:59Z', 'night', 'MON 05:59'],
    ['2026-01-05T05:00:00Z', 'dusk', 'MON 06:00'],
    ['2026-01-05T06:00:00Z', 'day', 'MON 07:00'],
    ['2026-01-05T17:59:59Z', 'day', 'MON 18:59'],
    ['2026-01-05T18:00:00Z', 'dusk', 'MON 19:00'],
    ['2026-01-05T18:59:59Z', 'dusk', 'MON 19:59'],
    ['2026-01-05T19:00:00Z', 'night', 'MON 20:00'],
  ] satisfies readonly (readonly [string, SkyPhaseV1, string])[]) {
    it(`${at} is ${phase} at ${clock} in Berlin`, () => {
      const sky = skyStateV1({ now: new Date(at) });
      assert.equal(sky.phase, phase);
      assert.equal(sky.clock, clock);
      assert.equal(sky.clockZone, 'Europe/Berlin');
      assert.deepEqual(sky.daylightLabels, { open: '07:00', close: '19:00' });
      assert.equal(sky.sunShare === null, phase !== 'day');
    });
  }

  it('uses the European spring transition while the US has already changed its clock', () => {
    const friday = skyStateV1({ now: new Date('2026-03-27T18:30:00Z'), earnings: [] });
    const monday = skyStateV1({ now: new Date('2026-03-30T18:30:00Z'), earnings: [] });
    assert.equal(friday.clock, 'FRI 19:30');
    assert.equal(friday.phase, 'dusk');
    assert.equal(monday.clock, 'MON 20:30');
    assert.equal(monday.phase, 'night');
    assert.equal(friday.marketPhase, 'open');
    assert.equal(monday.marketPhase, 'open');
    assert.equal(skyCaptionV1(monday).headline, 'Market open · full limits');
  });

  it('uses the European autumn transition before the US changes its clock', () => {
    const friday = skyStateV1({ now: new Date('2026-10-23T18:30:00Z'), earnings: [] });
    const monday = skyStateV1({ now: new Date('2026-10-26T18:30:00Z'), earnings: [] });
    assert.equal(friday.clock, 'FRI 20:30');
    assert.equal(friday.phase, 'night');
    assert.equal(monday.clock, 'MON 19:30');
    assert.equal(monday.phase, 'dusk');
    assert.equal(friday.marketClock, 'FRI 2:30 PM');
    assert.equal(monday.marketClock, 'MON 2:30 PM');
    assert.equal(friday.marketPhase, 'open');
    assert.equal(monday.marketPhase, 'open');
  });

  it('an open US session during Berlin night keeps its open badge and full-limit caption', () => {
    const sky = skyStateV1({ now: new Date('2026-10-28T19:30:00Z'), earnings: [] });
    assert.equal(sky.phase, 'night');
    assert.equal(sky.marketPhase, 'open');
    assert.equal(skyCaptionV1(sky).headline, 'Market open · full limits');
    const pill = renderToStaticMarkup(React.createElement(StillClockPill, { sky }));
    assert.match(pill, /Market open/);
    assert.doesNotMatch(pill, /Market closed|After hours/);
    const frame = renderToStaticMarkup(React.createElement(StillFrame, { tab: 'assets', sky, children: 'content' }));
    assert.match(frame, /data-sky="night"/);
    assert.match(frame, /data-market-phase="open"/);
  });

  it('a Berlin weekend afternoon stays day while the closed-market rule remains active', () => {
    const sky = skyStateV1({ now: new Date('2026-10-31T15:00:00Z'), earnings: [] });
    assert.equal(sky.phase, 'day');
    assert.equal(sky.closed.active, true);
    assert.equal(sky.marketPhase, 'closed');
    assert.match(skyCaptionV1(sky).detail!, /Sun 8 PM New York, new loans against stocks count at 40%/);
    const pill = renderToStaticMarkup(React.createElement(StillClockPill, { sky }));
    assert.match(pill, /Market closed/);
  });

  it('a Berlin morning before the US open is labelled before-open, not after-hours', () => {
    const sky = skyStateV1({ now: new Date('2026-10-28T07:00:00Z'), earnings: [] });
    assert.equal(sky.phase, 'day');
    assert.equal(sky.marketPhase, 'before_open');
    assert.match(renderToStaticMarkup(React.createElement(StillClockPill, { sky })), /Before the open/);
  });
});
