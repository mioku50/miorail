import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MarketRealityBasisDecisionV1Schema,
  type MarketRealityReferenceStateV1,
} from '@mioagent/route-storage';

import { evaluateMarketRealityBasisV1 } from '../src/basis.js';
import { effectivePriceV1, normalizedExposureV1 } from '../src/engine.js';
import {
  REVIEWED_US_EQUITIES_CALENDAR_2026_V1,
  classifyMarketRealityReferenceV1,
} from '../src/referenceSession.js';

const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const FEED = '0x04689a41629776563e6822f76f2e57d148d28513';
const HASH = `0x${'11'.repeat(32)}`;

function reference(
  overrides: Partial<MarketRealityReferenceStateV1> = {},
): MarketRealityReferenceStateV1 {
  return {
    status: 'fresh',
    session: 'regular_hours',
    marketSession: 'regular_hours',
    publicationMode: 'live_reference',
    publicationPlacement: 'inside_open_session',
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
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof evaluateMarketRealityBasisV1>[0]> = {}) {
  return {
    issuerId: 'coinbase' as const,
    marketStatus: 'quoted' as const,
    quoteObservedAt: '2026-08-27T14:00:00.000Z',
    quoteExpiresAt: '2026-08-27T14:00:20.000Z',
    evaluatedAt: '2026-08-27T14:00:06.000Z',
    normalizedExposureAtomic: '1000000000000000000',
    effectivePriceAtomic: '21154000000',
    effectivePriceDecimals: 8 as const,
    supplyState: 'positive_supply' as const,
    reference: reference(),
    ...overrides,
  };
}

test('fresh regular-hours exact Coinbase reference is comparable for BUY', () => {
  const basis = evaluateMarketRealityBasisV1(input());
  assert.equal(basis.status, 'comparable');
  assert.equal(basis.kind, 'current_reference');
  assert.equal(basis.premiumDiscountBps, '11');
});

test('fresh regular-hours exact Coinbase reference is comparable for SELL', () => {
  const basis = evaluateMarketRealityBasisV1(input({ effectivePriceAtomic: '21106000000' }));
  assert.equal(basis.status, 'comparable');
  assert.equal(basis.kind, 'current_reference');
  assert.equal(basis.premiumDiscountBps, '-11');
});

test('effective price is exact cash divided by normalized economic exposure', () => {
  assert.equal(effectivePriceV1('100000000', '500000000000000000', 18), '20000000000');
});

test('a non-1 B20 multiplier is applied exactly once', () => {
  const normalized = normalizedExposureV1({
    binding: {
      chainId: 8453,
      tokenAddress: TOKEN,
      underlyingKey: 'security:isin:US67066G1040',
      sourceKind: 'coinbase_b20_metadata',
      sourceRef: 'base-docs',
      sourceHash: 'ab'.repeat(32),
      issuerId: 'coinbase',
      issuerInstrumentKey: 'coinbase:b20:nvda',
      caip10: `eip155:8453:${TOKEN}`,
      representationKind: 'b20_asset',
      evidenceStrength: 'reviewed_machine_mapping_with_onchain_cross_check',
      observedBlockNumber: '50000000',
      observedBlockHash: HASH,
      observedAt: '2026-08-27T13:59:00.000Z',
    },
    tokenAtomic: '500000000000000000',
    tokenDecimals: 18,
    ratio: {
      chainId: 8453,
      tokenAddress: TOKEN,
      ratioKind: 'b20_multiplier',
      application: 'apply_to_raw_balance',
      rawValue: '2000000000000000000',
      scale: '1000000000000000000',
      scaleSource: 'read_from_contract',
      blockNumber: '50500000',
      blockHash: HASH,
      evidenceHash: HASH,
      observedAt: '2026-08-27T13:59:00.000Z',
      lastCheckedAt: '2026-08-27T13:59:00.000Z',
      lastChangedAt: null,
      reads: 1,
      changes: 0,
      createdAt: '2026-08-27T13:59:00.000Z',
    },
    nowMs: Date.parse('2026-08-27T14:00:00.000Z'),
  });
  assert.equal(normalized.atomic, '1000000000000000000');
  assert.equal(
    effectivePriceV1('100000000', normalized.atomic!, normalized.decimals!),
    '10000000000',
  );
});

test('exact reference identity mismatch withholds basis', () => {
  const basis = evaluateMarketRealityBasisV1(
    input({
      reference: reference({
        status: 'unknown',
        session: 'unknown',
        marketSession: 'unknown',
        publicationMode: 'unknown',
        valueAtomic: null,
        decimals: null,
        referenceUpdatedAt: null,
        freshness: 'unknown',
        calendar: null,
        evidence: null,
        reasonCode: 'reference_identity_mismatch',
      }),
    }),
  );
  assert.equal(basis.reasonCode, 'reference_identity_mismatch');
  assert.equal(basis.premiumDiscountBps, null);
});

test('Backed cannot borrow Coinbase reference evidence', () => {
  assert.equal(
    evaluateMarketRealityBasisV1(input({ issuerId: 'backed' })).reasonCode,
    'unreviewed_issuer_reference',
  );
});

test('RPC/reference failure withholds basis', () => {
  assert.equal(
    evaluateMarketRealityBasisV1(
      input({
        reference: reference({
          status: 'unknown',
          session: 'unknown',
          marketSession: 'unknown',
          publicationMode: 'unknown',
          valueAtomic: null,
          decimals: null,
          referenceUpdatedAt: null,
          freshness: 'unknown',
          calendar: null,
          evidence: null,
          reasonCode: 'reference_read_failed',
        }),
      }),
    ).reasonCode,
    'reference_read_failed',
  );
});

test('stale reference withholds basis without weakening health semantics', () => {
  assert.equal(
    evaluateMarketRealityBasisV1(
      input({
        reference: reference({
          status: 'stale',
          session: 'stale',
          publicationMode: 'stale',
          freshness: 'stale',
          reasonCode: 'reviewed_reference_stale',
        }),
      }),
    ).reasonCode,
    'reference_stale',
  );
});

test('corporate-action hold withholds basis', () => {
  assert.equal(
    evaluateMarketRealityBasisV1(
      input({
        reference: reference({
          status: 'paused',
          session: 'corporate_action_hold',
          publicationMode: 'corporate_action_hold',
          freshness: 'stale',
          reasonCode: 'reviewed_registry_corporate_action_hold',
        }),
      }),
    ).reasonCode,
    'corporate_action_hold',
  );
});

test('expired router quote has no current basis', () => {
  assert.equal(
    evaluateMarketRealityBasisV1(input({ evaluatedAt: '2026-08-27T14:00:20.000Z' })).reasonCode,
    'expired_quote',
  );
});

test('no-route has no basis', () => {
  assert.equal(
    evaluateMarketRealityBasisV1(input({ marketStatus: 'no_route' })).reasonCode,
    'no_route',
  );
});

test('unsized SELL has no basis', () => {
  assert.equal(
    evaluateMarketRealityBasisV1(input({ marketStatus: 'unsized' })).reasonCode,
    'unsized_sell',
  );
});

test('reviewed held publication has distinct last_close_reference meaning', () => {
  const held = reference({
    session: 'reference_holding_last_close',
    marketSession: 'after_hours',
    publicationMode: 'holding_last_close',
    publicationPlacement: 'last_closed_session',
    observedAt: '2026-08-27T22:00:05.000Z',
    referenceUpdatedAt: '2026-08-27T19:59:30.000Z',
    reasonCode: 'reviewed_feed_holding_last_close',
  });
  const basis = evaluateMarketRealityBasisV1(
    input({
      quoteObservedAt: '2026-08-27T22:00:00.000Z',
      quoteExpiresAt: '2026-08-27T22:00:20.000Z',
      evaluatedAt: '2026-08-27T22:00:06.000Z',
      reference: held,
    }),
  );
  assert.equal(basis.kind, 'last_close_reference');
  assert.equal(basis.status, 'comparable');
});

test('weekend cannot infer last-close behavior from Coinbase issuer name', () => {
  const basis = evaluateMarketRealityBasisV1(
    input({
      quoteObservedAt: '2026-08-29T14:00:00.000Z',
      quoteExpiresAt: '2026-08-29T14:00:20.000Z',
      evaluatedAt: '2026-08-29T14:00:06.000Z',
      reference: reference({
        session: 'weekend',
        marketSession: 'weekend',
        publicationMode: 'unknown',
        publicationPlacement: 'after_last_close',
        observedAt: '2026-08-29T14:00:05.000Z',
        referenceUpdatedAt: '2026-08-28T19:59:30.000Z',
        calendar: {
          ...reference().calendar!,
          localDate: '2026-08-29',
          publicationSessionLocalDate: '2026-08-28',
        },
        reasonCode: 'calendar_semantics_missing',
      }),
    }),
  );
  assert.equal(basis.reasonCode, 'unsupported_semantics');
});

test('reference observation outside the exact quote window withholds basis', () => {
  assert.equal(
    evaluateMarketRealityBasisV1(
      input({ reference: reference({ observedAt: '2026-08-27T14:00:21.000Z' }) }),
    ).reasonCode,
    'reference_timing_outside_quote_window',
  );
});

test('the basis answers to the placement, and the classifier owns the timezone', () => {
  // v1 re-derived New York time here and refused any publication outside
  // 09:30-16:00. There are now two layers and one definition: the classifier
  // places the publication against the reviewed calendar, and this gate reads
  // the placement. The end-to-end pair is asserted below, against the real
  // classifier, so the two layers cannot drift apart silently.
  const placed = evaluateMarketRealityBasisV1(
    input({
      reference: reference({
        referenceUpdatedAt: '2026-08-27T12:00:00.000Z',
        publicationMode: 'live_reference',
        publicationPlacement: 'after_last_close',
      }),
    }),
  );
  assert.equal(placed.kind, 'off_session_reference');
});

test('zero supply stays visible but cannot become comparable', () => {
  assert.equal(
    evaluateMarketRealityBasisV1(input({ supplyState: 'zero_supply' })).reasonCode,
    'zero_supply',
  );
});

test('zero supply is the primary basis blocker even when the router read failed', () => {
  const basis = evaluateMarketRealityBasisV1(
    input({ supplyState: 'zero_supply', marketStatus: 'measurement_failed' }),
  );
  assert.equal(basis.reasonCode, 'zero_supply');
  assert.equal(basis.reason, 'Zero supply is outside the active market comparison.');
});

test('basis objects never contain simulation, approval, calldata or transaction fields', () => {
  const json = JSON.stringify(evaluateMarketRealityBasisV1(input()));
  for (const forbidden of ['simulation', 'approval', 'calldata', 'transaction']) {
    assert.equal(json.includes(forbidden), false);
  }
});

test('typed basis contract cannot mix withheld and comparable semantics', () => {
  assert.throws(() =>
    MarketRealityBasisDecisionV1Schema.parse({
      policy: 'exact_normalized_price_same_quote_window_reviewed_publication_v1',
      status: 'withheld',
      kind: 'current_reference',
      premiumDiscountBps: null,
      reasonCode: 'current_reference_comparable',
      reason: 'Contradictory state.',
    }),
  );
});

// ---------------------------------------------------------------------------
// The off-session basis. Measured 2026-09-16: these feeds publish overnight,
// so "outside the regular session" is not one state but two — a feed that has
// printed since the bell and a feed that has not — and they are not the same
// number.
// ---------------------------------------------------------------------------

/** After hours, and the feed has printed since the close. */
function offSessionReference() {
  return reference({
    session: 'after_hours',
    marketSession: 'after_hours',
    publicationMode: 'live_reference',
    publicationPlacement: 'after_last_close',
    observedAt: '2026-08-28T03:15:05.000Z',
    referenceUpdatedAt: '2026-08-28T03:04:11.000Z',
    calendar: { ...reference().calendar!, localDate: '2026-08-27' },
    reasonCode: 'reviewed_feed_publishing_off_session',
    reason: 'Published after the close.',
  });
}

function offSessionInput(overrides: Partial<Parameters<typeof evaluateMarketRealityBasisV1>[0]> = {}) {
  return input({
    quoteObservedAt: '2026-08-28T03:15:00.000Z',
    quoteExpiresAt: '2026-08-28T03:15:20.000Z',
    evaluatedAt: '2026-08-28T03:15:06.000Z',
    reference: offSessionReference(),
    ...overrides,
  });
}

test('a publication after the close is comparable, and is not called a last close', () => {
  const basis = evaluateMarketRealityBasisV1(offSessionInput());
  assert.equal(basis.status, 'comparable');
  assert.equal(basis.kind, 'off_session_reference');
  assert.equal(basis.reasonCode, 'off_session_reference_comparable');
  assert.equal(basis.premiumDiscountBps, '11');
});

test('every decision this build makes carries the v2 policy', () => {
  assert.equal(
    evaluateMarketRealityBasisV1(offSessionInput()).policy,
    'exact_normalized_price_same_quote_window_placed_publication_v2',
  );
  assert.equal(
    evaluateMarketRealityBasisV1(input({ supplyState: 'zero_supply' })).policy,
    'exact_normalized_price_same_quote_window_placed_publication_v2',
  );
});

test('a publication older than a whole closed session is withheld by name', () => {
  const basis = evaluateMarketRealityBasisV1(
    offSessionInput({
      reference: { ...offSessionReference(), publicationPlacement: 'before_last_close' },
    }),
  );
  assert.equal(basis.status, 'withheld');
  assert.equal(basis.reasonCode, 'reference_publication_precedes_last_close');
  assert.equal(basis.premiumDiscountBps, null);
});

test('an unplaced publication is withheld rather than guessed at', () => {
  const basis = evaluateMarketRealityBasisV1(
    offSessionInput({
      reference: { ...offSessionReference(), publicationPlacement: 'not_classified' },
    }),
  );
  assert.equal(basis.status, 'withheld');
  assert.equal(basis.reasonCode, 'reference_publication_outside_reviewed_session');
});

test('placement and publication mode must agree before a number is published', () => {
  // The feed printed after the close, but the mode says it is holding one.
  // Two answers to one question; neither gets to be the label.
  const basis = evaluateMarketRealityBasisV1(
    offSessionInput({
      reference: { ...offSessionReference(), publicationMode: 'holding_last_close' },
    }),
  );
  assert.equal(basis.reasonCode, 'unsupported_semantics');
});

test('an in-session placement during regular hours is still the current reference', () => {
  const basis = evaluateMarketRealityBasisV1(input());
  assert.equal(basis.kind, 'current_reference');
  assert.equal(basis.reasonCode, 'current_reference_comparable');
});

test('the stored contract refuses a comparable basis whose kind and reason disagree', () => {
  assert.throws(() =>
    MarketRealityBasisDecisionV1Schema.parse({
      policy: 'exact_normalized_price_same_quote_window_placed_publication_v2',
      status: 'comparable',
      kind: 'off_session_reference',
      premiumDiscountBps: '11',
      reasonCode: 'last_close_reference_comparable',
      reason: 'Mislabelled.',
    }),
  );
});

test('a decision stored under v1 still reads back, keeping the policy it was made under', () => {
  const stored = MarketRealityBasisDecisionV1Schema.parse({
    policy: 'exact_normalized_price_same_quote_window_reviewed_publication_v1',
    status: 'comparable',
    kind: 'last_close_reference',
    premiumDiscountBps: '-11',
    reasonCode: 'last_close_reference_comparable',
    reason: 'Decided before the feeds were measured.',
  });
  assert.equal(stored.policy, 'exact_normalized_price_same_quote_window_reviewed_publication_v1');
});

// ---------------------------------------------------------------------------
// End to end: the real classifier feeding the real gate. The two layers meet
// here so a change to one cannot quietly stop matching the other.
// ---------------------------------------------------------------------------

function classified(input: { now: string; referenceUpdatedAt: string }) {
  return classifyMarketRealityReferenceV1({
    now: new Date(input.now),
    configuration: {
      chainId: 8453,
      tokenAddress: TOKEN,
      issuerId: 'coinbase',
      referenceAddress: FEED,
      referenceSource: 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base',
      calendar: REVIEWED_US_EQUITIES_CALENDAR_2026_V1,
      outsideRegularHours: 'publishes',
    },
    observation: {
      chainId: 8453,
      tokenAddress: TOKEN,
      issuerId: 'coinbase',
      referenceAddress: FEED,
      status: 'fresh',
      valueAtomic: '21130000000',
      decimals: 8,
      observedAt: input.now,
      referenceUpdatedAt: input.referenceUpdatedAt,
      evidence: {
        kind: 'chainlink_feed',
        source: 'chainlink_v3_proxy_total_return',
        blockNumber: '50500000',
        blockHash: HASH,
        targetAddress: FEED,
        evidenceHash: HASH,
      },
    },
  });
}

function basisAt(input: { now: string; referenceUpdatedAt: string }) {
  const quoteObservedAt = new Date(Date.parse(input.now) - 5_000).toISOString();
  return evaluateMarketRealityBasisV1({
    issuerId: 'coinbase',
    marketStatus: 'quoted',
    quoteObservedAt,
    quoteExpiresAt: new Date(Date.parse(quoteObservedAt) + 20_000).toISOString(),
    evaluatedAt: input.now,
    normalizedExposureAtomic: '1000000000000000000',
    effectivePriceAtomic: '21154000000',
    effectivePriceDecimals: 8,
    supplyState: 'positive_supply',
    reference: classified(input),
  });
}

test('03:04 on a Thursday: the feed printed after the close, and the basis says so', () => {
  // Measured shape: METAc printed 03:04 ET on 2026-09-16 with a value 0.5%
  // away from the one it carried at 14:19 the previous afternoon.
  const basis = basisAt({
    now: '2026-08-28T07:15:00.000Z',
    referenceUpdatedAt: '2026-08-28T07:04:11.000Z',
  });
  assert.equal(basis.status, 'comparable');
  assert.equal(basis.kind, 'off_session_reference');
});

test('03:04 on a Thursday, feed silent since the bell: the same clock, a last close', () => {
  const basis = basisAt({
    now: '2026-08-28T07:15:00.000Z',
    referenceUpdatedAt: '2026-08-27T19:55:25.000Z',
  });
  assert.equal(basis.status, 'comparable');
  assert.equal(basis.kind, 'last_close_reference');
});

test('mid-session, printed this morning: the current reference', () => {
  const basis = basisAt({
    now: '2026-08-27T15:00:00.000Z',
    referenceUpdatedAt: '2026-08-27T14:07:13.000Z',
  });
  assert.equal(basis.kind, 'current_reference');
});

test('mid-session, nothing printed since last night: named off-session, not current', () => {
  // The market is open and the feed has not answered it yet. v1 withheld here
  // and v2 publishes a number the reader can place.
  const basis = basisAt({
    now: '2026-08-27T13:40:00.000Z',
    referenceUpdatedAt: '2026-08-27T03:57:31.000Z',
  });
  assert.equal(basis.kind, 'off_session_reference');
});
