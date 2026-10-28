import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeMirror } from '@mioagent/still-engine';
import type { MirrorReport } from '@mioagent/still-engine/report';
import { EXAMPLE, calendar, snapshot, universe } from '../../still-engine/test/fixtures';
import { agentAnswerV1 } from '../src/still/agentAnswers';
import { skyStateV1 } from '../src/still/skyState';
import { homeViewV1 } from '../src/still/homeView';

const NOW = new Date('2026-10-28T15:00:00Z');
const sky = skyStateV1({ now: NOW });
function report(): MirrorReport {
  return JSON.parse(JSON.stringify(computeMirror({ universe: universe(), snapshot: snapshot(EXAMPLE), calendar: calendar(),
    subject: { address: '0x00000000000000000000000000000000000b0b0b', name: null, input: 'example' }, assembledAt: NOW })));
}
const answer = (r: MirrorReport) => agentAnswerV1({ question: 'How safe is my loan?', report: r, sky }).text;

describe('Agent debt and safety readings have separate unknown states', () => {
  it('does not turn a recorded loan with unread safety into no loan', () => {
    const r = report(); r.venues.forEach(v => { v.safety = null; });
    const text = answer(r);
    assert.match(text, /Your \$240\.17 loan on Aave is recorded, but its liquidation safety could not be read/);
    assert.doesNotMatch(text, /No loans|nothing to liquidate|No debt was recorded/);
  });
  it('does not infer zero debt from unread venues or an empty venue list', () => {
    for (const empty of [false, true]) {
      const r = report();
      if (empty) r.venues = [];
      else r.venues.forEach(v => { v.debtCents = null; v.safety = null; });
      const text = answer(r);
      assert.match(text, /Debt .* could not be read\. This does not establish that no loan exists\./);
      assert.doesNotMatch(text, /No loans|nothing to liquidate|No debt was recorded/);
    }
  });
  it('states zero debt only within the reviewed venues that actually answered zero', () => {
    const r = report(); r.venues.forEach(v => { v.debtCents = '0'; v.safety = null; });
    assert.equal(answer(r), 'No debt was recorded in the reviewed venues at this block.');
    assert.equal(homeViewV1({ report: r, sky }).stateLine, 'No debt was recorded in the reviewed markets at this block.');
  });
  it('keeps a measured loan safety answer while naming another unread debt', () => {
    const r = report(); const other = r.venues.find(v => v.venue === 'morpho')!; other.debtCents = null;
    const text = answer(r);
    assert.match(text, /Your \$240\.17 loan on Aave: prices can fall 52% together/);
    assert.match(text, /Debt at Morpho .* could not be read/);
  });
  it('does not describe an already liquidatable loan as having room to fall', () => {
    const r = report(); const loan = r.venues.find(v => v.debtCents === '24017')!;
    loan.safety = { ...loan.safety!, state: 'liquidation', marginBps: -100 };
    const text = answer(r);
    assert.match(text, /marks your \$240\.17 loan on Aave as liquidatable now/);
    assert.doesNotMatch(text, /fall -1%/);
  });
  it('distinguishes an authenticated unread wallet from a visitor who needs to sign in', () => {
    const authenticated = agentAnswerV1({ question: 'How safe is my loan?', report: null, sky, signedIn: true }).text;
    assert.match(authenticated, /wallet report has not been read yet/);
    assert.doesNotMatch(authenticated, /sign in|No loans/);
    assert.match(agentAnswerV1({ question: 'How safe is my loan?', report: null, sky, signedIn: false }).text, /sign in/);
  });
  it('keeps Home neutral when debt or liquidation safety is not known', () => {
    const r = report(); r.venues.forEach(v => { v.debtCents = null; v.safety = null; });
    const view = homeViewV1({ report: r, sky });
    assert.equal(view.stateWord, 'Not fully read.');
    assert.match(view.stateLine, /Debt could not be read in every reviewed market/);
    assert.doesNotMatch(view.stateLine, /Nothing borrowed|hang free/);
    const known = report(); known.venues.forEach(v => { v.safety = null; });
    const debt = homeViewV1({ report: known, sky });
    assert.equal(debt.stateWord, 'Not fully read.');
    assert.match(debt.stateLine, /Known debt: \$240\.17\..*unread liquidation safety/);
    assert.equal(debt.owed?.amount, 'Owed $240.17');
  });
  it('preserves measured critical Home safety warnings and labels only the known debt total', () => {
    const r = report(); r.venues.find(v => v.venue === 'morpho')!.debtCents = null;
    const loan = r.venues.find(v => v.debtCents === '24017')!; loan.safety = { ...loan.safety!, state: 'liquidation', marginBps: 0 };
    const view = homeViewV1({ report: r, sky });
    assert.equal(view.stateWord, 'Over the edge.');
    assert.match(view.stateLine, /liquidation can start now/);
    assert.match(view.stateLine, /Debt could not be read in every reviewed market/);
    assert.equal(view.owed?.amount, 'Known debt $240.17');
  });
});
