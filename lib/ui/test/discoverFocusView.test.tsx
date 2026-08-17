import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OpportunitiesScreen } from '../src/console/OpportunitiesScreen';
import { opportunityCardViewV1, type OpportunityCardWireV1 } from '../src/console/opportunityCardView';
import { discoverCardDomIdV1 } from '../src/console/discoverFocus';

void React;

// ---------------------------------------------------------------------------
// "View measurement" opens THIS token's measurement, on Discover.
//
// It used to navigate to `/portfolio?token=0x…`: a different product area,
// which owns the wallet-bound exit check and no Discover measurement at all,
// and which has never read `?token=` — so a reader who clicked a rail row
// landed on a generic Portfolio page with their selection dropped.
//
// The panel below is what replaced it. Four of its states look identical to a
// component that only checks for a card, and only one of them is a fact about
// the token; these tests are mostly about keeping the other three apart.
// ---------------------------------------------------------------------------

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const FOCUSED = `0x${'b'.repeat(40)}`;
const OTHER = `0x${'c'.repeat(40)}`;

function wire(token: string, symbol: string): OpportunityCardWireV1 {
  return {
    launch: {
      tokenAddress: token,
      name: symbol,
      symbol,
      variant: 'asset',
      decimals: 18,
      blockNumber: '50000000',
      ageSeconds: 600,
      launchTimeSource: 'onchain_block',
      canonical: true,
    },
    observation: {
      observationId: `0x${'a'.repeat(64)}`,
      evidenceHash: `0x${'d'.repeat(64)}`,
      state: 'rejected',
      reasonCode: 'round_trip_above_tolerance',
      headline: 'wire headline',
      detail: 'The typed measurement sentence.',
      referencePositionAtomic: '100000000',
      referenceQuoteAsset: USDC,
      maxRoundTripBps: 300,
      entryRouteFound: true,
      exitRouteFound: true,
      entrySourceKey: 'uniswap-v4:pool',
      exitSourceKey: 'uniswap-v4:pool',
      routeCoverage: 'complete',
      optimisticRoundTripBps: 436,
      largestPassingSizeAtomic: '4000000000000000000000',
      firstFailingSizeAtomic: '8000000000000000000000',
      capacityStable: true,
      transferPolicyNotice: null,
      quoteAlignmentNotice: null,
      preEntryNotice: null,
      poolHook: null,
      launchBuyers: { buyerCount: 12, topBuyerShareBps: 1_200, topThreeShareBps: 3_000 },
      launchBuyerWindow: { status: 'measured', closesAtBlock: '50010000' },
      observationBlockNumber: '50000028',
      freshness: 'fresh',
    },
    canCheckProfile: false,
    action: { action: 'none', label: null, reason: 'No wallet check can create a supported exit route.' },
    notMeasured: ['future price', 'profit probability'],
  };
}

const FOCUSED_CARD = opportunityCardViewV1(wire(FOCUSED, 'MIO'));
const FEED_CARD = opportunityCardViewV1(wire(OTHER, 'QUIET'));

function render(focus: Parameters<typeof OpportunitiesScreen>[0]['focus'], cards = [FEED_CARD]) {
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
      focus={focus}
    />,
  );
}

const CLEAR = () => undefined;

describe('a focused token opens its measurement without leaving Discover', () => {
  test('the card renders with What was measured already open', () => {
    const markup = render({
      tokenAddress: FOCUSED,
      card: FOCUSED_CARD,
      loading: false,
      notFound: false,
      error: null,
      onClear: CLEAR,
    });
    assert.match(markup, /<h3>Measurement<\/h3>/);
    assert.match(markup, /Back to all/);
    // The whole point of the deep link: the evidence is open on arrival rather
    // than behind one more click.
    assert.match(markup, /<details class="card-evidence" open=""><summary>What was measured<\/summary>/);
    // And it is THIS token, not the first card in the feed.
    assert.ok(markup.indexOf('MIO') < markup.indexOf('QUIET'));
  });

  test('a token outside the current page still opens', () => {
    // The feed shows 25 of ~26,000 launches in the window and the rails rank
    // over 1,000, so the card a rail row points at is usually not on the page.
    const markup = render(
      { tokenAddress: FOCUSED, card: FOCUSED_CARD, loading: false, notFound: false, error: null, onClear: CLEAR },
      [FEED_CARD],
    );
    assert.match(markup, new RegExp(discoverCardDomIdV1(FOCUSED)));
    assert.match(markup, /MIO/);
  });

  test('every card carries the id its deep link points at', () => {
    const markup = render(undefined, [FEED_CARD]);
    assert.match(markup, new RegExp(`id="${discoverCardDomIdV1(OTHER)}"`));
  });

  test('nothing focused renders the feed exactly as before', () => {
    const markup = render(undefined);
    assert.ok(!/<h3>Measurement<\/h3>/.test(markup));
    assert.ok(!/Back to all/.test(markup));
    // And no card is force-opened.
    assert.ok(!/card-evidence" open/.test(markup));
  });

  test('a host that has not wired focus at all is unaffected', () => {
    const markup = render({ tokenAddress: null, card: null, loading: false, notFound: false, error: null, onClear: CLEAR });
    assert.ok(!/<h3>Measurement<\/h3>/.test(markup));
  });
});

describe('loading, absent and failed stay three different sentences', () => {
  test('loading says it is reading, not that there is nothing', () => {
    const markup = render({
      tokenAddress: FOCUSED,
      card: null,
      loading: true,
      notFound: false,
      error: null,
      onClear: CLEAR,
    });
    assert.match(markup, /Reading this token’s measurement/);
    assert.ok(!/no canonical B20 launch/.test(markup));
  });

  test('an address the index does not hold says so about the index', () => {
    const markup = render({
      tokenAddress: FOCUSED,
      card: null,
      loading: false,
      notFound: true,
      error: null,
      onClear: CLEAR,
    });
    // Never "this is not a B20 token" — Discover knows what it ingested, and
    // saying more would be a claim nothing measured.
    assert.match(markup, /Miorail has no canonical B20 launch at/);
    assert.match(markup, new RegExp(FOCUSED));
    assert.ok(!/not a B20/.test(markup));
  });

  test('a failed read is worded as Miorail’s failure, not the token’s', () => {
    const markup = render({
      tokenAddress: FOCUSED,
      card: null,
      loading: false,
      notFound: false,
      error: 'This token’s measurement could not be read.',
      onClear: CLEAR,
    });
    assert.match(markup, /could not be read/);
    assert.ok(!/no canonical B20 launch/.test(markup));
  });
});
