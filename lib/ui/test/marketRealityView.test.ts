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
      comparable: false,
      reason: 'No reviewed comparable reference/session adapter answered.',
    },
    sources: [],
    observedAt: null,
    expiresAt: null,
    ...over,
  };
}

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
    coverage: {
      reviewedRepresentations: 3,
      comparableRepresentations: 0,
      status: 'incomplete',
      reason: 'Every reviewed representation must have fresh exact-size evidence.',
    },
    ranking: {
      status: 'withheld',
      orderedTokenAddresses: [],
      reason: 'Coverage comparability did not pass; no BEST representation is emitted.',
    },
    representations: [representation({ sources: [LAPSED_SOURCE] })],
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
    const outcome = representationOutcomeV1(representation({ sources: [LAPSED_SOURCE] }), NOW);
    assert.equal(outcome, 'lapsed');
  });

  test('a row with no evidence at all is never measured', () => {
    assert.equal(representationOutcomeV1(representation({ sources: [] }), NOW), 'never_measured');
  });

  test('a market with no venue is the asset, not us', () => {
    const outcome = representationOutcomeV1(
      representation({
        sources: [{ source: 'kyberswap', status: 'no_route', errorCode: 'cash_size_anchor_no_route', quoteEvidence: null }],
      }),
      NOW,
    );
    assert.equal(outcome, 'no_route');
  });

  test('a provider that would not answer is us, not the asset', () => {
    const outcome = representationOutcomeV1(
      representation({
        sources: [{ source: 'kyberswap', status: 'not_measured', errorCode: 'provider_http_error', quoteEvidence: null }],
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
      representationOutcomeV1(representation({ status: 'full', sources: [open] }), NOW),
      'priced',
    );
  });

  test('each outcome names whose fact it is', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({ sources: [LAPSED_SOURCE] }),
          representation({
            tokenAddress: BACKED_NVDA,
            issuerId: 'backed',
            representationKind: 'rebasing_erc20',
            issuerInstrumentKey: 'backed:instrument_id:c1077d76',
            sources: [
              { source: 'kyberswap', status: 'no_route', errorCode: 'cash_size_anchor_no_route', quoteEvidence: null },
            ],
          }),
          representation({
            tokenAddress: BACKED_WRAPPER,
            issuerId: 'backed',
            representationKind: 'non_rebasing_erc4626_wrapper',
            issuerInstrumentKey: 'backed:instrument_id:c1077d76',
            sources: [
              { source: 'kyberswap', status: 'not_measured', errorCode: 'provider_http_error', quoteEvidence: null },
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

  test('an available ranking carries no withheld note', () => {
    const view = marketRealityViewV1({
      wire: wire({
        ranking: { status: 'available', orderedTokenAddresses: [COINBASE_NVDA], reason: null },
      }),
      choice: null,
      now: NOW,
    });
    assert.equal(view?.rankingNote, null);
  });

  test('coverage is stated as a fraction, not as a verdict about the assets', () => {
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.equal(view?.coverageChip, '0 of 3 comparable');
    assert.equal(view?.coverageTone, 'warn');
  });

  test('the verdict is a reader sentence, not the engine reason', () => {
    // The engine says "fresh exact-size evidence, normalized exposure and the
    // same approved-router policy". True, and it tells a person nothing about
    // what to do next.
    const view = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    assert.doesNotMatch(view?.coverageBody ?? '', /normalized exposure|approved-router policy/);
    assert.match(view?.coverageBody ?? '', /held 3 ways on Base/);
    assert.match(view?.coverageBody ?? '', /none of them/i);
  });

  test('all three coverage shapes are different sentences', () => {
    const none = marketRealityViewV1({ wire: wire(), choice: null, now: NOW });
    const some = marketRealityViewV1({
      wire: wire({
        coverage: { reviewedRepresentations: 3, comparableRepresentations: 1, status: 'incomplete', reason: null },
      }),
      choice: null,
      now: NOW,
    });
    const all = marketRealityViewV1({
      wire: wire({
        coverage: { reviewedRepresentations: 3, comparableRepresentations: 3, status: 'complete', reason: null },
      }),
      choice: null,
      now: NOW,
    });
    assert.match(some?.coverageBody ?? '', /one of them has evidence/);
    assert.match(all?.coverageBody ?? '', /read against each other/);
    assert.notEqual(none?.coverageBody, some?.coverageBody);
    assert.notEqual(some?.coverageBody, all?.coverageBody);
  });

  test('a security nothing is bound to says so, and blames nobody', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [],
        coverage: { reviewedRepresentations: 0, comparableRepresentations: 0, status: 'incomplete', reason: null },
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
      ['—', '—', '—'],
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
    // No reference adapter answered, so the premium stays absent and says so
    // rather than comparing a cash return against a value in another unit.
    assert.equal(numbers[2]?.value, '—');
    assert.match(numbers[2]?.note ?? '', /reference/i);
  });

  test('the ratio convention is stated per representation, never assumed', () => {
    const view = marketRealityViewV1({
      wire: wire({
        representations: [
          representation({ normalization: 'reviewed_token_already_applied', issuerId: 'backed' }),
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
