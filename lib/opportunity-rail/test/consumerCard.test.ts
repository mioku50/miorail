import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_EXIT_STANDING_KINDS_V1,
  b20ConsumerCardV1,
  b20ExitStandingV1,
  b20PercentLabelV1,
  type B20ConsumerCardInputV1,
  type B20ExitStandingKindV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Discover was showing `rejected` as a badge and `round_trip_above_tolerance`
// inside a sentence. Both are true evidence and neither is readable: `rejected`
// is a verdict about a REFERENCE THRESHOLD, and on screen it reads as a verdict
// about the token.
//
// These tests pin the reading, not the wording — every assertion is either "the
// engineering vocabulary is absent" or "this number/qualifier is present".
// ---------------------------------------------------------------------------

const BASE: B20ConsumerCardInputV1 = {
  standing: { kind: 'two_sided', aboutToken: true },
  roundTripBps: null,
  referenceBps: 300,
  buyerCount: null,
  exitCapacityLabel: null,
  measuredAgeLabel: null,
  fresh: true,
  hasObservation: true,
};

const card = (over: Partial<B20ConsumerCardInputV1> = {}) => b20ConsumerCardV1({ ...BASE, ...over });

/** Every string a reader can see on the collapsed card. */
const surface = (input: Partial<B20ConsumerCardInputV1> = {}): string => {
  const view = card(input);
  return [
    view.status,
    view.headline,
    view.body,
    ...view.facts.flatMap((fact) => [fact.label, fact.value, fact.note ?? '']),
  ].join(' | ');
};

describe('the consumer card never speaks the measurement’s internal language', () => {
  // The regression the task names outright. These strings are real reason codes
  // and states; not one of them may reach a headline, a body or a fact.
  const FORBIDDEN = [
    'round_trip_above_tolerance',
    'route_search_degraded',
    'venue_not_found',
    'venue_not_searched',
    'bought_not_sellable',
    'sale_unpriced',
    'no_buyers_yet',
    'measurement_incomplete',
    'not_measured',
    'two_sided',
    'ruled_out',
    'rejected',
    'provisional',
    'unmeasured',
    'candidate',
    'aboutToken',
    'reasonCode',
    'standing.kind',
    'bps',
  ];

  for (const kind of B20_EXIT_STANDING_KINDS_V1) {
    test(`${kind}: no state, kind or reason code appears anywhere on the card`, () => {
      const text = surface({
        standing: { kind, aboutToken: kind === 'two_sided' },
        roundTripBps: 438,
        buyerCount: 14,
        exitCapacityLabel: '≥ 1.03B BWIF',
        measuredAgeLabel: '57 min ago',
      });
      for (const term of FORBIDDEN) {
        assert.ok(
          !text.toLowerCase().includes(term.toLowerCase()),
          `${kind} card leaked "${term}": ${text}`,
        );
      }
    });
  }

  test('the words "failed", "bad" and "rejected" are never used about the token', () => {
    for (const kind of B20_EXIT_STANDING_KINDS_V1) {
      const text = surface({ standing: { kind, aboutToken: true }, roundTripBps: 438 }).toLowerCase();
      assert.ok(!/\bfailed\b/.test(text), `${kind}: "failed"`);
      assert.ok(!/\bbad\b/.test(text), `${kind}: "bad"`);
      assert.ok(!/\brejected\b/.test(text), `${kind}: "rejected"`);
    }
  });

  test('no investment language anywhere', () => {
    // §11. This surface exists to make measured facts readable, and there is no
    // field on it a caller could sort into a recommendation.
    const banned = ['promising', 'bullish', 'good buy', 'safe', 'high potential', 'opportunity to', 'score'];
    for (const kind of B20_EXIT_STANDING_KINDS_V1) {
      const text = surface({ standing: { kind, aboutToken: true }, roundTripBps: 438 }).toLowerCase();
      for (const word of banned) assert.ok(!text.includes(word), `${kind} leaked "${word}"`);
    }
  });
});

describe('the nine cases a reader actually meets', () => {
  test('both routes, within reference', () => {
    const view = card({ standing: { kind: 'two_sided', aboutToken: true }, roundTripBps: 210 });
    assert.equal(view.status, 'Both routes measured');
    assert.equal(view.tone, 'measured');
    assert.match(view.headline, /both priced/i);
    const cost = view.facts.find((fact) => fact.label === 'Round-trip cost');
    assert.equal(cost?.value, '2.10%');
    assert.equal(cost?.note, 'within 3% reference');
  });

  test('both routes, above reference — same status, the number carries the difference', () => {
    // The point of the whole change. `ruled_out` and `two_sided` measured the
    // SAME thing; only the threshold comparison differs, and that belongs to the
    // number rather than to a chip.
    const ruled = card({ standing: { kind: 'ruled_out', aboutToken: true }, roundTripBps: 438 });
    const two = card({ standing: { kind: 'two_sided', aboutToken: true }, roundTripBps: 210 });
    assert.equal(ruled.status, two.status);
    assert.equal(ruled.tone, two.tone);
    const cost = ruled.facts.find((fact) => fact.label === 'Round-trip cost');
    assert.equal(cost?.value, '4.38%');
    assert.equal(cost?.note, 'above 3% reference');
    // And the body says whose threshold it was.
    assert.match(ruled.body, /threshold this product set, not a fault found in the token/i);
  });

  test('entry only, zero observed buyers', () => {
    const view = card({ standing: { kind: 'no_buyers_yet', aboutToken: true }, buyerCount: 0 });
    assert.equal(view.status, 'No buyer activity');
    assert.equal(view.tone, 'absent');
    assert.match(view.body, /absent market, not a defect found in the token/i);
    assert.equal(view.facts.find((fact) => fact.label === 'Buyers in launch window')?.value, '0');
  });

  test('entry only, buyers observed — the product’s actual finding', () => {
    const view = card({ standing: { kind: 'bought_not_sellable', aboutToken: true }, buyerCount: 14 });
    assert.equal(view.tone, 'finding');
    assert.match(view.status, /Bought/);
    // Must not claim the token cannot be sold. §12.
    assert.match(view.body, /may still be possible at another venue or another size/i);
  });

  test('a single buyer says how thin that is', () => {
    const view = card({ standing: { kind: 'bought_not_sellable', aboutToken: true }, buyerCount: 1 });
    assert.equal(view.facts.find((fact) => fact.label === 'Buyers in launch window')?.note, 'one wallet — the thinnest this evidence gets');
  });

  test('aboutToken=false keeps the gap tone in every branch', () => {
    for (const kind of ['sale_unpriced', 'venue_not_found', 'venue_not_searched', 'measurement_incomplete', 'not_measured'] as B20ExitStandingKindV1[]) {
      const view = card({ standing: { kind, aboutToken: false } });
      assert.equal(view.tone, 'gap', `${kind} must read as a Miorail limit`);
      assert.equal(view.aboutToken, false);
      // The sentence is about Miorail, and says so by naming it.
      assert.match(view.headline + view.body, /Miorail/, `${kind} must name Miorail as the subject`);
    }
  });

  test('an incomplete measurement concludes nothing', () => {
    const view = card({ standing: { kind: 'measurement_incomplete', aboutToken: false } });
    assert.match(view.body, /Nothing was established either way/i);
  });

  test('a stale observation says so beside the age, not instead of it', () => {
    const view = card({ measuredAgeLabel: '4 h ago', fresh: false });
    const row = view.facts.find((fact) => fact.label === 'Measured');
    assert.equal(row?.value, '4 h ago');
    assert.equal(row?.note, 'past freshness window');
  });

  test('a fresh observation carries no stale qualifier', () => {
    const view = card({ measuredAgeLabel: '12 min ago', fresh: true });
    assert.equal(view.facts.find((fact) => fact.label === 'Measured')?.note, null);
  });

  test('no observation at all', () => {
    const view = card({ standing: { kind: 'not_measured', aboutToken: false }, hasObservation: false });
    assert.equal(view.tone, 'gap');
    assert.equal(view.facts.length, 0, 'nothing measured means no facts to show');
  });

  test('a measured card with no timestamp still says whether it is fresh', () => {
    // The Discover wire carries `freshness` and no measurement time. The card
    // says what it knows rather than inventing an age from a block number.
    const stale = card({ measuredAgeLabel: null, fresh: false });
    const row = stale.facts.find((fact) => fact.label === 'Freshness');
    assert.equal(row?.value, 'Past the freshness window');
    assert.match(row?.note ?? '', /re-measure/i);
    assert.equal(card({ measuredAgeLabel: null, fresh: true }).facts.find((f) => f.label === 'Freshness')?.note, null);
  });
});

describe('null is unknown, and never renders as zero', () => {
  test('a null round trip omits the row rather than printing 0%', () => {
    const view = card({ roundTripBps: null });
    assert.equal(view.facts.some((fact) => fact.label === 'Round-trip cost'), false);
  });

  test('a null buyer count omits the row rather than printing 0', () => {
    // The distinction the whole product rests on: null is a window still
    // counting, zero is a window that closed with nobody in it.
    const open = card({ buyerCount: null });
    const closed = card({ buyerCount: 0 });
    assert.equal(open.facts.some((fact) => fact.label === 'Buyers in launch window'), false);
    assert.equal(closed.facts.find((fact) => fact.label === 'Buyers in launch window')?.value, '0');
  });

  test('a null capacity omits the row', () => {
    assert.equal(card({ exitCapacityLabel: null }).facts.some((f) => f.label === 'Largest tested exit'), false);
  });

  test('a missing reference leaves the cost unqualified rather than guessing one', () => {
    const view = card({ roundTripBps: 438, referenceBps: null });
    assert.equal(view.facts.find((fact) => fact.label === 'Round-trip cost')?.note, null);
  });

  test('a lower-bound capacity is never presented as a measured ceiling', () => {
    const view = card({ exitCapacityLabel: '≥ 1.03B BWIF' });
    const row = view.facts.find((fact) => fact.label === 'Largest tested exit');
    assert.match(row?.value ?? '', /^≥/);
    assert.match(row?.note ?? '', /lower bound/i);
  });
});

describe('the collapsed card stays short', () => {
  test('at most four facts even when everything is known', () => {
    const view = card({
      roundTripBps: 438, buyerCount: 14, exitCapacityLabel: '≥ 1.03B BWIF', measuredAgeLabel: '57 min ago',
    });
    assert.ok(view.facts.length <= 4, `${view.facts.length} facts is a technical wall`);
    assert.ok(view.facts.length >= 2, 'a card with evidence must show some of it');
  });
});

describe('b20PercentLabelV1', () => {
  test('a round reference prints without decimals', () => {
    assert.equal(b20PercentLabelV1(300), '3%');
  });
  test('a measured cost keeps two decimals', () => {
    assert.equal(b20PercentLabelV1(438), '4.38%');
    assert.equal(b20PercentLabelV1(411), '4.11%');
  });
});

describe('the projection agrees with the standing it is built from', () => {
  test('aboutToken is carried through, never re-derived', () => {
    // Driven by the REAL standing function, so a change to it that flipped a
    // flag would fail here rather than silently move a card into a token
    // section.
    const standing = b20ExitStandingV1({
      observation: { state: 'provisional', reasonCode: null, entryRouteFound: true, exitRouteFound: false },
      buyerCount: null,
    });
    assert.equal(standing.aboutToken, false);
    assert.equal(card({ standing }).aboutToken, false);
    assert.equal(card({ standing }).tone, 'gap');
  });

  test('a real bought-not-sellable standing reaches the finding tone', () => {
    const standing = b20ExitStandingV1({
      observation: { state: 'rejected', reasonCode: null, entryRouteFound: true, exitRouteFound: false },
      buyerCount: 3,
    });
    assert.equal(standing.kind, 'bought_not_sellable');
    assert.equal(card({ standing, buyerCount: 3 }).tone, 'finding');
  });
});
