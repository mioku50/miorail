import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { b20ExitStandingV1 } from '../src/exitStanding.js';

// ---------------------------------------------------------------------------
// One sentence used to cover four different situations.
//
// Every rejected Discover card read "Ruled out by public evidence for the
// feed's reference profile" — 4,067 of them on 2026-08-15. Measured, that one
// sentence was standing in for: Miorail never found the pool (892), the
// measurement did not complete (311), nobody has ever bought the token (1,769)
// and people bought it and Miorail could not price a sale (190).
//
// Two of those four are about MIORAIL. These tests pin which.
// ---------------------------------------------------------------------------

const measured = (over: Partial<{
  state: 'candidate' | 'provisional' | 'rejected' | 'unmeasured';
  reasonCode: string | null;
  entryRouteFound: boolean;
  exitRouteFound: boolean;
}>) => ({
  state: 'rejected' as const,
  reasonCode: null,
  entryRouteFound: true,
  exitRouteFound: false,
  ...over,
});

describe('a card never reports Miorail’s own limits as a finding', () => {
  test('nothing measured yet is not a verdict', () => {
    const standing = b20ExitStandingV1({ observation: null, buyerCount: null });
    assert.equal(standing.kind, 'not_measured');
    assert.equal(standing.aboutToken, false);
  });

  test('a degraded route search is our failure, not the token’s', () => {
    const standing = b20ExitStandingV1({
      observation: measured({ reasonCode: 'route_search_degraded' }),
      buyerCount: 0,
    });
    assert.equal(standing.kind, 'measurement_incomplete');
    assert.equal(standing.aboutToken, false);
    // It must not be readable as "nobody bought it", which is the neighbouring
    // branch and the one a zero buyer count would otherwise select.
    assert.doesNotMatch(standing.headline, /bought/i);
  });

  test('an unmeasured state outranks everything below it', () => {
    const standing = b20ExitStandingV1({
      observation: measured({ state: 'unmeasured', entryRouteFound: false }),
      buyerCount: null,
    });
    assert.equal(standing.kind, 'measurement_incomplete');
    assert.equal(standing.aboutToken, false);
  });

  test('no entry route says Miorail did not find the venue', () => {
    // 892 of these had no pool row at all. The old copy called it a rejection;
    // it is a gap in what was searched.
    const standing = b20ExitStandingV1({
      observation: measured({ entryRouteFound: false, reasonCode: 'no_entry_route' }),
      buyerCount: 0,
    });
    assert.equal(standing.kind, 'venue_not_found');
    assert.equal(standing.aboutToken, false);
    assert.match(standing.detail, /not proof that the token trades nowhere/i);
  });
});

describe('the buyer aggregate is what splits an absent market from a trapped one', () => {
  test('zero buyers means there is nothing to sell into', () => {
    const standing = b20ExitStandingV1({
      observation: measured({ reasonCode: 'no_exit_route' }),
      buyerCount: 0,
    });
    assert.equal(standing.kind, 'no_buyers_yet');
    assert.equal(standing.aboutToken, true);
    assert.match(standing.headline, /Nobody has bought this yet/);
  });

  test('real buyers and no priced sale is the card worth showing', () => {
    const standing = b20ExitStandingV1({
      observation: measured({ reasonCode: 'no_exit_route' }),
      buyerCount: 62,
    });
    assert.equal(standing.kind, 'bought_not_sellable');
    assert.equal(standing.aboutToken, true);
    assert.match(standing.headline, /62 wallets bought this/);
    // It states what was measured and refuses the explanation it does not have.
    assert.match(standing.detail, /did not establish why/i);
  });

  test('one buyer is not pluralised into a crowd', () => {
    const standing = b20ExitStandingV1({
      observation: measured({ reasonCode: 'no_exit_route' }),
      buyerCount: 1,
    });
    assert.match(standing.headline, /^1 wallet bought this/);
  });

  test('an uncounted window is not read as zero', () => {
    // 560 launches have no completed buyer window. Treating null as zero would
    // print "nobody has bought this" about a token nobody has counted.
    const standing = b20ExitStandingV1({
      observation: measured({ reasonCode: 'no_exit_route' }),
      buyerCount: null,
    });
    assert.equal(standing.kind, 'sale_unpriced');
    assert.equal(standing.aboutToken, false);
    assert.match(standing.detail, /cannot yet say whether/i);
  });
});

describe('both directions priced', () => {
  test('a rejection with both routes is about the reference check, not the route', () => {
    const standing = b20ExitStandingV1({
      observation: measured({ exitRouteFound: true, reasonCode: 'round_trip_above_tolerance' }),
      buyerCount: 12,
    });
    assert.equal(standing.kind, 'ruled_out');
    assert.equal(standing.aboutToken, true);
    assert.match(standing.detail, /round_trip_above_tolerance/);
  });

  test('a provisional two-sided quote still refuses to be an executable one', () => {
    const standing = b20ExitStandingV1({
      observation: measured({ state: 'provisional', exitRouteFound: true }),
      buyerCount: 40,
    });
    assert.equal(standing.kind, 'two_sided');
    assert.match(standing.detail, /before any entry moved the pool/i);
    assert.match(standing.detail, /not an executable quote/i);
  });
});

describe('no branch reads as advice', () => {
  test('every headline avoids recommendation vocabulary', () => {
    const cases = [
      b20ExitStandingV1({ observation: null, buyerCount: null }),
      b20ExitStandingV1({ observation: measured({ reasonCode: 'route_search_degraded' }), buyerCount: 0 }),
      b20ExitStandingV1({ observation: measured({ entryRouteFound: false }), buyerCount: 0 }),
      b20ExitStandingV1({ observation: measured({}), buyerCount: 0 }),
      b20ExitStandingV1({ observation: measured({}), buyerCount: 9 }),
      b20ExitStandingV1({ observation: measured({}), buyerCount: null }),
      b20ExitStandingV1({ observation: measured({ exitRouteFound: true }), buyerCount: 9 }),
      b20ExitStandingV1({ observation: measured({ state: 'provisional', exitRouteFound: true }), buyerCount: 9 }),
    ];
    for (const standing of cases) {
      assert.doesNotMatch(
        `${standing.headline} ${standing.detail}`,
        /\b(safe|unsafe|scam|rug|honeypot|buy now|opportunity|promising|gem|moon)\b/i,
        `standing ${standing.kind} used recommendation or accusation vocabulary`,
      );
    }
  });

  test('only the branches that measured the token claim to be about it', () => {
    const aboutToken = (input: Parameters<typeof b20ExitStandingV1>[0]) =>
      b20ExitStandingV1(input).aboutToken;
    assert.equal(aboutToken({ observation: null, buyerCount: null }), false);
    assert.equal(aboutToken({ observation: measured({ reasonCode: 'route_search_degraded' }), buyerCount: 5 }), false);
    assert.equal(aboutToken({ observation: measured({ entryRouteFound: false }), buyerCount: 5 }), false);
    assert.equal(aboutToken({ observation: measured({}), buyerCount: null }), false);
    assert.equal(aboutToken({ observation: measured({}), buyerCount: 0 }), true);
    assert.equal(aboutToken({ observation: measured({}), buyerCount: 5 }), true);
  });
});
