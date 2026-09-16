import assert from 'node:assert/strict';
import test from 'node:test';

import { stableHashV1 } from '@mioagent/route-domain';

import {
  MARKET_REALITY_PUBLICATION_PLACEMENTS_V1,
  MarketRealityBasisDecisionV1Schema,
  MarketRealityReferenceStateV1Schema,
} from '../src/marketRealitySnapshot.js';

const FEED = '0x04689a41629776563e6822f76f2e57d148d28513';
const HASH = `0x${'11'.repeat(32)}`;

/** A reference state exactly as it was written before the placement axis
 * existed: no `publicationPlacement` key at all. */
function storedBeforeThisAxis(): Record<string, unknown> {
  return {
    status: 'fresh',
    session: 'regular_hours',
    marketSession: 'regular_hours',
    publicationMode: 'live_reference',
    valueAtomic: '21130000000',
    decimals: 8,
    observedAt: '2026-08-27T14:00:05.000Z',
    referenceUpdatedAt: '2026-08-27T13:59:30.000Z',
    freshness: 'fresh',
    referenceSource: 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base',
    referenceAddress: FEED,
    calendar: {
      key: 'us_equities_core_2026_v1',
      sourceUrls: ['https://www.nyse.com/trade/hours-calendars'],
      timeZone: 'America/New_York',
      localDate: '2026-08-27',
      regularOpenMinute: 570,
      regularCloseMinute: 960,
      publicationSessionLocalDate: '2026-08-27',
      publicationSessionOpenMinute: 570,
      publicationSessionCloseMinute: 960,
    },
    evidence: {
      kind: 'chainlink_feed',
      source: 'chainlink_v3_proxy_total_return',
      blockNumber: '50500000',
      blockHash: HASH,
      targetAddress: FEED,
      evidenceHash: HASH,
    },
    comparable: false,
    reasonCode: 'reviewed_calendar_regular_hours',
    reason: 'Reviewed regular hours.',
  };
}

test('reading a snapshot written before the placement axis does not change its content hash', () => {
  // A stored snapshot proves itself by a hash over its own content. A zod
  // `.default()` on a new field writes the key in at parse time, and the
  // recomputed hash then stops matching the stored one — every snapshot taken
  // before the field existed would fail integrity on read. This is why the
  // field is optional and never defaulted.
  const stored = storedBeforeThisAxis();
  const before = stableHashV1('market-reality-evidence-snapshot/v1', stored);
  const parsed = MarketRealityReferenceStateV1Schema.parse(stored);
  const after = stableHashV1('market-reality-evidence-snapshot/v1', parsed);
  assert.equal(before, after);
  assert.equal('publicationPlacement' in parsed, false);
  assert.equal(parsed.publicationPlacement, undefined);
});

test('an absent placement is not the same answer as one the calendar could not make', () => {
  // Absent: nobody asked, because this row predates the question.
  // not_classified: the reviewed calendar was asked and had no answer.
  const unplaced = MarketRealityReferenceStateV1Schema.parse({
    ...storedBeforeThisAxis(),
    publicationPlacement: 'not_classified',
  });
  assert.equal(unplaced.publicationPlacement, 'not_classified');
  assert.notEqual(
    MarketRealityReferenceStateV1Schema.parse(storedBeforeThisAxis()).publicationPlacement,
    'not_classified',
  );
});

test('the placement set is the five the classifier can produce, and nothing else', () => {
  assert.deepEqual(MARKET_REALITY_PUBLICATION_PLACEMENTS_V1, [
    'inside_open_session',
    'last_closed_session',
    'after_last_close',
    'before_last_close',
    'not_classified',
  ]);
  assert.throws(() =>
    MarketRealityReferenceStateV1Schema.parse({
      ...storedBeforeThisAxis(),
      publicationPlacement: 'overnight',
    }),
  );
});

test('a basis decision keeps the policy it was decided under, both ways', () => {
  for (const policy of [
    'exact_normalized_price_same_quote_window_reviewed_publication_v1',
    'exact_normalized_price_same_quote_window_placed_publication_v2',
  ]) {
    const decision = MarketRealityBasisDecisionV1Schema.parse({
      policy,
      status: 'comparable',
      kind: 'last_close_reference',
      premiumDiscountBps: '-11',
      reasonCode: 'last_close_reference_comparable',
      reason: 'Comparable with the reviewed last-close publication.',
    });
    assert.equal(decision.policy, policy);
  }
});

test('only v2 may name an off-session reference, and it must say so in the reason code', () => {
  assert.throws(() =>
    MarketRealityBasisDecisionV1Schema.parse({
      policy: 'exact_normalized_price_same_quote_window_placed_publication_v2',
      status: 'comparable',
      kind: 'off_session_reference',
      premiumDiscountBps: '11',
      reasonCode: 'current_reference_comparable',
      reason: 'Mislabelled.',
    }),
  );
  assert.throws(() =>
    MarketRealityBasisDecisionV1Schema.parse({
      policy: 'exact_normalized_price_same_quote_window_placed_publication_v2',
      status: 'withheld',
      kind: 'withheld',
      premiumDiscountBps: null,
      reasonCode: 'off_session_reference_comparable',
      reason: 'A withheld basis cannot carry a comparable reason.',
    }),
  );
});
