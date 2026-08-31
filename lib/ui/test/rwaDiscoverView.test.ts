import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  cashExitLadderRungsV1,
  cashSizeLabelV1,
  lookalikeFeedViewV1,
  moneyLabelV1,
  officialAssetsViewV1,
  rwaAgeLabelV1,
  rwaBpsLabelV1,
  signalFeedViewV1,
  type OfficialAssetWireV1,
  type OfficialAssetsOverviewWireV1,
} from '../src/console/rwaDiscoverView';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const COIN = '0xb200000000000000000000c85a31389d71f3ecfb';
const IMPOSTOR = '0xb200000000000000000000dead0000000000ad01';

function assetV1(overrides: Partial<OfficialAssetWireV1> = {}): OfficialAssetWireV1 {
  return {
    tokenAddress: AAPL,
    ticker: 'AAPLc',
    displayName: 'Coinbase AAPL',
    issuer: 'coinbase',
    listedIn: ['base_docs_technical', 'base_product_list'],
    sourceDiscrepancy: false,
    referenceValue: {
      status: 'fresh',
      valueAtomic: '31025000000',
      decimals: 8,
      ageSeconds: 38,
      feedAddress: '0x1111111111111111111111111111111111111111',
    },
    executableValue: {
      status: 'full',
      valueAtomic: '99902125',
      decimals: 6,
      requestedSizeAtomic: '100000000',
      destination: 'USDC',
      observedAt: '2026-08-25T11:59:46.000Z',
    },
    comparison: { status: 'comparable', differenceBps: '11', reason: null },
    market: {
      routeStatus: 'cash_route_established',
      measuredAt: '2026-08-25T11:59:46.000Z',
      approvedSources: ['kyberswap'],
      ladder: [
        {
          requestedCashAtomic: '100000000',
          destination: 'USDC',
          status: 'full',
          roundTripCostBps: '9',
          derivedFromExactRung: false,
          lowerBoundRequestedCashAtomic: null,
          entryRouteRefused: false,
        },
        {
          requestedCashAtomic: '100000000000',
          destination: 'USDC',
          status: 'partial',
          roundTripCostBps: '9',
          derivedFromExactRung: true,
          lowerBoundRequestedCashAtomic: '100000000',
          entryRouteRefused: false,
        },
      ],
      observation: { status: 'not_observed', pairedPoolCount: null, movementCount: null },
    },
    lookalikeCount: 3,
    ...overrides,
  };
}

function overviewV1(
  assets: OfficialAssetWireV1[],
  overrides: Partial<OfficialAssetsOverviewWireV1> = {},
): OfficialAssetsOverviewWireV1 {
  const counts = {
    officialIssuance: assets.length,
    cashRouteEstablished: assets.filter((a) => a.market.routeStatus === 'cash_route_established')
      .length,
    noRouteAtMeasuredSizes: assets.filter(
      (a) => a.market.routeStatus === 'no_route_at_measured_sizes',
    ).length,
    noEntryRouteAtMeasuredSizes: assets.filter(
      (a) => a.market.routeStatus === 'no_entry_route_at_measured_sizes',
    ).length,
    measurementFailed: assets.filter((a) => a.market.routeStatus === 'measurement_failed').length,
    notMeasured: assets.filter((a) => a.market.routeStatus === 'not_measured').length,
  };
  return {
    observedAt: NOW.toISOString(),
    counts,
    sources: [
      {
        sourceKind: 'base_docs_technical',
        sourceUrl: 'https://docs.base.org/x.md',
        checkedAt: '2026-08-25T11:00:00.000Z',
        status: 'ok',
        assetCount: 13,
        lastSuccessfulAt: '2026-08-25T11:00:00.000Z',
      },
      {
        sourceKind: 'base_product_list',
        sourceUrl: 'https://brand.base.org/stocks',
        checkedAt: '2026-08-25T11:00:00.000Z',
        status: 'ok',
        assetCount: 4,
        lastSuccessfulAt: '2026-08-25T11:00:00.000Z',
      },
    ],
    marketObservation: {
      status: 'never_run',
      checkedThroughBlock: null,
      checkedAt: null,
      identifiedVenueCount: null,
      candidatesPendingIdentification: null,
    },
    assets,
    ...overrides,
  };
}

describe('rwa discover view — formatting', () => {
  test('basis points become a percentage, and a missing one stays missing', () => {
    assert.equal(rwaBpsLabelV1('9'), '0.09%');
    assert.equal(rwaBpsLabelV1('197'), '1.97%');
    assert.equal(rwaBpsLabelV1('-25'), '-0.25%');
    // The whole point of the module: nothing turns an absent measurement into
    // a number with a decimal point in it.
    assert.equal(rwaBpsLabelV1(null), null);
    assert.equal(rwaBpsLabelV1('not a number'), null);
  });

  test('a size is money, and a value without its decimals is not a value', () => {
    assert.equal(cashSizeLabelV1('100000000'), '$100');
    assert.equal(cashSizeLabelV1('100000000000'), '$100,000');
    assert.equal(moneyLabelV1('99902125', 6), '$99.90');
    assert.equal(moneyLabelV1('31025000000', 8), '$310.25');
    assert.equal(moneyLabelV1(null, 6), null);
    assert.equal(moneyLabelV1('1', null), null);
  });

  test('an age is the coarsest unit that is still true', () => {
    assert.equal(rwaAgeLabelV1('2026-08-25T11:59:22.000Z', NOW), '38s ago');
    assert.equal(rwaAgeLabelV1('2026-08-25T11:30:00.000Z', NOW), '30m ago');
    assert.equal(rwaAgeLabelV1('2026-08-24T12:00:00.000Z', NOW), '1d ago');
    assert.equal(rwaAgeLabelV1(null, NOW), null);
  });
});

describe('rwa discover view — official assets', () => {
  test('an asset with no route says so about the asset, not about us', () => {
    const view = officialAssetsViewV1(
      overviewV1([
        assetV1({
          tokenAddress: COIN,
          ticker: 'COINc',
          executableValue: {
            status: 'unavailable',
            valueAtomic: null,
            decimals: null,
            requestedSizeAtomic: null,
            destination: null,
            observedAt: null,
          },
          comparison: {
            status: 'withheld',
            differenceBps: null,
            reason: 'executable_value_unavailable',
          },
          market: {
            routeStatus: 'no_route_at_measured_sizes',
            measuredAt: '2026-08-25T11:00:00.000Z',
            approvedSources: ['kyberswap'],
            ladder: [
              {
                requestedCashAtomic: '100000000',
                destination: 'USDC',
                status: 'unavailable',
                roundTripCostBps: null,
                derivedFromExactRung: false,
                lowerBoundRequestedCashAtomic: null,
                entryRouteRefused: false,
              },
            ],
            observation: { status: 'not_observed', pairedPoolCount: null, movementCount: null },
          },
        }),
      ]),
      NOW,
    );
    const card = view.assets[0]!;
    assert.equal(card.status.chip, 'NO EXIT AT MEASURED SIZES');
    assert.match(card.status.body, /reading about the market, not about the issuance/);

    const executable = card.facts.find((fact) => /cash-out/i.test(fact.label))!;
    assert.equal(executable.value, 'not measured');
    assert.equal(executable.note, 'Bought, and no approved router would sell it back');
    // A rung with no cost renders the words, never a percentage.
    assert.deepEqual(
      card.ladder.map((rung) => rung.value),
      ['no exit route'],
    );
  });

  test('a refused buy leg is the router answering, and claims nothing about exiting', () => {
    // Nine of thirteen Coinbase equities read this way. The ladder is sized in
    // cash, so it buys first; with no buy route the sell was never attempted,
    // and saying "cannot be exited" would be a claim about a position nobody
    // tested.
    const view = officialAssetsViewV1(
      overviewV1([
        assetV1({
          tokenAddress: COIN,
          ticker: 'COINc',
          executableValue: {
            status: 'measurement_failed',
            valueAtomic: null,
            decimals: null,
            requestedSizeAtomic: null,
            destination: null,
            observedAt: null,
          },
          comparison: { status: 'withheld', differenceBps: null, reason: null },
          market: {
            routeStatus: 'no_entry_route_at_measured_sizes',
            measuredAt: '2026-08-25T11:00:00.000Z',
            approvedSources: ['kyberswap'],
            ladder: [
              {
                requestedCashAtomic: '100000000',
                destination: 'USDC',
                status: 'measurement_failed',
                roundTripCostBps: null,
                derivedFromExactRung: false,
                lowerBoundRequestedCashAtomic: null,
                entryRouteRefused: true,
              },
            ],
            observation: { status: 'not_observed', pairedPoolCount: null, movementCount: null },
          },
        }),
      ]),
      NOW,
    );
    const card = view.assets[0]!;
    assert.equal(card.status.chip, 'NO CASH ENTRY AT MEASURED SIZES');
    assert.match(card.status.body, /never tested and is not claimed either way/);
    // The rung says the router refused, not that our measurement broke.
    assert.deepEqual(
      card.ladder.map((rung) => rung.value),
      ['no buy route'],
    );
    assert.equal(
      card.facts.find((fact) => /cash-out/i.test(fact.label))!.note,
      'No approved router would sell it to you for cash',
    );
  });

  test('an unmeasured asset and an asset with no route do not share a sentence', () => {
    const view = officialAssetsViewV1(
      overviewV1([
        assetV1({
          market: {
            routeStatus: 'not_measured',
            measuredAt: null,
            approvedSources: [],
            ladder: [],
            observation: { status: 'not_observed', pairedPoolCount: null, movementCount: null },
          },
        }),
      ]),
      NOW,
    );
    const card = view.assets[0]!;
    assert.equal(card.status.chip, 'NOT MEASURED');
    assert.match(card.status.body, /gap in Miorail, not a finding about the token/);
    // No ladder rows at all rather than four rows of "not measured", which is
    // four ways of saying nothing.
    assert.deepEqual(card.ladder, []);
    assert.equal(card.ladderNote, null);
  });

  test('a cost carried from a smaller size says which size it came from', () => {
    const view = officialAssetsViewV1(overviewV1([assetV1()]), NOW);
    const carried = view.assets[0]!.ladder.find((rung) => rung.label === '$100,000')!;
    assert.equal(carried.value, '0.09%');
    assert.equal(carried.note, 'carried from $100');
  });

  test('a tail that has identified no venue is our backlog, not a quiet market', () => {
    // Measured on the first production pass: 10,824 transfers read, 97
    // counterparties found, none yet identified — so nothing could be
    // attributed and every asset would have shown "0 recent movements".
    const view = officialAssetsViewV1(
      overviewV1([assetV1()], {
        marketObservation: {
          status: 'observed',
          checkedThroughBlock: 50_447_451,
          checkedAt: '2026-08-25T11:55:00.000Z',
          identifiedVenueCount: 0,
          candidatesPendingIdentification: 97,
        },
      }),
      NOW,
    );
    assert.match(view.marketObservation, /No counterparty has been identified as a venue yet/);
    assert.match(view.marketObservation, /97 still to ask/);
    assert.match(view.marketObservation, /our backlog, not a quiet market/);
  });

  test('a ledger tail that never ran is never rendered as a quiet market', () => {
    const view = officialAssetsViewV1(overviewV1([assetV1()]), NOW);
    assert.match(view.marketObservation, /has not run on this deployment/);
    assert.match(view.marketObservation, /not a quiet market/);
    const market = view.assets[0]!.market;
    assert.deepEqual(
      market.map((fact) => fact.value),
      ['not observed', 'not observed'],
    );
    // Never the word "trades". Six per cent of measured movements through the
    // v4 singleton carried no swap at all.
    assert.equal(market[1]!.note, 'Transfers through a venue, not confirmed swaps');
  });

  test('the counters carry only the states that exist, and always the sum', () => {
    const measured = officialAssetsViewV1(overviewV1([assetV1()]), NOW);
    assert.deepEqual(
      measured.counters.map((counter) => counter.label),
      [
        'Official issuance',
        'Cash route established',
        'No exit at measured sizes',
        'No cash entry at measured sizes',
      ],
    );

    const withGap = officialAssetsViewV1(
      overviewV1([
        assetV1(),
        assetV1({
          tokenAddress: COIN,
          ticker: 'COINc',
          market: {
            routeStatus: 'not_measured',
            measuredAt: null,
            approvedSources: [],
            ladder: [],
            observation: { status: 'not_observed', pairedPoolCount: null, movementCount: null },
          },
        }),
      ]),
      NOW,
    );
    const notMeasured = withGap.counters.find((counter) => counter.label === 'Not measured')!;
    assert.equal(notMeasured.value, '1');
    const total = Number(withGap.counters[0]!.value);
    const parts = withGap.counters
      .slice(1)
      .reduce((sum, counter) => sum + Number(counter.value), 0);
    assert.equal(parts, total);
  });

  test('a source that could not be read withdraws nothing, and says so', () => {
    const view = officialAssetsViewV1(
      overviewV1([assetV1()], {
        sources: [
          {
            sourceKind: 'base_docs_technical',
            sourceUrl: 'https://docs.base.org/x.md',
            checkedAt: '2026-08-25T11:55:00.000Z',
            status: 'unreachable',
            assetCount: 13,
            lastSuccessfulAt: '2026-08-25T06:00:00.000Z',
          },
        ],
      }),
      NOW,
    );
    const source = view.sources[0]!;
    assert.equal(source.value, 'check failed · 5m ago');
    assert.match(source.note!, /Membership is unchanged/);
    assert.match(source.note!, /6h ago/);
  });

  test('identity comes before price, and both halves of it travel', () => {
    const view = officialAssetsViewV1(overviewV1([assetV1()]), NOW);
    const card = view.assets[0]!;
    assert.equal(card.trustRoot, 'OFFICIAL');
    assert.equal(card.listedIn, 'Base docs + Base product page');
    assert.equal(card.tokenAddress, AAPL);
    assert.match(card.lookalikeNote!, /not a claim about intent/);
  });
});

describe('rwa discover view — lookalikes', () => {
  test('the disclaimer travels with the feed, and no card carries a verdict', () => {
    const view = lookalikeFeedViewV1(
      {
        observedAt: NOW.toISOString(),
        disclaimer: 'Address identity remains authoritative.',
        counts: { total: 112, publishedTicker: 12, underlying: 95, displayName: 5 },
        filteredBy: null,
        lastScanAt: '2026-08-25T11:00:00.000Z',
        cards: [
          {
            tokenAddress: IMPOSTOR,
            officialAddress: AAPL,
            officialTicker: 'AAPLc',
            officialDisplayName: 'Coinbase AAPL',
            matchKind: 'symbol_exact',
            matchedAlias: 'published_ticker',
            matchedValue: 'AAPLc',
            declaredSymbol: 'AAPLc',
            declaredName: 'Apple',
            launchedAt: null,
            firstFlaggedAt: '2026-08-25T09:00:00.000Z',
            lastSeenAt: '2026-08-25T11:00:00.000Z',
          },
        ],
      },
      NOW,
    );
    assert.equal(view.disclaimer, 'Address identity remains authoritative.');
    assert.deepEqual(
      view.filters.map((filter) => [filter.label, filter.count]),
      [
        ['All', 112],
        ['Published ticker', 12],
        ['Underlying', 95],
        ['Display name', 5],
      ],
    );
    const card = view.cards[0]!;
    assert.equal(card.official.address, AAPL);
    assert.equal(card.matchedLabel, 'Published ticker · AAPLc');
    // The index not knowing when a contract launched is different from it
    // launching at the epoch.
    assert.equal(
      card.facts.find((fact) => fact.label === 'Launched')!.value,
      'not known to the index',
    );

    const rendered = JSON.stringify(view).toLowerCase();
    for (const word of ['scam', 'suspicious', 'fraud', 'high risk', 'malicious', 'severity']) {
      assert.equal(rendered.includes(word), false, `the lookalike view must not say "${word}"`);
    }
  });

  test('a corpus never scanned is not a scan that found nothing', () => {
    const view = lookalikeFeedViewV1(
      {
        observedAt: NOW.toISOString(),
        disclaimer: 'x',
        counts: { total: 0, publishedTicker: 0, underlying: 0, displayName: 0 },
        filteredBy: null,
        lastScanAt: null,
        cards: [],
      },
      NOW,
    );
    assert.match(view.lastScan!, /never been scanned/);
  });
});

describe('rwa discover view — signals', () => {
  test('an empty feed with nothing watched and one with a watch say different things', () => {
    const unwatched = signalFeedViewV1(
      { observedAt: NOW.toISOString(), watching: [], notReported: [], cards: [] },
      NOW,
    );
    assert.equal(unwatched.watching, null);
    assert.match(unwatched.emptyNote!, /No emitter has run yet/);

    const watched = signalFeedViewV1(
      {
        observedAt: NOW.toISOString(),
        watching: [
          { kind: 'official_asset_lookalike_created', watchingSince: '2026-08-25T10:00:00.000Z' },
        ],
        notReported: [],
        cards: [],
      },
      NOW,
    );
    assert.match(watched.watching!, /Nothing before that can appear here/);
    assert.match(watched.emptyNote!, /Nothing has changed since/);
  });

  test('a Backed source transition is never mislabeled as Coinbase evidence', () => {
    const view = signalFeedViewV1(
      {
        observedAt: NOW.toISOString(),
        watching: [
          { kind: 'official_source_added_asset', watchingSince: '2026-08-20T10:00:00.000Z' },
        ],
        notReported: [],
        cards: [
          {
            signalId: 'backed-1',
            kind: 'official_source_added_asset',
            subjectAddress: COIN,
            subjectTicker: 'bCOIN',
            officialAddress: null,
            officialTicker: null,
            occurredAt: '2026-08-25T11:00:00.000Z',
            recordedAt: '2026-08-25T11:00:05.000Z',
            facts: {
              sourceKind: 'backed_assets_api',
              sourceUrl: 'https://api.xstocks.fi/api/v1/token?type=btokens',
              ticker: 'bCOIN',
              displayName: 'Backed Coinbase Global',
            },
          },
        ],
      },
      NOW,
    );
    assert.match(view.cards[0]!.detail, /Backed bTokens API/);
    assert.doesNotMatch(view.cards[0]!.detail, /Base docs corpus/);
  });

  test('a market signal names the size it was decided on', () => {
    const view = signalFeedViewV1(
      {
        observedAt: NOW.toISOString(),
        watching: [
          {
            kind: 'official_asset_market_became_active',
            watchingSince: '2026-08-20T10:00:00.000Z',
          },
        ],
        notReported: ['Trades.'],
        cards: [
          {
            signalId: '1',
            kind: 'official_asset_market_became_active',
            subjectAddress: COIN,
            subjectTicker: 'COINc',
            officialAddress: null,
            officialTicker: null,
            occurredAt: '2026-08-25T11:00:00.000Z',
            recordedAt: '2026-08-25T11:00:05.000Z',
            facts: {
              ticker: 'COINc',
              destination: 'USDC',
              requestedCashAtomic: '10000000000',
              roundTripCostBps: '150',
              approvedSources: ['kyberswap'],
            },
          },
        ],
      },
      NOW,
    );
    const card = view.cards[0]!;
    assert.equal(card.title, 'A cash route appeared');
    assert.equal(card.subject.label, 'COINc');
    assert.equal(card.occurred, '1h ago');
    assert.match(card.detail, /at \$10,000/);
    assert.match(card.detail, /for 1\.50%/);
    assert.match(card.detail, /previous measurement found no route/);
    assert.equal(view.emptyNote, null);
  });

  test('a lost route is never described as a failed measurement', () => {
    const view = signalFeedViewV1(
      {
        observedAt: NOW.toISOString(),
        watching: [
          {
            kind: 'official_asset_market_became_unreachable',
            watchingSince: '2026-08-20T10:00:00.000Z',
          },
        ],
        notReported: [],
        cards: [
          {
            signalId: '2',
            kind: 'official_asset_market_became_unreachable',
            subjectAddress: COIN,
            subjectTicker: 'COINc',
            officialAddress: null,
            officialTicker: null,
            occurredAt: '2026-08-25T11:00:00.000Z',
            recordedAt: '2026-08-25T11:00:05.000Z',
            facts: {
              ticker: 'COINc',
              destination: 'USDC',
              requestedCashAtomic: '100000000',
              roundTripCostBps: null,
              approvedSources: ['kyberswap'],
            },
          },
        ],
      },
      NOW,
    );
    assert.match(view.cards[0]!.detail, /The measurement itself succeeded/);
    // A contract the corpus cannot name is offered by address, never by a
    // symbol alone: two impostors wearing one word would be one card.
    const unnamed = signalFeedViewV1(
      {
        observedAt: NOW.toISOString(),
        watching: [
          { kind: 'official_asset_lookalike_created', watchingSince: '2026-08-20T10:00:00.000Z' },
        ],
        notReported: [],
        cards: [
          {
            signalId: '3',
            kind: 'official_asset_lookalike_created',
            subjectAddress: IMPOSTOR,
            subjectTicker: null,
            officialAddress: AAPL,
            officialTicker: 'AAPLc',
            occurredAt: '2026-08-25T11:00:00.000Z',
            recordedAt: '2026-08-25T11:00:05.000Z',
            facts: {
              matchKind: 'symbol_exact',
              matchedAlias: 'published_ticker',
              matchedValue: 'AAPLc',
              officialTicker: 'AAPLc',
              launchSymbol: 'AAPLc',
              launchName: 'Apple',
            },
          },
        ],
      },
      NOW,
    );
    assert.equal(unnamed.cards[0]!.subject.label, '0xb200…ad01');
    assert.match(unnamed.cards[0]!.detail, /Addresses differ; this is a resemblance/);
  });
});

describe('the cash-exit ladder as rows', () => {
  test('an expired rung is history, not an empty ladder', () => {
    // Stocks rendered no ladder at all for any representation, because the
    // dossier's projection turns an expired rung into `not_measured` and this
    // list dropped those rows as "four ways of saying nothing". The run had
    // finished minutes earlier and had answers for every rung.
    const rows = cashExitLadderRungsV1(
      [
        {
          requestedCashAtomic: '1000000000',
          destination: 'USDC',
          status: 'not_measured',
          roundTripCostBps: null,
          derivedFromExactRung: false,
          lowerBoundRequestedCashAtomic: null,
          lastMeasured: {
            status: 'full',
            errorCode: null,
            observedAt: '2026-08-25T11:50:00.000Z',
            roundTripCostBps: '9',
          },
        },
        {
          requestedCashAtomic: '10000000000',
          destination: 'USDC',
          status: 'not_measured',
          roundTripCostBps: null,
          derivedFromExactRung: false,
          lowerBoundRequestedCashAtomic: null,
          lastMeasured: {
            status: 'measurement_failed',
            errorCode: 'cash_size_anchor_no_route',
            observedAt: '2026-08-25T11:50:00.000Z',
            roundTripCostBps: null,
          },
        },
      ],
      NOW,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.value, '0.09%');
    assert.equal(rows[0]?.note, 'measured 10m ago');
    // The router's refusal, named as the router's — the same label Discover's
    // own preview gives it, from the same error code.
    assert.equal(rows[1]?.value, 'no buy route');
  });

  test('a router that does not carry the token is not "did not finish"', () => {
    const rows = cashExitLadderRungsV1(
      [
        {
          requestedCashAtomic: '1000000000',
          destination: 'USDC',
          status: 'not_measured',
          roundTripCostBps: null,
          derivedFromExactRung: false,
          lowerBoundRequestedCashAtomic: null,
          lastMeasured: {
            status: 'measurement_failed',
            errorCode: 'provider_unsupported_token',
            observedAt: '2026-08-25T11:50:00.000Z',
            roundTripCostBps: null,
          },
        },
      ],
      NOW,
    );
    assert.equal(rows[0]?.value, 'not covered');
  });

  test('a rung nothing ever measured stays out of the ladder', () => {
    const rows = cashExitLadderRungsV1(
      [
        {
          requestedCashAtomic: '1000000000',
          destination: 'USDC',
          status: 'not_measured',
          roundTripCostBps: null,
          derivedFromExactRung: false,
          lowerBoundRequestedCashAtomic: null,
          lastMeasured: null,
        },
      ],
      NOW,
    );
    assert.deepEqual(rows, []);
  });

  test('an open figure still wins over the history beside it', () => {
    const rows = cashExitLadderRungsV1(
      [
        {
          requestedCashAtomic: '1000000000',
          destination: 'USDC',
          status: 'full',
          roundTripCostBps: '4',
          derivedFromExactRung: false,
          lowerBoundRequestedCashAtomic: null,
          lastMeasured: {
            status: 'unavailable',
            errorCode: null,
            observedAt: '2026-08-25T11:50:00.000Z',
            roundTripCostBps: null,
          },
        },
      ],
      NOW,
    );
    assert.equal(rows[0]?.value, '0.04%');
    assert.equal(rows[0]?.note, null);
  });
});

describe('a stored round trip is never spoken of in the present', () => {
  const withObservation = (secondsAgo: number) =>
    officialAssetsViewV1(
      overviewV1([
        assetV1({
          executableValue: {
            status: 'full',
            valueAtomic: '9974382',
            decimals: 2,
            requestedSizeAtomic: '100000000000',
            destination: 'USDC',
            observedAt: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
          },
        }),
      ]),
      NOW,
    );

  test('ACTIVE MARKET never appears, and an aged observation says it is history', () => {
    // Screenshot, 2026-08-30: AAPLc carried "ACTIVE MARKET" over an executable
    // observation 22 minutes old, beside a reference feed marked stale. The
    // verdict was right; the tense was a claim nothing supported.
    const fresh = withObservation(60);
    const aged = withObservation(22 * 60);
    assert.equal(fresh.assets[0]?.status.chip, 'ROUTE OBSERVED');
    assert.equal(aged.assets[0]?.status.chip, 'HISTORICAL ROUTE EVIDENCE');
    for (const view of [fresh, aged]) {
      assert.doesNotMatch(JSON.stringify(view), /ACTIVE MARKET/);
    }
    // And the aged one stops claiming the good tone.
    assert.notEqual(aged.assets[0]?.status.tone, 'good');
    assert.match(aged.assets[0]?.status.body ?? '', /history, not a current price/);
  });

  test('a cash-out figure carries its size in the label, not just in a note', () => {
    // The unit bug this closes: a $99,663 cash TOTAL was divided by a $320
    // per-share reference and rendered as 31,015%, because both rows read
    // "value".
    const view = withObservation(60);
    const row = view.assets[0]?.facts.find((fact) => /cash-out/i.test(fact.label));
    assert.ok(row, 'the executable row names its size');
    assert.match(row!.label, /^\$100k cash-out$/);
    assert.doesNotMatch(JSON.stringify(view.assets[0]?.facts), /Executable value/);
  });
});
