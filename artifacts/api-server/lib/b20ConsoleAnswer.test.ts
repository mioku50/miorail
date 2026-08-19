import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_PORTFOLIO_SIZE_CAVEAT_V1,
  b20ChangesAnswerV1,
  b20ComparabilityV1,
  b20ExploreAnswerV1,
  b20InvestigateAnswerV1,
  b20NeedsEvidenceAnswerV1,
  b20PortfolioAnswerV1,
  b20ResearchCandidatesAnswerV1,
  type B20ConsoleSummaryV1,
  type B20ConsoleTokenReadV1,
} from './b20ConsoleAnswer.js';
import type { B20ExitAssessmentV1 } from './b20ExitAssessment.js';

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
    assert.ok(result.caveats.some((entry) => /counts of the newest launches/.test(entry)));
    // The number itself, and the sentence that leads with it, must both say
    // which of the two figures it is. Asked "how many B20 launches were
    // measured in the last 48 hours", production answered "3000 in the last 48
    // hours" — true of what was read, and read by everyone as the total.
    assert.match(result.answer, /read the newest/);
    assert.match(result.answer, /does not establish the total/);
    const read = result.facts.find((fact) => fact.label === 'Launches read');
    assert.ok(read, 'the launches-read fact is present');
    assert.match(read.value, /scan cap reached, not the total/);
  });

  test('a complete scan states a total without a hedge', () => {
    // The other half. A caveat that fires on every answer teaches a reader to
    // skip it, so the complete window must not carry the capped wording.
    const result = b20ExploreAnswerV1({ summary: SUMMARY, intent: 'universe_counts' });
    assert.ok(!/scan cap/i.test(result.answer));
    assert.ok(!result.caveats.some((entry) => /scan limit was reached/.test(entry)));
    const read = result.facts.find((fact) => fact.label === 'Launches read');
    assert.equal(read?.value, `${SUMMARY.window.launches} in the last 48 hours`);
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
    project: null,
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
  indexStanding: 'indexed_b20',
  detection: null,
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
  // ---------------------------------------------------------------------
  // The MIO defect. A missing Discover row was reported as
  // "Not a canonical B20 launch in Miorail" — a sentence about the token,
  // built from a fact about our index. MIO (0xb200…0101) is confirmed by the
  // factory and launched 739,484 blocks before Discover began scanning, so
  // Miorail was denying its own token.
  //
  // Four states, four different sentences. The assertions below are written to
  // fail if any two of them are ever collapsed again.
  // ---------------------------------------------------------------------
  const MIO_V1 = '0xb200000000000000000000578f3ae29d9e6e0101';
  const missingRowV1 = (
    indexStanding: B20ConsoleTokenReadV1['indexStanding'],
    detection: B20ConsoleTokenReadV1['detection'] = null,
    tokenAddress = MIO_V1,
  ): B20ConsoleTokenReadV1 => ({
    tokenAddress, card: null, profile: null, historyCount: 0, indexStanding, detection,
  });

  // A — indexed: the fallback is not consulted and the existing answer stands.
  test('A · an indexed launch answers exactly as before', () => {
    const result = b20InvestigateAnswerV1({ reads: [readV1('a')] });
    // None of the three fallback branches may appear for a token we hold.
    assert.doesNotMatch(result.answer, /not indexed|could not be completed|not confirmed|confirmed onchain/i);
    assert.doesNotMatch(result.answer, /B20 identity/i);
    // The answer is still about the measurement, keyed by the token's symbol.
    assert.match(result.answer, /^a: /);
  });

  // B — confirmed by the factory, absent from the index. The regression that
  // matters: this answer must not contain a denial of the token.
  test('B · confirmed B20 with no index row is never called "not a B20"', () => {
    const result = b20InvestigateAnswerV1({ reads: [missingRowV1('confirmed_b20_not_indexed', 'b20')] });
    assert.doesNotMatch(result.answer, /not a canonical B20/i);
    assert.doesNotMatch(result.answer, /not a B20/i);
    assert.doesNotMatch(result.answer, /was not confirmed/i);
    assert.match(result.answer, /confirmed onchain/i);
    assert.match(result.answer, /not present in Miorail’s Discover index/i);
    // Identity and index are separate rows, and only the index one is a warning.
    const identity = result.facts.find((fact) => /B20 identity/.test(fact.label));
    const index = result.facts.find((fact) => /Discover index/.test(fact.label));
    assert.equal(identity?.value, 'Confirmed by factory');
    assert.equal(identity?.tone, 'positive');
    assert.equal(index?.value, 'Launch not indexed');
    assert.equal(index?.tone, 'warning');
    assert.ok(result.missingEvidence.some((entry) => /has not been ingested into Miorail Discover/.test(entry)));
  });

  test('B · created-but-uninitialised is reported without denying the identity', () => {
    const result = b20InvestigateAnswerV1({
      reads: [missingRowV1('confirmed_b20_not_indexed', 'b20_uninitialised')],
    });
    assert.doesNotMatch(result.answer, /not a B20/i);
    assert.ok(result.facts.some((fact) => fact.value === 'Created, not initialised'));
  });

  // C — the factory answered no. This is the only branch entitled to a denial.
  test('C · a factory negative is stated as the factory’s answer', () => {
    const result = b20InvestigateAnswerV1({ reads: [missingRowV1('not_b20', 'not_b20')] });
    assert.match(result.answer, /was not confirmed as a B20 token by the B20 factory/i);
    assert.doesNotMatch(result.answer, /confirmed onchain/i);
    // Must not claim anything about the index, which was never the question.
    assert.doesNotMatch(result.answer, /Historical Discover measurements/i);
  });

  // D — nothing was established. An outage must not read as either verdict.
  test('D · an unavailable identity check concludes nothing about the token', () => {
    const result = b20InvestigateAnswerV1({
      reads: [missingRowV1('identity_check_unavailable', 'rpc_failure')],
    });
    assert.match(result.answer, /could not be completed/i);
    assert.match(result.answer, /not evidence either way/i);
    assert.doesNotMatch(result.answer, /is not a B20/i);
    assert.doesNotMatch(result.answer, /was not confirmed as a B20/i);
    assert.doesNotMatch(result.answer, /confirmed onchain/i);
    assert.ok(result.missingEvidence.some((entry) => /completed B20 factory identity check/.test(entry)));
  });

  test('the four states never produce the same sentence', () => {
    const answers = [
      b20InvestigateAnswerV1({ reads: [readV1('a')] }).answer,
      b20InvestigateAnswerV1({ reads: [missingRowV1('confirmed_b20_not_indexed', 'b20')] }).answer,
      b20InvestigateAnswerV1({ reads: [missingRowV1('not_b20', 'not_b20')] }).answer,
      b20InvestigateAnswerV1({ reads: [missingRowV1('identity_check_unavailable', null)] }).answer,
    ];
    assert.equal(new Set(answers).size, 4);
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

const measured = (coverageBps: number | null, over: Partial<B20ExitAssessmentV1> = {}): B20ExitAssessmentV1 => ({
  status: 'measured_reference_bound',
  requestComparison: 'reference_profile_only',
  coverageBps,
  capacityStable: true,
  ...over,
});

const portfolio = (
  entries: readonly { symbol: string; assessment: B20ExitAssessmentV1; profile?: Partial<NonNullable<B20ConsoleTokenReadV1['profile']>> }[],
) =>
  b20PortfolioAnswerV1({
    reads: entries.map((entry) => readV1(entry.symbol, entry.profile ?? {})),
    assessments: Object.fromEntries(
      entries.map((entry) => [`0x${entry.symbol.repeat(40).slice(0, 40)}`, entry.assessment]),
    ),
  });

describe('Portfolio orders what was measured, and says whose size it was', () => {
  test('hardest to close first, by measured exit coverage', () => {
    const result = portfolio([
      { symbol: 'a', assessment: measured(9000) },
      { symbol: 'b', assessment: measured(1200) },
      { symbol: 'c', assessment: measured(4500) },
    ]);
    assert.match(result.answer, /^Hardest to close first/);
    assert.match(result.answer, /a smaller share is a harder exit: b at 12%, c at 45%, a at 90%/);
  });

  test('"of the rest" is only said when there WAS a preceding group', () => {
    // Observed live 2026-08-15: with no unsellable position the answer opened
    // on a phrase referring back to nothing.
    const alone = portfolio([{ symbol: 'a', assessment: measured(9000) }]);
    assert.doesNotMatch(alone.answer, /Of the rest/);

    const after = portfolio([
      { symbol: 'a', assessment: { status: 'no_supported_exit_route' } },
      { symbol: 'b', assessment: measured(9000) },
    ]);
    assert.match(after.answer, /Of the rest, hardest to close first/);
  });

  test('no sale priced is its own group, and is not a cost', () => {
    // Ranking an absence beside a measurement would put "we could not price
    // this" in an ordering of prices.
    const result = portfolio([
      { symbol: 'a', assessment: { status: 'no_supported_exit_route' } },
      { symbol: 'b', assessment: measured(1200) },
    ]);
    assert.match(result.answer, /^One position priced no sale at all at the reference size: a\./);
    assert.match(result.answer, /it is not a cost — nothing was quoted to compare/);
  });

  test('positions measured against different reference sizes are stated, not ordered', () => {
    const result = portfolio([
      { symbol: 'a', assessment: measured(9000) },
      { symbol: 'b', assessment: measured(1200), profile: { referencePositionAtomic: '999' } },
    ]);
    assert.doesNotMatch(result.answer, /hardest to close first/);
    assert.match(result.answer, /not against the same reference position, so they are stated rather than ordered/);
  });

  test('the size caveat is in the answer itself, not only under the fold', () => {
    const result = portfolio([{ symbol: 'a', assessment: measured(9000) }]);
    assert.match(result.answer, /not at the size you are holding/);
    assert.ok(result.caveats.includes(B20_PORTFOLIO_SIZE_CAVEAT_V1));
  });

  test('an unmeasured position is named as unranked rather than ranked last', () => {
    // Sorting it to the bottom would read as "the worst one", which is a claim
    // about the token rather than about the absence of a measurement.
    const result = portfolio([
      { symbol: 'a', assessment: measured(9000) },
      { symbol: 'b', assessment: { status: 'not_measured' } },
      { symbol: 'c', assessment: { status: 'capacity_not_measured' } },
    ]);
    assert.match(result.answer, /2 positions could not be ordered/);
    assert.match(result.answer, /b has no stored measurement yet/);
    assert.match(result.answer, /c has no measured exit capacity to order by/);
    assert.ok(result.missingEvidence.some((entry) => /An Exit-First measurement for b/.test(entry)));
  });

  test('an unstable ladder is flagged on the position it belongs to', () => {
    const result = portfolio([{ symbol: 'a', assessment: measured(9000, { capacityStable: false }) }]);
    assert.match(result.facts[0]?.value ?? '', /ladder unstable/);
    assert.equal(result.facts[0]?.tone, 'warning');
  });

  test('the reads never repeat the wallet’s holdings', () => {
    const result = portfolio([{ symbol: 'a', assessment: measured(9000) }, { symbol: 'b', assessment: measured(1200) }]);
    assert.deepEqual(result.reads, [
      { tool: 'positions', detail: '2 held tokens, read from stored measurements only' },
    ]);
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
    assert.match(result.answer, /WORM at \+2\.5%/);
    assert.match(result.answer, /MOSS at -12%/);
    assert.ok(result.caveats.some((entry) => /It is not a price/.test(entry)));
  });

  test('a symbol that is a number does not read as one', () => {
    // Observed live: a B20 token whose symbol is "40", rendered directly after
    // the sentence's own count of 40 launches.
    const result = b20ChangesAnswerV1({
      changes: {
        movers: [mover('40', -2793)],
        excluded: [],
        collectingHistory: false,
        baselineAgeMs: 24 * 60 * 60 * 1000,
        pairsConsidered: 40,
      },
    });
    assert.match(result.answer, /40 at -27\.93%/);
    assert.doesNotMatch(result.answer, /: 40 -27\.93%/);
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

// ---------------------------------------------------------------------------
// The two answers added for questions readers actually asked.
// ---------------------------------------------------------------------------

describe('"which launches need more evidence" answers about the measurement', () => {
  test('the gaps are attributed in the leading sentence, and broken down by reason', () => {
    const result = b20NeedsEvidenceAnswerV1({ summary: SUMMARY });
    // 193 + 44 — every standing whose `aboutToken` is false, read off the flag
    // rather than off a hand-kept list of kinds.
    assert.match(result.answer, /^237 launches in the last 48 hours carry a reading Miorail did not finish/);
    assert.match(result.answer, /limits of Miorail’s measurement, not properties of the tokens/);
    assert.match(result.answer, /market not fully measured \(193\)/);
    assert.match(result.answer, /not measured yet \(44\)/);
  });

  test('the assertions say the subject is Miorail, so a narration must attribute it', () => {
    const result = b20NeedsEvidenceAnswerV1({ summary: SUMMARY });
    assert.equal(result.assertions.about, 'miorail');
    assert.equal(result.assertions.matched, 237);
  });

  test('a window with no gaps says so rather than printing an empty breakdown', () => {
    const result = b20NeedsEvidenceAnswerV1({
      summary: {
        ...SUMMARY,
        standing: [{ kind: 'two_sided', group: 'two_sided', count: 112, aboutToken: true }],
      },
    });
    assert.match(result.answer, /carries a completed reading/);
    assert.equal(result.assertions.matched, 0);
  });
});

describe('"what is worth looking at" answers without ranking anything', () => {
  const CATEGORIES = [
    {
      label: 'Bought, and a sale would not price',
      because: 'wallets bought in the launch window and Miorail could not price a sale back.',
      cards: [cardV1({ symbol: 'WORM' })],
    },
    {
      label: 'Both directions priced',
      because: 'a purchase and a sale were both quoted against the same measured pool.',
      cards: [cardV1({ symbol: 'MOSS' })],
    },
  ];

  test('the categories are named, and none of them is a superlative', () => {
    const result = b20ResearchCandidatesAnswerV1({ categories: CATEGORIES, movers: [] });
    assert.match(result.answer, /not a ranking, not a score and not a shortlist to buy/);
    assert.ok(!/\b(best|top|promising|recommend)\b/i.test(result.answer), result.answer);
    assert.deepEqual(
      result.facts.map((fact) => fact.label),
      ['Bought, and a sale would not price', 'Both directions priced'],
    );
    assert.deepEqual(result.assertions.subjects, ['WORM', 'MOSS']);
  });

  test('an empty category is a named absence, not a silent omission', () => {
    const result = b20ResearchCandidatesAnswerV1({
      categories: [{ ...CATEGORIES[0]!, cards: [] }],
      movers: [],
    });
    assert.ok(
      result.missingEvidence.some((entry) => /Bought, and a sale would not price — no launch/.test(entry)),
      result.missingEvidence.join(' | '),
    );
    // Nothing to put forward is a state of the measurement, and the answer
    // says which. A refusal here would be the defect this intent replaced.
    assert.match(result.answer, /not a statement about any token/);
    assert.equal(result.assertions.matched, 0);
  });

  test('no comparable pair is reported as an absence of comparison, never of movement', () => {
    const result = b20ResearchCandidatesAnswerV1({ categories: CATEGORIES, movers: [] });
    assert.ok(
      result.missingEvidence.some((entry) => /two comparable observations about 24 hours apart/.test(entry)),
      result.missingEvidence.join(' | '),
    );
  });
});
