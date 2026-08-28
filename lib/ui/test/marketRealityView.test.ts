import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
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
    assert.match(view?.representations[0]?.outcomeBody ?? '', /current reviewed router policy/i);
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
    assert.match(view?.representations[0]?.outcomeBody ?? '', /No outstanding supply/);
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
          lastObservation: { ...LAPSED_OBSERVATION, open: true },
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
  test('a withheld ranking always carries its reason', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.match(view?.rankingNote ?? '', /no BEST/i);
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
    assert.match(view?.rankingNote ?? '', /withholds ranking/i);
  });

  test('coverage is stated as a fraction, not as a verdict about the assets', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.equal(view?.coverageChip, '0 of 3 market outcomes');
    assert.equal(view?.coverageTone, 'warn');
  });

  test('the verdict is a reader sentence, not the engine reason', () => {
    // The engine says "fresh exact-size evidence, normalized exposure and the
    // same approved-router policy". True, and it tells a person nothing about
    // what to do next.
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.doesNotMatch(view?.coverageBody ?? '', /normalized exposure|approved-router policy/);
    assert.match(view?.coverageBody ?? '', /answered this exact market question for 0 of 3/);
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
  test('every missing figure is an em dash with a reason', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const numbers = view?.representations[0]?.numbers ?? [];
    assert.deepEqual(
      numbers.map((fact) => fact.value),
      ['—', '—', '—', '—'],
    );
    for (const fact of numbers) {
      assert.ok(fact.note && fact.note.length > 0, `${fact.label} must say why it is empty`);
    }
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
    assert.equal(numbers[2]?.value, '—');
    assert.match(numbers[2]?.note ?? '', /not established|reference/i);
    assert.equal(numbers[3]?.value, '—');
    assert.match(numbers[3]?.note ?? '', /reference/i);
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
    assert.equal(reference?.value, '$211.3');
    assert.equal(reference?.tone, 'neutral');
    assert.equal(basis?.value, '+11 bps');
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
    assert.equal(basis?.value, '-11 bps');
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
    const basis = view?.representations[0]?.numbers.find(
      (fact) => fact.label === 'Basis withheld',
    );
    assert.equal(basis?.value, '—');
    assert.equal(basis?.note, reason);
    assert.equal(basis?.tone, 'neutral');
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
    assert.match(reference?.note ?? '', /Live reference/);
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
    assert.match(reference?.note ?? '', /Reference holding last published value/);
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
    const ranking = view?.comparisonSummary.find((fact) => fact.label === 'Ranking');
    assert.equal(ranking?.value, 'WITHHELD');
    assert.equal(ranking?.tone, 'off');
    assert.match(view?.rankingNote ?? '', /withholds ranking/);
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

  test('the headline counter is the number of comparable securities', () => {
    const counters = underlyingCountersV1({
      entries: [],
      totals: { underlyings: 19, boundRepresentations: 25, multiIssuerUnderlyings: 2 },
      observedAt: NOW,
    });
    const compare = counters.find((row) => row.label === 'Carried by two issuers');
    assert.equal(compare?.value, '2');
    assert.equal(compare?.tone, 'good');
  });

  test('nothing to compare is stated, not hidden', () => {
    const counters = underlyingCountersV1({
      entries: [],
      totals: { underlyings: 19, boundRepresentations: 25, multiIssuerUnderlyings: 0 },
      observedAt: NOW,
    });
    assert.equal(counters.find((row) => row.label === 'Carried by two issuers')?.tone, 'off');
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

  test('the lapsed sentence carries the age and says the number was real', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const body = view?.representations[0]?.outcomeBody ?? '';
    assert.match(body, /39 min ago/);
    assert.match(body, /twenty seconds/);
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
    assert.equal(row?.outcomeChip, 'Finding expired');
    assert.doesNotMatch(row?.outcomeBody ?? '', /price/i);
  });

  test('the last observation is shown apart from the current numbers', () => {
    // A background sample rendered in the same list as open evidence is the
    // confusion the engine grew a second field to prevent.
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const row = view?.representations[0];
    assert.equal(row?.lastSeen?.value, '$99.95');
    assert.match(row?.lastSeen?.note ?? '', /history, not a price now/);
    // And the current numbers stay empty.
    assert.deepEqual(
      row?.numbers.map((fact) => fact.value),
      ['—', '—', '—', '—'],
    );
  });

  test('an open observation is labelled open, not as history', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({
            status: 'full',
            liveness: 'live',
            lastObservation: { ...LAPSED_OBSERVATION, open: true },
            returnedCashAtomic: '99952618',
          }),
        ],
      }),
      choice: null,
      now: NOW,
    });
    assert.match(view?.representations[0]?.lastSeen?.note ?? '', /still open/);
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
