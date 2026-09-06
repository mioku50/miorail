import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarketRealityScreen } from '../src/console/MarketRealityScreen';
import {
  comparableMarketHistoryViewV1,
  marketExitCostBpsV1,
  type MarketRealityHistoryWireV1,
} from '../src/console/marketRealityHistoryView';
import {
  MARKET_REALITY_ROUND_TRIP_BOUND_BPS_V1,
  MARKET_REALITY_ROUND_TRIP_SEVERE_BPS_V1,
  accessNoticesV1,
  clocksV1,
  exitCostViewV1,
  routedThroughV1,
  collapseLadderRungsV1,
  expiresInLabelV1,
  partitionByIssuerRoleV1,
  partitionChoicesBySupplyV1,
  poolSpotViewV1,
  splitEstablishedFactsV1,
  stockScopeViewV1,
  transferGateViewV1,
  utilityAnswerV1,
  useSectionsV1,
  sourceLabelV1,
  stockFiltersV1,
  stocksHeadlineV1,
  MARKET_REALITY_SIZES_V1,
  marketRealityViewV1,
  quoteAgeLabelV1,
  representationOutcomeV1,
  underlyingChoicesV1,
  underlyingCountersV1,
  type MarketRealityRepresentationWireV1,
  type MarketRealityWireV1,
} from '../src/console/marketRealityView';

const NOW = '2026-08-26T20:34:19.000Z';
const COINBASE_NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const BACKED_NVDA = '0xa34c5e0abe843e10461e2c9586ea03e55dbcc495';
const BACKED_WRAPPER = '0x7e8101a1c322d394b3961498c7d40d2dfa94c392';

function representation(
  over: Partial<MarketRealityRepresentationWireV1> = {},
): MarketRealityRepresentationWireV1 {
  return {
    tokenAddress: COINBASE_NVDA,
    issuerId: 'coinbase',
    issuerInstrumentKey: `coinbase:b20_address:${COINBASE_NVDA}`,
    representationKind: 'b20_asset',
    supply: {
      state: 'positive_supply',
      totalSupplyAtomic: '1000000000000000000',
      decimals: 18,
      blockNumber: '50000000',
      blockHash: `0x${'11'.repeat(32)}`,
      observedAt: NOW,
      evidenceHash: `0x${'12'.repeat(32)}`,
      readOutcome: 'success',
      fresh: true,
      reason: null,
    },
    status: 'not_measured',
    routePolicyKey: `0x${'b5'.repeat(32)}`,
    exactTestedTokenAtomic: null,
    normalizedExposureAtomic: null,
    normalizedExposureDecimals: null,
    normalization: 'not_established',
    returnedCashAtomic: null,
    effectivePriceAtomic: null,
    effectivePriceDecimals: null,
    premiumDiscountBps: null,
    reference: {
      status: 'unknown',
      session: 'unknown',
      marketSession: 'unknown',
      publicationMode: 'unknown',
      valueAtomic: null,
      decimals: null,
      comparable: false,
      reason: 'No reviewed comparable reference/session adapter answered.',
    },
    basis: {
      status: 'withheld',
      kind: 'withheld',
      premiumDiscountBps: null,
      reason: 'No reviewed reference basis was established.',
    },
    sources: [],
    observedAt: null,
    expiresAt: null,
    liveness: 'never_measured',
    lastObservation: null,
    ...over,
  };
}

/** The observation the engine emits beside a lapsed row: real, and closed. */
const LAPSED_OBSERVATION = {
  source: 'kyberswap',
  status: 'quoted' as const,
  errorCode: null,
  observedAt: '2026-08-26T19:55:03.000Z',
  expiresAt: '2026-08-26T19:55:23.000Z',
  returnedCashAtomic: '99952618',
  open: false,
};

/**
 * The same observation with its window still open.
 *
 * `open: true` over a window that closed thirty-nine minutes ago is exactly the
 * production bug this file now guards, so a fixture that wants a live quote has
 * to carry a live expiry — not just the flag.
 */
const OPEN_OBSERVATION = {
  ...LAPSED_OBSERVATION,
  observedAt: NOW,
  expiresAt: '2026-08-26T20:34:39.000Z',
  open: true,
};

/** The measured production shape: a real quote whose 20-second window closed. */
const LAPSED_SOURCE = {
  source: 'kyberswap',
  status: 'not_measured' as const,
  errorCode: null,
  quoteEvidence: {
    source: 'kyberswap',
    direction: 'sell' as const,
    inputAtomic: '47673533',
    outputAtomic: '99952618',
    observedAt: '2026-08-26T19:55:03.000Z',
    expiresAt: '2026-08-26T19:55:23.000Z',
    evidenceHash: `0x${'94'.repeat(32)}`,
    blockNumber: null,
  },
};

function wire(over: Partial<MarketRealityWireV1> = {}): MarketRealityWireV1 {
  return {
    question: {
      underlyingKey: 'security:isin:US67066G1040',
      direction: 'sell',
      requestedCashAtomic: '100000000',
      cashDecimals: 6,
      destination: 'USDC',
    },
    universe: {
      reviewedRepresentationCount: 3,
      positiveSupplyRepresentationCount: 3,
      zeroSupplyRepresentationCount: 0,
      unresolvedSupplyRepresentationCount: 0,
    },
    marketOutcomeCoverage: {
      eligibleRepresentationCount: 3,
      establishedOutcomeCount: 0,
      status: 'incomplete',
      reason: 'Every reviewed representation must have fresh exact-size evidence.',
    },
    numericComparisonCoverage: {
      eligibleRepresentationCount: 3,
      pricedRepresentationCount: 0,
      status: 'incomplete',
      reason: 'Numeric comparison coverage is incomplete.',
    },
    ranking: {
      status: 'withheld',
      orderedTokenAddresses: [],
      reason: 'Coverage comparability did not pass; no BEST representation is emitted.',
    },
    representations: [
      representation({
        sources: [LAPSED_SOURCE],
        liveness: 'history_only',
        lastObservation: LAPSED_OBSERVATION,
      }),
    ],
    assembledAt: NOW,
    ...over,
  };
}

const ROUTE_POLICY = `0x${'b5'.repeat(32)}`;

function openSellWireV1(returnedCashAtomic = '9958200000'): MarketRealityWireV1 {
  return wire({
    question: {
      underlyingKey: 'security:isin:US67066G1040',
      direction: 'sell',
      requestedCashAtomic: '10000000000',
      cashDecimals: 6,
      destination: 'USDC',
    },
    representations: [
      representation({
        status: 'full',
        routePolicyKey: ROUTE_POLICY,
        exactTestedTokenAtomic: '50000000000000000000',
        normalizedExposureAtomic: '50000000000000000000',
        normalizedExposureDecimals: 18,
        normalization: 'fresh_ratio_applied',
        returnedCashAtomic,
        effectivePriceAtomic: '19916400000',
        effectivePriceDecimals: 8,
        premiumDiscountBps: '11',
        basis: {
          status: 'comparable',
          kind: 'current_reference',
          premiumDiscountBps: '11',
          reason: 'Same-window reviewed reference.',
        },
        sources: [
          {
            source: 'kyberswap',
            status: 'quoted',
            errorCode: null,
            quoteEvidence: {
              source: 'kyberswap',
              direction: 'sell',
              inputAtomic: '50000000000000000000',
              outputAtomic: returnedCashAtomic,
              observedAt: NOW,
              expiresAt: '2026-08-26T20:35:00.000Z',
              evidenceHash: `0x${'95'.repeat(32)}`,
              blockNumber: null,
            },
          },
        ],
        liveness: 'live',
        observedAt: NOW,
        expiresAt: '2026-08-26T20:35:00.000Z',
        lastObservation: {
          ...LAPSED_OBSERVATION,
          observedAt: NOW,
          expiresAt: '2026-08-26T20:35:00.000Z',
          returnedCashAtomic,
          open: true,
        },
      }),
    ],
  });
}

function historyPointV1(
  over: Partial<MarketRealityHistoryWireV1['representations'][number]['points'][number]> = {},
): MarketRealityHistoryWireV1['representations'][number]['points'][number] {
  const observedAt = over.observedAt ?? '2026-08-26T19:30:00.000Z';
  return {
    observedAt,
    status: 'quoted',
    source: 'kyberswap',
    returnedCashAtomic: '9973400000',
    testedTokenAtomic: '50000000000000000000',
    errorCode: null,
    approvedSources: ['kyberswap'],
    marketReality: {
      tokenAddress: COINBASE_NVDA,
      direction: 'sell',
      requestedCashAtomic: '10000000000',
      destination: 'USDC',
      source: 'kyberswap',
      approvedSources: ['kyberswap'],
      routePolicyKey: ROUTE_POLICY,
      marketStatus: 'quoted',
      marketObservedAt: observedAt,
      effectivePriceAtomic: '19946800000',
      effectivePriceDecimals: 8,
      basis: {
        status: 'comparable',
        premiumDiscountBps: '-4',
        reason: 'Same-window reviewed reference.',
      },
    },
    ...over,
  };
}

function historyWireV1(
  points: MarketRealityHistoryWireV1['representations'][number]['points'],
): MarketRealityHistoryWireV1 {
  return {
    underlyingKey: 'security:isin:US67066G1040',
    direction: 'sell',
    requestedCashAtomic: '10000000000',
    destination: 'USDC',
    window: '7d',
    since: '2026-08-19T20:34:19.000Z',
    interpolated: false,
    representations: [
      {
        tokenAddress: COINBASE_NVDA,
        issuerId: 'coinbase',
        representationKind: 'b20_asset',
        points,
        pointCount: points.length,
        quotedCount: points.filter((point) => point.status === 'quoted').length,
        firstObservedAt: points[0]?.observedAt ?? null,
        lastObservedAt: points[points.length - 1]?.observedAt ?? null,
      },
    ],
    assembledAt: NOW,
  };
}

describe('Phase 12.1 comparable market history', () => {
  test('SELL history derives cash-back and exit-cost changes with exact integer math', () => {
    assert.equal(marketExitCostBpsV1('10000000000', '9973400000'), '27');
    assert.equal(marketExitCostBpsV1('10000000000', '9958200000'), '42');

    const view = comparableMarketHistoryViewV1({
      wire: openSellWireV1(),
      history: historyWireV1([historyPointV1()]),
      period: '1h',
      now: NOW,
    });
    const row = view?.representations[0];
    assert.equal(row?.state, 'quoted');
    assert.deepEqual(row?.metrics, [
      { label: 'Cash back', value: '$9,973.40', note: null },
      { label: 'Exit cost', value: '0.27%', note: '27 bps' },
    ]);
    assert.deepEqual(row?.changesToNow, [
      {
        label: 'Cash back',
        value: '$9,973.40 → $9,958.20',
        note: '−$15.20',
      },
      {
        label: 'Exit cost',
        value: '0.27% → 0.42%',
        note: '+15 bps',
      },
    ]);
  });

  test('a provider failure remains a gap and cannot replace a nearby market observation', () => {
    const failedAt = '2026-08-26T19:34:00.000Z';
    const failed = historyPointV1({
      observedAt: failedAt,
      status: 'measurement_failed',
      returnedCashAtomic: null,
      testedTokenAtomic: null,
      errorCode: 'provider_http_error',
      marketReality: {
        ...historyPointV1().marketReality!,
        marketStatus: 'measurement_failed',
        marketObservedAt: failedAt,
        effectivePriceAtomic: null,
        effectivePriceDecimals: null,
      },
    });
    const view = comparableMarketHistoryViewV1({
      wire: openSellWireV1(),
      history: historyWireV1([historyPointV1(), failed]),
      period: '1h',
      now: NOW,
    });
    assert.equal(view?.representations[0]?.observedAt, '2026-08-26T19:30:00.000Z');
    assert.equal(view?.representations[0]?.state, 'quoted');

    const onlyFailure = comparableMarketHistoryViewV1({
      wire: openSellWireV1(),
      history: historyWireV1([failed]),
      period: '1h',
      now: NOW,
    });
    assert.equal(onlyFailure?.representations[0]?.state, 'no_comparable_observation');
    assert.doesNotMatch(onlyFailure?.representations[0]?.summary ?? '', /unavailable|no route/i);
  });

  test('old evidence, a different route policy and an observation outside the target stay gaps', () => {
    const cases = [
      historyPointV1({ marketReality: null }),
      historyPointV1({
        marketReality: {
          ...historyPointV1().marketReality!,
          routePolicyKey: `0x${'ee'.repeat(32)}`,
        },
      }),
      historyPointV1({
        observedAt: '2026-08-26T18:40:00.000Z',
        marketReality: {
          ...historyPointV1().marketReality!,
          marketObservedAt: '2026-08-26T18:40:00.000Z',
        },
      }),
    ];
    for (const point of cases) {
      const view = comparableMarketHistoryViewV1({
        wire: openSellWireV1(),
        history: historyWireV1([point]),
        period: '1h',
        now: NOW,
      });
      assert.equal(view?.representations[0]?.state, 'no_comparable_observation');
    }
  });

  test('a successful scoped no-route can describe an outcome change', () => {
    const noRoute = historyPointV1({
      status: 'no_route',
      returnedCashAtomic: null,
      errorCode: 'provider_no_route',
      marketReality: {
        ...historyPointV1().marketReality!,
        marketStatus: 'no_route',
        effectivePriceAtomic: null,
        effectivePriceDecimals: null,
      },
    });
    const view = comparableMarketHistoryViewV1({
      wire: openSellWireV1(),
      history: historyWireV1([noRoute]),
      period: '1h',
      now: NOW,
    });
    assert.equal(view?.representations[0]?.state, 'no_route');
    assert.deepEqual(view?.representations[0]?.changesToNow, [
      { label: 'Outcome', value: 'No reviewed route → Route priced', note: null },
    ]);
  });

  test('without a fresh Now observation numeric change is withheld', () => {
    const view = comparableMarketHistoryViewV1({
      wire: wire({
        question: openSellWireV1().question,
        representations: [representation({ routePolicyKey: ROUTE_POLICY })],
      }),
      history: historyWireV1([historyPointV1()]),
      period: '1h',
      now: NOW,
    });
    assert.equal(view?.representations[0]?.state, 'quoted');
    assert.deepEqual(view?.representations[0]?.changesToNow, []);
    assert.match(view?.representations[0]?.changeNote ?? '', /No fresh comparable Now/);
  });

  test('a changed winning route source withholds numeric change instead of mixing routes', () => {
    const current = openSellWireV1();
    const changedSource = wire({
      ...current,
      representations: [
        representation({
          ...current.representations[0]!,
          sources: [
            {
              ...current.representations[0]!.sources[0]!,
              source: 'another-router',
              quoteEvidence: {
                ...current.representations[0]!.sources[0]!.quoteEvidence!,
                source: 'another-router',
              },
            },
          ],
        }),
      ],
    });
    const view = comparableMarketHistoryViewV1({
      wire: changedSource,
      history: historyWireV1([historyPointV1()]),
      period: '1h',
      now: NOW,
    });
    assert.deepEqual(view?.representations[0]?.changesToNow, []);
    assert.match(view?.representations[0]?.changeNote ?? '', /route source changed/);
  });

  test('the history screen is neutral, exact and does not emit ranking', () => {
    const current = openSellWireV1();
    const currentView = marketRealityViewV1({ wire: current, choice: null, now: NOW });
    const historyView = comparableMarketHistoryViewV1({
      wire: current,
      history: historyWireV1([historyPointV1()]),
      period: '1h',
      now: NOW,
    });
    assert.ok(currentView && historyView);
    const markup = renderToStaticMarkup(
      React.createElement(MarketRealityScreen, {
        model: {
          choices: [],
          choicesLoading: false,
          choicesError: null,
          counters: [],
          selectedKey: current.question.underlyingKey,
          direction: 'sell',
          requestedCashAtomic: current.question.requestedCashAtomic,
          surface: 'market',
          historyPeriod: '1h',
          view: currentView,
          viewLoading: false,
          viewError: null,
          history: historyView,
          historyLoading: false,
          historyError: null,
          measuring: false,
          measurementNote: null,
          measurementError: null,
          watchedTokenAddresses: [],
          watchingTokenAddress: null,
          removingWatchTokenAddress: null,
          watchError: null,
          actions: {
            onUnderlying: () => undefined,
            onDirection: () => undefined,
            onSize: () => undefined,
            onSurface: () => undefined,
            onHistoryPeriod: () => undefined,
          },
        },
      }),
    );
    assert.match(markup, /Comparable market history/);
    assert.match(markup, /NOW|Now/);
    assert.match(markup, /1H/);
    assert.match(markup, /Cash back/);
    assert.match(markup, /Change to now/);
    assert.match(markup, /same Base address|Same Base address/);
    assert.doesNotMatch(markup, /data-tone="good"|cr-v mono good|BEST/);
  });
});

describe('the five outcomes stay apart', () => {
  test('a quote whose window closed is lapsed, not unmeasured', () => {
    // The state EVERY row is in on the live product: a router quote is good
    // for about twenty seconds and the worker runs on a much longer timer. The
    // engine reports `not_measured` for it, correctly — but a reader told
    // "not measured" concludes nobody ever looked.
    const outcome = representationOutcomeV1(
      representation({
        sources: [LAPSED_SOURCE],
        liveness: 'history_only',
        lastObservation: LAPSED_OBSERVATION,
      }),
      NOW,
    );
    assert.equal(outcome, 'lapsed');
  });

  test('a row with no evidence at all is never measured', () => {
    assert.equal(representationOutcomeV1(representation({ sources: [] }), NOW), 'never_measured');
  });

  test('a scoped router-policy no-route is a market outcome, not our transport failure', () => {
    const outcome = representationOutcomeV1(
      representation({
        status: 'unavailable',
        liveness: 'live',
        lastObservation: {
          ...LAPSED_OBSERVATION,
          status: 'no_route',
          returnedCashAtomic: null,
          open: true,
        },
        sources: [
          {
            source: 'kyberswap',
            status: 'no_route',
            errorCode: 'provider_no_route',
            quoteEvidence: null,
          },
        ],
      }),
      NOW,
    );
    assert.equal(outcome, 'no_route');
  });

  test('no-route copy names the reviewed router-policy scope and never all approved venues', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            status: 'unavailable',
            liveness: 'live',
            lastObservation: {
              ...LAPSED_OBSERVATION,
              status: 'no_route',
              returnedCashAtomic: null,
              open: true,
            },
            sources: [
              {
                source: 'kyberswap',
                status: 'no_route',
                errorCode: 'provider_no_route',
                quoteEvidence: null,
              },
            ],
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    // The scope is still stated — it is what keeps this from being an
    // asset-level claim — but as WHERE we looked, not as the name of an
    // internal rule set.
    assert.match(
      view?.representations[0]?.outcomeBody ?? '',
      /Checked across Miorail's reviewed route sources/i,
    );
    assert.doesNotMatch(view?.representations[0]?.outcomeBody ?? '', /No approved venue/);
  });

  test('zero supply is primary; unsupported-router diagnostics never become the market verdict', () => {
    const row = representation({
      supply: {
        ...representation().supply,
        state: 'zero_supply',
        totalSupplyAtomic: '0',
      },
      liveness: 'live',
      sources: [
        {
          source: 'kyberswap',
          status: 'measurement_failed',
          errorCode: 'provider_unsupported_token',
          quoteEvidence: null,
        },
      ],
    });
    assert.equal(representationOutcomeV1(row, NOW), 'zero_supply');
    const view = marketRealityViewV1({
      wire: wire({ representations: [row] }),
      choice: null,
      now: NOW,
    });
    assert.equal(view?.representations[0]?.attribution, 'onchain read');
    assert.match(view?.representations[0]?.outcomeBody ?? '', /nothing to buy or sell at this address/);
    assert.doesNotMatch(view?.representations[0]?.outcomeBody ?? '', /no market/i);
  });

  test('a cash rung nobody could size is the market, and is NOT "no route"', () => {
    // Phase 10B.7. A cash size becomes a token amount by pricing the buy
    // first. When that buy has no route the sell was never sized — which says
    // nothing about selling a position already held, so calling it "no route"
    // would be a market verdict on a question nobody asked.
    const outcome = representationOutcomeV1(
      representation({
        liveness: 'live',
        lastObservation: {
          ...LAPSED_OBSERVATION,
          status: 'measurement_failed',
          returnedCashAtomic: null,
          open: true,
        },
        sources: [
          {
            source: 'kyberswap',
            status: 'not_measured',
            errorCode: 'cash_size_anchor_no_route',
            quoteEvidence: null,
          },
        ],
      }),
      NOW,
    );
    assert.equal(outcome, 'unsized');
  });

  test('a token the router does not index is OURS, not a market verdict', () => {
    // Measured 2026-08-27: KyberSwap answers the Backed wrapper with HTTP 400
    // code 4011 "token not found" — it never looked for a route. That arrived
    // as `provider_http_error` on 25 consecutive passes, our infrastructure
    // taking the blame for the router's token list.
    const outcome = representationOutcomeV1(
      representation({
        liveness: 'live',
        lastObservation: {
          ...LAPSED_OBSERVATION,
          status: 'measurement_failed',
          returnedCashAtomic: null,
          open: true,
        },
        sources: [
          {
            source: 'kyberswap',
            status: 'not_measured',
            errorCode: 'provider_unsupported_token',
            quoteEvidence: null,
          },
        ],
      }),
      NOW,
    );
    assert.equal(outcome, 'unsupported_token');
  });

  test('the three NVIDIA representations produce three different outcomes', () => {
    // The audit's whole point, as one assertion. Same router, same size, same
    // direction, same destination — three answers, and the product must not
    // report them as two.
    const outcomes = (
      [
        [null, 'full' as const],
        ['provider_no_route', 'unavailable' as const],
        ['provider_unsupported_token', 'measurement_failed' as const],
      ] as const
    ).map(([errorCode, status]) =>
      representationOutcomeV1(
        representation({
          status,
          liveness: 'live',
          lastObservation: OPEN_OBSERVATION,
          sources: [{ source: 'kyberswap', status: 'quoted', errorCode, quoteEvidence: null }],
        }),
        NOW,
      ),
    );
    assert.deepEqual(outcomes, ['priced', 'no_route', 'unsupported_token']);
  });

  test('an expired unsupported-token stays ours, and an expired unsized stays the market', () => {
    // The stored status folds every non-quote into `measurement_failed`, so
    // once evidence expires the error code is all that keeps the three apart.
    const aged = (errorCode: string) =>
      representationOutcomeV1(
        representation({
          liveness: 'history_only',
          lastObservation: {
            ...LAPSED_OBSERVATION,
            status: 'measurement_failed',
            errorCode,
            returnedCashAtomic: null,
          },
          sources: [LAPSED_SOURCE],
        }),
        NOW,
      );
    assert.equal(aged('provider_unsupported_token'), 'unsupported_token');
    assert.equal(aged('cash_size_anchor_no_route'), 'unsized');
    assert.equal(aged('provider_http_error'), 'provider_failed');
  });

  test('a provider that would not answer is us, not the asset', () => {
    const outcome = representationOutcomeV1(
      representation({
        liveness: 'live',
        lastObservation: {
          ...LAPSED_OBSERVATION,
          status: 'measurement_failed',
          returnedCashAtomic: null,
          open: true,
        },
        sources: [
          {
            source: 'kyberswap',
            status: 'not_measured',
            errorCode: 'provider_http_error',
            quoteEvidence: null,
          },
        ],
      }),
      NOW,
    );
    assert.equal(outcome, 'provider_failed');
  });

  test('an open quote is priced', () => {
    const open = {
      ...LAPSED_SOURCE,
      status: 'quoted' as const,
      quoteEvidence: { ...LAPSED_SOURCE.quoteEvidence, expiresAt: '2026-08-26T20:35:00.000Z' },
    };
    assert.equal(
      representationOutcomeV1(
        representation({
          status: 'full',
          sources: [open],
          liveness: 'live',
          lastObservation: { ...LAPSED_OBSERVATION, open: true },
        }),
        NOW,
      ),
      'priced',
    );
  });

  test('each outcome names whose fact it is', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            sources: [LAPSED_SOURCE],
            liveness: 'history_only',
            lastObservation: LAPSED_OBSERVATION,
          }),
          representation({
            tokenAddress: BACKED_NVDA,
            issuerId: 'backed',
            representationKind: 'rebasing_erc20',
            issuerInstrumentKey: 'backed:instrument_id:c1077d76',
            status: 'unavailable',
            liveness: 'live',
            lastObservation: {
              ...LAPSED_OBSERVATION,
              status: 'no_route',
              returnedCashAtomic: null,
              open: true,
            },
            sources: [
              {
                source: 'kyberswap',
                status: 'no_route',
                errorCode: 'provider_no_route',
                quoteEvidence: null,
              },
            ],
          }),
          representation({
            tokenAddress: BACKED_WRAPPER,
            issuerId: 'backed',
            representationKind: 'non_rebasing_erc4626_wrapper',
            issuerInstrumentKey: 'backed:instrument_id:c1077d76',
            liveness: 'live',
            lastObservation: {
              ...LAPSED_OBSERVATION,
              status: 'measurement_failed',
              returnedCashAtomic: null,
              open: true,
            },
            sources: [
              {
                source: 'kyberswap',
                status: 'not_measured',
                errorCode: 'provider_http_error',
                quoteEvidence: null,
              },
            ],
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    assert.deepEqual(
      view?.representations.map((row) => [row.outcome, row.attribution]),
      [
        ['lapsed', 'the clock'],
        ['no_route', 'the market'],
        ['provider_failed', 'Miorail'],
      ],
      'three empty cells, three different owners',
    );
  });
});

describe('the board never picks a winner', () => {
  test('a withheld ranking is consumer-neutral', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.match(view?.rankingNote ?? '', /No winner is selected/i);
    assert.doesNotMatch(view?.rankingNote ?? '', /Phase|BEST|WITHHELD/);
  });

  test('even complete numeric coverage remains explicitly withheld in Phase 10B.8', () => {
    const view = marketRealityViewV1({
      wire: wire({
        numericComparisonCoverage: {
          eligibleRepresentationCount: 2,
          pricedRepresentationCount: 2,
          status: 'complete',
          reason: null,
        },
        ranking: {
          status: 'withheld',
          orderedTokenAddresses: [],
          reason: 'Numeric coverage is complete, but Phase 10B.8 withholds ranking.',
        },
      }),
      choice: null,
      now: NOW,
    });
    assert.match(view?.rankingNote ?? '', /No winner is selected/i);
  });

  test('coverage is stated as a fraction, not as a verdict about the assets', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.equal(view?.coverageChip, '0 / 3 market answers');
    assert.equal(view?.coverageTone, 'warn');
  });

  test('the verdict is a reader sentence, not the engine reason', () => {
    // The engine says "fresh exact-size evidence, normalized exposure and the
    // same approved-router policy". True, and it tells a person nothing about
    // what to do next.
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.doesNotMatch(view?.coverageBody ?? '', /normalized exposure|approved-router policy/);
    assert.match(view?.coverageBody ?? '', /current market answer for 0 of 3/);
  });

  test('all three coverage shapes are different sentences', () => {
    const none = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const some = marketRealityViewV1({
      wire: wire({
        marketOutcomeCoverage: {
          eligibleRepresentationCount: 3,
          establishedOutcomeCount: 1,
          status: 'incomplete',
          reason: null,
        },
      }),
      choice: null,
      now: NOW,
    });
    const all = marketRealityViewV1({
      wire: wire({
        marketOutcomeCoverage: {
          eligibleRepresentationCount: 3,
          establishedOutcomeCount: 3,
          status: 'complete',
          reason: null,
        },
      }),
      choice: null,
      now: NOW,
    });
    assert.match(some?.coverageBody ?? '', /1 of 3/);
    assert.match(all?.coverageBody ?? '', /all 3/);
    assert.notEqual(none?.coverageBody, some?.coverageBody);
    assert.notEqual(some?.coverageBody, all?.coverageBody);
  });

  test('a security nothing is bound to says so, and blames nobody', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [],
        universe: {
          reviewedRepresentationCount: 0,
          positiveSupplyRepresentationCount: 0,
          zeroSupplyRepresentationCount: 0,
          unresolvedSupplyRepresentationCount: 0,
        },
        marketOutcomeCoverage: {
          eligibleRepresentationCount: 0,
          establishedOutcomeCount: 0,
          status: 'incomplete',
          reason: null,
        },
      }),
      choice: null,
      now: NOW,
    });
    assert.match(view?.coverageBody ?? '', /No reviewed source has bound/);
  });
});

describe('an absent number never renders as a zero', () => {
  test('a missing figure keeps its reason and leaves the value grid', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const card = view?.representations[0];
    // The cash row carries the last measurement, with its age. The three that
    // follow need open evidence or a reference nobody established — they are
    // not values, so they no longer occupy a value column. Phase 17.1: four
    // stacked em dashes read as a broken card, not as four absences.
    assert.deepEqual(card?.numbers.map((fact) => fact.label), ['Cash back']);
    assert.deepEqual(
      card?.withheld.map((fact) => fact.label),
      ['Effective price', 'Reference price', 'Basis withheld'],
    );
    for (const fact of card?.withheld ?? []) {
      assert.ok(fact.note && fact.note.length > 0, `${fact.label} must say why it is empty`);
    }
    assert.equal(
      card?.numbers.some((fact) => fact.value === '—'),
      false,
      'no row renders a dash as if it were a value',
    );
  });

  // -------------------------------------------------------------------------
  // Four consequences of one cause.
  //
  // Production, 2026-09-03: three of the four NVDA cards read
  //
  //   Cash back        no reviewed router would sell this token for cash…
  //   Effective price  the share ratio isn't confirmed…
  //   Reference price  Market session not confirmed · How the reference price…
  //   Basis withheld   SELL was not sized because the exact BUY sizing anchor…
  //
  // Every line is true, and all four are downstream of the last one. A reader
  // is told four times that something is missing and never once what.
  // -------------------------------------------------------------------------
  const unsizedObservation = {
    source: 'kyberswap',
    status: 'unsized' as const,
    errorCode: 'cash_size_anchor_no_route',
    observedAt: '2026-08-26T19:55:03.000Z',
    expiresAt: '2026-08-26T19:55:23.000Z',
    returnedCashAtomic: null,
    open: false,
  };

  test('a wholly withheld grid states its cause once, in the reader’s units', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({ liveness: 'history_only', lastObservation: unsizedObservation }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const card = view?.representations[0];
    assert.equal(card?.numbers.length, 0, 'nothing in this grid was established');
    assert.equal(card?.withheldCause?.headline, '$100 cash exit could not be sized.');
    // The bound travels with the claim: what was NOT tested is named.
    assert.match(card?.withheldCause?.detail ?? '', /position already held was never tested/);
    // And it never becomes a statement about the market.
    for (const pattern of [/nobody/i, /\bno market\b/i, /does not trade/i, /illiquid/i]) {
      assert.doesNotMatch(
        `${card?.withheldCause?.headline} ${card?.withheldCause?.detail}`,
        pattern,
      );
    }
  });

  test('the four absences are not lost — they move to Technical evidence', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({ liveness: 'history_only', lastObservation: unsizedObservation }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const card = view?.representations[0];
    const technical = card?.technical.filter((row) => row.label.startsWith('Not established · '));
    assert.deepEqual(
      technical?.map((row) => row.label.replace('Not established · ', '')),
      ['Cash back', 'Effective price', 'Reference price', 'Basis withheld'],
    );
    for (const row of technical ?? []) assert.ok(row.value.length > 0, `${row.label} lost its reason`);
  });

  test('a coverage gap is named as ours, not as the market’s answer', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            liveness: 'history_only',
            lastObservation: {
              ...unsizedObservation,
              status: 'measurement_failed' as const,
              errorCode: 'provider_unsupported_token',
            },
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const cause = view?.representations[0]?.withheldCause;
    assert.equal(cause?.headline, 'This route source does not carry this token.');
    assert.match(cause?.detail ?? '', /Miorail’s coverage, not the market’s answer/);
    assert.match(cause?.detail ?? '', /says nothing about whether the token trades/);
  });

  test('one established value keeps the rows as the separate absences they are', () => {
    // The collapse is for a grid that went dark all at once. With a cash figure
    // present the remaining three are genuinely different absences, and folding
    // them into one cause would assert a shared origin that does not exist.
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const card = view?.representations[0];
    assert.equal(card?.numbers.length, 1);
    assert.equal(card?.withheldCause, null);
    assert.equal(card?.withheld.length, 3);
  });

  test('a measured figure fills the body, marked as history, and its age is on the card', () => {
    // The defect this replaced: a card over a stored run rendered four dashes
    // and hid the measurement in a one-line strip, while Discover showed the
    // same run in full. The number is the body now; the age is what keeps it
    // honest.
    //
    // The age moved to the clocks row rather than leaving the card. What the
    // note has to carry is the KIND of number — a reader who mistakes it for a
    // live price acts on it — and the age is stated once, in the row that
    // exists for ages, from the SAME observation this figure came from.
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const row = view?.representations[0];
    const cash = row?.numbers[0];
    assert.equal(cash?.value, '$99.95');
    assert.match(cash?.note ?? '', /history, not a price now/);
    assert.doesNotMatch(cash?.note ?? '', /ago/, 'the age belongs to exactly one place');
    assert.equal(cash?.tone, 'off', 'history is muted, never styled as a live price');
    const roundTrip = row?.clocks.find((clock) => clock.id === 'round_trip');
    assert.equal(roundTrip?.state, 'Measured');
    assert.match(roundTrip?.detail ?? '', /ago/);
  });

  test('the strip says whether anything is open, and only that', () => {
    // Phase 15.1 — it used to carry the twenty-second explanation too, once per
    // card. That belongs to router quotes, not to a representation, so the
    // board says it once and the strip states NOW.
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const strip = view?.representations[0]?.openQuote;
    assert.equal(strip?.value, 'No live quote');
    assert.equal(strip?.note, null);
  });

  test('a router that does not carry the token says so, and is not our outage', () => {
    // Screenshot, 2026-08-30: NVDA's two Backed representations rendered five
    // dashes and "Miorail's router call did not complete". Both readings were
    // wrong. `provider_unsupported_token` is the router answering that it does
    // not carry the token; `cash_size_anchor_no_route` is the router refusing
    // to sell it for cash at this size. Neither is a call that failed, and a
    // reader told it was ours will press Measure now forever.
    const wrapper = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            liveness: 'history_only',
            lastObservation: {
              ...LAPSED_OBSERVATION,
              status: 'measurement_failed',
              errorCode: 'provider_unsupported_token',
              returnedCashAtomic: null,
            },
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    // With no figure, the cash row is a reason rather than a value — it keeps
    // the reason and moves out of the grid.
    const cash = wrapper?.representations[0]?.withheld[0];
    assert.equal(cash?.label, 'Cash back');
    assert.match(cash?.note ?? '', /does not carry this token/);
    assert.doesNotMatch(cash?.note ?? '', /did not complete/);
    assert.equal(
      wrapper?.representations[0]?.lastSeen?.value,
      'This route source does not cover this token',
    );

    const unsized = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            liveness: 'history_only',
            lastObservation: {
              ...LAPSED_OBSERVATION,
              // The engine maps this code to `unsized` for a sell, which is
              // what production carries.
              status: 'unsized',
              errorCode: 'cash_size_anchor_no_route',
              returnedCashAtomic: null,
            },
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    assert.match(unsized?.representations[0]?.withheld[0]?.note ?? '', /at this size/);
    // One name for one outcome, shared with the chip. Phase 10B.7's rule still
    // holds — a cash size nobody could price is not a verdict on selling a
    // position already held — the words just no longer differ per row.
    assert.equal(unsized?.representations[0]?.lastSeen?.value, 'Sell size not established');
  });

  test('the page is named by its security, never by the key that stores it', () => {
    // `security:isin:US67066G1040` was the heading whenever the chooser had not
    // arrived — on first paint, and for any key the chooser does not carry.
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.equal(view?.title, 'US67066G1040');
    assert.equal(view?.identifier, 'ISIN US67066G1040');
    // A chooser entry still wins: it carries the company name.
    const named = marketRealityViewV1({
      wire: wire(),
      choice: {
        underlyingKey: 'security:isin:US67066G1040',
        title: 'NVIDIA (NVDA)',
        identifier: 'ISIN US67066G1040',
        issuerLine: 'Coinbase',
        issuerIds: ['coinbase'],
        representationCount: 3,
        multiIssuer: true,
        emptyNote: null,
      },
      now: NOW,
    });
    assert.equal(named?.title, 'NVIDIA (NVDA)');
  });

  test('utility evidence is dated by age, with the exact instant kept', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const edge = view?.representations[0]?.utility?.groups[0]?.edges[0];
    assert.ok(edge, 'the first market edge');
    // The ISO stays — evidence needs it — but the reader is shown an age.
    assert.match(edge!.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(edge!.checkedAgo !== null && /ago$/.test(edge!.checkedAgo));
  });

  test('a router that does not carry the token is never "Miorail failed"', () => {
    // Two different facts wore one sentence: a router that answered "I do not
    // carry this token", and a router call of ours that did not complete. The
    // reader told the second when the first is true keeps pressing Measure now.
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            liveness: 'history_only',
            lastObservation: {
              ...LAPSED_OBSERVATION,
              status: 'measurement_failed',
              errorCode: 'provider_unsupported_token',
              returnedCashAtomic: null,
            },
            sources: [
              {
                source: 'kyberswap',
                status: 'not_measured',
                errorCode: 'provider_unsupported_token',
                quoteEvidence: null,
              },
            ],
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const card = view!.representations[0]!;
    const spoken = [card.outcomeBody, card.numbers[0]?.note ?? '', card.lastSeen?.value ?? ''].join(' ');
    assert.match(spoken, /does not (carry|cover) this (token|contract)/);
    for (const blame of [/Miorail failed/i, /did not complete/i, /our failure/i]) {
      assert.doesNotMatch(card.numbers[0]?.note ?? '', blame);
      assert.doesNotMatch(card.lastSeen?.value ?? '', blame);
    }
    // And it is still not a market verdict about the asset.
    assert.doesNotMatch(spoken, /cannot be (sold|traded)|no liquidity|untradeable/i);
  });

  test('zero supply says what was read, and claims nothing about the market', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            supply: {
              ...representation().supply,
              state: 'zero_supply',
              totalSupplyAtomic: '0',
            },
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const card = view!.representations[0]!;
    assert.equal(card.outcome, 'zero_supply');
    // The attribution names the read, not the market and not us.
    assert.equal(card.attribution, 'onchain read');
    assert.match(card.outcomeBody, /No tokens of this contract are outstanding/);
    // Never "delisted", never "dead", never a route verdict.
    for (const forbidden of [/delisted/i, /\bdead\b/i, /no route/i, /cannot be sold/i]) {
      assert.doesNotMatch(card.outcomeBody, forbidden);
    }
    // It stays visible: a reviewed representation is not removed for having
    // no supply, it is removed from the comparison denominator.
    assert.match(card.outcomeBody, /stays on the page/);
  });

  test('now and last measured are separate fields, and the TTL is not on the card', () => {
    // Phase 15.1. The strip carried the state AND the twenty-second
    // explanation, on every card. Three cards taught the window three times and
    // the state none.
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({ liveness: 'history_only', lastObservation: LAPSED_OBSERVATION }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const card = view!.representations[0]!;
    assert.equal(card.openQuote!.value, 'No live quote');
    assert.equal(card.openQuote!.note, null, 'the strip states NOW and nothing else');
    assert.match(card.lastMeasuredLabel ?? '', /^Last measured .+ ago$/);
    for (const field of [card.openQuote!.value, card.openQuote!.note ?? '', card.lastMeasuredLabel ?? '']) {
      assert.doesNotMatch(field, /twenty seconds/i, 'the quote window is said once, for the board');
    }
  });

  test('a historical cash total is never presented as current', () => {
    const lapsed = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({ liveness: 'history_only', lastObservation: LAPSED_OBSERVATION }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const card = lapsed!.representations[0]!;
    // The strip is the only field allowed to speak in the present, and it says
    // there is nothing open.
    assert.equal(card.openQuote!.value, 'No live quote');
    for (const row of card.numbers) {
      if (row.value === '\u2014') continue;
      // Any figure on the card carries its age and is toned as history.
      assert.match(row.note ?? '', /ago|history|not a price now|no per-share price|reference|Zero supply/i);
    }
  });

  test('zero supply is the whole card, and leaves the comparison', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            supply: { ...representation().supply, state: 'zero_supply', totalSupplyAtomic: '0' },
          }),
          representation({ tokenAddress: BACKED_NVDA, issuerId: 'backed' }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const zero = view!.representations[0]!;
    const live = view!.representations[1]!;
    assert.equal(zero.outcome, 'zero_supply');
    assert.equal(zero.inComparison, false, 'a representation with nothing outstanding is not compared');
    assert.deepEqual(zero.numbers, [], 'five dashes buried the one fact that mattered');
    assert.equal(zero.outcomeChip, 'No tokens outstanding');
    // Membership, never ranking: the other card keeps its own state and no order.
    assert.equal(live.inComparison, true);
    assert.deepEqual(
      view!.comparisonSummary.map((row) => row.label),
      ['Reviewed representations', 'With tokens outstanding', 'Live answers', 'Comparison'],
    );
  });

  test('an unsized sell says the size was not established, not that we failed', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            liveness: 'history_only',
            lastObservation: {
              ...LAPSED_OBSERVATION,
              status: 'unsized',
              errorCode: 'cash_size_anchor_no_route',
              returnedCashAtomic: null,
            },
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const card = view!.representations[0]!;
    assert.equal(card.outcomeChip, 'Sell size not established');
    // One outcome, one name. The chip and the last-market-check said it two
    // different ways on the same card, which reads as two findings.
    assert.equal(card.lastSeen?.value, card.outcomeChip);
  });

  test('the router refusing coverage is spelled out, and is the router\u2019s', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            liveness: 'history_only',
            lastObservation: {
              ...LAPSED_OBSERVATION,
              status: 'measurement_failed',
              errorCode: 'provider_unsupported_token',
              returnedCashAtomic: null,
            },
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const card = view!.representations[0]!;
    assert.equal(
      card.lastSeen?.value,
      'This route source does not cover this token',
    );
    assert.doesNotMatch(card.lastSeen?.value ?? '', /Miorail|our |failed/i);
  });

  test('the quote window is explained for the board, never on a card', () => {
    // It left the strip and stayed in the lapsed body, which put it back on
    // every card it had just been taken off.
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({ liveness: 'history_only', lastObservation: LAPSED_OBSERVATION }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const card = view!.representations[0]!;
    for (const text of [card.outcomeBody, card.openQuote!.note ?? '', card.lastMeasuredLabel ?? '']) {
      assert.doesNotMatch(text, /twenty seconds/i);
    }
    // The recovery is still named — that is what a reader acts on.
    assert.match(card.outcomeBody, /Measure now/);
  });

  test('a zero-supply card carries no ladder of its own', () => {
    const address = COINBASE_NVDA.toLowerCase();
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            supply: { ...representation().supply, state: 'zero_supply', totalSupplyAtomic: '0' },
            lastObservation: {
              ...LAPSED_OBSERVATION,
              status: 'measurement_failed',
              errorCode: 'provider_unsupported_token',
              returnedCashAtomic: null,
            },
          }),
        ],
      }),
      choice: null,
      now: NOW,
      ladders: {
        [address]: {
          rungs: [
            { label: '$100', value: 'not supported', note: null, tone: 'warn' },
            { label: '$1,000', value: 'not supported', note: null, tone: 'warn' },
          ],
          note: 'Exact sizes only.',
        },
      },
    });
    const card = view!.representations[0]!;
    // Four rungs repeating a finding that is not about supply, under a card
    // whose whole subject is that nothing is outstanding.
    assert.deepEqual(card.ladder, []);
    assert.equal(card.ladderNote, null);
    // Phase 17.1: the route strips go with them. "No live quote" and a route
    // reading over a contract with nothing outstanding measure our question,
    // not this token, and both invite the reader to conclude the market
    // refused something. The reading stays under Technical evidence.
    assert.equal(card.lastSeen, null);
    assert.equal(card.openQuote, null);
    assert.equal(card.lastMeasuredLabel, null);
    assert.deepEqual(card.withheld, []);
    assert.ok(card.technical.length > 0, 'the measurement is still reachable');
  });

  test('the ladder is the caller’s, and absent until one is supplied', () => {
    const bare = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.deepEqual(bare?.representations[0]?.ladder, []);
    assert.equal(bare?.representations[0]?.ladderNote, null);

    const address = bare!.representations[0]!.tokenAddress.toLowerCase();
    const withLadder = marketRealityViewV1({
      wire: wire(),
      choice: null,
      now: NOW,
      ladders: {
        [address]: {
          rungs: [{ label: '$1,000', value: '0.09%', note: null, tone: 'neutral' }],
          note: 'Measured 46m ago through kyberswap.',
        },
      },
    });
    assert.equal(withLadder?.representations[0]?.ladder[0]?.value, '0.09%');
    assert.match(withLadder?.representations[0]?.ladderNote ?? '', /kyberswap/);
  });

  test('a quote that answers is not the same as a position that can be closed', () => {
    const bare = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const address = bare!.representations[0]!.tokenAddress.toLowerCase();
    // Nothing measured a round trip: the line is absent, never a zero.
    assert.equal(bare?.representations[0]?.exit, null);

    const cheap = marketRealityViewV1({
      wire: wire(),
      choice: null,
      now: NOW,
      ladders: {
        [address]: {
          rungs: [],
          note: null,
          exit: {
            roundTripCostBps: '51',
            requestedCashAtomic: null,
            returnedCashAtomic: null,
            basis: 'open',
            observedAt: NOW,
          },
        },
      },
    });
    const good = cheap!.representations[0]!.exit!;
    assert.equal(good.value, '0.51%');
    assert.equal(good.tone, 'good');
    assert.doesNotMatch(good.note ?? '', /cannot be closed/);

    // The audit's case: a router quotes it, and the money does not come back.
    const dust = marketRealityViewV1({
      wire: wire(),
      choice: null,
      now: NOW,
      ladders: {
        [address]: {
          rungs: [],
          note: null,
          exit: {
            roundTripCostBps: '9957',
            requestedCashAtomic: null,
            returnedCashAtomic: null,
            basis: 'last_measured',
            observedAt: NOW,
          },
        },
      },
    });
    const bad = dust!.representations[0]!.exit!;
    assert.equal(bad.value, '99.57%');
    // `bad`, not `warn`. `off` reads as "we did not look" and this is the
    // answer; `warn` was carrying both this and a 4% round trip, so a reader
    // comparing two cards saw one colour on a bad trade and on a total loss.
    assert.equal(bad.tone, 'bad');
    // The chip beside it grades the same number from the same evidence, so the
    // two can never disagree about what they are grading.
    assert.equal(dust!.representations[0]!.exitCost?.tone, 'bad');
    assert.equal(dust!.representations[0]!.exitCost?.chip, 'Round trip 99.57%');
    // Never borrows the market's vocabulary for absence: a route existed.
    assert.doesNotMatch(bad.note ?? '', /no route/i);
    assert.match(bad.note ?? '', /Most of the money does not come back/);
    // The word a reader would have to translate is gone from this line.
    assert.doesNotMatch(bad.note ?? '', /policy/i);
  });

  test('the round-trip bound is our policy, and the measured cost is always shown beside it', () => {
    const bare = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const address = bare!.representations[0]!.tokenAddress.toLowerCase();
    const at = (bps: string) =>
      marketRealityViewV1({
        wire: wire(),
        choice: null,
        now: NOW,
        ladders: {
          [address]: {
            rungs: [],
            note: null,
            exit: {
              roundTripCostBps: bps,
              requestedCashAtomic: null,
              returnedCashAtomic: null,
              basis: 'open',
              observedAt: NOW,
            },
          },
        },
      })!.representations[0]!.exit!;
    // Exactly at the bound is still exitable; one basis point past it is not.
    assert.equal(at(String(MARKET_REALITY_ROUND_TRIP_BOUND_BPS_V1)).tone, 'good');
    // `warn`, never `off`: `off` is this console's word for nothing having been
    // measured, and a round trip that ate the money is a measurement.
    assert.equal(at(String(MARKET_REALITY_ROUND_TRIP_BOUND_BPS_V1 + 1)).tone, 'warn');
    // Three bands, not two. A 4% round trip and a 99.90% one shared `warn`, and
    // on a board where a reader compares representations at a glance that made
    // a bad trade and a total loss the same colour. The severe band is a stated
    // multiple of the derived bound, and the boundary is exact.
    assert.equal(at(String(MARKET_REALITY_ROUND_TRIP_SEVERE_BPS_V1 - 1)).tone, 'warn');
    assert.equal(at(String(MARKET_REALITY_ROUND_TRIP_SEVERE_BPS_V1)).tone, 'bad');
    assert.equal(at('9990').tone, 'bad');
    // A reader who disagrees with either bound can still see the number both
    // were applied to.
    assert.equal(at('1234').value, '12.34%');
  });

  test('open evidence and history are named apart, never merged', () => {
    const bare = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const address = bare!.representations[0]!.tokenAddress.toLowerCase();
    const withBasis = (basis: 'open' | 'last_measured') =>
      marketRealityViewV1({
        wire: wire(),
        choice: null,
        now: NOW,
        ladders: {
          [address]: {
            rungs: [],
            note: null,
            exit: {
              roundTripCostBps: '51',
              requestedCashAtomic: null,
              returnedCashAtomic: null,
              basis,
              observedAt: LAPSED_OBSERVATION.observedAt,
            },
          },
        },
      })!.representations[0]!.exit!;
    assert.match(withBasis('open').note ?? '', /on the open quote/);
    assert.doesNotMatch(withBasis('open').note ?? '', /measured/);
    assert.match(withBasis('last_measured').note ?? '', /measured/);
  });

  test('the no-route chip is scoped to the reviewed policy, not to Base', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            status: 'unavailable',
            liveness: 'live',
            lastObservation: { ...LAPSED_OBSERVATION, status: 'no_route', returnedCashAtomic: null, open: true },
            sources: [
              { source: 'kyberswap', status: 'no_route', errorCode: 'provider_no_route', quoteEvidence: null },
            ],
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const card = view!.representations[0]!;
    assert.equal(card.outcome, 'no_route');
    // An asset-level claim this product has never measured. The chip is the
    // headline, so an unbounded one there outranks every bounded sentence
    // below it — and "No route" reads as a fact about the whole of Base.
    assert.equal(card.outcomeChip, 'No cash route found');
    // The chip and the history line say it the same way, not two findings.
    assert.equal(card.lastSeen?.value, card.outcomeChip);
  });

  test('a present figure is formatted, not raw atomic', () => {
    const open = {
      ...LAPSED_SOURCE,
      status: 'quoted' as const,
      quoteEvidence: { ...LAPSED_SOURCE.quoteEvidence, expiresAt: '2026-08-26T20:35:00.000Z' },
    };
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            status: 'full',
            liveness: 'live',
            lastObservation: { ...LAPSED_OBSERVATION, open: true },
            sources: [open],
            returnedCashAtomic: '99952618',
            normalizedExposureAtomic: '47673533',
            normalizedExposureDecimals: 8,
            normalization: 'fresh_ratio_applied',
            effectivePriceAtomic: '20966410000',
            effectivePriceDecimals: 8,
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const numbers = view?.representations[0]?.numbers ?? [];
    assert.equal(numbers[0]?.value, '$99.95');
    assert.equal(numbers[1]?.value, '$209.66');
    // No reference adapter answered, so both reference and basis stay absent
    // rather than comparing a cash return against a value in another unit.
    const withheld = view?.representations[0]?.withheld ?? [];
    assert.deepEqual(withheld.map((fact) => fact.label), ['Reference price', 'Basis withheld']);
    assert.match(withheld[0]?.note ?? '', /not established|reference/i);
    assert.match(withheld[1]?.note ?? '', /reference/i);
  });

  test('the ratio convention is stated per representation, never assumed', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            normalization: 'reviewed_token_already_applied',
            issuerId: 'backed',
            liveness: 'live',
            lastObservation: { ...LAPSED_OBSERVATION, open: true },
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const ratio = view?.representations[0]?.terms.find((row) => row.label === 'Ratio');
    // Applying a rebasing token's ratio a second time overstates a holding by
    // the whole ratio. Five Dinari dShares are already away from 1.0.
    assert.match(ratio?.note ?? '', /already carries the ratio/);
  });
});

describe('numeric Market Reality facts stay factual and neutral', () => {
  function comparableRepresentation(bps: string): MarketRealityRepresentationWireV1 {
    const open = {
      ...LAPSED_SOURCE,
      status: 'quoted' as const,
      quoteEvidence: {
        ...LAPSED_SOURCE.quoteEvidence,
        direction: 'sell' as const,
        expiresAt: '2026-08-26T20:35:00.000Z',
      },
    };
    return representation({
      status: 'full',
      liveness: 'live',
      lastObservation: { ...LAPSED_OBSERVATION, open: true },
      sources: [open],
      returnedCashAtomic: '100000000',
      normalizedExposureAtomic: '47272400',
      normalizedExposureDecimals: 8,
      normalization: 'fresh_ratio_applied',
      effectivePriceAtomic: bps.startsWith('-') ? '21106000000' : '21154000000',
      effectivePriceDecimals: 8,
      premiumDiscountBps: bps,
      reference: {
        ...representation().reference,
        status: 'fresh',
        session: 'regular_hours',
        marketSession: 'regular_hours',
        publicationMode: 'live_reference',
        valueAtomic: '21130000000',
        decimals: 8,
        reason: null,
      },
      basis: {
        status: 'comparable',
        kind: 'current_reference',
        premiumDiscountBps: bps,
        reason: 'The exact execution price and reviewed current reference are comparable.',
      },
    });
  }

  test('+11 bps and established prices do not receive a good tone', () => {
    const view = marketRealityViewV1({
      wire: wire({ representations: [comparableRepresentation('11')] }),
      choice: null,
      now: NOW,
    });
    const numbers = view?.representations[0]?.numbers ?? [];
    const effective = numbers.find((fact) => fact.label === 'Effective price');
    const reference = numbers.find((fact) => fact.label === 'Reference price');
    const basis = numbers.find((fact) => fact.label === 'Basis');

    assert.equal(effective?.value, '$211.54');
    assert.equal(effective?.tone, 'neutral');
    assert.equal(reference?.value, '$211.30');
    assert.equal(reference?.tone, 'neutral');
    // Percent first: basis points are a unit a reader has to convert, and
    // this was the primary value of the row rather than a footnote.
    assert.equal(basis?.value, '+0.11% · +11 bps');
    assert.equal(basis?.tone, 'neutral');
    assert.notEqual(basis?.tone, 'good');
  });

  test('-11 bps receives neither a good nor a bad semantic', () => {
    const view = marketRealityViewV1({
      wire: wire({ representations: [comparableRepresentation('-11')] }),
      choice: null,
      now: NOW,
    });
    const basis = view?.representations[0]?.numbers.find((fact) => fact.label === 'Basis');
    assert.equal(basis?.value, '-0.11% · -11 bps');
    assert.equal(basis?.tone, 'neutral');
    assert.notEqual(basis?.tone, 'good');
    assert.notEqual(String(basis?.tone), 'bad');
  });

  test('withheld basis stays neutral and retains the exact evidence reason', () => {
    const reason = 'The exact executable quote is no longer open.';
    const row = representation({
      basis: {
        status: 'withheld',
        kind: 'withheld',
        premiumDiscountBps: null,
        reason,
      },
    });
    const view = marketRealityViewV1({
      wire: wire({ representations: [row] }),
      choice: null,
      now: NOW,
    });
    const basis = view?.representations[0]?.withheld.find((fact) => fact.label === 'Basis withheld');
    assert.ok(basis, 'a withheld basis is still stated, with its reason');
    assert.equal(basis!.note, reason);
    assert.equal(basis!.tone, 'neutral');
    assert.equal(
      view?.representations[0]?.numbers.some((fact) => fact.label === 'Basis withheld'),
      false,
      'a reason is not a value, so it does not sit in the value grid',
    );
  });

  test('primary reference copy is human-readable while technical evidence keeps raw enums', () => {
    const view = marketRealityViewV1({
      wire: wire({ representations: [comparableRepresentation('11')] }),
      choice: null,
      now: NOW,
    });
    const row = view?.representations[0];
    const reference = row?.numbers.find((fact) => fact.label === 'Reference price');
    assert.match(reference?.note ?? '', /US market open/);
    // A publication mode that only restates freshness left this line: the
    // Reference clock says whether the feed is publishing, and saying it twice
    // in two vocabularies taught a reader neither. It is still printed raw
    // under Technical evidence.
    assert.doesNotMatch(reference?.note ?? '', /Reference price is live/);
    assert.equal(row?.clocks.find((clock) => clock.id === 'reference')?.state, 'Publishing');
    assert.doesNotMatch(reference?.note ?? '', /regular_hours|live_reference/);
    assert.match(
      row?.technical.find((fact) => fact.label === 'Reference')?.value ?? '',
      /regular_hours · live_reference/,
    );
  });

  test('closed-market and held-reference enums become consumer labels', () => {
    const base = comparableRepresentation('11');
    const row = representation({
      ...base,
      reference: {
        ...base.reference,
        session: 'reference_holding_last_close',
        marketSession: 'after_hours',
        publicationMode: 'holding_last_close',
      },
      basis: {
        ...base.basis,
        kind: 'last_close_reference',
      },
    });
    const view = marketRealityViewV1({
      wire: wire({ representations: [row] }),
      choice: null,
      now: NOW,
    });
    const reference = view?.representations[0]?.numbers.find(
      (fact) => fact.label === 'Reference price',
    );
    assert.match(reference?.note ?? '', /US market closed \/ after hours/);
    assert.match(reference?.note ?? '', /Reference price is holding its last published value/);
    assert.doesNotMatch(reference?.note ?? '', /after_hours|holding_last_close/);
  });

  test('ranking remains withheld after numeric facts become present', () => {
    const view = marketRealityViewV1({
      wire: wire({
        ranking: {
          status: 'withheld',
          orderedTokenAddresses: [],
          reason: 'Numeric coverage is complete, but Phase 10B.8 withholds ranking.',
        },
        representations: [comparableRepresentation('11')],
      }),
      choice: null,
      now: NOW,
    });
    const ranking = view?.comparisonSummary.find((fact) => fact.label === 'Comparison');
    assert.equal(ranking?.value, 'Not ranked');
    assert.equal(ranking?.tone, 'off');
    assert.match(view?.rankingNote ?? '', /No winner is selected/);
  });
});

describe('the chooser', () => {
  test('says which securities can actually be compared', () => {
    const index = {
      entries: [
        {
          underlyingKey: 'security:isin:US67066G1040',
          canonicalName: 'NVIDIA Corporation',
          displaySymbol: null,
          assetClass: 'equity' as const,
          identifierScheme: 'isin',
          identifierValue: 'US67066G1040',
          representationCount: 3,
          liveRepresentationCount: 2,
          issuerIds: ['backed', 'coinbase'] as const,
          multiIssuer: true,
        },
        {
          underlyingKey: 'security:isin:US5949724083',
          canonicalName: 'MSTR',
          displaySymbol: null,
          assetClass: 'unknown' as const,
          identifierScheme: 'isin',
          identifierValue: 'US5949724083',
          representationCount: 2,
          liveRepresentationCount: 0,
          issuerIds: ['backed'] as const,
          multiIssuer: false,
        },
      ],
      totals: { underlyings: 19, boundRepresentations: 25, multiIssuerUnderlyings: 2 },
      observedAt: NOW,
    };
    const choices = underlyingChoicesV1(index);
    assert.equal(choices[0]?.issuerLine, 'Backed · Coinbase');
    assert.equal(choices[0]?.multiIssuer, true);
    assert.equal(choices[0]?.identifier, 'ISIN US67066G1040');
    // Two representations, one issuer — a structure choice, not a comparison.
    assert.equal(choices[1]?.representationCount, 2);
    assert.equal(choices[1]?.multiIssuer, false);
  });

  test('a row whose only name is its ticker is titled once, not twice', () => {
    const [named, tickerOnly] = underlyingChoicesV1({
      entries: [
        {
          underlyingKey: 'security:isin:US0378331005',
          canonicalName: 'Apple Inc.',
          displaySymbol: 'AAPL',
          assetClass: 'equity',
          identifierScheme: 'isin',
          identifierValue: 'US0378331005',
          representationCount: 1,
          liveRepresentationCount: 1,
          issuerIds: ['coinbase'] as const,
          multiIssuer: false,
        },
        {
          underlyingKey: 'security:isin:US67066G1040',
          canonicalName: 'NVDA',
          displaySymbol: 'NVDA',
          assetClass: 'equity',
          identifierScheme: 'isin',
          identifierValue: 'US67066G1040',
          representationCount: 3,
          liveRepresentationCount: 3,
          issuerIds: ['backed', 'coinbase'] as const,
          multiIssuer: true,
        },
      ],
      totals: { underlyings: 2, boundRepresentations: 4, multiIssuerUnderlyings: 1 },
      observedAt: NOW,
    });
    // Ticker first: this row is one line and it ellipsis, so the company name
    // is the half that can afford to be cut.
    assert.equal(named?.title, 'AAPL · Apple Inc.');
    assert.equal(tickerOnly?.title, 'NVDA');
  });

  test('the headline counter is the number of comparable securities', () => {
    const counters = underlyingCountersV1({
      entries: [],
      totals: { underlyings: 19, boundRepresentations: 25, multiIssuerUnderlyings: 2 },
      observedAt: NOW,
    });
    const compare = counters.find((row) => row.label === 'Multi-issuer stocks');
    assert.equal(compare?.value, '2');
    assert.equal(compare?.tone, 'neutral');
  });

  test('nothing to compare is stated, not hidden', () => {
    const counters = underlyingCountersV1({
      entries: [],
      totals: { underlyings: 19, boundRepresentations: 25, multiIssuerUnderlyings: 0 },
      observedAt: NOW,
    });
    assert.equal(counters.find((row) => row.label === 'Multi-issuer stocks')?.tone, 'neutral');
  });
});

describe('Phase 11 utility and eligibility map', () => {
  test('utility evidence is keyed to the exact CAIP-10 representation', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const utility = view?.representations[0]?.utility;
    assert.equal(utility?.caip10, `eip155:8453:${COINBASE_NVDA}`);
    assert.equal(utility?.groups.length, 4);
  });

  test('a router quote is observed or stale, never presented as execution availability', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const trade = view?.representations[0]?.utility.groups
      .flatMap((group) => group.edges)
      .find(
      (edge) => edge.edgeId === 'market_trade',
      );
    assert.equal(trade?.state, 'stale');
    assert.match(trade?.note ?? '', /history/);
    assert.notEqual(trade?.state, 'available');
  });

  test('unreviewed DeFi gaps are consolidated without becoming unavailable claims', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const defi = view?.representations[0]?.utility.groups
      .flatMap((group) => group.edges)
      .filter((edge) => edge.edgeId === 'defi_reviewed_integrations') ?? [];
    assert.equal(defi.length, 1);
    assert.equal(defi[0]?.state, 'not_established');
    assert.match(defi[0]?.note ?? '', /one evidence gap/i);
  });

  test('reviewed issuer processes link their evidence without deciding wallet eligibility', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const primaryMarket = view?.representations[0]?.utility.groups
      .flatMap((group) => group.edges)
      .find((edge) => edge.edgeId === 'issuer_primary_market');
    assert.equal(primaryMarket?.state, 'documented');
    assert.ok(primaryMarket?.sources.some((source) => source.href?.startsWith('https://')));
    assert.match(primaryMarket?.eligibilityNote ?? '', /eligible|outside/i);
    assert.doesNotMatch(JSON.stringify(primaryMarket), /walletEligible|approval|calldata/i);
  });

  test('legal claim, access, reference, primary market and value lifecycle are separate facts', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const ids = new Set(
      view?.representations[0]?.utility.groups.flatMap((group) =>
        group.edges.map((edge) => edge.edgeId),
      ),
    );
    for (const id of [
      'representation_claim_model',
      'representation_transfer',
      'representation_eligibility',
      'representation_reference_model',
      'issuer_primary_market',
      'issuer_value_lifecycle',
    ]) {
      assert.ok(ids.has(id as never), `missing ${id}`);
    }
    assert.equal(ids.has('issuer_mint_issue'), false);
    assert.equal(ids.has('issuer_redeem_sell'), false);
  });

  test('a security nothing has outstanding says so, and counts correctly', () => {
    const entry = (representationCount: number, liveRepresentationCount: number) => ({
      underlyingKey: `security:isin:US000000000${representationCount}`,
      canonicalName: 'Example Inc.',
      displaySymbol: 'EX',
      assetClass: 'equity' as const,
      identifierScheme: 'isin',
      identifierValue: 'US0378331005',
      representationCount,
      liveRepresentationCount,
      issuerIds: ['coinbase'] as const,
      multiIssuer: false,
    });
    const noteFor = (reps: number, live: number) =>
      underlyingChoicesV1({
        entries: [entry(reps, live)],
        totals: { underlyings: 1, boundRepresentations: reps, multiIssuerUnderlyings: 0 },
        observedAt: NOW,
      })[0]?.emptyNote;

    assert.equal(noteFor(1, 0), 'No tokens outstanding');
    assert.equal(noteFor(2, 0), 'No tokens outstanding on either contract');
    // "either" is two. MSTR has three.
    assert.equal(noteFor(3, 0), 'No tokens outstanding on any of 3 contracts');
    // One live representation is enough for the security to be worth opening.
    assert.equal(noteFor(3, 1), null);
    assert.equal(noteFor(1, 1), null);
  });

  test('a filter chip exists only when something is behind it', () => {
    // Dinari has a hundred contracts proven to be dShares and none bound to a
    // security, and the chip list was a literal of five — so pressing "Dinari"
    // emptied the page. A filter that can only return nothing reads as a broken
    // product, not as a gap in coverage.
    const choice = (issuerIds: readonly ('coinbase' | 'dinari' | 'backed')[], multiIssuer: boolean) => ({
      underlyingKey: issuerIds.join('-') + String(multiIssuer),
      title: 'x',
      identifier: null,
      issuerLine: 'x',
      issuerIds,
      representationCount: issuerIds.length,
      multiIssuer,
      emptyNote: null,
    });

    const both = stockFiltersV1([choice(['coinbase', 'backed'], true), choice(['backed'], false)]);
    assert.deepEqual(
      both.map((entry) => entry.id),
      ['all', 'multi', 'coinbase', 'backed'],
    );
    assert.deepEqual(
      both.map((entry) => entry.count),
      [2, 1, 1, 2],
    );

    // Nothing held by two issuers: no "Multi-issuer" chip either.
    const single = stockFiltersV1([choice(['coinbase'], false)]);
    assert.deepEqual(
      single.map((entry) => entry.id),
      ['all', 'coinbase'],
    );

    // And the moment a Dinari representation IS bound, its chip appears with
    // no further change here.
    assert.ok(stockFiltersV1([choice(['dinari'], false)]).some((entry) => entry.id === 'dinari'));
    assert.deepEqual(stockFiltersV1([]).map((entry) => entry.id), ['all']);
  });

  test('two documents on one edge are named by publisher, never twice by kind', () => {
    // Production rendered "Reviewed documentation  Reviewed documentation" on
    // every Coinbase card: the label was the source KIND, so two independent
    // documents were indistinguishable and read as a duplication bug.
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const sources = view!.representations[0]!.utility.groups
      .flatMap((group) => group.edges)
      .flatMap((edge) => edge.sources)
      .filter((source) => source.href !== null);
    assert.ok(sources.length > 0);
    for (const source of sources) {
      assert.notEqual(source.label, 'Reviewed documentation');
    }
    // Every edge that cites more than one document distinguishes them.
    for (const edge of view!.representations[0]!.utility.groups.flatMap((g) => g.edges)) {
      const labels = edge.sources.map((source) => source.label);
      assert.equal(new Set(labels).size, labels.length, `${edge.edgeId} repeats a source label`);
    }
    // A host nobody reviewed keeps the kind label rather than inventing one.
    assert.equal(
      sourceLabelV1('https://example.invalid/x', 'Reviewed documentation'),
      'Reviewed documentation',
    );
    assert.equal(sourceLabelV1(null, 'Reviewed documentation'), 'Reviewed documentation');
    assert.equal(
      sourceLabelV1('https://docs.base.org/anything', 'Reviewed documentation'),
      'Base standard',
    );
  });

  test('the Utility view renders evidence states without rendering a ranking', () => {
    const choices = underlyingChoicesV1({
      entries: [
        {
          underlyingKey: 'security:isin:US67066G1040',
          canonicalName: 'NVIDIA Corporation',
          displaySymbol: 'NVDA',
          assetClass: 'equity',
          identifierScheme: 'isin',
          identifierValue: 'US67066G1040',
          representationCount: 1,
          liveRepresentationCount: 1,
          issuerIds: ['coinbase'],
          multiIssuer: false,
        },
      ],
      totals: { underlyings: 1, boundRepresentations: 1, multiIssuerUnderlyings: 0 },
      observedAt: NOW,
    });
    const view = marketRealityViewV1({ wire: wire(), choice: choices[0] ?? null, now: NOW });
    assert.ok(view);
    const markup = renderToStaticMarkup(
      React.createElement(MarketRealityScreen, {
        model: {
          choices,
          choicesLoading: false,
          choicesError: null,
          counters: [],
          selectedKey: choices[0]!.underlyingKey,
          direction: 'sell',
          requestedCashAtomic: MARKET_REALITY_SIZES_V1[0]!.requestedCashAtomic,
          surface: 'utility',
          historyPeriod: 'now',
          view,
          viewLoading: false,
          viewError: null,
          history: null,
          historyLoading: false,
          historyError: null,
          measuring: false,
          measurementNote: null,
          measurementError: null,
          watchedTokenAddresses: [],
          watchingTokenAddress: null,
          removingWatchTokenAddress: null,
          watchError: null,
          actions: {
            onUnderlying: () => undefined,
            onDirection: () => undefined,
            onSize: () => undefined,
            onSurface: () => undefined,
            onHistoryPeriod: () => undefined,
          },
        },
      }),
    );
    assert.match(markup, /Use &amp; access/);
    assert.match(markup, /eip155:8453:/);
    assert.match(markup, /Documented/);
    assert.match(markup, /Not established/);
    // Phase 17.4 — the six sections, in the order a person asks. The structure
    // rows still exist; they are the last two sections rather than the page.
    assert.deepEqual(
      [...markup.matchAll(/<section class="mr-use-section" aria-label="([^"]+)"/g)].map(
        (match) => match[1],
      ),
      ['Trade', 'Transfer', 'Bridge', 'Lend and borrow', 'Issuer services', 'How it works'],
    );
    assert.match(markup, /No reviewed exact-address evidence/);
    // `approve()` is an Evidence line, never a headline card of its own.
    assert.match(markup, /an approval is not permission to transfer/);
    // The boundary, stated on the page and not only in a type.
    assert.match(markup, /not KYC/);
    assert.doesNotMatch(markup, /Not confirmed yet/);
    assert.doesNotMatch(markup, /No winner is selected|Not ranked|BEST/);
  });
});

describe('Phase 12.2 exact-market watch control', () => {
  test('the view carries the reviewed policy and source set used by the server', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const representation = view?.representations[0];
    assert.equal(representation?.watchable, true);
    assert.match(representation?.routePolicyKey ?? '', /^0x[0-9a-f]{64}$/);
    assert.deepEqual(representation?.approvedSources, ['kyberswap']);
  });

  test('zero or unresolved supply cannot be presented as a watchable market', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            supply: {
              ...representation().supply,
              state: 'zero_supply',
              totalSupplyAtomic: '0',
            },
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    assert.equal(view?.representations[0]?.watchable, false);
    assert.match(view?.representations[0]?.watchUnavailableReason ?? '', /outstanding supply/i);
  });

  test('a watched Stocks card exposes an enabled removal control', () => {
    const choices: ReturnType<typeof underlyingChoicesV1> = [];
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.ok(view);
    const watchedAddress = view.representations[0]!.tokenAddress;
    const markup = renderToStaticMarkup(
      React.createElement(MarketRealityScreen, {
        model: {
          choices,
          choicesLoading: false,
          choicesError: null,
          counters: [],
          selectedKey: 'security:isin:US67066G1040',
          direction: 'sell',
          requestedCashAtomic: MARKET_REALITY_SIZES_V1[0]!.requestedCashAtomic,
          surface: 'market',
          historyPeriod: 'now',
          view,
          viewLoading: false,
          viewError: null,
          history: null,
          historyLoading: false,
          historyError: null,
          measuring: false,
          measurementNote: null,
          measurementError: null,
          watchedTokenAddresses: [watchedAddress],
          watchingTokenAddress: null,
          removingWatchTokenAddress: null,
          watchError: null,
          actions: {
            onUnderlying: () => undefined,
            onDirection: () => undefined,
            onSize: () => undefined,
            onSurface: () => undefined,
            onHistoryPeriod: () => undefined,
            onWatch: () => undefined,
            onUnwatch: () => undefined,
          },
        },
      }),
    );
    assert.match(markup, />Remove watch</);
    assert.match(markup, /Remove this exact market question from Radar/);
    assert.doesNotMatch(markup, /disabled=""[^>]*>Remove watch/);
    assert.doesNotMatch(markup, />Watching this market</);
  });
});

describe('the question is restated where the answer is', () => {
  test('direction and size read as one sentence', () => {
    const sell = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.equal(sell?.questionLine, 'Selling $100 worth into USDC');
    const buy = marketRealityViewV1({
      wire: wire({
        question: {
          underlyingKey: 'security:isin:US67066G1040',
          direction: 'buy',
          requestedCashAtomic: '10000000000',
          cashDecimals: 6,
          destination: 'USDC',
        },
      }),
      choice: null,
      now: NOW,
    });
    assert.equal(buy?.questionLine, 'Buying $10,000 worth with USDC');
  });

  test('the sizes offered are the rungs the ladder measures', () => {
    assert.deepEqual(
      MARKET_REALITY_SIZES_V1.map((size) => size.requestedCashAtomic),
      ['100000000', '1000000000', '10000000000', '100000000000'],
    );
  });

  test('scope is unconditional', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.match(view?.scope ?? '', /Base only/);
    assert.match(view?.scope ?? '', /never a promise of execution/);
  });
});

describe('ages, not timestamps', () => {
  test('a lapsed quote is described by how long ago it was taken', () => {
    assert.equal(quoteAgeLabelV1('2026-08-26T19:55:03.000Z', NOW), '39 min ago');
    assert.equal(quoteAgeLabelV1('2026-08-26T20:34:04.000Z', NOW), '15s ago');
    assert.equal(quoteAgeLabelV1(null, NOW), null);
  });

  test('a reading taken this second says "just now", never "0s ago"', () => {
    // Seen in production: "measured 0s ago" sat directly above "measured 1h
    // ago" on one card. Two ages, one of them apparently instantaneous, reading
    // as a contradiction — and "0s ago" is not a time anyone can act on.
    assert.equal(quoteAgeLabelV1(NOW, NOW), 'just now');
    assert.equal(quoteAgeLabelV1('2026-08-26T20:34:17.000Z', NOW), 'just now');
    // Five seconds is where a number starts telling the reader something.
    assert.equal(quoteAgeLabelV1('2026-08-26T20:34:14.000Z', NOW), '5s ago');
  });

  test('the lapsed sentence carries the age and says the number was real', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const body = view?.representations[0]?.outcomeBody ?? '';
    assert.match(body, /39 min ago/);
    // The twenty-second window moved to the board: it is a property of router
    // quotes, and saying it here put it back on every card.
    assert.doesNotMatch(body, /twenty seconds/);
    assert.match(body, /Measure now/);
    assert.doesNotMatch(body, /no data|unavailable/i);
  });
});

describe('history is history, and says so', () => {
  test('an expired quote is a lapsed PRICE and points at the fix', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const row = view?.representations[0];
    assert.equal(row?.outcome, 'lapsed');
    assert.match(row?.outcomeBody ?? '', /Measure now/);
  });

  test('an expired no-route is not a lapsed price', () => {
    // Telling a reader their price expired when we never had one is a small
    // lie, and it is the one a single "not measured" bucket forces.
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            liveness: 'history_only',
            lastObservation: {
              ...LAPSED_OBSERVATION,
              status: 'no_route',
              returnedCashAtomic: null,
            },
            sources: [LAPSED_SOURCE],
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const row = view?.representations[0];
    assert.equal(row?.outcome, 'stale_finding');
    assert.equal(row?.outcomeChip, 'Earlier check expired');
    assert.doesNotMatch(row?.outcomeBody ?? '', /price/i);
  });

  test('a quoted observation is not repeated below the body that carries it', () => {
    // A background sample rendered in the same list as open evidence is the
    // confusion the engine grew a second field to prevent.
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const row = view?.representations[0];
    // The figure lives in the body now, with its age. Showing it twice, in two
    // styles, taught nobody anything and made the card longer.
    assert.equal(row?.numbers[0]?.value, '$99.95');
    assert.equal(row?.lastSeen, null);
  });

  test('a look that found no figure still gets its own line, naming the read', () => {
    // The badge names the read it reports. "Last seen · Read failed" under a
    // headline about a fresh successful totalSupply read reads as a
    // contradiction; supply and the cash-exit route are different reads.
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            lastObservation: {
              ...LAPSED_OBSERVATION,
              status: 'no_route' as const,
              returnedCashAtomic: null,
            },
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const row = view?.representations[0];
    assert.equal(row?.lastSeen?.label, 'Last market check');
    assert.equal(row?.lastSeen?.value, 'No cash route found');
    // And the card says why it has no figure — as a reason, not as a dash.
    assert.match(row?.withheld[0]?.note ?? '', /no cash route was found/i);
  });

  test('an open observation is labelled open, not as history', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            status: 'full',
            liveness: 'live',
            lastObservation: { ...LAPSED_OBSERVATION, open: true },
            // Phase 17.2: the strip decides liveness from the clock, so a
            // fixture that wants a live strip needs quote evidence that has not
            // actually expired. The default source's has.
            sources: [
              {
                ...LAPSED_SOURCE,
                status: 'quoted' as const,
                quoteEvidence: {
                  ...LAPSED_SOURCE.quoteEvidence,
                  expiresAt: '2026-08-26T20:34:36.000Z',
                },
              },
            ],
            returnedCashAtomic: '99952618',
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    // Open evidence is the strip's job now, and the body says so too. The
    // history line is for a look that produced no figure at all.
    const row = view?.representations[0];
    // Phase 17.2: NOW says the round trip in the same words the durable answer
    // does, so a reader reads one measurement taken twice — not two kinds of
    // thing that happen to sit near each other.
    assert.equal(row?.openQuote?.state, 'live');
    assert.equal(row?.openQuote?.value, '$100 in \u2192 $99.95 back');
    assert.match(row?.openQuote?.note ?? '', /open right now/);
    assert.match(row?.numbers[0]?.note ?? '', /still open/);
    assert.equal(row?.numbers[0]?.tone, 'neutral', 'a live figure is not muted');
    assert.equal(row?.lastSeen, null);
  });

  test('an expired failed read stays OUR failure, however long ago it was', () => {
    // "Finding expired" for a call that never completed hands our failure to
    // the market. Whose fact it is does not change with time.
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            liveness: 'history_only',
            lastObservation: {
              ...LAPSED_OBSERVATION,
              status: 'measurement_failed',
              returnedCashAtomic: null,
            },
            sources: [LAPSED_SOURCE],
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    const row = view?.representations[0];
    assert.equal(row?.outcome, 'provider_failed');
    assert.equal(row?.attribution, 'Miorail');
    assert.match(row?.outcomeBody ?? '', /39 min ago/, 'and it still says when');
    assert.match(row?.outcomeBody ?? '', /not the contract/);
  });

  test('a representation nobody measured shows no history row at all', () => {
    const view = marketRealityViewV1({
      wire: wire({ representations: [representation()] }),
      choice: null,
      now: NOW,
    });
    assert.equal(view?.representations[0]?.lastSeen, null, 'absence, not a zeroed row');
    assert.equal(view?.representations[0]?.outcome, 'never_measured');
  });

  test('liveness comes from the engine, not from re-reading timestamps here', () => {
    // The two disagreeing about whether something was ever measured is exactly
    // the drift that put "not measured" over a token measured minutes ago.
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            liveness: 'never_measured',
            lastObservation: null,
            // Sources present but carrying nothing — the engine already ruled.
            sources: [
              { source: 'kyberswap', status: 'not_measured', errorCode: null, quoteEvidence: null },
            ],
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    assert.equal(view?.representations[0]?.outcome, 'never_measured');
  });
});


// ---------------------------------------------------------------------------
// A venue that CAN route this and will not.
//
// The audit measured 0x answering BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE at HTTP
// 200 on the Coinbase equities: a complete answer, carrying a verdict, that is
// not a route finding. Each of the three states it could have been filed under
// names the wrong party.
// ---------------------------------------------------------------------------

describe('a venue declining to quote is its own answer', () => {
  const refused = () =>
    marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            status: 'measurement_failed',
            liveness: 'live',
            sources: [
              {
                source: 'kyberswap',
                status: 'measurement_failed' as const,
                errorCode: 'provider_policy_refused',
                quoteEvidence: null,
              },
            ],
          }),
        ],
      }),
      choice: null,
      now: NOW,
    })!.representations[0]!;

  test('it is not the market, not our coverage, and not our failure', () => {
    const card = refused();
    assert.equal(card.outcome, 'policy_refused');
    for (const collapsed of ['no_route', 'unsupported_token', 'provider_failed']) {
      assert.notEqual(card.outcome, collapsed);
    }
    // Storage folds a refusal into `measurement_failed`, so reading the row
    // status before the error code would have filed it under our name.
    assert.equal(card.attribution, 'the venue');
  });

  test('the chip and the body say what happened and stop there', () => {
    const card = refused();
    assert.equal(card.outcomeChip, 'Venue declined to quote');
    assert.match(card.outcomeBody, /declined to quote it/);
    assert.match(card.outcomeBody, /other sources were still asked/);
    // No legal or moral inference about the reader or the asset.
    for (const overclaim of [/you are not eligible/i, /prohibited/i, /restricted asset/i, /illegal/i]) {
      assert.doesNotMatch(card.outcomeBody, overclaim);
    }
    // And never the market's vocabulary for absence.
    assert.doesNotMatch(card.outcomeBody, /no route/i);
  });
});

describe('Use & access answers first and documents second', () => {
  test('the four measured sections open, the two documentation sections fold', () => {
    // A reader asking "can I trade this" was getting four short answers
    // followed by several screens of eligibility and authorized-participant
    // prose. Collapsed is not hidden: both sections keep their heading and
    // their verdict chip, which is the whole of what they conclude.
    const sections = useSectionsV1({
      use: null,
      groups: [],
      exit: null,
      exitBasis: null,
      openQuote: null,
      lastMeasuredLabel: null,
      outcomeBody: 'A router quoted this exact size and the quote is still open.',
      caip10: 'eip155:8453/erc20:0xb20000000000000000000078ee7ce2fe4908108c',
    });
    const folded = sections.filter((section) => section.collapsed).map((section) => section.id);
    assert.deepEqual(folded, ['issuer', 'how_it_works']);
    for (const section of sections) {
      assert.ok(section.chip.length > 0, `${section.id} folds away without a verdict`);
    }
  });
});

// ---------------------------------------------------------------------------
// One authority for whether a quote is open.
//
// Production, 2026-09-04: one card carried `Priced now` in its header, `NOW ·
// No live quote` in its strip, and "A router quoted this exact size and the
// quote is still open" in its body. Three statements about one quote, two of
// them false, because the header read a status stamped at assembly and the
// strip read the clock.
// ---------------------------------------------------------------------------

describe('the chip and the strip cannot disagree about a quote', () => {
  /** A representation the server assembled as `full`, read at `readAt`. */
  const card = (readAt: string) =>
    marketRealityViewV1({ wire: openSellWireV1(), choice: null, now: readAt })!.representations[0]!;

  test('inside the window: priced, live, and a countdown', () => {
    const open = card(NOW);
    assert.equal(open.outcome, 'priced');
    assert.equal(open.outcomeChip, 'Priced now');
    assert.equal(open.openQuote?.state, 'live');
    assert.match(open.outcomeBody, /still open/);
  });

  test('past the window: lapsed everywhere, on the same payload', () => {
    // Nothing about the response changed — only the clock. Twenty-two seconds
    // is the ordinary case: a router quote lives about twenty.
    const late = card('2026-08-26T20:35:41.000Z');
    assert.equal(late.outcome, 'lapsed');
    assert.equal(late.outcomeChip, 'Price expired');
    assert.equal(late.openQuote?.state, 'none');
    assert.doesNotMatch(late.outcomeBody, /still open/);
    assert.match(late.outcomeBody, /has since expired/);
  });

  test('no reading of a payload puts an open chip over a closed strip', () => {
    // The invariant itself, swept across the window rather than sampled at two
    // points: whatever the clock says, the two halves of the card agree.
    for (let second = 0; second <= 120; second += 1) {
      const at = new Date(Date.parse(NOW) + second * 1000).toISOString();
      const read = card(at);
      assert.equal(
        read.outcome === 'priced',
        read.openQuote?.state === 'live',
        `at +${second}s the header says ${read.outcomeChip} and the strip says ${read.openQuote?.state}`,
      );
    }
  });

  test('a stamped `open` flag never outranks the clock', () => {
    // The flag is written when the response is assembled and cannot expire. One
    // production representation carried `open: true` beside a window that had
    // closed thirty-nine minutes earlier.
    assert.equal(
      representationOutcomeV1(
        representation({
          status: 'full',
          liveness: 'live',
          lastObservation: { ...LAPSED_OBSERVATION, open: true },
          sources: [LAPSED_SOURCE],
        }),
        NOW,
      ),
      'lapsed',
    );
  });
});

// ---------------------------------------------------------------------------
// The venue that held the money, not the aggregator that answered.
// ---------------------------------------------------------------------------

describe('a priced card names the pool the number went through', () => {
  // The exact production reference, from the stored NVDAc run on 2026-09-04.
  const AERODROME_POOL = 'eip155:8453/aerodrome-cl-3:0x853f5f1b92b16714fe6cda67caad0856b83c7ab9';

  test('Aerodrome is named, with the exact pool', () => {
    // Base's product page says these stocks have deep liquidity on Aerodrome.
    // Every priced card here was already routing through an Aerodrome CL pool
    // and reporting only "kyberswap", so the product looked like it had missed
    // the one venue it was in fact measuring.
    const view = routedThroughV1({ source: 'kyberswap', liquiditySources: [AERODROME_POOL] });
    assert.equal(view?.headline, 'Priced by kyberswap · routed through Aerodrome CL');
    assert.deepEqual(view?.venues, [
      {
        label: 'Aerodrome CL',
        poolAddress: '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9',
        named: true,
      },
    ]);
  });

  test('a venue with no pool address is not evidence of a venue', () => {
    // The same production route carried `elfomofi:unknown`. A name the router
    // could not attach to an address cannot be checked against the chain, and
    // printing it would put an unverifiable venue on screen.
    assert.equal(
      routedThroughV1({ source: 'kyberswap', liquiditySources: ['eip155:8453/elfomofi:unknown'] }),
      null,
    );
    const mixed = routedThroughV1({
      source: 'kyberswap',
      liquiditySources: [AERODROME_POOL, 'eip155:8453/elfomofi:unknown'],
    });
    assert.equal(mixed?.venues.length, 1);
  });

  test('an unknown protocol keeps its slug rather than being dressed up', () => {
    // Same rule as every other provider label in this console: the registry is
    // code-owned, so a router cannot name a venue on our screen.
    const view = routedThroughV1({
      source: 'kyberswap',
      liquiditySources: ['eip155:8453/some-new-dex:0x1111111111111111111111111111111111111111'],
    });
    assert.equal(view?.venues[0]?.label, 'some-new-dex');
    assert.equal(view?.venues[0]?.named, false);
  });

  test('one pool crossed twice is one venue', () => {
    const view = routedThroughV1({
      source: 'kyberswap',
      liquiditySources: [AERODROME_POOL, AERODROME_POOL],
    });
    assert.equal(view?.venues.length, 1);
  });

  test('nothing priced, nothing routed', () => {
    assert.equal(routedThroughV1(null), null);
    assert.equal(routedThroughV1({ source: 'kyberswap', liquiditySources: [] }), null);
    // An older payload carries no field at all rather than an empty one.
    assert.equal(routedThroughV1({ source: 'kyberswap' }), null);
  });

  test('the line is a claim about attribution, never about price', () => {
    const view = routedThroughV1({ source: 'kyberswap', liquiditySources: [AERODROME_POOL] });
    // It must not read as "Aerodrome quoted this". Miorail's own Aerodrome
    // adapter still cannot quote a concentrated-liquidity pool and refuses.
    assert.doesNotMatch(view?.headline ?? '', /Aerodrome quoted|quoted by Aerodrome/i);
    assert.match(view?.note ?? '', /factory\(\)/);
  });

  test('a lapsed card routes through nothing', () => {
    // The venue line sits beside a live figure. A pool a route went through
    // forty minutes ago is not where a trade would go now.
    const late = marketRealityViewV1({
      wire: openSellWireV1(),
      choice: null,
      now: '2026-08-26T20:35:41.000Z',
    })!.representations[0]!;
    assert.equal(late.outcome, 'lapsed');
    assert.equal(late.routedThrough, null);
  });
});

// ---------------------------------------------------------------------------
// Availability is not quality.
// ---------------------------------------------------------------------------

describe('a card grades the answer separately from having one', () => {
  const at = (bps: string) => {
    const bare = marketRealityViewV1({ wire: openSellWireV1(), choice: null, now: NOW })!;
    const address = bare.representations[0]!.tokenAddress.toLowerCase();
    return marketRealityViewV1({
      wire: openSellWireV1(),
      choice: null,
      now: NOW,
      ladders: {
        [address]: {
          rungs: [],
          note: null,
          exit: {
            roundTripCostBps: bps,
            requestedCashAtomic: '1000000000',
            returnedCashAtomic: '940000',
            basis: 'open' as const,
            observedAt: NOW,
          },
        },
      },
    })!.representations[0]!;
  };

  test('the availability chip is the same colour whatever the answer costs', () => {
    // The defect, exactly: a COIN card reading `$1,000 in → $0.94 back` wore
    // the same success green as one reading `$999.72 back`, because the one
    // chip on the card reported that a router had answered.
    for (const bps of ['2', '400', '9990']) {
      assert.equal(at(bps).outcomeTone, 'neutral', `${bps} bps moved the availability chip`);
      assert.equal(at(bps).outcomeChip, 'Priced now');
    }
  });

  test('the cost chip is where the economics are, and it moves', () => {
    assert.equal(at('2').exitCost?.tone, 'good');
    assert.equal(at('400').exitCost?.tone, 'warn');
    assert.equal(at('9990').exitCost?.tone, 'bad');
    assert.equal(at('9990').exitCost?.chip, 'Round trip 99.90%');
  });

  test('an unmeasured round trip is never graded', () => {
    // `off` is the word for an absence and it belongs on the withheld rows. A
    // coloured chip over nothing measured would read as a verdict about the
    // market.
    const bare = marketRealityViewV1({ wire: openSellWireV1(), choice: null, now: NOW })!;
    assert.equal(bare.representations[0]!.exitCost, null);
    assert.equal(exitCostViewV1(null), null);
  });
});

// ---------------------------------------------------------------------------
// The exit line, in money.
// ---------------------------------------------------------------------------

describe('what a round trip costs, said as money first', () => {
  const at = (over: Record<string, unknown>) => {
    const bare = marketRealityViewV1({ wire: wire(), choice: null, now: NOW })!;
    const address = bare.representations[0]!.tokenAddress.toLowerCase();
    return marketRealityViewV1({
      wire: wire(),
      choice: null,
      now: NOW,
      ladders: {
        [address]: {
          rungs: [],
          note: null,
          exit: { basis: 'last_measured', observedAt: NOW, ...over } as never,
        },
      },
    })!.representations[0]!.exit!;
  };

  test('both sides measured: the reader sees money, then the percentage', () => {
    // "Round trip: 65.72%" is arithmetic somebody has to do something with.
    // "$1,000 in → $342.80 back" is the same measurement, read rather than
    // computed, and needs no DeFi vocabulary at all.
    const bad = at({
      roundTripCostBps: '6572',
      requestedCashAtomic: '1000000000',
      returnedCashAtomic: '342800000',
    });
    assert.equal(bad.value, '$1,000 in → $342.80 back');
    assert.match(bad.note ?? '', /Total cost to buy and exit: 65\.72%/);
    // `bad`, not `off`. `off` is this console's word for nothing having been
    // measured; a round trip that returned a third of the money is a
    // measurement, and past ten times the reviewed bound it is not the same
    // finding as a trade that costs a few percent.
    assert.equal(bad.tone, 'bad');
    // Never "no route": a route existed and answered.
    assert.doesNotMatch(bad.note ?? '', /no route/i);
    assert.doesNotMatch(bad.note ?? '', /bps/);

    const good = at({
      roundTripCostBps: '32',
      requestedCashAtomic: '1000000000',
      returnedCashAtomic: '996800000',
    });
    assert.equal(good.value, '$1,000 in → $996.80 back');
    assert.match(good.note ?? '', /Total cost to buy and exit: 0\.32%/);
    assert.equal(good.tone, 'good');
  });

  test('one side unmeasured falls back to the percentage, never a rebuilt figure', () => {
    // The percentage is derived FROM the two amounts. Reconstructing an amount
    // out of it would print money that was never measured.
    const only = at({
      roundTripCostBps: '32',
      requestedCashAtomic: '1000000000',
      returnedCashAtomic: null,
    });
    assert.equal(only.value, '0.32%');
    assert.equal(only.label, 'Cost to buy and exit');
    assert.doesNotMatch(only.value, /\$/);
  });
});

describe('Phase 17.1 — the answer, then the evidence', () => {
  const LADDER = [
    { label: '$100', value: 'not covered', note: 'measured 28 min ago', tone: 'warn' as const },
    { label: '$1,000', value: 'not covered', note: 'measured 28 min ago', tone: 'warn' as const },
    { label: '$10,000', value: 'not covered', note: 'measured 28 min ago', tone: 'warn' as const },
    { label: '$100,000', value: 'not covered', note: 'measured 28 min ago', tone: 'warn' as const },
  ];

  test('four rungs saying one thing become one line that keeps both ends', () => {
    const collapsed = collapseLadderRungsV1(LADDER);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0]?.label, '$100 – $100,000');
    assert.equal(collapsed[0]?.value, 'not covered');
    assert.equal(collapsed[0]?.note, 'measured 28 min ago');
    assert.equal(collapsed[0]?.tone, 'warn');
  });

  test('one size differing brings every size back', () => {
    const mixed = [...LADDER.slice(0, 3), { ...LADDER[3]!, value: '0.50%', tone: 'good' as const }];
    assert.deepEqual(collapseLadderRungsV1(mixed), mixed);
    // Same value, different age is still two findings.
    const restaggered = [LADDER[0]!, { ...LADDER[1]!, note: 'measured 4h ago' }];
    assert.equal(collapseLadderRungsV1(restaggered).length, 2);
  });

  test('a single rung and an empty ladder are left exactly as they are', () => {
    assert.deepEqual(collapseLadderRungsV1([]), []);
    assert.deepEqual(collapseLadderRungsV1([LADDER[0]!]), [LADDER[0]!]);
  });

  test('the ladder on a card is the collapsed one', () => {
    const bare = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const address = bare!.representations[0]!.tokenAddress.toLowerCase();
    const view = marketRealityViewV1({
      wire: wire(),
      choice: null,
      now: NOW,
      ladders: { [address]: { rungs: LADDER, note: 'Exact sizes only.' } },
    });
    assert.deepEqual(
      view?.representations[0]?.ladder.map((rung) => rung.label),
      ['$100 – $100,000'],
    );
  });

  test('a withheld fact has a reason and no value field to render', () => {
    const split = splitEstablishedFactsV1([
      { label: 'Cash back', value: '$999.00', note: 'history', tone: 'off' },
      { label: 'Effective price', value: '—', note: "the share ratio isn't confirmed", tone: 'neutral' },
      { label: 'Basis withheld', value: '—', note: null, tone: 'neutral' },
    ]);
    assert.deepEqual(split.established.map((fact) => fact.label), ['Cash back']);
    assert.deepEqual(split.withheld.map((fact) => fact.label), ['Effective price', 'Basis withheld']);
    assert.equal(split.withheld[0]?.note, "the share ratio isn't confirmed");
    // A withheld row with no reason at all would be the original defect wearing
    // a new name, so the type has no way to carry an empty one.
    assert.equal(split.withheld[1]?.note, 'not established');
    for (const fact of split.withheld) {
      assert.equal('value' in fact, false, `${fact.label} must carry no value`);
    }
  });

  test('the utility answer buckets the same edges by the same states', () => {
    const edge = (edgeId: string, label: string, state: string) => ({
      edgeId, label, state, stateLabel: state, checkedAt: NOW, checkedAgo: 'just now',
      providerLabel: null, note: '', eligibilityNote: '', sources: [],
    });
    const answer = utilityAnswerV1([
      { label: 'Market reachability', edges: [edge('market_trade', 'Trade at this size', 'observed')] as never },
      {
        label: 'Issuer lifecycle',
        edges: [
          edge('issuer_primary_market', 'Primary issue and redemption', 'documented'),
          edge('issuer_bridge', 'Bridge', 'not_established'),
        ] as never,
      },
    ]);
    assert.match(answer.headline, /Established right now/);
    assert.deepEqual(
      answer.buckets.map((bucket) => [bucket.label, bucket.items]),
      [
        ['Established right now', ['Trade at this size']],
        ['Documented by the issuer', ['Primary issue and redemption']],
        ['Not established', ['Bridge']],
      ],
    );
  });

  test('with nothing observed, the answer says so instead of leading with documents', () => {
    const edge = (edgeId: string, label: string, state: string) => ({
      edgeId, label, state, stateLabel: state, checkedAt: NOW, checkedAgo: 'just now',
      providerLabel: null, note: '', eligibilityNote: '', sources: [],
    });
    const answer = utilityAnswerV1([
      { label: 'Issuer lifecycle', edges: [edge('issuer_bridge', 'Bridge', 'not_established')] as never },
    ]);
    assert.match(answer.headline, /Nothing is established at this exact address yet/);
    assert.match(answer.headline, /gap in evidence, not a property of the token/);
    assert.equal(answer.buckets.length, 1);
    // An empty bucket is not rendered as an empty heading.
    assert.equal(answer.buckets.some((bucket) => bucket.items.length === 0), false);
  });

  test('a real card carries an answer built from its own edges', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const utility = view!.representations[0]!.utility;
    assert.ok(utility.answer.headline.length > 0);
    const named = new Set(utility.answer.buckets.flatMap((bucket) => bucket.items));
    for (const group of utility.groups) {
      for (const edge of group.edges) {
        assert.ok(named.has(edge.label), `${edge.label} must appear in the answer`);
      }
    }
  });
});

describe('Phase 17.2 — NOW is short-lived, LAST MEASURED is not', () => {
  const OPEN_SOURCE = {
    ...LAPSED_SOURCE,
    status: 'quoted' as const,
    quoteEvidence: { ...LAPSED_SOURCE.quoteEvidence, expiresAt: '2026-08-26T20:34:36.000Z' },
  };

  function openCard(now: string) {
    return marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            status: 'full',
            liveness: 'live',
            lastObservation: { ...LAPSED_OBSERVATION, open: true },
            sources: [OPEN_SOURCE],
            returnedCashAtomic: '99952618',
          }),
        ],
      }),
      choice: null,
      now,
      ladders: {
        [COINBASE_NVDA]: {
          rungs: [{ label: '$100', value: '0.09%', note: 'measured 28 min ago', tone: 'good' }],
          note: 'Exact sizes only, quoted through KyberSwap.',
          exit: {
            roundTripCostBps: '9',
            requestedCashAtomic: '100000000',
            returnedCashAtomic: '99910000',
            observedAt: '2026-08-26T20:06:00.000Z',
            basis: 'last_measured',
          },
        },
      },
    });
  }

  test('an open quote counts down, in whole seconds', () => {
    assert.equal(expiresInLabelV1('2026-08-26T20:34:36.000Z', NOW), 'Expires in 17s');
    assert.equal(expiresInLabelV1('2026-08-26T20:34:19.400Z', NOW), 'Expires in 1s');
    // At and past expiry nothing is open, so the strip claims nothing.
    assert.equal(expiresInLabelV1('2026-08-26T20:34:19.000Z', NOW), null);
    assert.equal(expiresInLabelV1('2026-08-26T20:34:10.000Z', NOW), null);
    assert.equal(expiresInLabelV1(null, NOW), null);
  });

  test('NOW says the round trip in the same words the stored answer does', () => {
    const strip = openCard(NOW)?.representations[0]?.openQuote;
    assert.equal(strip?.state, 'live');
    assert.equal(strip?.value, '$100 in \u2192 $99.95 back');
    assert.equal(strip?.expiresInLabel, 'Expires in 17s');
  });

  test('when the quote lapses, ONLY the strip changes', () => {
    const live = openCard(NOW)!.representations[0]!;
    // Twenty seconds later: past this quote's own expiry.
    const lapsed = openCard('2026-08-26T20:34:39.000Z')!.representations[0]!;

    assert.equal(live.openQuote?.state, 'live');
    assert.equal(lapsed.openQuote?.state, 'none');
    assert.equal(lapsed.openQuote?.expiresInLabel, null);

    // The durable half is byte-identical across the lapse. This is the whole
    // point: a card that emptied itself twenty seconds after a measurement is
    // what made Stocks look like it had no data.
    // Same money, same tone, same label. Only the AGE moves, because an age is
    // supposed to move — what must not move is the answer.
    assert.equal(lapsed.exit?.value, live.exit?.value);
    assert.equal(lapsed.exit?.label, live.exit?.label);
    assert.equal(lapsed.exit?.tone, live.exit?.tone);
    assert.equal(lapsed.exitBasis, 'last_measured');
    assert.deepEqual(lapsed.ladder, live.ladder);
    assert.ok(lapsed.exit, 'the stored round trip survives the lapse');
    assert.match(lapsed.exit!.value, /in \u2192 .* back/);
    assert.ok(lapsed.numbers.length > 0, 'the value grid is not emptied by an expiry');
    assert.ok(lapsed.lastMeasuredLabel, 'and it still says when it was measured');
  });

  test('a stored round trip is marked as stored, not as live', () => {
    const card = openCard('2026-08-26T20:34:39.000Z')!.representations[0]!;
    assert.equal(card.exitBasis, 'last_measured');
    assert.match(card.exit?.note ?? '', /measured/);
    assert.doesNotMatch(card.exit?.note ?? '', /open quote/);
  });
});

describe('Phase 17.2 — markets first, reviewed-and-empty second', () => {
  const choice = (key: string, emptyNote: string | null) => ({
    underlyingKey: key, title: key, identifier: null, issuerLine: 'Coinbase',
    issuerIds: ['coinbase'], representationCount: 1, multiIssuer: false, emptyNote,
  });

  test('a security whose supply read came back zero moves below the markets', () => {
    const split = partitionChoicesBySupplyV1([
      choice('NVDA', null),
      choice('MSFT', 'No tokens outstanding'),
      choice('GOOGL', null),
      choice('CRCL', 'No tokens outstanding'),
    ] as never);
    assert.deepEqual(split.live.map((row) => row.underlyingKey), ['NVDA', 'GOOGL']);
    assert.deepEqual(split.empty.map((row) => row.underlyingKey), ['MSFT', 'CRCL']);
  });

  test('an unread security is not an empty one', () => {
    // `emptyNote` is set only when supply was read and came back zero on every
    // contract. Never-read stays with the markets rather than being filed as
    // empty on evidence nobody has.
    const split = partitionChoicesBySupplyV1([choice('UNREAD', null)] as never);
    assert.deepEqual(split.live.map((row) => row.underlyingKey), ['UNREAD']);
    assert.deepEqual(split.empty, []);
  });

  test('nothing is dropped', () => {
    const rows = [choice('A', null), choice('B', 'No tokens outstanding')] as never;
    const split = partitionChoicesBySupplyV1(rows);
    assert.equal(split.live.length + split.empty.length, 2);
  });
});

describe('Phase 17.4 — Use & access answers, then cites', () => {
  const base = {
    groups: [],
    exit: null,
    exitBasis: null as 'open' | 'last_measured' | null,
    openQuote: null,
    lastMeasuredLabel: null,
    outcomeBody: 'Nothing has been measured at this size yet.',
    caip10: 'eip155:8453:0xb20000000000000000000078ee7ce2fe4908108c',
  };
  const use = (over: Record<string, unknown> = {}) =>
    ({
      schemaVersion: 'representation-use-access/v1',
      chainId: 8453,
      tokenAddress: '0xb20000000000000000000078ee7ce2fe4908108c',
      caip10: base.caip10,
      blockTag: '0x3060000',
      observedAt: NOW,
      transfers: { state: 'read', transfersPaused: false },
      transferPolicies: [
        { scope: 'sender', state: 'bound', policyId: '5', policyExists: true },
        { scope: 'receiver', state: 'bound', policyId: '5', policyExists: true },
        { scope: 'executor', state: 'bound', policyId: '5', policyExists: true },
      ],
      bridge: { state: 'none_detected' },
      defi: { checkedVenues: ['Moonwell', 'Morpho'], venues: [] },
      wallet: null,
      ...over,
    }) as never;

  test('the six sections are in the order a person asks', () => {
    const sections = useSectionsV1({ ...base, use: use() });
    assert.deepEqual(sections.map((section) => section.id), [
      'trade',
      'transfer',
      'bridge',
      'defi',
      'issuer',
      'how_it_works',
    ]);
  });

  test('an expired quote does not un-measure a trade', () => {
    // The bug this replaces: Trade read only the twenty-second quote, so a
    // round trip measured half an hour ago and rendered in full on Market
    // Reality read here as "Stale".
    const sections = useSectionsV1({
      ...base,
      use: use(),
      exit: { label: 'Buying in and selling back out', value: '$100 in → $99.91 back', note: 'measured 28 min ago', tone: 'good' },
      exitBasis: 'last_measured',
      lastMeasuredLabel: 'Last measured 28 min ago',
      openQuote: { state: 'none', value: 'No live quote', note: null, expiresInLabel: null },
    });
    const trade = sections[0]!;
    assert.equal(trade.chip, 'Tradable when measured');
    assert.doesNotMatch(trade.headline, /Stale|not established/i);
    assert.match(trade.headline, /measurement stands/);
    assert.equal(trade.facts.length, 1);
  });

  test('a live quote sits above the stored answer, not instead of it', () => {
    const sections = useSectionsV1({
      ...base,
      use: use(),
      exit: { label: 'Buying in and selling back out', value: '$100 in → $99.91 back', note: 'measured 28 min ago', tone: 'good' },
      exitBasis: 'last_measured',
      openQuote: { state: 'live', value: '$100 in → $99.95 back', note: null, expiresInLabel: 'Expires in 17s' },
    });
    assert.equal(sections[0]!.chip, 'Tradable now');
    assert.deepEqual(sections[0]!.facts.map((fact) => fact.label), [
      'Open right now',
      'Buying in and selling back out',
    ]);
  });

  test('transfers say active or paused, and no id leaves Evidence', () => {
    const active = useSectionsV1({ ...base, use: use() })[1]!;
    assert.equal(active.chip, 'Transfers active');
    assert.equal(active.tone, 'good');

    const paused = useSectionsV1({
      ...base,
      use: use({ transfers: { state: 'read', transfersPaused: true } }),
    })[1]!;
    assert.equal(paused.chip, 'Transfers paused');
    assert.equal(paused.tone, 'warn');

    // Policy numbers, selectors and the block are Evidence, never a headline.
    const visible = JSON.stringify([active.headline, active.facts]);
    assert.doesNotMatch(visible, /policy 5|0x3060000|ALWAYS_ALLOW|bc61e733/);
    assert.match(JSON.stringify(active.evidence), /policy 5/);
    assert.match(JSON.stringify(active.evidence), /0x3060000/);
  });

  test('approve() is an Evidence line, not a card', () => {
    const transfer = useSectionsV1({ ...base, use: use() })[1]!;
    assert.match(
      JSON.stringify(transfer.evidence),
      /an approval is not permission to transfer/,
    );
    assert.doesNotMatch(JSON.stringify(transfer.facts), /approve/i);
  });

  test('the wallet answer names the scope and never claims more than a policy read', () => {
    const transfer = useSectionsV1({
      ...base,
      use: use({
        wallet: {
          address: '0xdead00000000000000000000000000000000beef',
          checks: [
            { scope: 'sender', state: 'allowed', policyId: '5' },
            { scope: 'receiver', state: 'blocked', policyId: '5' },
            { scope: 'executor', state: 'not_confirmed', reason: 'the policy was not checked for this address' },
          ],
        },
      }),
    })[1]!;
    assert.deepEqual(
      transfer.facts.map((fact) => [fact.label, fact.value]),
      [
        ['Transfers', 'Active'],
        ['Your wallet can send', 'Yes'],
        ['Your wallet can receive', 'No'],
        ['Route executor checked', 'Not confirmed'],
      ],
    );
    assert.doesNotMatch(JSON.stringify(transfer), /KYC|jurisdiction|accredited|permission to trade/i);
  });

  test('a bridge is claimed only for a destination that is really configured', () => {
    const none = useSectionsV1({ ...base, use: use() })[2]!;
    assert.equal(none.chip, 'No bridge here');
    assert.match(none.headline, /No bridge capability answers at this exact address/);

    const capable = useSectionsV1({
      ...base,
      use: use({ bridge: { state: 'detected', endpointAddress: '0x1a44', configuredPeers: [] } }),
    })[2]!;
    assert.equal(capable.chip, 'Bridge capability detected');
    assert.match(capable.headline, /no destination Miorail checked is configured/);

    const established = useSectionsV1({
      ...base,
      use: use({ bridge: { state: 'detected', endpointAddress: '0x1a44', configuredPeers: [30101] } }),
    })[2]!;
    assert.equal(established.chip, 'Bridge established');
    assert.match(established.headline, /configured at this exact address to Ethereum/);
  });

  test('a lending miss names the venues, and never claims the token is out of DeFi', () => {
    // The section checked four LENDING venues and was labelled "DeFi", so a
    // screen whose Trade section read "Tradable now" said "DeFi · none found
    // here" two sections below it. Both true of what they measured; the one
    // with the broader word measured the narrower thing.
    const defi = useSectionsV1({ ...base, use: use() })[3]!;
    assert.equal(defi.label, 'Lend and borrow');
    assert.match(defi.headline, /No reviewed lending venue lists this exact address \(Moonwell, Morpho were checked\)/);
    assert.match(defi.headline, /Other venues exist and were not checked/);
    assert.doesNotMatch(defi.headline, /not in DeFi|no DeFi|unavailable/i);
    // Bounded to the question asked, not a verdict on the token.
    assert.equal(defi.chip, 'Not on these venues');
  });

  test('a found integration leads with the use, per axis', () => {
    const defi = useSectionsV1({
      ...base,
      use: use({
        defi: {
          checkedVenues: ['Moonwell', 'Morpho'],
          venues: [
            {
              venueId: 'moonwell',
              venueName: 'Moonwell',
              state: 'listed',
              uses: { lend: true, borrow: null, collateral: true },
              marketRef: '0xabc',
              reason: null,
            },
          ],
        },
      }),
    })[3]!;
    assert.equal(defi.chip, 'Integration found');
    assert.deepEqual(defi.facts.map((fact) => fact.label), ['Lend', 'Collateral']);
    assert.doesNotMatch(JSON.stringify(defi.facts), /Borrow/);
  });

  // The envelope's `blockTag` never covered these rows: two venues answer from
  // chain state at head, two from catalogues with no block at all. A reviewer
  // read the block as covering all four, because nothing said otherwise.
  test('the venue rows name their own axis, and disown the block above', () => {
    const defi = useSectionsV1({
      ...base,
      use: use({
        blockTag: '0x3060000',
        defi: {
          checkedVenues: ['Moonwell', 'Aave v3'],
          venues: [
            {
              venueId: 'moonwell',
              venueName: 'Moonwell',
              state: 'not_listed',
              uses: { lend: null, borrow: null, collateral: null },
              marketRef: null,
              reason: null,
              observed: { source: 'venue_catalogue', at: '2026-09-05T09:00:01.000Z' },
            },
            {
              venueId: 'aave_v3',
              venueName: 'Aave v3',
              state: 'not_listed',
              uses: { lend: null, borrow: null, collateral: null },
              marketRef: null,
              reason: null,
              observed: { source: 'chain_head', at: '2026-09-05T09:00:02.000Z' },
            },
          ],
        },
      }),
    })[3]!;
    const row = defi.evidence.find((entry) => entry.label === 'How these were read');
    assert.ok(row, 'the DeFi section states how its rows were read');
    assert.match(row!.value, /Aave v3 — read on chain at head/);
    assert.match(row!.value, /Moonwell — read from the venue’s own catalogue/);
    assert.match(row!.value, /the block under Transfer covers none of them/);
    // And the block itself never appears on this section at all.
    assert.doesNotMatch(JSON.stringify(defi), /0x3060000/);
  });

  test('a reply with no provenance states none, rather than guessing one', () => {
    const defi = useSectionsV1({
      ...base,
      use: use({
        defi: {
          checkedVenues: ['Moonwell'],
          venues: [
            {
              venueId: 'moonwell',
              venueName: 'Moonwell',
              state: 'not_listed',
              uses: { lend: null, borrow: null, collateral: null },
              marketRef: null,
              reason: null,
            },
          ],
        },
      }),
    })[3]!;
    assert.equal(
      defi.evidence.find((entry) => entry.label === 'How these were read'),
      undefined,
    );
  });

  // -------------------------------------------------------------------------
  // Base announced, on 24 Aug 2026, that these stocks are collateral on Aave.
  // Aave's reserve list on Base holds fifteen reserves and not one B20 address.
  // Both are true, and the card used to print only the second one to a reader
  // who had just read the first — who then concludes our data is stale.
  // -------------------------------------------------------------------------
  const withAave = (over: Record<string, unknown>) =>
    use({
      defi: {
        checkedVenues: ['Moonwell', 'Morpho', 'Aave v3', 'Compound v3'],
        venues: [
          {
            venueId: 'aave_v3',
            venueName: 'Aave v3',
            state: 'not_listed',
            uses: { lend: null, borrow: null, collateral: null },
            curated: null,
            marketRef: null,
            reason: null,
            ...over,
          },
        ],
      },
    });

  test('an announced venue that has not listed the address says so, with the date', () => {
    const defi = useSectionsV1({ ...base, issuerId: 'coinbase', use: withAave({}) })[3]!;
    const fact = defi.facts.find((entry) => entry.label === 'Announced at Aave v3');
    assert.ok(fact);
    assert.equal(fact.value, 'Not there yet');
    assert.match(fact.note ?? '', /Base announced use as collateral at Aave v3 on 24 Aug 2026/);
    assert.match(fact.note ?? '', /does not list this exact address/);
    assert.match(fact.note ?? '', /Announced is not the same as live/);
    assert.ok(
      defi.evidence.some(
        (row) => row.label === 'Base announcement' && /blog\.base\.org/.test(row.value),
      ),
    );
  });

  test('an announcement never becomes a use, a chip or a colour', () => {
    const defi = useSectionsV1({ ...base, issuerId: 'coinbase', use: withAave({}) })[3]!;
    assert.equal(defi.tone, 'off');
    assert.equal(defi.chip, 'Not on these venues');
    assert.doesNotMatch(defi.headline, /used in DeFi/);
    assert.deepEqual(
      defi.facts.filter((entry) => ['Lend', 'Borrow', 'Collateral'].includes(entry.label)),
      [],
    );
    for (const entry of defi.facts) assert.notEqual(entry.tone, 'good');
  });

  test('a venue nobody checked is not a venue that refused', () => {
    const defi = useSectionsV1({ ...base, issuerId: 'coinbase', use: use() })[3]!;
    const fact = defi.facts.find((entry) => entry.label === 'Announced at Aave v3');
    assert.equal(fact?.value, 'Not checked here');
    assert.match(fact?.note ?? '', /not among the venues this reading checked/);
    assert.doesNotMatch(fact?.note ?? '', /does not list/);
  });

  test('a listed reserve still does not say collateral is enabled', () => {
    const defi = useSectionsV1({
      ...base,
      issuerId: 'coinbase',
      use: withAave({ state: 'listed', uses: { lend: true, borrow: true, collateral: null } }),
    })[3]!;
    const fact = defi.facts.find((entry) => entry.label === 'Announced at Aave v3');
    assert.equal(fact?.value, 'Listed, use as collateral not read');
    assert.match(fact?.note ?? '', /venue configuration this reading does not cover/);
  });

  test('an announcement about Coinbase never appears on another issuer', () => {
    for (const issuerId of ['backed', 'dinari'] as const) {
      const defi = useSectionsV1({ ...base, issuerId, use: withAave({}) })[3]!;
      assert.deepEqual(defi.facts, []);
      assert.doesNotMatch(JSON.stringify(defi.evidence), /announcement/i);
    }
  });

  test('with nothing read on chain, every measured section says so and none says no', () => {
    const sections = useSectionsV1({ ...base, use: null });
    for (const section of sections.slice(1, 4)) {
      assert.match(section.headline, /gap in our reading|did not check/);
      assert.doesNotMatch(section.headline, /cannot|is not allowed|no bridge exists/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Which representation a reader meets first.
//
// Three issuers put representations of the same securities on Base, and the
// board treated them as peers. Measured 2026-09-04 at $1,000 SELL: 10 of 13
// Coinbase representations held a cash route, 2 of 21 Backed, 0 of 96 Dinari.
// So the first card a reader saw was usually a contract that cannot be priced,
// on a page whose whole subject is what things cost.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The answer used to sit a full viewport below the controls that produce it:
// title, counters, search, chips, thirteen tiles, a collapsed section, tabs,
// two rails, a question console, a history rail -- and only then the number.
// The card that fixed that must be a PROJECTION, or the page grows a second
// place where a verdict can be decided.
// ---------------------------------------------------------------------------
describe('which corpus is a switch, not a one-way button', () => {
  const wire = (scope: string, coinbase = 13, all = 35) =>
    ({ scope, totals: { coinbaseUnderlyings: coinbase, allUnderlyings: all }, entries: [] }) as never;

  test('both corpora are offered, in the unit the band above counts in', () => {
    const view = stockScopeViewV1(wire('coinbase_b20'))!;
    assert.deepEqual(view.options, [
      { scope: 'coinbase_b20', label: 'Coinbase B20', count: 13 },
      { scope: 'all_representations', label: 'All reviewed', count: 35 },
    ]);
    assert.equal(view.selected, 'coinbase_b20');
  });

  test('the switch lights the corpus actually loaded', () => {
    assert.equal(stockScopeViewV1(wire('all_representations'))!.selected, 'all_representations');
  });

  test('with nothing outside Coinbase there is no second corpus to offer', () => {
    // A switch with one side is not a choice; it is a label pretending to be one.
    const view = stockScopeViewV1(wire('coinbase_b20', 13, 13))!;
    assert.deepEqual(view.options.map((o) => o.scope), ['coinbase_b20']);
    assert.equal(view.other, null);
  });
});

describe('the answer card decides nothing the board has not already decided', () => {
  const rep = (over: Record<string, unknown> = {}) =>
    ({
      tokenAddress: '0xb20000000000000000000078ee7ce2fe4908108c',
      issuerName: 'Coinbase',
      structureLabel: 'B20 asset',
      outcomeChip: 'Tradable now',
      outcomeTone: 'good',
      outcomeBody: 'A router reaches this exact address at this size.',
      attribution: 'the market',
      inComparison: true,
      lastSeen: { label: 'Buying in and selling back out', value: '$1,000 in → $999.12 back', note: 'measured 5 min ago' },
      ...over,
    }) as never;
  const view = (representations: unknown[]) =>
    ({
      title: 'NVDA',
      identifier: 'ISIN US67066G1040',
      questionLine: 'Selling $1,000 worth into USDC',
      representations,
    }) as never;

  test('every field is copied off the card that stays below', () => {
    const headline = stocksHeadlineV1(view([rep()]))!;
    assert.equal(headline.title, 'NVDA');
    assert.equal(headline.questionLine, 'Selling $1,000 worth into USDC');
    assert.equal(headline.representation?.chip, 'Tradable now');
    assert.equal(headline.representation?.tone, 'good');
    assert.equal(headline.representation?.attribution, 'the market');
    assert.deepEqual(headline.representation?.lastSeen, {
      label: 'Buying in and selling back out',
      value: '$1,000 in → $999.12 back',
      note: 'measured 5 min ago',
    });
  });

  test('the lead is the documented standard, never the better number', () => {
    // Backed first in the array, and with the healthier-sounding chip.
    const headline = stocksHeadlineV1(
      view([
        rep({ issuerName: 'Backed', outcomeChip: 'Round trip 0.01%', tokenAddress: '0xbbb0000000000000000000000000000000000001' }),
        rep(),
      ]),
    )!;
    assert.equal(headline.representation?.issuerName, 'Coinbase');
    assert.equal(headline.alternativeCount, 2);
  });

  test('a security with no Coinbase contract leads with nothing rather than a substitute', () => {
    const headline = stocksHeadlineV1(
      view([rep({ issuerName: 'Backed' }), rep({ issuerName: 'Dinari' })]),
    )!;
    assert.equal(headline.representation, null);
    // The board is still the answer, and its size is still stated.
    assert.equal(headline.alternativeCount, 2);
  });

  test('a representation outside the comparison never becomes the headline', () => {
    const headline = stocksHeadlineV1(
      view([rep({ inComparison: false }), rep({ issuerName: 'Backed' })]),
    )!;
    assert.equal(headline.representation, null);
    assert.equal(headline.alternativeCount, 1);
  });

  test('an expired quote does not un-measure the round trip', () => {
    // `lastSeen` is history by construction. The card carries it whatever the
    // twenty-second quote is doing, which is the whole reason it exists.
    const headline = stocksHeadlineV1(view([rep({ outcomeChip: 'Price expired', outcomeTone: 'warn' })]))!;
    assert.equal(headline.representation?.chip, 'Price expired');
    assert.match(headline.representation?.lastSeen?.value ?? '', /999\.12/);
  });

  test('nothing measured says so, rather than showing a dash', () => {
    const headline = stocksHeadlineV1(view([rep({ lastSeen: null })]))!;
    assert.equal(headline.representation?.lastSeen, null);
  });

  test('no view is no card', () => {
    assert.equal(stocksHeadlineV1(null), null);
  });
});

describe('the canonical representation is met first, and the others are still there', () => {
  const card = (issuerName: string, tokenAddress: string) =>
    ({ issuerName, tokenAddress }) as unknown as Parameters<typeof partitionByIssuerRoleV1>[0][number];

  test('Coinbase leads and Backed and Dinari follow, with nothing dropped', () => {
    const { primary, others } = partitionByIssuerRoleV1([
      card('Backed', '0x7e8101a1c322d394b3961498c7d40d2dfa94c392'),
      card('Coinbase', '0xb20000000000000000000078ee7ce2fe4908108c'),
      card('Dinari', '0x92ecf64fdb76e60b76d78a29ad4bf9d38b7b1b97'),
    ]);
    assert.deepEqual(primary.map((row) => row.issuerName), ['Coinbase']);
    assert.deepEqual(others.map((row) => row.issuerName), ['Backed', 'Dinari']);
    // The count is the invariant: this is an order, not a filter.
    assert.equal(primary.length + others.length, 3);
  });

  test('with no Coinbase card there is nothing to be other than', () => {
    // A Backed-only security is a board in its own right. Heading its
    // representations "other" would measure them against a card that is not on
    // the page.
    const { primary, others } = partitionByIssuerRoleV1([
      card('Backed', '0x7e8101a1c322d394b3961498c7d40d2dfa94c392'),
      card('Dinari', '0x92ecf64fdb76e60b76d78a29ad4bf9d38b7b1b97'),
    ]);
    assert.deepEqual(primary, []);
    assert.deepEqual(others, []);
  });
});

describe('a scoped list says what it is a slice of', () => {
  const totals = {
    underlyings: 13,
    boundRepresentations: 13,
    multiIssuerUnderlyings: 0,
    coinbaseUnderlyings: 13,
    allUnderlyings: 35,
  };

  test('the default scope names the standard and offers the wider corpus', () => {
    const scope = stockScopeViewV1({
      scope: 'coinbase_b20',
      entries: [],
      totals,
      observedAt: NOW,
    });
    assert.equal(scope?.title, 'Coinbase Tokenized Stocks');
    // The other 22 are named as somewhere to go, not silently absent — and
    // named in the same unit as the counters beside them. The button used to
    // read `All representations · 35` over a band counting securities, so the
    // one number a reader could compare it against was in the other unit.
    assert.match(scope?.aside ?? '', /35 companies/);
    assert.equal(scope?.other?.scope, 'all_representations');
    assert.equal(scope?.other?.label, 'View all issuers');
    assert.doesNotMatch(scope?.other?.label ?? '', /\d/);
  });

  test('every number on the scope band names the unit it counts', () => {
    // The whole defect, as one assertion: `Securities 13`, `Representations 39`
    // and a button reading `All representations · 35` — thirteen companies,
    // thirty-nine contracts, thirty-five companies, three headings, no units.
    const counters = underlyingCountersV1({
      scope: 'coinbase_b20',
      entries: [],
      totals: { ...totals, underlyings: 13, boundRepresentations: 13 },
      observedAt: NOW,
    });
    for (const counter of counters) {
      assert.match(
        `${counter.label} ${counter.note ?? ''}`,
        /companies|contracts|addresses/i,
        `"${counter.label}" never says what it counts`,
      );
    }
  });

  test('the wide scope says why several contracts for one company is the point', () => {
    const scope = stockScopeViewV1({
      scope: 'all_representations',
      entries: [],
      totals,
      observedAt: NOW,
    });
    assert.match(scope?.title ?? '', /Every reviewed representation/);
    assert.match(scope?.body ?? '', /not economically identical/);
    assert.equal(scope?.other?.scope, 'coinbase_b20');
  });

  test('a wire without the corpus totals claims no scope at all', () => {
    // Older payloads carry neither count. Inventing "13 of 13" from a page is
    // exactly the false floor this panel exists to prevent.
    assert.equal(
      stockScopeViewV1({
        entries: [],
        totals: { underlyings: 13, boundRepresentations: 13, multiIssuerUnderlyings: 0 },
        observedAt: NOW,
      }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 17.5 — the issuer's verdict about this wallet, as one line.
//
// The gate fails open by construction. That makes the `not_established` case
// the important one to render: a surface that shows nothing lets a reader
// conclude somebody checked and found nothing wrong, when in fact nobody could
// reach the registry.
// ---------------------------------------------------------------------------
describe('the issuer policy line says which of the three states it is in', () => {
  test('a denial is the only state that carries weight, and the only one that blocks', () => {
    for (const [direction, expected] of [
      ['buy', /refuses this purchase/],
      ['sell', /refuses this sale/],
    ] as const) {
      const gate = transferGateViewV1({ state: 'denied', direction, detail: 'because the issuer said so' });
      assert.ok(gate);
      assert.match(gate.label, expected);
      assert.equal(gate.tone, 'bad');
      assert.equal(gate.blocking, true);
    }
  });

  test('an unestablished policy renders as itself, never as reassurance', () => {
    const gate = transferGateViewV1({ state: 'not_established', direction: 'buy', detail: 'nobody answered' });
    assert.ok(gate, 'silence here would read as a completed check');
    assert.match(gate.label, /not established/i);
    assert.equal(gate.tone, 'off');
    assert.equal(gate.blocking, false);
    // Never borrows the vocabulary of a pass.
    assert.doesNotMatch(gate.label, /allow|authorized|clear/i);
  });

  test('an authorized wallet is stated plainly and still blocks nothing', () => {
    const gate = transferGateViewV1({ state: 'authorized', direction: 'sell', detail: 'the registry answered' });
    assert.ok(gate);
    assert.equal(gate.tone, 'good');
    assert.equal(gate.blocking, false);
  });

  test('a verdict with no sentence behind it renders nothing at all', () => {
    // A gate with no explanation is a verdict the reader cannot check, and an
    // empty box says neither "no restriction" nor "we did not look".
    assert.equal(transferGateViewV1(null), null);
    assert.equal(transferGateViewV1(undefined), null);
    assert.equal(transferGateViewV1({ state: 'denied', direction: 'buy' }), null);
    assert.equal(transferGateViewV1({ state: 'denied', direction: 'buy', detail: '' }), null);
  });

  test('an unknown state is treated as not established, never as a pass', () => {
    // A server one version ahead, or a field this build does not know. The safe
    // reading of an unrecognised verdict is that nothing was established.
    const gate = transferGateViewV1({ state: 'something_new', direction: 'buy', detail: 'x'.repeat(50) });
    assert.ok(gate);
    assert.equal(gate.tone, 'off');
    assert.equal(gate.blocking, false);
  });
});

// ---------------------------------------------------------------------------
// Phase 17.5 — the second reading, rendered so it can never pass for the first.
// ---------------------------------------------------------------------------
describe('the pool’s own price is a corroboration, never a quote', () => {
  // The real NVDAc/USDC pool, read live 2026-09-04.
  const READ = {
    outcome: 'read',
    token0: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    token1: '0xb20000000000000000000078ee7ce2fe4908108c',
    token0PerToken1: '231.878101242070949243',
    token1PerToken0: '0.00431261078404313',
    sqrtPriceX96: '52029507624582080717065656647',
    blockTag: '0x2222',
    note: 'This is the pool’s own marginal price. It is not a quote.',
  };

  test('the side is chosen by which slot the token occupies', () => {
    // Not by which figure looks more like a dollar amount. NVDAc is token1
    // here, so its price is the token0-per-token1 figure.
    const nvdac = poolSpotViewV1({ wire: READ, tokenAddress: READ.token1 });
    assert.ok(nvdac);
    assert.match(nvdac.headline, /231\.878101242070949243 USDC per token/);

    const usdc = poolSpotViewV1({ wire: READ, tokenAddress: READ.token0 });
    assert.ok(usdc);
    assert.match(usdc.headline, /0\.00431261078404313/);
  });

  test('a pool that does not hold this token renders nothing', () => {
    // Printing either figure would attach a price to the wrong asset.
    assert.equal(
      poolSpotViewV1({ wire: READ, tokenAddress: '0x1111111111111111111111111111111111111111' }),
      null,
    );
  });

  test('the word quote never appears, and the disclaimer always does', () => {
    const view = poolSpotViewV1({ wire: READ, tokenAddress: READ.token1 });
    assert.ok(view);
    assert.doesNotMatch(view.headline, /quote/i);
    assert.match(view.headline, /marginal/i);
    assert.ok(view.note.length > 0, 'a figure with no size attached needs this every time');
    // Neutral, never the success tone: it reports that a reading exists, not
    // that the price is good. The same rule the availability chip follows.
    assert.equal(view.tone, 'neutral');
    // And the raw word is carried, so the arithmetic can be redone.
    assert.equal(view.sqrtPriceX96, READ.sqrtPriceX96);
    assert.equal(view.blockTag, '0x2222');
  });

  test('an absent reading is stated as an absence, in its own words', () => {
    const view = poolSpotViewV1({
      wire: {
        outcome: 'unavailable',
        reason: 'not_aerodrome_cl',
        detail: 'That address does not answer as an Aerodrome pool.',
      },
      tokenAddress: READ.token1,
    });
    assert.ok(view);
    assert.equal(view.price, null);
    // Never `bad`: a reading we could not take is an absence, not a defect in
    // the market. That vocabulary belongs to what a trade costs.
    assert.equal(view.tone, 'off');
    assert.notEqual(view.tone, 'bad');
    assert.match(view.note, /does not answer as an Aerodrome pool/);
  });

  test('nothing at all renders nothing at all', () => {
    assert.equal(poolSpotViewV1({ wire: null, tokenAddress: READ.token1 }), null);
    assert.equal(poolSpotViewV1({ wire: undefined, tokenAddress: READ.token1 }), null);
    // An unavailable reading with no explanation is a verdict nobody can check.
    assert.equal(
      poolSpotViewV1({ wire: { outcome: 'unavailable', reason: 'unreadable' }, tokenAddress: READ.token1 }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// A round trip that returned more than it took.
//
// Found on the review page of a live $0.10 draft: the chip read
// `Round trip -5.29%` in SUCCESS GREEN. `bps <= 200` is true of every negative
// number, so a claimed 5.29% gain wore the colour of a real 0.02% cost.
//
// This is the failure the whole two-chip design exists to prevent, pointed at
// our own arithmetic instead of at the market.
// ---------------------------------------------------------------------------
describe('a round trip cannot claim a gain and wear the success colour', () => {
  const exit = (bps: string) =>
    exitCostViewV1({ roundTripCostBps: bps } as never);

  test('a negative round trip is never good, and never bad either', () => {
    for (const bps of ['-1', '-529', '-9999']) {
      const view = exit(bps);
      assert.ok(view);
      assert.equal(view.grade, 'returned_more_than_taken');
      // Not green: it is not an outcome to rely on.
      assert.notEqual(view.tone, 'good');
      // And not red: nothing here says the market is worse than it is.
      assert.notEqual(view.tone, 'bad');
      assert.equal(view.tone, 'off');
    }
  });

  test('the number stays on screen, and stops reading as a cost', () => {
    const view = exit('-529');
    assert.ok(view);
    // Hiding a measured number would be the other failure.
    assert.match(view.chip, /-5\.29%/);
    // But it must not be taken for a cost.
    assert.match(view.chip, /not a cost reading/);
    assert.match(view.note, /returned more than it took/);
    // The note names the cause rather than blaming the market.
    assert.match(view.note, /separate quotes|rounding/);
  });

  test('the positive bands are untouched', () => {
    assert.equal(exit('2')!.grade, 'within_policy');
    assert.equal(exit('200')!.grade, 'within_policy');
    assert.equal(exit('201')!.grade, 'above_policy');
    assert.equal(exit('1999')!.grade, 'above_policy');
    assert.equal(exit('2000')!.grade, 'most_value_lost');
    assert.equal(exit('9990')!.grade, 'most_value_lost');
    // Zero is a real, and good, round trip.
    assert.equal(exit('0')!.grade, 'within_policy');
  });
});

// ---------------------------------------------------------------------------
// The four clocks.
//
// Every one of these is a case where the card previously borrowed one clock's
// deadline for another fact, or printed a state with no time at all.
// ---------------------------------------------------------------------------
describe('four clocks, four times', () => {
  const at = (id: string, rows: ReturnType<typeof clocksV1>) => rows.find((row) => row.id === id)!;

  test('an expired quote does not stop the round trip clock', () => {
    const rows = clocksV1(
      representation({
        status: 'full',
        liveness: 'history_only',
        observedAt: LAPSED_OBSERVATION.observedAt,
        expiresAt: LAPSED_OBSERVATION.expiresAt,
        lastObservation: LAPSED_OBSERVATION,
        returnedCashAtomic: LAPSED_OBSERVATION.returnedCashAtomic,
      }),
      NOW,
    );
    assert.equal(rows.length, 4);
    // The quote is gone and says only that. Its own lapse age would be the
    // round trip's age minus twenty seconds — the same event, written twice,
    // with two numbers that disagree by a rounding.
    assert.equal(at('quote', rows).state, 'Expired');
    assert.equal(at('quote', rows).detail, null);
    // The measurement is not gone, and is not greyed out for being old.
    assert.equal(at('round_trip', rows).state, 'Measured');
    assert.equal(at('round_trip', rows).detail, '39 min ago');
    assert.equal(at('round_trip', rows).tone, 'neutral');
  });

  test('a live quote counts down while the measurement keeps its own age', () => {
    const rows = clocksV1(
      representation({
        status: 'full',
        liveness: 'live',
        observedAt: '2026-08-26T20:34:09.000Z',
        expiresAt: '2026-08-26T20:34:33.000Z',
        sources: [
          {
            source: 'kyberswap',
            status: 'quoted',
            errorCode: null,
            quoteEvidence: {
              source: 'kyberswap',
              direction: 'sell',
              inputAtomic: '1000000000000000000',
              outputAtomic: '99952618',
              observedAt: '2026-08-26T20:34:09.000Z',
              expiresAt: '2026-08-26T20:34:33.000Z',
              evidenceHash: `0x${'aa'.repeat(32)}`,
              blockNumber: '50000000',
            },
          },
        ],
        lastObservation: { ...LAPSED_OBSERVATION, observedAt: '2026-08-26T20:34:09.000Z',
          expiresAt: '2026-08-26T20:34:33.000Z', open: true },
      }),
      NOW,
    );
    assert.equal(at('quote', rows).state, 'Open');
    assert.match(at('quote', rows).detail ?? '', /^Expires in \d+s$/);
    assert.equal(at('quote', rows).tone, 'good');
    assert.equal(at('round_trip', rows).detail, '10s ago');
  });

  test('a reference nobody reviewed still reports when WE looked', () => {
    const rows = clocksV1(
      representation({
        reference: {
          status: 'unknown',
          session: 'unknown',
          marketSession: 'unknown',
          publicationMode: 'unknown',
          valueAtomic: null,
          decimals: null,
          comparable: false,
          reason: 'No reviewed backed reference/session configuration is established.',
          referenceUpdatedAt: null,
          observedAt: '2026-08-26T20:26:19.000Z',
        },
      }),
      NOW,
    );
    // Ours, and named as ours. The absence of a feed is our coverage, not the
    // issuer's failure, and it still happened at a stated time.
    assert.equal(at('reference', rows).state, 'Not reviewed');
    assert.equal(at('reference', rows).detail, 'we looked 8 min ago');
    assert.equal(at('reference', rows).tone, 'off');
  });

  test('a publishing feed reports the feed clock, never our own', () => {
    const rows = clocksV1(
      representation({
        reference: {
          status: 'fresh',
          session: 'regular_hours',
          marketSession: 'regular_hours',
          publicationMode: 'live_reference',
          valueAtomic: '18023000000',
          decimals: 8,
          comparable: false,
          reason: null,
          referenceUpdatedAt: '2026-08-26T20:32:19.000Z',
          observedAt: '2026-08-26T20:34:15.000Z',
        },
      }),
      NOW,
    );
    assert.equal(at('reference', rows).state, 'Publishing');
    // Two instants exist and the publishing one wins: how recently we read a
    // feed says nothing about how recently the feed moved.
    assert.equal(at('reference', rows).detail, 'published 2 min ago');
    assert.equal(at('reference', rows).tone, 'good');
  });

  test('a stale multiplier reports when we last knew, not that we never did', () => {
    const rows = clocksV1(
      representation({
        normalization: 'not_established',
        normalizationCheckedAt: '2026-08-26T11:34:19.000Z',
        normalizationExpiresAt: '2026-08-26T18:34:19.000Z',
      }),
      NOW,
    );
    assert.equal(at('multiplier', rows).state, 'Window closed');
    assert.equal(at('multiplier', rows).detail, 'read 9h ago');
    assert.equal(at('multiplier', rows).tone, 'off');
  });

  test('an open window with nothing to normalize is not an expired window', () => {
    // Found on production: "Window closed · read 4h ago" against a seven-hour
    // window. Nothing had expired — there was no quote, so nothing asked the
    // ratio to normalize anything, and the fallback wrote the reading off as
    // stale. Two states, one word, and the word blamed the wrong one.
    const rows = clocksV1(
      representation({
        normalization: 'not_established',
        normalizationCheckedAt: '2026-08-26T16:34:19.000Z',
        normalizationExpiresAt: '2026-08-26T23:34:19.000Z',
      }),
      NOW,
    );
    const multiplier = at('multiplier', rows);
    assert.equal(multiplier.state, 'Read, not applied');
    assert.equal(multiplier.detail, 'read 4h ago');
    assert.equal(multiplier.tone, 'neutral', 'a live reading is not a fault');
  });

  test('an applied multiplier is open, and a token that carries its own has no clock', () => {
    const applied = clocksV1(
      representation({
        normalization: 'fresh_ratio_applied',
        normalizationCheckedAt: '2026-08-26T20:14:19.000Z',
        normalizationExpiresAt: '2026-08-27T03:14:19.000Z',
      }),
      NOW,
    );
    assert.equal(at('multiplier', applied).state, 'Applied');
    assert.equal(at('multiplier', applied).detail, 'read 20 min ago');
    assert.equal(at('multiplier', applied).tone, 'good');

    const inToken = clocksV1(
      representation({ issuerId: 'backed', normalization: 'reviewed_token_already_applied' }),
      NOW,
    );
    // Not an absent value: there is no second reading, so there is no clock,
    // and an empty column would read as a fetch we failed.
    assert.equal(at('multiplier', inToken).state, 'In the token');
    assert.equal(at('multiplier', inToken).detail, 'nothing separate to age');
  });

  test('the row is always four captions, shortest-lived first, even unmeasured', () => {
    const rows = clocksV1(representation(), NOW);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['quote', 'round_trip', 'reference', 'multiplier'],
    );
    assert.equal(at('quote', rows).state, 'None taken');
    assert.equal(at('round_trip', rows).state, 'Never measured');
    assert.equal(at('multiplier', rows).state, 'Not read');
    // A clock that never ran states that; it never renders as a blank.
    for (const row of rows) assert.ok(row.state.length > 0, row.id);
  });
});

// ---------------------------------------------------------------------------
// Access, out of the collapsed section.
// ---------------------------------------------------------------------------
describe('the issuer restrictions are on the card', () => {
  test('a reviewed kind becomes a restriction in the reader\'s words', () => {
    const rows = accessNoticesV1('coinbase');
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Who may hold it', 'Transfers', 'Getting out'],
    );
    // The defect this exists for: every Coinbase term reads "Reviewed",
    // including the one whose reviewed content is that the product is not
    // offered to US persons. "Reviewed" grades our evidence, and it was sitting
    // where a reader looks for a grade of their access.
    assert.match(rows[0]!.note, /Not offered to US persons/);
    assert.match(rows[2]!.note, /cannot redeem with the issuer/);
    for (const row of rows) {
      assert.doesNotMatch(row.note, /Reviewed|reviewed|_/, row.label);
    }
  });

  test('every reviewed issuer has all three, and each says something different', () => {
    for (const issuer of ['coinbase', 'dinari', 'backed'] as const) {
      const rows = accessNoticesV1(issuer);
      assert.equal(rows.length, 3, issuer);
      assert.equal(new Set(rows.map((row) => row.note)).size, 3, issuer);
    }
    // Two issuers do not share a sentence, because they do not share a term.
    assert.notEqual(accessNoticesV1('coinbase')[0]!.note, accessNoticesV1('backed')[0]!.note);
  });

  test('the restrictions render without expanding anything, and Terms keeps all six', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const row = view!.representations[0]!;
    assert.equal(row.accessNotices.length, 3);
    // The full terms list is untouched: this promotes, it does not move.
    // Seven rows — the six structure fields plus Ratio, whose measurement is
    // now the Multiplier clock and whose explanation stays collapsed here.
    assert.equal(row.terms.length, 7);
    assert.ok(
      row.terms.every(
        (fact) =>
          fact.value === 'Reviewed' ||
          fact.value === 'Not confirmed yet' ||
          fact.value === 'Applied once',
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// The action row: two weights of one accent, and a read that earns the accent
// without becoming a third loud button.
// ---------------------------------------------------------------------------
describe('the prepare pair says which way you are looking, not which side is better', () => {
  const css = readFileSync(new URL('../src/console/console.css', import.meta.url), 'utf8');
  const screen = readFileSync(new URL('../src/console/MarketRealityScreen.tsx', import.meta.url), 'utf8');

  test('the page direction picks the filled button; the other is outlined', () => {
    assert.match(screen, /direction === 'buy' \? 'btn' : 'btn alt'/);
    assert.match(screen, /direction === 'sell' \? 'btn' : 'btn alt'/);
  });

  test('neither prepare button wears a sentiment colour, and red keeps its one job', () => {
    // Green buy / red sell was proposed. The board withholds ranking on
    // purpose, so colouring the two directions would state the thing it
    // refuses to state — and red on this surface already means the issuer's
    // policy refuses the transfer.
    const alt = css.slice(css.indexOf('.mio-console .btn.alt {'), css.indexOf('.mio-console .btn.sec.accent'));
    assert.doesNotMatch(alt, /green|red|#0?[0-9a-f]*(?:00ff00|ff0000)/i);
    assert.match(alt, /--accent-line/);
    // `--accent` does not exist in this stylesheet; using it would fall back
    // silently and produce no accent at all.
    assert.doesNotMatch(alt, /var\(--accent[,)]/);
  });

  test('Investigate takes the accent in text and edge, not a third filled button', () => {
    assert.match(screen, /className="btn sec accent"/);
    const rule = css.slice(css.indexOf('.mio-console .btn.sec.accent'));
    assert.match(rule.slice(0, 200), /--accent-line/);
    // It is still a secondary button: no gradient fill.
    assert.doesNotMatch(rule.slice(0, 200), /--grad/);
  });
});
