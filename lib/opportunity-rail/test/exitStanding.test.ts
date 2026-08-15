import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  B20_STANDING_GROUPS_V1,
  B20_STANDING_GROUP_COPY_V1,
  b20CardStandingGroupV1,
  b20ExitStandingV1,
  b20StandingGroupV1,
  type B20ExitStandingKindV1,
} from '../src/exitStanding.js';

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
  venuesConsulted: readonly string[] | null | undefined;
}>) => ({
  state: 'rejected' as const,
  reasonCode: null,
  entryRouteFound: true,
  exitRouteFound: false,
  // The default is a reading that DID search the venue where B20 tokens trade.
  // Tests about the venue gap say so explicitly, because the difference
  // between "looked and found nothing" and "did not look" is the whole point.
  venuesConsulted: ['uniswap-v4', 'aerodrome'] as readonly string[] | null | undefined,
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

  test('one buyer is not pluralised into a crowd, and is not left to imply a market', () => {
    // 44 of the 61 launches in this position in the live 48-hour window had
    // exactly one buyer. The count alone reads as far stronger evidence than
    // one wallet is.
    const standing = b20ExitStandingV1({
      observation: measured({ reasonCode: 'no_exit_route' }),
      buyerCount: 1,
    });
    assert.match(standing.headline, /^1 wallet bought this/);
    assert.match(standing.detail, /thinnest form this evidence takes/);
    // And it says what it did NOT check, rather than guessing at a deployer.
    assert.match(standing.detail, /did not check whose wallet it is/);
  });

  test('a real crowd is not given the single-wallet caveat', () => {
    const standing = b20ExitStandingV1({
      observation: measured({ reasonCode: 'no_exit_route' }),
      buyerCount: 62,
    });
    assert.doesNotMatch(standing.detail, /thinnest form/);
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

// ---------------------------------------------------------------------------
// The four sections.
//
// Eight kinds is the right resolution for a measurement and the wrong one for a
// screen. What must survive the collapse is the one property the split exists
// for: a card describing MIORAIL never lands in a section a reader would take
// as a finding about a token.
// ---------------------------------------------------------------------------

const EVERY_KIND_V1: readonly B20ExitStandingKindV1[] = [
  'not_measured',
  'measurement_incomplete',
  'venue_not_found',
  'no_buyers_yet',
  'bought_not_sellable',
  'sale_unpriced',
  'ruled_out',
  'two_sided',
];

describe('every card lands in exactly one section', () => {
  test('a standing about Miorail can never reach a token section', () => {
    for (const kind of EVERY_KIND_V1) {
      assert.equal(
        b20StandingGroupV1({ kind, aboutToken: false }),
        'miorail_limit',
        `${kind} escaped the Miorail section when aboutToken was false`,
      );
    }
  });

  test('the three kinds that measure the token get their own sections', () => {
    assert.equal(b20StandingGroupV1({ kind: 'bought_not_sellable', aboutToken: true }), 'bought_not_sellable');
    assert.equal(b20StandingGroupV1({ kind: 'no_buyers_yet', aboutToken: true }), 'no_buyers_yet');
    // A rejection and a provisional pass are one section: both mean a purchase
    // AND a sale priced against the same pool, which is the evidence. The
    // verdict that followed is on the card, in its own headline.
    assert.equal(b20StandingGroupV1({ kind: 'ruled_out', aboutToken: true }), 'two_sided');
    assert.equal(b20StandingGroupV1({ kind: 'two_sided', aboutToken: true }), 'two_sided');
  });

  test('the real standings agree with the flag they were built with', () => {
    // Run through the ACTUAL constructor rather than hand-made pairs: if a
    // branch ever flips its `aboutToken`, its section must move with it.
    const cases: { input: Parameters<typeof b20ExitStandingV1>[0]; group: string }[] = [
      { input: { observation: null, buyerCount: null }, group: 'miorail_limit' },
      { input: { observation: measured({ reasonCode: 'route_search_degraded' }), buyerCount: 3 }, group: 'miorail_limit' },
      { input: { observation: measured({ entryRouteFound: false }), buyerCount: 3 }, group: 'miorail_limit' },
      { input: { observation: measured({}), buyerCount: null }, group: 'miorail_limit' },
      { input: { observation: measured({}), buyerCount: 0 }, group: 'no_buyers_yet' },
      { input: { observation: measured({}), buyerCount: 62 }, group: 'bought_not_sellable' },
      { input: { observation: measured({ exitRouteFound: true }), buyerCount: 62 }, group: 'two_sided' },
      {
        input: { observation: measured({ state: 'provisional', exitRouteFound: true }), buyerCount: 62 },
        group: 'two_sided',
      },
    ];
    for (const { input, group } of cases) {
      const standing = b20ExitStandingV1(input);
      assert.equal(b20StandingGroupV1(standing), group, `${standing.kind} was filed under the wrong section`);
    }
  });

  test('a launch nobody has measured is Miorail’s gap, not a finding', () => {
    // 1,220 stored launches had no observation at all on 2026-08-15. Filing
    // them anywhere else would publish a backlog as a verdict.
    assert.equal(b20CardStandingGroupV1({ observation: null }), 'miorail_limit');
  });

  test('a card carries its observation’s own section', () => {
    assert.equal(
      b20CardStandingGroupV1({
        observation: { standing: b20ExitStandingV1({ observation: measured({}), buyerCount: 62 }) },
      }),
      'bought_not_sellable',
    );
  });
});

describe('a section header states what it found without recommending it', () => {
  test('every section has copy, in the declared order', () => {
    assert.deepEqual(
      [...B20_STANDING_GROUPS_V1],
      ['bought_not_sellable', 'two_sided', 'no_buyers_yet', 'miorail_limit'],
    );
    for (const group of B20_STANDING_GROUPS_V1) {
      const copy = B20_STANDING_GROUP_COPY_V1[group];
      assert.ok(copy.label.length > 0 && copy.chip.length > 0 && copy.note.length > 0, `${group} has empty copy`);
      // The chip sits in a filter row, so it has to stay short enough to read.
      assert.ok(copy.chip.length <= 18, `${group} chip is too long for a filter: ${copy.chip}`);
    }
  });

  test('no section header reads as advice or as an accusation', () => {
    for (const group of B20_STANDING_GROUPS_V1) {
      const copy = B20_STANDING_GROUP_COPY_V1[group];
      assert.doesNotMatch(
        `${copy.label} ${copy.chip} ${copy.note}`,
        /\b(safe|unsafe|scam|rug|honeypot|buy now|opportunity|promising|gem|moon|avoid)\b/i,
        `${group} used recommendation or accusation vocabulary`,
      );
    }
  });

  test('the Miorail section says outright that it is not about the token', () => {
    // The whole reason the section exists. 346 of 1,139 live cards sit in it.
    assert.match(
      B20_STANDING_GROUP_COPY_V1.miorail_limit.note,
      /Nothing in this section is a statement about the token/i,
    );
  });
});

// ---------------------------------------------------------------------------
// "We looked and found nothing" is not "we did not look".
//
// Measured 2026-08-15: 1,891 stored launches carry a USDC-denominated verdict
// while only TEN USDC pools exist. A USDC-denominated observation is the
// fingerprint of the Aerodrome fallback — and 1,662 of them were last measured
// before 2026-08-10, when Uniswap v4 entered the route search at all. 1,581
// claim `routeCoverage: 'complete'` over a search that never included the
// venue where B20 tokens trade.
// ---------------------------------------------------------------------------

describe('a verdict is only as wide as the venues behind it', () => {
  test('a search that skipped Uniswap v4 says so instead of blaming the token', () => {
    const standing = b20ExitStandingV1({
      observation: measured({ entryRouteFound: false, reasonCode: 'no_entry_route', venuesConsulted: ['aerodrome'] }),
      buyerCount: 0,
    });
    assert.equal(standing.kind, 'venue_not_searched');
    assert.equal(standing.aboutToken, false);
    assert.match(standing.headline, /has not looked where this trades/i);
    assert.match(standing.detail, /aerodrome/i);
    assert.match(standing.detail, /cannot support any statement/i);
  });

  test('a row that records no venues at all is unknown, never "searched nothing"', () => {
    // Every observation written before the field existed. Silence is not a
    // measurement in either direction.
    for (const venuesConsulted of [null, undefined, []]) {
      const standing = b20ExitStandingV1({
        observation: measured({ entryRouteFound: false, venuesConsulted }),
        buyerCount: 0,
      });
      assert.equal(standing.kind, 'venue_not_searched');
      assert.equal(standing.aboutToken, false);
      assert.match(standing.detail, /does not record which venues/i);
    }
  });

  test('a search that DID include Uniswap v4 keeps the ordinary venue verdict', () => {
    const standing = b20ExitStandingV1({
      observation: measured({
        entryRouteFound: false,
        reasonCode: 'no_entry_route',
        venuesConsulted: ['uniswap-v4', 'aerodrome'],
      }),
      buyerCount: 0,
    });
    assert.equal(standing.kind, 'venue_not_found');
    assert.equal(standing.aboutToken, false);
  });

  test('both venue verdicts are filed under Miorail’s own limits', () => {
    for (const venuesConsulted of [null, ['aerodrome'], ['uniswap-v4']]) {
      const standing = b20ExitStandingV1({
        observation: measured({ entryRouteFound: false, venuesConsulted }),
        buyerCount: 0,
      });
      assert.equal(b20StandingGroupV1(standing), 'miorail_limit');
    }
  });

  test('the venue set changes nothing once an entry actually priced', () => {
    // The gap only bounds a NEGATIVE finding. A priced entry is evidence in
    // itself, whatever else was or was not searched.
    const standing = b20ExitStandingV1({
      observation: measured({ entryRouteFound: true, venuesConsulted: ['aerodrome'] }),
      buyerCount: 62,
    });
    assert.equal(standing.kind, 'bought_not_sellable');
    assert.equal(standing.aboutToken, true);
  });

  test('neither venue verdict reads as advice or as an accusation', () => {
    for (const venuesConsulted of [null, ['aerodrome'], ['uniswap-v4']]) {
      const standing = b20ExitStandingV1({
        observation: measured({ entryRouteFound: false, venuesConsulted }),
        buyerCount: 0,
      });
      assert.doesNotMatch(
        `${standing.headline} ${standing.detail}`,
        /\b(safe|unsafe|scam|rug|honeypot|buy now|opportunity|promising|gem|moon)\b/i,
      );
    }
  });
});
