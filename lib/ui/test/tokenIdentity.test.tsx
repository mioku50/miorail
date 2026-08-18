import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  B20ExitCapacityLeadersCard,
  type B20MarketRailsModelV1,
} from '../src/console/B20MarketRails';
import { OpportunitiesScreen, type OpportunityCardViewV1 } from '../src/console/OpportunitiesScreen';
import { opportunityCardViewV1 } from '../src/console/opportunityCardView';
import { TokenIdentityV1 } from '../src/console/TokenIdentity';

void React;

// ---------------------------------------------------------------------------
// The two CHEESEBURGEs.
//
// A Discover screen showed the feed card and the exit rail both headed
// `CHEESEBURGE`, with different round trips and different tested exits. They
// were two different contracts, and neither surface printed an address — so
// the screen read as one token whose own numbers contradicted each other.
//
// These are the real addresses and the real numbers from production on
// 2026-08-18.
// ---------------------------------------------------------------------------

const FEED_CHEESEBURGE = '0xb200000000000000000000e8a8e7f56723f7b997';
const RAIL_CHEESEBURGE = '0xb20000000000000000000000b55c902d374e9b01';

describe('a token is named by its address, not only by what the deployer typed', () => {
  test('the symbol and the address travel together', () => {
    const html = renderToStaticMarkup(
      <TokenIdentityV1 symbol="CHEESEBURGE" name="Cheeseburger" tokenAddress={FEED_CHEESEBURGE} />,
    );
    assert.match(html, /CHEESEBURGE/);
    assert.match(html, /Cheeseburger/);
    assert.match(html, /0xb20000…b997/);
    // The full address is recoverable without a round trip to a block explorer.
    assert.match(html, new RegExp(`title="${FEED_CHEESEBURGE}"`));
  });

  test('two launches sharing a symbol are told apart', () => {
    // The whole point. `shortAddressV1` keeps BOTH ends precisely because every
    // B20 address opens `0xb2000000…` — a leading fragment alone would be
    // identical across all 33,541 launches and would separate nothing.
    const first = renderToStaticMarkup(
      <TokenIdentityV1 symbol="CHEESEBURGE" tokenAddress={FEED_CHEESEBURGE} />,
    );
    const second = renderToStaticMarkup(
      <TokenIdentityV1 symbol="CHEESEBURGE" tokenAddress={RAIL_CHEESEBURGE} />,
    );
    assert.notEqual(first, second);
    assert.match(first, /b997/);
    assert.match(second, /9b01/);
  });

  test('a token with no symbol is still identified, and invents nothing', () => {
    const html = renderToStaticMarkup(<TokenIdentityV1 symbol={null} tokenAddress={FEED_CHEESEBURGE} />);
    assert.match(html, /0xb20000…b997/);
    // No placeholder symbol, no "Unknown", no em-dash pretending to be a name.
    assert.ok(!/Unknown|—/.test(html));
  });

  test('a name identical to the symbol is not printed twice', () => {
    const html = renderToStaticMarkup(
      <TokenIdentityV1 symbol="MIO" name="MIO" tokenAddress={FEED_CHEESEBURGE} />,
    );
    assert.equal((html.match(/MIO/g) ?? []).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Rendered on the surfaces themselves, not asserted against the source: the
// defect was invisible in every unit test precisely because each component
// said the right words about the token it was given.
// ---------------------------------------------------------------------------

function wireCard(tokenAddress: string, symbol: string) {
  return {
    launch: {
      tokenAddress,
      name: 'Cheeseburger',
      symbol,
      variant: 'asset' as const,
      decimals: 18,
      blockNumber: '50141835',
      ageSeconds: null,
      launchTimeSource: 'discovered' as const,
      canonical: true,
    },
    observation: null,
    canCheckProfile: false,
    action: { action: 'none' as const, label: null, reason: 'Nothing has been measured yet.' },
    notMeasured: [],
  };
}

function renderFeed(cards: OpportunityCardViewV1[]): string {
  return renderToStaticMarkup(
    <OpportunitiesScreen
      pipelineNotice={null}
      pipelineState="healthy"
      feedRenderable
      cards={cards}
      filter="all"
      freshOnly={false}
      loading={false}
      onFilterChange={() => undefined}
      onFreshOnlyChange={() => undefined}
      onOpenToken={() => undefined}
    />,
  );
}

const leader = (tokenAddress: string, symbol: string) => ({
  tokenAddress,
  symbol,
  name: 'Cheeseburger',
  decimals: 18,
  largestPassingSizeAtomic: '11179191120910974312437596',
  capacityCoverageBps: 10_000,
  firstFailingSizeAtomic: null,
  toleranceBps: 300,
  optimisticRoundTripBps: 434,
  roundTripReferenceBps: 300,
  profileStatus: 'outside_round_trip_reference' as const,
  state: 'rejected' as const,
  reasonCode: 'round_trip_above_tolerance',
  measuredAt: '2026-08-18T17:11:01.443Z',
  staleAfter: '2026-08-18T17:41:01.443Z',
  observationBlockNumber: '50141835',
  freshness: 'stale' as const,
});

describe('the surfaces that put two CHEESEBURGEs on one screen', () => {
  test('the Discover card carries the address', () => {
    const markup = renderFeed([opportunityCardViewV1(wireCard(FEED_CHEESEBURGE, 'CHEESEBURGE'))]);
    assert.match(markup, /CHEESEBURGE/);
    assert.match(markup, /0xb20000…b997/);
  });

  test('the exit rail carries it too, and two rows are distinguishable', () => {
    const model: B20MarketRailsModelV1 = {
      loading: false,
      unavailableReason: null,
      leaders: [leader(FEED_CHEESEBURGE, 'CHEESEBURGE'), leader(RAIL_CHEESEBURGE, 'CHEESEBURGE')],
      movers: [],
      collectingHistory: false,
      toleranceBps: 300,
      moveLabel: '24h change from Miorail measured quotes',
      moveNote: 'Computed from two Miorail quotes about 24 hours apart.',
      now: new Date('2026-08-18T18:00:00.000Z'),
      expanded: false,
      onToggleExpanded: () => undefined,
    };
    const markup = renderToStaticMarkup(<B20ExitCapacityLeadersCard {...model} />);
    assert.match(markup, /0xb20000…b997/);
    assert.match(markup, /0xb20000…9b01/);
    // Both rows say CHEESEBURGE; only the address separates them, which is the
    // whole reason it is there.
    assert.equal((markup.match(/CHEESEBURGE/g) ?? []).length, 2);
  });
});
