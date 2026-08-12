import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

import {
  B20ExitCapacityLeadersCard,
  B20ExitCoverageCard,
  B20MeasuredMoversCard,
  MARKET_RAIL_DISCLAIMER_V1,
  defaultRailLeadersV1,
  measuredAgoLabelV1,
  signedBpsLabelV1,
  type B20MarketRailsModelV1,
} from '../src/console/B20MarketRails';

void React;

// ---------------------------------------------------------------------------
// T73-UI — the rail renders the server's numbers. The ranking, exclusions and
// arithmetic were decided server-side and are asserted here to be copied
// rather than recomputed. The view only labels profile status.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-05T12:00:00.000Z');

function leader(address: string, overrides: Record<string, unknown> = {}) {
  return {
    tokenAddress: address,
    symbol: `S${address.slice(2, 4)}`,
    name: 'token',
    decimals: 18,
    largestPassingSizeAtomic: '4000000000000000000000',
    capacityCoverageBps: 10_000,
    firstFailingSizeAtomic: '8000000000000000000000',
    toleranceBps: 300,
    optimisticRoundTripBps: 130,
    roundTripReferenceBps: 300,
    profileStatus: 'within_reference' as const,
    state: 'provisional' as const,
    reasonCode: 'quoted_pre_entry',
    measuredAt: '2026-08-05T11:50:00.000Z',
    observationBlockNumber: '49531075',
    freshness: 'fresh' as const,
    ...overrides,
  };
}

function mover(address: string, changeBps: number) {
  return {
    tokenAddress: address,
    symbol: `S${address.slice(2, 4)}`,
    name: 'token',
    decimals: 18,
    changeBps,
    label: '24h change from Miorail measured quotes' as const,
    entryOutputThenAtomic: '4000000000000000000000',
    entryOutputNowAtomic: '3200000000000000000000',
    referencePositionAtomic: '100000000',
    intervalSeconds: 86_400,
    baselineMeasuredAt: '2026-08-04T11:50:00.000Z',
    measuredAt: '2026-08-05T11:50:00.000Z',
    largestPassingSizeAtomic: '4000000000000000000000',
    optimisticRoundTripBps: 130,
    roundTripReferenceBps: 300,
    profileStatus: 'within_reference' as const,
    state: 'provisional' as const,
    reasonCode: 'quoted_pre_entry',
  };
}

function model(overrides: Partial<B20MarketRailsModelV1> = {}): B20MarketRailsModelV1 {
  return {
    loading: false,
    unavailableReason: null,
    leaders: [],
    movers: [],
    collectingHistory: false,
    toleranceBps: 300,
    moveLabel: '24h change from Miorail measured quotes',
    moveNote: 'Computed from two Miorail quotes about 24 hours apart.',
    now: NOW,
    expanded: false,
    onToggleExpanded: () => undefined,
    ...overrides,
  };
}

const renderLeaders = (overrides: Partial<B20MarketRailsModelV1> = {}) =>
  renderToStaticMarkup(<B20ExitCapacityLeadersCard {...model(overrides)} />);
const renderMovers = (overrides: Partial<B20MarketRailsModelV1> = {}) =>
  renderToStaticMarkup(<B20MeasuredMoversCard {...model(overrides)} />);

const ADDRESSES = Array.from({ length: 12 }, (_, index) => `0x${String(index + 10).repeat(20)}`.slice(0, 42));

describe('§4 — measured profile misses remain visible and are said plainly', () => {
  test('a round-trip reference miss is kept in the leaders list', () => {
    const result = defaultRailLeadersV1([
      leader(ADDRESSES[0]!),
      leader(ADDRESSES[1]!, {
        state: 'rejected',
        reasonCode: 'round_trip_above_tolerance',
        optimisticRoundTripBps: 436,
        profileStatus: 'outside_round_trip_reference',
      }),
    ]);
    assert.equal(result.shown.length, 2);
    assert.equal(result.outsideReference, 1);
  });

  test('the card shows the measurement in amber and names the reference', () => {
    const markup = renderLeaders({
      leaders: [
        leader(ADDRESSES[0]!),
        leader(ADDRESSES[1]!, {
          state: 'rejected',
          reasonCode: 'round_trip_above_tolerance',
          optimisticRoundTripBps: 436,
          profileStatus: 'outside_round_trip_reference',
        }),
      ],
    });
    assert.match(markup, /4\.36% round trip · outside 3% reference/);
    assert.match(markup, /class="v mono warn"/);
    assert.match(markup, /1 measured profile exceeds the configured round-trip reference and remains visible in amber/);
  });

  test('nothing is said when every profile is within reference', () => {
    assert.ok(!/remain.*visible in amber/.test(renderLeaders({ leaders: [leader(ADDRESSES[0]!)] })));
  });

  test('the client labels but never re-ranks', () => {
    const source = readFileSync(new URL('../src/console/B20MarketRails.tsx', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // §2 — no ordering, no comparison of measured magnitudes, no arithmetic on
    // the server's numbers beyond formatting.
    assert.ok(!/\.sort\(/.test(code), 'the rail sorts the server’s ranking');
    assert.ok(!/BigInt\(/.test(code), 'the rail does arithmetic on measured amounts');
  });
});

describe('§3 — top 5 in the rail, top 10 behind a control', () => {
  const many = ADDRESSES.map((address, index) =>
    leader(address, { largestPassingSizeAtomic: String(9_000 - index) }),
  );

  test('five by default', () => {
    const markup = renderLeaders({ leaders: many });
    assert.equal((markup.match(/qrow/g) ?? []).length, 5);
    assert.match(markup, /View top 10/);
  });

  test('ten when expanded, and a way back', () => {
    const markup = renderLeaders({ leaders: many, expanded: true });
    assert.equal((markup.match(/qrow/g) ?? []).length, 10);
    assert.match(markup, /Show top 5/);
  });

  test('no control at all when there is nothing more to show', () => {
    const markup = renderLeaders({ leaders: many.slice(0, 3) });
    assert.ok(!/View top/.test(markup));
  });
});

describe('§3 — loading, empty and collecting-history are distinct states', () => {
  test('loading says it is reading, not that there is nothing', () => {
    assert.match(renderLeaders({ loading: true }), /Reading measured exits/);
    assert.match(renderMovers({ loading: true }), /Reading measured quotes/);
  });

  test('an unavailable rail says so instead of showing an empty list', () => {
    const markup = renderMovers({ unavailableReason: 'Discover is off on this server.' });
    assert.match(markup, /Discover is off on this server/);
    assert.ok(!/No token has two comparable/.test(markup));
  });

  test('collecting history is shown only when the server says so', () => {
    const collecting = renderMovers({ collectingHistory: true });
    assert.match(collecting, /Collecting 24h history/);
    assert.match(collecting, /about 24 hours apart/);
    // The client never infers it from an empty list.
    const empty = renderMovers({ collectingHistory: false });
    assert.ok(!/Collecting 24h history/.test(empty));
    assert.match(empty, /No token has two comparable measurements/);
  });

  test('an empty leaders list is about what was measured, not about the tokens', () => {
    assert.match(renderLeaders(), /not about what can be sold/);
  });
});

describe('§6 — measured views, stated as such', () => {
  test('every populated card carries the disclaimer', () => {
    assert.match(renderLeaders({ leaders: [leader(ADDRESSES[0]!)] }), new RegExp(MARKET_RAIL_DISCLAIMER_V1));
    assert.match(renderMovers({ movers: [mover(ADDRESSES[0]!, 2500)] }), new RegExp(MARKET_RAIL_DISCLAIMER_V1));
  });

  test('the movers card prints the server label verbatim, not "24h"', () => {
    // Shortening it is exactly the paraphrase this metric must not suffer.
    const markup = renderMovers({ movers: [mover(ADDRESSES[0]!, 2500)] });
    assert.match(markup, /24h change from Miorail measured quotes/);
    assert.match(markup, /Computed from two Miorail quotes/);
  });

  test('capacity renders as a bound, never a bare figure', () => {
    const markup = renderLeaders({ leaders: [leader(ADDRESSES[0]!)] });
    assert.match(markup, /≥ 4000 S/);
    assert.match(markup, /100% of reference entry/);
    assert.match(markup, /Nothing between the largest passing and first failing size/);
  });

  test('a signed move keeps its sign', () => {
    assert.equal(signedBpsLabelV1(2500), '+25%');
    assert.equal(signedBpsLabelV1(-2500), '-25%');
    assert.equal(signedBpsLabelV1(0), '0%');
  });

  test('measurement age is whole units, never seconds', () => {
    assert.equal(measuredAgoLabelV1('2026-08-05T11:50:00.000Z', NOW), 'measured 10 min ago');
    assert.equal(measuredAgoLabelV1('2026-08-05T11:59:40.000Z', NOW), 'measured just now');
    assert.equal(measuredAgoLabelV1('2026-08-04T12:00:00.000Z', NOW), 'measured 1 d ago');
  });

  test('no card says safe, recommended, best or predicted', () => {
    const markup = [
      renderLeaders({ leaders: [leader(ADDRESSES[0]!)] }),
      renderMovers({ movers: [mover(ADDRESSES[0]!, 2500)] }),
    ]
      .join(' ')
      // The disclaimer legitimately contains "recommendation" — it is the
      // sentence denying one. Scan everything except it.
      .replaceAll(MARKET_RAIL_DISCLAIMER_V1, '');
    for (const banned of ['safe', 'recommend', 'best', 'predict', 'should buy', 'opportunity to']) {
      assert.ok(!new RegExp(banned, 'i').test(markup), `a rail says "${banned}"`);
    }
  });
});

describe('§5 — Your Exit Coverage', () => {
  const observation = {
    tokenAddress: ADDRESSES[0]!,
    state: 'provisional' as const,
    reasonCode: 'quoted_pre_entry',
    referenceQuoteAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    referencePositionAtomic: '100000000',
    profileIdentity: '',
    measurementVersion: 'b20-exit-check/v1',
    entryOutputAtomic: null,
    optimisticRoundTripBps: null,
    maxRoundTripBps: 300,
    largestPassingSizeAtomic: '4000000000000000000000',
    firstFailingSizeAtomic: '8000000000000000000000',
    capacityToleranceBps: 300,
    capacityStable: true,
    exitRouteFound: true,
    transfersPaused: false,
    transferPolicyState: 'open' as const,
    controlsComplete: true,
    controlsBlockNumber: '49531075',
    observationBlockNumber: '49531075',
    measuredAt: '2026-08-05T11:50:00.000Z',
    staleAfter: '2026-08-05T12:20:00.000Z',
  };

  const render = (positionAtomic: string, overrides: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <B20ExitCoverageCard
        tokenAddress={ADDRESSES[0]!}
        symbol="DINo1"
        decimals={18}
        positionAtomic={positionAtomic}
        observation={{ ...observation, ...overrides }}
        now={NOW}
      />,
    );

  test('shows position, measured exit, ratio and freshness', () => {
    const markup = render('2000000000000000000000');
    assert.match(markup, /Your position/);
    assert.match(markup, /2000 DINo1/);
    assert.match(markup, /≥ 4000 DINo1/);
    assert.match(markup, /100%/);
    assert.match(markup, /measured 10 min ago/);
  });

  test('a position larger than the measured exit says what is unknown', () => {
    const markup = render('8000000000000000000000');
    assert.match(markup, /50%/);
    assert.match(markup, /unknown rather than impossible/);
  });

  test('an unmeasured exit is not zero coverage', () => {
    // A 0% would read as "you cannot sell this" — a claim nothing measured.
    const markup = renderToStaticMarkup(
      <B20ExitCoverageCard
        tokenAddress={ADDRESSES[0]!}
        symbol="DINo1"
        decimals={18}
        positionAtomic="1000"
        observation={null}
        now={NOW}
      />,
    );
    assert.match(markup, /not measured/);
    assert.ok(!/>0%</.test(markup));
  });

  test('a paused transfer is surfaced as a warning', () => {
    assert.match(render('1000', { transfersPaused: true }), /cannot be sold while/);
  });

  test('a stale measurement keeps its numbers and says it is past its window', () => {
    const markup = render('2000000000000000000000', { staleAfter: '2026-08-05T11:00:00.000Z' });
    assert.match(markup, /past its window/);
    assert.match(markup, /≥ 4000 DINo1/);
  });
});
