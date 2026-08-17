import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_FUNDAMENTAL_PREDICATES_V1,
  b20ClaimStandingV1,
  b20FundamentalProfileV1,
  type B20FundamentalPredicateV1,
  type B20FundamentalProfileV1,
} from '@mioagent/opportunity-rail';

import { b20FundamentalAnswerV1, type B20ConsoleProjectMatchV1 } from './b20ConsoleAnswer.js';

// ---------------------------------------------------------------------------
// The fundamental answer.
//
// One property runs through every test: a fundamental question is asked of the
// CLAIMED corpus, and an answer that borrows a number from the measured
// universe is answering a different question with someone else's evidence.
//
// The previous version of this answer opened with "Miorail has stored
// measurements for 881 B20 launches detected in the last 48 hours" before
// naming a single project, because it was built by the explore builder. That
// sentence is now unreachable from here: this function is never handed a
// summary.
// ---------------------------------------------------------------------------

const NOW = '2026-08-16T12:00:00.000Z';

function profileV1(overrides: {
  domain?: string;
  product?: { functional: boolean } | null;
  website?: boolean;
} = {}): B20FundamentalProfileV1 {
  const domain = overrides.domain ?? 'miorail.xyz';
  return b20FundamentalProfileV1({
    claim: b20ClaimStandingV1({
      claimantDomain: domain,
      status: 'verified',
      verifiedLinks: ['domain_file'],
      refutedLinks: [],
      lastCheckedAt: NOW,
    }),
    claimantDomain: domain,
    website:
      overrides.website === false
        ? null
        : { url: `https://${domain}`, reachable: true, observedAt: NOW },
    product:
      overrides.product === null
        ? null
        : {
            url: `https://${domain}/mcp`,
            reachable: true,
            functional: overrides.product?.functional ?? true,
            observedAt: NOW,
          },
    docs: null,
    repository: null,
    basePresence: null,
    launchedAt: null,
    now: NOW,
  });
}

function matchV1(overrides: Partial<B20ConsoleProjectMatchV1> = {}): B20ConsoleProjectMatchV1 {
  return {
    tokenAddress: '0xb200000000000000000000578f3ae29d9e6e0101',
    symbol: 'MIO',
    profile: profileV1(),
    indexed: true,
    ...overrides,
  };
}

/** Every word that would mean the answer had reached into the measured
 * universe. None may appear in a fundamental answer, in any branch. */
const MARKET_VOCABULARY = [
  'launches read',
  'in the last 48 hours',
  'bought',
  'sellable',
  'both directions',
  'exit',
  'round trip',
  'measurement',
  'buyer',
  'venue',
];

function everySentenceOf(answer: ReturnType<typeof b20FundamentalAnswerV1>): string {
  return [
    answer.answer,
    ...answer.facts.map((fact) => `${fact.label} ${fact.value}`),
    ...answer.missingEvidence,
    ...answer.caveats,
    ...answer.reads.map((read) => `${read.tool} ${read.detail}`),
  ]
    .join(' ')
    .toLowerCase();
}

describe('a fundamental answer is asked of the claimed corpus and quotes no other', () => {
  const answer = b20FundamentalAnswerV1({
    predicate: 'live_product',
    matches: [matchV1()],
    corpus: 1,
    available: true,
  });

  test('it leads with the match and its denominator', () => {
    assert.match(answer.answer, /^1 matched among 1 verified project claim: MIO has a live product\./);
  });

  test('the denominator is the claims, and the rest is named as outside rather than below', () => {
    // The wording the reader asked for: a launch with no claim was never
    // checked, so it cannot be reported as having failed one.
    assert.match(answer.answer, /outside this fundamental corpus and remain unknown/);
    assert.match(answer.answer, /never checked them/);
    assert.match(answer.answer, /nothing here is a negative finding about them/i);
  });

  test('no sentence reaches into the measured universe', () => {
    const text = everySentenceOf(answer);
    for (const word of MARKET_VOCABULARY) {
      assert.ok(!text.includes(word), `a fundamental answer said "${word}"`);
    }
  });

  test('the only read it reports is the project read', () => {
    assert.deepEqual(
      answer.reads.map((read) => read.tool),
      ['projects'],
    );
    assert.match(answer.reads[0]!.detail, /matched 1 of 1 verified project claim/);
  });

  test('the corpus is a FACT, so a narrator may quote it', () => {
    // The verifier rejects any figure that is not in the bundle. A denominator
    // that lived only in prose would make every narration of this answer fail.
    const corpus = answer.facts.find((fact) => fact.label === 'Fundamental corpus');
    assert.equal(corpus?.value, '1 verified project claim');
  });

  test('the matching finding is shown with its provenance and its time', () => {
    const fact = answer.facts.find((entry) => entry.label === 'MIO — product');
    assert.equal(fact?.value, 'Live · functional probe · 2026-08-16 12:00 UTC');
  });

  test('what was not established is named per token', () => {
    assert.ok(
      answer.missingEvidence.some((line) => line.startsWith('MIO — not established:') && line.includes('repository')),
      'the missing dimensions were not named',
    );
  });

  test('the predicate bounds its own claim in the caveats', () => {
    assert.ok(
      answer.caveats.some((caveat) => /not that it is useful, correct, safe or maintained/.test(caveat)),
      'the live-product caveat is missing',
    );
    assert.ok(
      answer.caveats.some((caveat) => /check on publication, not a review/.test(caveat)),
      'the publication caveat is missing',
    );
  });
});

describe('zero is a real answer, and it is not a negative one', () => {
  test('an empty match set says what the corpus was, not that projects failed', () => {
    const answer = b20FundamentalAnswerV1({
      predicate: 'repository_found',
      matches: [],
      corpus: 3,
      available: true,
    });
    // Not "none of them HAS a repository" — that asserts an absence Miorail
    // never established. The sentence is about what was established.
    assert.match(answer.answer, /Miorail has not established a repository for any of the 3 verified project claims it holds\./);
    assert.ok(!/none of (them|the)/i.test(answer.answer), 'the answer asserts an absence');
    assert.match(answer.answer, /outside this fundamental corpus and remain unknown/);
    const text = everySentenceOf(answer);
    for (const word of MARKET_VOCABULARY) assert.ok(!text.includes(word), `said "${word}"`);
  });

  test('an empty corpus is stated as empty rather than as nothing matching', () => {
    // "0 of 0" would read as a search that ran and found nothing. Nothing ran.
    const answer = b20FundamentalAnswerV1({
      predicate: 'live_product',
      matches: [],
      corpus: 0,
      available: true,
    });
    assert.match(answer.answer, /empty corpus rather than a negative answer/);
    assert.match(answer.answer, /serving a file on a domain it controls/);
  });

  test('a server without the layer says so about ITSELF', () => {
    // "This deployment does not run the layer" and "no project has claimed a
    // token" are different statements, and only the second is about tokens.
    const answer = b20FundamentalAnswerV1({
      predicate: 'live_product',
      matches: [],
      corpus: 0,
      available: false,
    });
    assert.match(answer.answer, /does not run the project-claim layer/);
    assert.match(answer.answer, /not about any token/);
    assert.deepEqual(answer.facts, []);
    assert.deepEqual(answer.reads, []);
  });
});

describe('a verified project that Discover has not ingested is still an answer', () => {
  // The bug: the feed read dropped a claimed token with no launch row using a
  // silent `continue`, so "which B20 have a live product" would have answered
  // "none" while the claim sat verified in the database. Identity, ingestion
  // and measurement are three axes.
  const answer = b20FundamentalAnswerV1({
    predicate: 'live_product',
    matches: [matchV1({ symbol: null, indexed: false })],
    corpus: 1,
    available: true,
  });

  test('the match is named by address rather than dropped', () => {
    assert.match(answer.answer, /1 matched among 1 verified project claim/);
    assert.match(answer.answer, /0xb200000000000000000000578f3ae29d9e6e0101/);
  });

  test('the missing launch row is reported as Miorail’s gap, against that token', () => {
    const line = answer.missingEvidence.find((entry) => entry.includes('no canonical launch row'));
    assert.ok(line, 'the index gap was not reported');
    assert.match(line!, /^0xb200000000000000000000578f3ae29d9e6e0101 —/);
    assert.match(line!, /The project claim is unaffected/);
  });
});

describe('every predicate produces an answer, and none of them ranks', () => {
  test('all eight are answerable and each names its own subject', () => {
    for (const predicate of B20_FUNDAMENTAL_PREDICATES_V1) {
      const answer = b20FundamentalAnswerV1({
        predicate: predicate as B20FundamentalPredicateV1,
        matches: [matchV1()],
        corpus: 2,
        available: true,
      });
      assert.match(answer.answer, /1 matched among 2 verified project claims/, predicate);
      assert.match(answer.answer, /outside this fundamental corpus/, predicate);
    }
  });

  test('nothing in an answer orders projects against one another', () => {
    const answer = b20FundamentalAnswerV1({
      predicate: 'verified_project',
      matches: [matchV1(), matchV1({ tokenAddress: '0xb200000000000000000000000000000000000bad', symbol: 'TWO' })],
      corpus: 2,
      available: true,
    });
    const text = everySentenceOf(answer);
    for (const word of ['best', 'top', 'strongest', 'score', 'rank', 'better', 'leading', 'promising']) {
      assert.ok(!text.includes(word), `a fundamental answer said "${word}"`);
    }
  });
});

describe('the singular corpus reads like a sentence', () => {
  test('one claim is "the one verified project claim", never "any of the 1"', () => {
    // The branch production renders today: the corpus is one claim.
    const answer = b20FundamentalAnswerV1({
      predicate: 'repository_found',
      matches: [],
      corpus: 1,
      available: true,
    });
    assert.match(
      answer.answer,
      /^Miorail has not established a repository for the one verified project claim it holds\./,
    );
    assert.ok(!/any of the 1 /.test(answer.answer), 'a plural helper leaked into a singular sentence');
  });
});
