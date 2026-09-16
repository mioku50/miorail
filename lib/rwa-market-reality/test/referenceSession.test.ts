import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REVIEWED_US_EQUITIES_CALENDAR_2026_V1,
  classifyMarketRealityReferenceV1,
  type ReviewedReferenceConfigurationV1,
  type ReviewedReferenceObservationV1,
} from '../src/referenceSession.js';

const TOKEN_A = '0xb20000000000000000000078ee7ce2fe4908108c';
const TOKEN_B = '0xa34c5e0abe843e10461e2c9586ea03e55dbcc495';
const FEED = '0x04689a41629776563e6822f76f2e57d148d28513';
const HASH = `0x${'11'.repeat(32)}`;

function configuration(
  overrides: Partial<ReviewedReferenceConfigurationV1> = {},
): ReviewedReferenceConfigurationV1 {
  return {
    chainId: 8453,
    tokenAddress: TOKEN_A,
    issuerId: 'coinbase',
    referenceAddress: FEED,
    referenceSource: 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base',
    calendar: REVIEWED_US_EQUITIES_CALENDAR_2026_V1,
    outsideRegularHours: 'publishes',
    ...overrides,
  };
}

function observation(
  overrides: Partial<ReviewedReferenceObservationV1> = {},
): ReviewedReferenceObservationV1 {
  return {
    chainId: 8453,
    tokenAddress: TOKEN_A,
    issuerId: 'coinbase',
    referenceAddress: FEED,
    status: 'fresh',
    valueAtomic: '18125000000',
    decimals: 8,
    observedAt: '2026-08-27T14:00:00.000Z',
    referenceUpdatedAt: '2026-08-27T13:59:30.000Z',
    evidence: {
      kind: 'chainlink_feed',
      source: 'chainlink_v3_proxy_total_return',
      blockNumber: '50500000',
      blockHash: HASH,
      targetAddress: FEED,
      evidenceHash: HASH,
    },
    ...overrides,
  };
}

test('classifies an explicit timestamp inside reviewed regular hours', () => {
  const result = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-27T14:00:00.000Z'),
    configuration: configuration(),
    observation: observation(),
  });
  assert.equal(result.session, 'regular_hours');
  assert.equal(result.freshness, 'fresh');
  assert.equal(result.calendar?.localDate, '2026-08-27');
  assert.equal(result.referenceAddress, FEED);
});

test('after hours with nothing printed since the bell is a held last close, whatever the feed is configured to do', () => {
  // The fixture publishes at 09:59 ET and we look at 18:00 ET. The old answer
  // read the configuration and said "after hours, publishing" — a claim about
  // the feed's habits over an observation of the feed's behaviour. It has not
  // published since the close, so at this instant it is holding one.
  const result = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-27T22:00:00.000Z'),
    configuration: configuration(),
    observation: observation({ observedAt: '2026-08-27T22:00:00.000Z' }),
  });
  assert.equal(result.marketSession, 'after_hours');
  assert.equal(result.publicationPlacement, 'last_closed_session');
  assert.equal(result.publicationMode, 'holding_last_close');
  assert.equal(result.reasonCode, 'reviewed_feed_holding_last_close');
});

test('after hours with a print since the bell is an off-session publication', () => {
  // Measured 2026-09-16: six of ten Coinbase feeds had printed between 20:00
  // and 03:13 ET, each with a value that had moved. This is that state.
  const result = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-28T07:15:00.000Z'),
    configuration: configuration(),
    observation: observation({
      observedAt: '2026-08-28T07:15:00.000Z',
      referenceUpdatedAt: '2026-08-28T07:04:11.000Z',
    }),
  });
  assert.equal(result.marketSession, 'after_hours');
  assert.equal(result.publicationPlacement, 'after_last_close');
  assert.equal(result.publicationMode, 'live_reference');
  assert.equal(result.reasonCode, 'reviewed_feed_publishing_off_session');
});

test('the market clock never bends to the feed', () => {
  // A Saturday is a Saturday whether the feed printed on Friday afternoon or
  // at 20:00 on Sunday. Only the publication axis moves.
  const held = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-29T14:00:00.000Z'),
    configuration: configuration(),
    observation: observation({
      observedAt: '2026-08-29T14:00:00.000Z',
      referenceUpdatedAt: '2026-08-28T15:56:09.000Z',
    }),
  });
  const printed = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-29T14:00:00.000Z'),
    configuration: configuration(),
    observation: observation({
      observedAt: '2026-08-29T14:00:00.000Z',
      referenceUpdatedAt: '2026-08-29T00:40:35.000Z',
    }),
  });
  assert.equal(held.marketSession, 'weekend');
  assert.equal(printed.marketSession, 'weekend');
  assert.equal(held.publicationPlacement, 'last_closed_session');
  assert.equal(printed.publicationPlacement, 'after_last_close');
  assert.equal(held.publicationMode, 'holding_last_close');
  assert.equal(printed.publicationMode, 'live_reference');
});

test('a publication with a whole closed session behind it is placed, and not called a close', () => {
  // Thursday's print, read on Saturday, with Friday's session in between. It
  // is neither current nor the last close, and the mode refuses to name it.
  const result = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-29T14:00:00.000Z'),
    configuration: configuration(),
    observation: observation({ observedAt: '2026-08-29T14:00:00.000Z' }),
  });
  assert.equal(result.publicationPlacement, 'before_last_close');
  assert.equal(result.publicationMode, 'unknown');
  assert.equal(result.reasonCode, 'reviewed_publication_precedes_last_close');
});

test('an unreviewed off-hours publication policy still refuses to name the value', () => {
  const result = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-28T07:15:00.000Z'),
    configuration: configuration({ outsideRegularHours: 'unknown' }),
    observation: observation({
      observedAt: '2026-08-28T07:15:00.000Z',
      referenceUpdatedAt: '2026-08-28T07:04:11.000Z',
    }),
  });
  assert.equal(result.publicationPlacement, 'after_last_close');
  assert.equal(result.publicationMode, 'unknown');
  assert.equal(result.reasonCode, 'calendar_semantics_missing');
});

test('classifies a reviewed Saturday as weekend without using the browser timezone', () => {
  const result = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-29T14:00:00.000Z'),
    configuration: configuration(),
    observation: observation({ observedAt: '2026-08-29T14:00:00.000Z' }),
  });
  assert.equal(result.session, 'weekend');
  assert.equal(result.calendar?.timeZone, 'America/New_York');
});

test('uses reviewed Coinbase publication semantics to establish a held last close', () => {
  const result = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-27T22:00:00.000Z'),
    configuration: configuration({ outsideRegularHours: 'holds_last_close' }),
    observation: observation({ observedAt: '2026-08-27T22:00:00.000Z' }),
  });
  assert.equal(result.session, 'reference_holding_last_close');
  assert.equal(result.reasonCode, 'reviewed_feed_holding_last_close');
});

test('an explicitly established issuer-registry pause is a corporate-action hold', () => {
  const result = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-27T14:00:00.000Z'),
    configuration: configuration(),
    observation: observation({ status: 'corporate_action_hold' }),
  });
  assert.equal(result.session, 'corporate_action_hold');
  assert.equal(result.status, 'paused');
  assert.equal(result.freshness, 'stale');
});

test('a reviewed stale observation remains stale even during regular hours', () => {
  const result = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-27T14:00:00.000Z'),
    configuration: configuration(),
    observation: observation({ status: 'stale' }),
  });
  assert.equal(result.session, 'stale');
  assert.equal(result.reasonCode, 'reviewed_reference_stale');
});

test('missing or out-of-range calendar semantics stay unknown', () => {
  const missing = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-27T14:00:00.000Z'),
    configuration: configuration({ calendar: null }),
    observation: observation(),
  });
  const future = classifyMarketRealityReferenceV1({
    now: new Date('2027-08-27T14:00:00.000Z'),
    configuration: configuration(),
    observation: observation({
      observedAt: '2027-08-27T14:00:00.000Z',
      referenceUpdatedAt: '2027-08-27T13:59:30.000Z',
    }),
  });
  assert.equal(missing.session, 'unknown');
  assert.equal(missing.reasonCode, 'calendar_semantics_missing');
  assert.equal(future.session, 'unknown');
  assert.equal(future.reasonCode, 'calendar_outside_reviewed_range');
});

test('a same-underlying observation for representation B cannot satisfy representation A', () => {
  const result = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-27T14:00:00.000Z'),
    configuration: configuration(),
    observation: observation({ tokenAddress: TOKEN_B }),
  });
  assert.equal(result.session, 'unknown');
  assert.equal(result.status, 'unknown');
  assert.equal(result.reasonCode, 'reference_identity_mismatch');
  assert.equal(result.valueAtomic, null);
});
