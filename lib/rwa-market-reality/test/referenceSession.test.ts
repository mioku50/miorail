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

test('classifies reviewed weekday time outside core hours as after-hours for a publishing feed', () => {
  const result = classifyMarketRealityReferenceV1({
    now: new Date('2026-08-27T22:00:00.000Z'),
    configuration: configuration(),
    observation: observation({ observedAt: '2026-08-27T22:00:00.000Z' }),
  });
  assert.equal(result.session, 'after_hours');
  assert.equal(result.reasonCode, 'reviewed_calendar_after_hours');
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
