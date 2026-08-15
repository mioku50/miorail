import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  b20ChangesAnswerV1,
  b20ComparabilityV1,
  b20ExploreAnswerV1,
  b20InvestigateAnswerV1,
  type B20ConsoleSummaryV1,
  type B20ConsoleTokenReadV1,
} from './b20ConsoleAnswer.js';

// ---------------------------------------------------------------------------
// The three scopes' deterministic answers.
//
// Every test here is about one distinction: whether a sentence describes the
// TOKEN or describes MIORAIL. The product's recurring failure is a count of
// what could not be measured, printed in the same shape as a count of tokens —
// and a global console is where that mistake would be made at scale, because
// it prints counts and nothing else.
// ---------------------------------------------------------------------------

const SUMMARY: B20ConsoleSummaryV1 = {
  window: { maxLaunchAgeMs: 48 * 60 * 60 * 1000, launches: 881, complete: true },
  standing: [
    { kind: 'bought_not_sellable', group: 'bought_not_sellable', count: 60, aboutToken: true },
    { kind: 'two_sided', group: 'two_sided', count: 112, aboutToken: true },
    { kind: 'venue_not_searched', group: 'miorail_limit', count: 193, aboutToken: false },
    { kind: 'not_measured', group: 'miorail_limit', count: 44, aboutToken: false },
  ],
  sections: [
    { group: 'bought_not_sellable', label: 'Bought, not sellable', count: 60 },
    { group: 'two_sided', label: 'Both directions priced', count: 112 },
    { group: 'miorail_limit', label: 'Miorail could not measure', count: 237 },
  ],
  venues: [{ venues: 'uniswap-v4,aerodrome', count: 600 }, { venues: null, count: 281 }],
  buyers: [
    { band: 'not_counted', count: 120 },
    { band: '0', count: 400 },
    { band: '1', count: 44 },
  ],
  computedAt: '2026-08-15T12:00:00.000Z',
  caveats: ['These are counts of STORED MEASUREMENTS inside a launch-age window.'],
};

describe('Explore states whose limit a count describes', () => {
  test('the Miorail-limit section is labelled as Miorail’s, on the fact itself', () => {
    const result = b20ExploreAnswerV1({ summary: SUMMARY, intent: 'universe_counts' });
    const fact = result.facts.find((entry) => entry.label === 'Miorail could not measure');
    assert.match(fact?.value ?? '', /Miorail’s own limit, not the token’s/);
    assert.equal(fact?.tone, 'warning');
  });

  test('the answer says so in prose too, not only in a chip', () => {
    const result = b20ExploreAnswerV1({ summary: SUMMARY, intent: 'universe_counts' });
    assert.match(result.answer, /237 of them describe a reading Miorail did not complete/);
    assert.match(result.answer, /none of those is a statement about the token/);
  });

  test('an unfinished venue search is an ABSENCE, not a property of 193 tokens', () => {
    const result = b20ExploreAnswerV1({ summary: SUMMARY, intent: 'universe_counts' });
    assert.ok(
      result.missingEvidence.some((entry) => /venue search that included Uniswap v4 for 193/.test(entry)),
      result.missingEvidence.join(' | '),
    );
  });

  test('an open buying window is never counted as nobody buying', () => {
    const result = b20ExploreAnswerV1({ summary: SUMMARY, intent: 'universe_counts' });
    assert.ok(result.missingEvidence.some((entry) => /which is not a zero/.test(entry)));
  });

  test('a truncated scan says the counts are of a prefix', () => {
    const result = b20ExploreAnswerV1({
      summary: { ...SUMMARY, window: { ...SUMMARY.window, complete: false } },
      intent: 'universe_counts',
    });
    assert.ok(result.caveats.some((entry) => /counts of the newest launches rather than of every launch/.test(entry)));
  });

  test('a question that named a finding is answered with that finding first', () => {
    // Measured live 2026-08-15: "which tokens did people buy but cannot sell"
    // and "where was coverage incomplete" both opened with the same universe
    // counts and appended the tokens at the end. The reads were right and the
    // sentence answered a different question.
    const result = b20ExploreAnswerV1({
      summary: SUMMARY,
      intent: 'find_bought_not_sellable',
      cards: [cardV1({ symbol: 'WORM' }), cardV1({ symbol: 'MOSS' })],
    });
    assert.match(result.answer, /^60 launches were bought and would not price a sale/);
    assert.match(result.answer, /The first 2 are: WORM, MOSS\./);
  });

  test('a finding about Miorail says so in the leading sentence, not in a caveat', () => {
    const result = b20ExploreAnswerV1({
      summary: SUMMARY,
      intent: 'find_not_searched',
      cards: [cardV1({ symbol: 'WORM' })],
    });
    assert.match(result.answer, /^193 launches carry a reading that never searched the venue/);
    assert.match(result.answer, /That is Miorail’s limit, not a property of those tokens/);
  });

  test('a find that matched nothing says so plainly', () => {
    // Zero is a real answer. Opening with the universe counts instead would
    // read as an evasion of a question that has a one-sentence answer.
    const result = b20ExploreAnswerV1({ summary: SUMMARY, intent: 'find_two_sided', cards: [] });
    assert.match(result.answer, /^No launch in the last 48 hours priced in both directions/);
  });

  test('all of them is not "the first two of them"', () => {
    const result = b20ExploreAnswerV1({
      summary: { ...SUMMARY, standing: [{ kind: 'bought_not_sellable', group: 'bought_not_sellable', count: 2, aboutToken: true }] },
      intent: 'find_bought_not_sellable',
      cards: [cardV1({ symbol: 'WORM' }), cardV1({ symbol: 'MOSS' })],
    });
    assert.match(result.answer, /They are: WORM, MOSS\./);
  });

  test('an empty universe is not reported as a shape', () => {
    const result = b20ExploreAnswerV1({
      summary: { ...SUMMARY, window: { ...SUMMARY.window, launches: 0 }, sections: [], standing: [] },
      intent: 'universe_counts',
    });
    assert.match(result.answer, /None of them has reached a stored conclusion yet/);
  });
});

// ---------------------------------------------------------------------------

const cardV1 = (overrides: {
  symbol: string;
  kind?: string;
  aboutToken?: boolean;
  headline?: string;
  roundTripBps?: number | null;
  exitRouteFound?: boolean;
}) =>
  ({
    schemaVersion: 'b20-opportunity-card/v1',
    launch: { tokenAddress: `0x${overrides.symbol.repeat(40).slice(0, 40)}`, symbol: overrides.symbol },
    observation: {
      standing: {
        kind: overrides.kind ?? 'two_sided',
        aboutToken: overrides.aboutToken ?? true,
        headline: overrides.headline ?? 'Both directions priced.',
        detail: `${overrides.symbol} priced in both directions at the reference size.`,
      },
      referenceQuoteAsset: '0x4200000000000000000000000000000000000006',
      optimisticRoundTripBps: overrides.roundTripBps === undefined ? 130 : overrides.roundTripBps,
      largestPassingSizeAtomic: null,
      observationBlockNumber: '49929328',
      freshness: 'fresh',
      exitRouteFound: overrides.exitRouteFound ?? true,
    },
  }) as never;

const readV1 = (
  symbol: string,
  profile: Partial<NonNullable<B20ConsoleTokenReadV1['profile']>> = {},
  card = cardV1({ symbol }),
): B20ConsoleTokenReadV1 => ({
  tokenAddress: `0x${symbol.repeat(40).slice(0, 40)}`,
  card,
  profile: {
    profileIdentity: 'reference/v1',
    referenceQuoteAsset: '0x4200000000000000000000000000000000000006',
    referencePositionAtomic: '30000000000000000',
    measurementVersion: 'b20-observation/v1',
    ...profile,
  },
  historyCount: 3,
});

describe('Investigate refuses to compare what was not measured the same way', () => {
  test('two tokens on the same profile are comparable', () => {
    assert.equal(b20ComparabilityV1([readV1('a'), readV1('b')]).comparable, true);
  });

  test('a different reference position is not comparable', () => {
    const verdict = b20ComparabilityV1([readV1('a'), readV1('b', { referencePositionAtomic: '100000000' })]);
    assert.equal(verdict.comparable, false);
    assert.match(verdict.reason ?? '', /different reference positions/);
  });

  test('a different measurement version is its own reason', () => {
    // Not the same statement: one is a different size, the other is a different
    // definition of the measurement itself.
    const verdict = b20ComparabilityV1([readV1('a'), readV1('b', { measurementVersion: 'b20-observation/v2' })]);
    assert.match(verdict.reason ?? '', /different versions of the measurement/);
  });

  test('the answer carries the refusal as a caveat rather than ranking anyway', () => {
    const result = b20InvestigateAnswerV1({
      reads: [readV1('a'), readV1('b', { referencePositionAtomic: '100000000' })],
    });
    assert.ok(result.caveats.some((entry) => /Each is stated on its own/.test(entry)));
  });
});

describe('Investigate says what it does not have', () => {
  test('an address that is not a canonical launch is a real answer, not an error', () => {
    const result = b20InvestigateAnswerV1({
      reads: [{ tokenAddress: '0x' + '9'.repeat(40), card: null, profile: null, historyCount: 0 }],
    });
    assert.match(result.answer, /not a canonical B20 launch/);
    assert.equal(result.facts[0]?.tone, 'warning');
  });

  test('a finding about Miorail is never reported as a property of the token', () => {
    const result = b20InvestigateAnswerV1({
      reads: [
        readV1('c', {}, cardV1({
          symbol: 'c',
          kind: 'venue_not_searched',
          aboutToken: false,
          headline: 'Miorail has not looked where this trades.',
          exitRouteFound: false,
        })),
      ],
    });
    assert.ok(
      result.caveats.some((entry) => /not evidence that the token cannot be sold/.test(entry)),
      result.caveats.join(' | '),
    );
  });

  test('a single stored observation is named as missing history', () => {
    const result = b20InvestigateAnswerV1({ reads: [{ ...readV1('d'), historyCount: 1 }] });
    assert.ok(result.missingEvidence.some((entry) => /second comparable observation/.test(entry)));
  });

  test('what was read is reported per token', () => {
    const result = b20InvestigateAnswerV1({ reads: [readV1('a'), readV1('b')] });
    assert.equal(result.reads.length, 2);
    assert.ok(result.reads.every((read) => read.tool === 'card'));
  });
});

// ---------------------------------------------------------------------------

const mover = (symbol: string, changeBps: number) =>
  ({
    tokenAddress: `0x${symbol.repeat(40).slice(0, 40)}`,
    symbol,
    name: symbol,
    decimals: 18,
    changeBps,
    intervalSeconds: 25 * 3600,
    freshness: 'fresh',
    profileStatus: 'within_reference',
  }) as never;

describe('Changes never reports an absence of comparison as an absence of movement', () => {
  test('waiting only on time says exactly that', () => {
    const result = b20ChangesAnswerV1({
      changes: {
        movers: [],
        excluded: [{ tokenAddress: '0x1', reason: 'no_baseline' }],
        collectingHistory: true,
        baselineAgeMs: 24 * 60 * 60 * 1000,
        pairsConsidered: 40,
      },
    });
    assert.match(result.answer, /the only thing missing is time/);
  });

  test('anything else says the pairs are not comparable, and lists why', () => {
    const result = b20ChangesAnswerV1({
      changes: {
        movers: [],
        excluded: [
          { tokenAddress: '0x1', reason: 'below_minimum_capacity' },
          { tokenAddress: '0x2', reason: 'below_minimum_capacity' },
          { tokenAddress: '0x3', reason: 'unstable_ladder' },
        ],
        collectingHistory: false,
        baselineAgeMs: 24 * 60 * 60 * 1000,
        pairsConsidered: 3,
      },
    });
    assert.match(result.answer, /This is not a statement that nothing moved/);
    assert.deepEqual(result.missingEvidence, [
      '2 launches: has too little measured exit to compare.',
      '1 launch: has a capacity ladder that disagreed with itself.',
    ]);
  });

  test('a move is stated as two quotes divided, never as a price', () => {
    const result = b20ChangesAnswerV1({
      changes: {
        movers: [mover('WORM', 250), mover('MOSS', -1200)],
        excluded: [],
        collectingHistory: false,
        baselineAgeMs: 24 * 60 * 60 * 1000,
        pairsConsidered: 12,
      },
    });
    assert.match(result.answer, /WORM \+2\.5%/);
    assert.match(result.answer, /MOSS -12%/);
    assert.ok(result.caveats.some((entry) => /It is not a price/.test(entry)));
  });

  test('the denominator is stated, so a count is not read as out of everything', () => {
    const result = b20ChangesAnswerV1({
      changes: {
        movers: [mover('WORM', 250)],
        excluded: [],
        collectingHistory: false,
        baselineAgeMs: 24 * 60 * 60 * 1000,
        pairsConsidered: 12,
      },
    });
    assert.match(result.answer, /Of 12 launches with stored history, 1 could be compared/);
    assert.ok(result.facts.some((fact) => fact.label === 'Pairs considered' && fact.value === '12'));
  });
});
