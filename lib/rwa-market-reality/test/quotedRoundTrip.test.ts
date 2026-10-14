import assert from 'node:assert/strict';
import test from 'node:test';
import { quotedRoundTripOutcomeV1 } from '../src/quotedRoundTrip.js';
import { stockBriefV1 } from '../src/stockBrief.js';
import { briefInput, FEED, TOKEN } from './fixtures/stockBrief.js';

test('quote excess is above input, a shortfall below, and zero is not free', () => {
  assert.equal(quotedRoundTripOutcomeV1('-315'), '3.15% above cash input');
  assert.equal(quotedRoundTripOutcomeV1('2'), '0.02% below cash input');
  assert.equal(quotedRoundTripOutcomeV1('0'), 'within 0.01% of cash input');
  assert.equal(quotedRoundTripOutcomeV1('-0'), 'within 0.01% of cash input');
  for (const value of [null, '', 'unknown', 'NaN', '-Infinity', '3.15', '10000000000']) {
    assert.equal(quotedRoundTripOutcomeV1(value), null);
  }
});

test('the two observed transitions never become negative costs or an executable return in the inbox', () => {
  const cards = [['-315', '0'], ['2', '-315']].map(([before, after], index) => ({
    signalId: String(index + 1), kind: 'official_asset_cash_exit_changed' as const,
    chainId: 8453 as const, subjectAddress: TOKEN, officialAddress: null,
    subjectTicker: 'NVDAc', officialTicker: null,
    occurredAt: '2026-09-30T16:06:32.506Z', recordedAt: '2026-09-30T16:06:33.000Z',
    facts: { destination: 'USDC', requestedCashAtomic: '100000000',
      previousRoundTripCostBps: before, roundTripCostBps: after },
  }));
  const { inbox } = stockBriefV1({ ...briefInput(), changes: { ...FEED, cards } });
  assert.equal(inbox.items.length, 2);
  for (const item of inbox.items) {
    assert.equal(item.headline, 'Quoted round trip changed');
    assert.match(item.summary!, /\$100|3\.15% above cash input/);
    assert.match(item.summary!, /not an executed return or a verified trading opportunity/);
    assert.doesNotMatch(item.summary!, /costs|free|profit|now/);
  }
  assert.match(inbox.items[0]!.summary!, /within 0\.01% of cash input/);
  assert.match(inbox.items[1]!.summary!, /0\.02% below cash input/);
});
