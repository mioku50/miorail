import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MarketRealityBasisDecisionV1Schema,
  type MarketRealityReferenceStateV1,
} from '@mioagent/route-storage';

import { evaluateMarketRealityBasisV1 } from '../src/basis.js';
import { effectivePriceV1, normalizedExposureV1 } from '../src/engine.js';

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

test('publication outside the reviewed regular session withholds basis', () => {
  assert.equal(
    evaluateMarketRealityBasisV1(
      input({ reference: reference({ referenceUpdatedAt: '2026-08-27T12:00:00.000Z' }) }),
    ).reasonCode,
    'reference_publication_outside_reviewed_session',
  );
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
