import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OpportunitiesScreen, opportunitySectionsV1 } from '../src/console/OpportunitiesScreen';
import { cardStandingV1, opportunityCardViewV1, type OpportunityCardWireV1 } from '../src/console/opportunityCardView';

// The JSX below compiles to React.createElement.
void React;

// ---------------------------------------------------------------------------
// Stage 02 — the verdict, on screen.
//
// The feed had one list and one sentence. Measured against the live 48-hour
// window on 2026-08-15 (1,139 canonical launches), that list was:
//
//   715  nobody has bought it
//   346  MIORAIL could not measure it — 30% of the feed
//    70  wallets bought it and a sale would not price
//     8  both directions priced
//
// So the list was mixing three unlike things, and the 70 cards carrying the
// product's actual finding sat roughly one per page. These tests pin the two
// properties that fixes: Miorail's own failures are kept in their own section,
// and the conclusion is above the evidence rather than under it.
// ---------------------------------------------------------------------------

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function wire(over: {
  token: string;
  symbol: string;
  state?: 'provisional' | 'rejected' | 'unmeasured';
  reasonCode?: string | null;
  entryRouteFound?: boolean;
  exitRouteFound?: boolean;
  buyerCount?: number | null;
  windowStatus?: 'collecting' | 'measured' | 'closed_unmeasured' | 'unknown';
}): OpportunityCardWireV1 {
  const buyerCount = over.buyerCount ?? null;
  return {
    launch: {
      tokenAddress: over.token,
      name: over.symbol,
      symbol: over.symbol,
      variant: 'asset',
      decimals: 18,
      blockNumber: '50000000',
      ageSeconds: 600,
      launchTimeSource: 'onchain_block',
      canonical: true,
    },
    observation: {
      observationId: `0x${'a'.repeat(64)}`,
      evidenceHash: `0x${'b'.repeat(64)}`,
      state: over.state ?? 'rejected',
      reasonCode: over.reasonCode ?? 'no_exit_route',
      headline: 'wire headline',
      detail: 'The typed measurement sentence.',
      referencePositionAtomic: '100000000',
      referenceQuoteAsset: USDC,
      maxRoundTripBps: 300,
      entryRouteFound: over.entryRouteFound ?? true,
      exitRouteFound: over.exitRouteFound ?? false,
      entrySourceKey: 'uniswap-v4:pool',
      exitSourceKey: null,
      routeCoverage: 'complete',
      optimisticRoundTripBps: null,
      largestPassingSizeAtomic: null,
      firstFailingSizeAtomic: null,
      capacityStable: null,
      transferPolicyNotice: null,
      quoteAlignmentNotice: null,
      preEntryNotice: null,
      poolHook: null,
      launchBuyers:
        buyerCount === null ? null : { buyerCount, topBuyerShareBps: 1_200, topThreeShareBps: 3_000 },
      launchBuyerWindow: {
        status: over.windowStatus ?? (buyerCount === null ? 'collecting' : 'measured'),
        closesAtBlock: '50010000',
      },
      observationBlockNumber: '50000028',
      freshness: 'fresh',
    },
    canCheckProfile: false,
    action: { action: 'none', label: null, reason: 'No wallet check can create a supported exit route.' },
    notMeasured: ['future price', 'profit probability'],
  };
}

const BOUGHT = opportunityCardViewV1(wire({ token: `0x${'1'.repeat(40)}`, symbol: 'WORM', buyerCount: 62 }));
const NO_BUYERS = opportunityCardViewV1(wire({ token: `0x${'2'.repeat(40)}`, symbol: 'QUIET', buyerCount: 0 }));
const NO_VENUE = opportunityCardViewV1(
  wire({ token: `0x${'3'.repeat(40)}`, symbol: 'MADI', reasonCode: 'no_entry_route', entryRouteFound: false, buyerCount: 0 }),
);
const DEGRADED = opportunityCardViewV1(
  wire({ token: `0x${'4'.repeat(40)}`, symbol: 'RQQAD', reasonCode: 'route_search_degraded', buyerCount: 0 }),
);
const TWO_SIDED = opportunityCardViewV1(
  wire({ token: `0x${'5'.repeat(40)}`, symbol: 'PAIR', state: 'provisional', reasonCode: 'quoted_pre_entry', exitRouteFound: true, buyerCount: 40 }),
);

describe('the card projection carries the verdict, not just its words', () => {
  test('each measured shape reaches its own section', () => {
    assert.equal(BOUGHT.standingGroup, 'bought_not_sellable');
    assert.equal(NO_BUYERS.standingGroup, 'no_buyers_yet');
    assert.equal(NO_VENUE.standingGroup, 'miorail_limit');
    assert.equal(DEGRADED.standingGroup, 'miorail_limit');
    assert.equal(TWO_SIDED.standingGroup, 'two_sided');
  });

  test('aboutToken comes off the standing rather than being re-derived', () => {
    assert.equal(BOUGHT.aboutToken, true);
    assert.equal(NO_VENUE.aboutToken, false);
    assert.equal(DEGRADED.aboutToken, false);
  });

  test('the headline is the verdict, and the typed sentence stays separate', () => {
    // The card holds both. Losing one would either publish a reason code as a
    // conclusion or drop the evidence that supports it.
    assert.match(BOUGHT.headline, /62 wallets bought this/);
    assert.equal(BOUGHT.detail, 'The typed measurement sentence.');
    assert.match(BOUGHT.standingDetail, /did not establish why/i);
  });

  test('a server that predates the standing still gets the right section', () => {
    // A tab open across a deploy. The rebuild runs the one shared constructor
    // over fields the wire already carried, so an older server cannot make
    // every card read "not measured".
    const older = wire({ token: `0x${'6'.repeat(40)}`, symbol: 'OLD', buyerCount: 62 });
    delete older.observation!.standing;
    assert.equal(cardStandingV1(older.observation).kind, 'bought_not_sellable');
    assert.equal(opportunityCardViewV1(older).standingGroup, 'bought_not_sellable');
  });

  test('an open buyer window is not rebuilt into a zero', () => {
    const collecting = wire({ token: `0x${'7'.repeat(40)}`, symbol: 'OPEN', buyerCount: 5, windowStatus: 'collecting' });
    delete collecting.observation!.standing;
    // A window still counting has counted nobody, so the honest answer is that
    // Miorail cannot yet say which of the two it is.
    assert.equal(cardStandingV1(collecting.observation).kind, 'sale_unpriced');
    assert.equal(opportunityCardViewV1(collecting).standingGroup, 'miorail_limit');
  });
});

describe('sections', () => {
  test('the finding leads and Miorail’s own limits come last', () => {
    const sections = opportunitySectionsV1([NO_VENUE, NO_BUYERS, BOUGHT, DEGRADED, TWO_SIDED]);
    assert.deepEqual(
      sections.map((section) => section.group),
      ['bought_not_sellable', 'two_sided', 'no_buyers_yet', 'miorail_limit'],
    );
    assert.deepEqual(sections[3]!.cards.map((card) => card.symbol), ['MADI', 'RQQAD']);
  });

  test('an empty section is dropped, never drawn as a zero', () => {
    // "0 tokens were bought and could not be sold" is a claim about one page,
    // not about the feed, and it reads as the opposite of what it means.
    const sections = opportunitySectionsV1([NO_BUYERS]);
    assert.deepEqual(sections.map((section) => section.group), ['no_buyers_yet']);
  });
});

function render(cards: readonly ReturnType<typeof opportunityCardViewV1>[]) {
  return renderToStaticMarkup(
    <OpportunitiesScreen
      pipelineNotice={null}
      pipelineState="healthy"
      feedRenderable
      cards={cards}
      filter="all"
      standingFilter="all"
      freshOnly={false}
      loading={false}
      onFilterChange={() => undefined}
      onStandingFilterChange={() => undefined}
      onFreshOnlyChange={() => undefined}
      onOpenToken={() => undefined}
    />,
  );
}

describe('the screen separates a finding from a failure to measure', () => {
  test('the Miorail section is drawn, and says the cards in it are not about the token', () => {
    const markup = render([BOUGHT, NO_VENUE]);
    assert.match(markup, /Miorail could not measure these/);
    assert.match(markup, /Nothing in this section is a statement about the token/);
  });

  test('the finding is rendered above Miorail’s own limits', () => {
    const markup = render([NO_VENUE, BOUGHT]);
    // Order in the DOM, not order in the input array.
    assert.ok(
      markup.indexOf('Bought, and a sale would not price') < markup.indexOf('Miorail could not measure these'),
      'the section carrying the product’s finding was rendered below Miorail’s failures',
    );
  });

  test('the conclusion is on the card and the evidence is behind a control', () => {
    const markup = render([BOUGHT]);
    const verdict = markup.indexOf('62 wallets bought this');
    const control = markup.indexOf('What was measured');
    assert.ok(verdict >= 0 && control > verdict, 'the verdict must come before the evidence control');
    // The measured rows still exist — folded, not deleted.
    assert.match(markup, /Round trip/);
    assert.match(markup, /<details class="card-evidence">/);
  });

  test('a warning is never folded away', () => {
    // A pre-entry or transfer-policy sentence qualifies the numbers below it. A
    // warning a reader has to open something to see is not a warning.
    const withNotice = { ...BOUGHT, notices: ['Transfers are restricted by an active policy.'] };
    const markup = render([withNotice]);
    const notice = markup.indexOf('Transfers are restricted');
    const control = markup.indexOf('What was measured');
    assert.ok(notice >= 0 && notice < control, 'a notice was rendered inside the evidence fold');
  });

  test('the verdict filter is offered before the measurement state', () => {
    const markup = render([BOUGHT]);
    assert.match(markup, /What was found/);
    assert.match(markup, /Measurement state/);
    assert.ok(markup.indexOf('What was found') < markup.indexOf('Measurement state'));
    // The chip a reader clicks to get the 70 cards that matter.
    assert.match(markup, /Bought, no sale/);
  });
});

// ---------------------------------------------------------------------------
// Which venues a reading asked, on the card.
//
// `routeCoverage` says whether the candidates a search generated all answered.
// It cannot say which VENUES the search covered, and 1,581 stored observations
// claim complete coverage over a search that never included Uniswap v4 — where
// 2,161 of 2,171 resolved B20 pools live.
// ---------------------------------------------------------------------------

describe('a card states which venues were searched', () => {
  const withVenues = (venues: readonly string[] | null) =>
    opportunityCardViewV1(
      (() => {
        const card = wire({ token: `0x${'9'.repeat(40)}`, symbol: 'VEN', reasonCode: 'no_entry_route', entryRouteFound: false, buyerCount: 0 });
        delete card.observation!.standing;
        card.observation!.venuesConsulted = venues;
        return card;
      })(),
    );

  test('a row that records nothing says so, and is not read as "searched nothing"', () => {
    const view = withVenues(null);
    assert.equal(view.venueLabel, 'Not recorded');
    assert.match(view.venueNote!, /does not say which venues/i);
    assert.equal(view.standingKind, 'venue_not_searched');
  });

  test('an Aerodrome-only reading is named, and told it cannot support the finding', () => {
    const view = withVenues(['aerodrome']);
    assert.equal(view.venueLabel, 'Aerodrome');
    assert.match(view.venueNote!, /Uniswap v4 was not searched/);
    assert.equal(view.standingKind, 'venue_not_searched');
    assert.equal(view.aboutToken, false);
  });

  test('a reading that did search v4 names both venues and carries no warning', () => {
    const view = withVenues(['uniswap-v4', 'aerodrome']);
    assert.equal(view.venueLabel, 'Uniswap v4 + Aerodrome');
    assert.equal(view.venueNote, null);
    assert.equal(view.standingKind, 'venue_not_found');
  });

  test('the venue row renders inside the evidence fold, and its warning with it', () => {
    const markup = render([withVenues(['aerodrome'])]);
    assert.match(markup, /Venues searched/);
    assert.match(markup, /Uniswap v4 was not searched/);
    // Still filed under Miorail's own limits, never as a finding.
    assert.match(markup, /Miorail could not measure these/);
  });
});
