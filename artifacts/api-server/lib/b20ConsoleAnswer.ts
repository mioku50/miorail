import {
  B20_CONSUMER_STANDING_COPY_V1,
  B20_FUNDAMENTAL_DIMENSION_LABEL_V1,
  B20_FUNDAMENTAL_PREDICATE_RULES_V1,
  B20_FUNDAMENTAL_STANDING_COPY_V1,
  b20PredicateFindingV1,
  measurementProfileMismatchV1,
  type B20FundamentalPredicateV1,
  type B20FundamentalProfileV1,
  type B20OpportunityCardV1,
  type MeasuredMoverV1,
  type MoverExclusionV1,
} from '@mioagent/opportunity-rail';
import { b20QuoteAssetDisplayV1 } from '@mioagent/opportunity-rail/quoteAsset';
import type { B20DetectionOutcomeV1, B20TokenIndexStandingV1 } from '@mioagent/b20-control';

import type { B20AnswerAssertionsV1 } from './b20AnswerVerify.js';
import { b20AmountLabelV1 } from './b20Copilot.js';
import type { B20ExitAssessmentV1 } from './b20ExitAssessment.js';
import type { B20ConsolePlanV1 } from './b20ConsolePlan.js';

// ---------------------------------------------------------------------------
// Stage 07 — the answer, built from what was read and nothing else.
//
// Pure over already-read data: every function here takes the result of a plan
// step and returns words. That is what makes the scopes testable against a
// corpus rather than against a live database, and it is why the narrator can
// be handed a bundle that provably contains no figure the reader was not
// shown.
//
// The recurring hazard this file is written against is the one this product
// exists to name: a count of what MIORAIL could not measure, printed in the
// same shape as a count of tokens. `aboutToken` carries that distinction
// through the standing layer, and every sentence below that touches such a
// count says whose limit it is.
// ---------------------------------------------------------------------------

export interface B20ConsoleFactV1 {
  label: string;
  value: string;
  tone: 'neutral' | 'positive' | 'warning';
}

/** One bounded read that actually ran. Shown to the reader, because a global
 * answer has no single observation to pin and "what was this built from" is
 * the honest substitute for one. */
export interface B20ConsoleReadV1 {
  tool: string;
  detail: string;
}

export interface B20ConsoleDeterministicV1 {
  answer: string;
  facts: B20ConsoleFactV1[];
  missingEvidence: string[];
  caveats: string[];
  reads: B20ConsoleReadV1[];
  /**
   * What this answer MEANS, for the narrator to be held to.
   *
   * Every builder below produces it, and it is not derived from the sentence:
   * it is what the builder already knew while writing the sentence. A narration
   * that contradicts it is discarded — see `verifyB20NarrationSemanticsV1`.
   */
  assertions: B20AnswerAssertionsV1;
}

/** The counts a plan's `summary` step returned. Structurally the universe
 * summary, restated so this module does not depend on the route it came from. */
export interface B20ConsoleSummaryV1 {
  window: { maxLaunchAgeMs: number; launches: number; complete: boolean };
  standing: readonly { kind: string; group: string; count: number; aboutToken: boolean }[];
  sections: readonly { group: string; label: string; count: number }[];
  venues: readonly { venues: string | null; count: number }[];
  buyers: readonly { band: string; count: number }[];
  computedAt: string;
  caveats: readonly string[];
}

/** One token as Investigate reads it: the card a screen would draw, plus the
 * four fields that decide whether it may be set beside another. */
export interface B20ConsoleTokenReadV1 {
  tokenAddress: string;
  card: B20OpportunityCardV1 | null;
  profile: {
    profileIdentity: string;
    referenceQuoteAsset: string;
    referencePositionAtomic: string;
    measurementVersion: string;
  } | null;
  historyCount: number;
  /**
   * Which of the three separate questions this read actually answered.
   *
   * Required rather than optional: the whole defect was a missing index row
   * being read as a fact about the token, and a field that can be left out
   * would let a new call site reintroduce exactly that by saying nothing.
   * `indexed_b20` whenever `card` is present.
   */
  indexStanding: B20TokenIndexStandingV1;
  /** The factory outcome behind the standing, when one was obtained. Kept so
   * copy can distinguish a finished token from one created but uninitialised
   * without widening the standing enum. */
  detection: B20DetectionOutcomeV1 | null;
}

export interface B20ConsoleChangesReadV1 {
  movers: readonly MeasuredMoverV1[];
  excluded: readonly { tokenAddress: string; reason: MoverExclusionV1 }[];
  collectingHistory: boolean;
  baselineAgeMs: number;
  /** Launches the movers rail actually looked at. Without it, "3 moved" reads
   * as "3 out of everything" rather than "3 out of the pairs it could compare". */
  pairsConsidered: number;
}

const HOUR_MS_V1 = 60 * 60 * 1000;

function bpsV1(value: number): string {
  const percent = (value / 100).toFixed(2);
  return `${percent.replace(/\.?0+$/, '')}%`;
}

function signedBpsV1(value: number): string {
  return `${value > 0 ? '+' : ''}${bpsV1(value)}`;
}

function pluralV1(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function symbolV1(card: B20OpportunityCardV1): string {
  return card.launch.symbol || card.launch.tokenAddress;
}

/**
 * What a capped scan actually established.
 *
 * The summary reads the NEWEST launches up to a scan limit. When that limit is
 * reached before the window runs out, "3000 in the last 48 hours" is not the
 * number of launches in the window — it is the number Miorail looked at. The
 * two were indistinguishable on screen, and a reader had no way to tell a total
 * from a ceiling. Every surface that quotes the figure now carries this
 * sentence with it.
 */
export const SCAN_CAP_CAVEAT_V1 =
  'The scan limit was reached before the window ran out, so these are counts of the newest launches Miorail read rather than of every launch in the window.';

/** The caveat every scope carries. Stated once, at the end, in the reader's
 * words rather than the schema's. */
export const B20_CONSOLE_BASE_CAVEATS_V1 = [
  'This is a read of stored measurements. Nothing here is a quote you can execute, a recommendation, or a claim about a token’s future.',
] as const;

// ---------------------------------------------------------------------------
// Explore
// ---------------------------------------------------------------------------

function windowLabelV1(maxLaunchAgeMs: number): string {
  const hours = Math.round(maxLaunchAgeMs / HOUR_MS_V1);
  return pluralV1(hours, 'hour', 'hours');
}

/**
 * What each named finding is, said as the first sentence of its own answer.
 *
 * `none` is written to complete "No launch in the last 48 hours ___" and is as
 * load-bearing as the rest: a find that matched nothing has a plain answer, and
 * opening with the universe counts instead would read as an evasion.
 */
const FINDING_COPY_V1 = {
  find_bought_not_sellable: {
    standingKind: 'bought_not_sellable',
    group: null,
    headline: 'launches were bought and would not price a sale at the reference size.',
    none: 'was bought and then failed to price a sale.',
  },
  find_two_sided: {
    standingKind: null,
    group: 'two_sided',
    headline: 'launches priced in both directions at the reference size.',
    none: 'priced in both directions at the reference size.',
  },
  find_not_searched: {
    standingKind: 'venue_not_searched',
    group: null,
    // Whose limit this is, in the sentence that leads the answer rather than
    // in a caveat under it.
    headline: 'launches carry a reading that never searched the venue where B20 tokens trade. That is Miorail’s limit, not a property of those tokens.',
    none: 'is waiting on a venue search Miorail did not perform.',
  },
} as const;

export function b20ExploreAnswerV1(input: {
  summary: B20ConsoleSummaryV1;
  /** Present for the three "find" intents. Named tokens, already bounded. */
  cards?: readonly B20OpportunityCardV1[];
  intent: B20ConsolePlanV1['intent'];
}): B20ConsoleDeterministicV1 {
  const { summary } = input;
  const window = windowLabelV1(summary.window.maxLaunchAgeMs);
  const capped = !summary.window.complete;
  const facts: B20ConsoleFactV1[] = [
    {
      label: 'Launches read',
      // "3000 in the last 48 hours" reads as the total. It is the ceiling: the
      // scan stopped there. The distinction goes in the value itself, because
      // a caveat under the fold does not travel with the number.
      value: capped
        ? `${summary.window.launches} newest in the last ${window} — scan cap reached, not the total`
        : `${summary.window.launches} in the last ${window}`,
      tone: capped ? 'warning' : 'neutral',
    },
  ];

  // Sections in their display order, so the answer and the screen agree about
  // what the universe looks like.
  for (const section of summary.sections) {
    const aboutMiorail = section.group === 'miorail_limit';
    facts.push({
      label: section.label,
      value: `${pluralV1(section.count, 'launch', 'launches')}${aboutMiorail ? ' (Miorail’s own limit, not the token’s)' : ''}`,
      tone: aboutMiorail ? 'warning' : section.group === 'bought_not_sellable' ? 'warning' : 'neutral',
    });
  }

  const missingEvidence: string[] = [];
  const notMeasured = summary.standing.find((entry) => entry.kind === 'not_measured');
  if (notMeasured) {
    missingEvidence.push(
      `An Exit-First measurement for ${pluralV1(notMeasured.count, 'launch', 'launches')} in this window.`,
    );
  }
  const notSearched = summary.standing.find((entry) => entry.kind === 'venue_not_searched');
  if (notSearched) {
    missingEvidence.push(
      `A venue search that included Uniswap v4 for ${pluralV1(notSearched.count, 'launch', 'launches')}.`,
    );
  }
  const notCounted = summary.buyers.find((band) => band.band === 'not_counted');
  if (notCounted && notCounted.count > 0) {
    missingEvidence.push(
      `A closed launch-buying window for ${pluralV1(notCounted.count, 'launch', 'launches')} — an open window has counted nobody, which is not a zero.`,
    );
  }

  const caveats = [...summary.caveats, ...B20_CONSOLE_BASE_CAVEATS_V1];
  if (capped) caveats.push(SCAN_CAP_CAVEAT_V1);

  // The lead sentence says which of the two numbers this is. Asked "how many
  // B20 launches were measured in the last 48 hours", the console answered
  // "3000 in the last 48 hours" — true of what it read, and read by everyone
  // as the total.
  const context = capped
    ? `Miorail read the newest ${pluralV1(summary.window.launches, 'B20 launch', 'B20 launches')} detected in the last ${window}. The scan cap was reached, so this does not establish the total number of launches in that window.`
    : `Miorail has stored measurements for ${pluralV1(summary.window.launches, 'B20 launch', 'B20 launches')} detected in the last ${window}.`;
  const sectionSentence = summary.sections.length === 0
    ? ' None of them has reached a stored conclusion yet.'
    : ` They fall into ${pluralV1(summary.sections.length, 'group', 'groups')}: ${summary.sections
        .map((section) => `${section.label.toLowerCase()} (${section.count})`)
        .join(', ')}.`;

  const named = (input.cards ?? []).slice(0, 5);
  for (const card of named) {
    facts.push({
      label: symbolV1(card),
      value: card.observation?.headline ?? 'Not measured',
      tone: card.observation?.standing.aboutToken === false ? 'warning' : 'neutral',
    });
  }

  const limitGroup = summary.sections.find((section) => section.group === 'miorail_limit');
  const limitSentence = limitGroup
    ? ` ${limitGroup.count} of them describe a reading Miorail did not complete, and none of those is a statement about the token.`
    : '';

  // A question that named a finding is answered with that finding FIRST.
  //
  // Measured live 2026-08-15: "which tokens did people buy but cannot sell"
  // and "where was coverage incomplete" both came back opening with the same
  // universe counts, with the tokens appended at the end of the paragraph. The
  // reads were right and the sentence answered a different question.
  const finding = FINDING_COPY_V1[input.intent as keyof typeof FINDING_COPY_V1] ?? null;
  let lead = `${context}${sectionSentence}${limitSentence}`;

  let matched = summary.window.launches;
  if (finding) {
    const count = finding.standingKind
      ? summary.standing.find((entry) => entry.kind === finding.standingKind)?.count ?? 0
      : summary.sections.find((section) => section.group === finding.group)?.count ?? 0;
    matched = count;
    lead = named.length === 0
      // Zero is a real answer here and it is NOT the universe counts. Opening
      // with those would read as an evasion of a question with a plain answer.
      ? `No launch in the last ${window} ${finding.none} ${context}`
      : `${count} ${finding.headline} ${named.length === count ? 'They are' : `The first ${named.length} are`}: ${named
          .map((card) => symbolV1(card))
          .join(', ')}. ${context}${sectionSentence}`;
  }

  return {
    answer: lead,
    facts: facts.slice(0, 16),
    missingEvidence: missingEvidence.slice(0, 20),
    caveats: caveats.slice(0, 12),
    reads: [
      { tool: 'summary', detail: `${summary.window.launches} launches, window ${window}, computed ${summary.computedAt}` },
      ...(input.cards ? [{ tool: 'list', detail: `${input.cards.length} cards matching the question’s filter` }] : []),
    ],
    assertions: {
      // A summary that read launches HAS measured something, whatever the
      // finding count turns out to be. Zero matches is a result, not an
      // absence of one — which is why `matched` and `state` are separate.
      state: summary.window.launches > 0 ? 'measured' : 'not_measured',
      matched,
      complete: summary.window.complete,
      subjects: named.map((card) => symbolV1(card)),
      about: input.intent === 'find_not_searched' ? 'miorail' : 'token',
    },
  };
}

// ---------------------------------------------------------------------------
// Needs more evidence — the gaps, stated as Miorail's.
//
// Its own builder rather than a fourth `FINDING_COPY_V1` row, because the
// SUBJECT is different from every other answer in this console. "Which
// launches were bought and would not price a sale" is about tokens; "which
// launches need more evidence" is about a measurement Miorail did not finish,
// and the tokens named in it are named as places where that gap shows.
//
// So every sentence here attributes the gap, and the per-kind reasons come
// from the same table the Discover card renders — a second list of reasons
// would drift, and the two surfaces would then disagree about what
// `venue_not_searched` means.
// ---------------------------------------------------------------------------

export function b20NeedsEvidenceAnswerV1(input: {
  summary: B20ConsoleSummaryV1;
  /** The bounded page of `miorail_limit` cards, so the answer can name a few. */
  cards?: readonly B20OpportunityCardV1[];
}): B20ConsoleDeterministicV1 {
  const { summary } = input;
  const window = windowLabelV1(summary.window.maxLaunchAgeMs);
  // `aboutToken === false` is the definition of this section, and reading it
  // off the flag rather than off a hand-kept list of kinds is what stops a new
  // kind from silently landing in the token sections instead.
  const gaps = summary.standing
    .filter((entry) => entry.aboutToken === false && entry.count > 0)
    .slice()
    .sort((left, right) => right.count - left.count);
  const total = gaps.reduce((sum, entry) => sum + entry.count, 0);

  const facts: B20ConsoleFactV1[] = [];
  const missingEvidence: string[] = [];
  for (const gap of gaps) {
    const copy = B20_CONSUMER_STANDING_COPY_V1[gap.kind as keyof typeof B20_CONSUMER_STANDING_COPY_V1];
    facts.push({
      label: copy ? copy.headline : gap.kind.replaceAll('_', ' '),
      value: pluralV1(gap.count, 'launch', 'launches'),
      tone: 'warning',
    });
    if (copy) missingEvidence.push(`${copy.status}: ${copy.body}`);
  }

  const named = (input.cards ?? []).slice(0, 5);
  for (const card of named) {
    facts.push({
      label: symbolV1(card),
      value: card.observation?.standing.headline ?? 'Not measured',
      tone: 'warning',
    });
  }

  const caveats = [
    ...summary.caveats,
    // The sentence this whole answer exists to carry. Stated as a caveat AND in
    // the lead, because a reader who skims one will read the other.
    'Every line above is a gap in Miorail\u2019s own measurement. None of it is a finding about the tokens named, and none of it is evidence that they cannot be sold.',
    ...B20_CONSOLE_BASE_CAVEATS_V1,
  ];
  if (!summary.window.complete) caveats.push(SCAN_CAP_CAVEAT_V1);

  const answer =
    total === 0
      ? `Every B20 launch Miorail read in the last ${window} carries a completed reading, so there is no evidence gap to report in this window.`
      : `${pluralV1(total, 'launch', 'launches')} in the last ${window} carry a reading Miorail did not finish. ${
          gaps.length === 1 ? 'The reason is' : `The ${gaps.length} reasons are`
        }: ${gaps
          .map((gap) => {
            const copy = B20_CONSUMER_STANDING_COPY_V1[gap.kind as keyof typeof B20_CONSUMER_STANDING_COPY_V1];
            return `${copy ? copy.status.toLowerCase() : gap.kind.replaceAll('_', ' ')} (${gap.count})`;
          })
          .join(', ')}. These are limits of Miorail\u2019s measurement, not properties of the tokens${
          named.length > 0 ? `, and the ones below are where they currently show: ${named.map((card) => symbolV1(card)).join(', ')}` : ''
        }.`;

  return {
    answer,
    facts: facts.slice(0, 16),
    missingEvidence: missingEvidence.slice(0, 20),
    caveats: caveats.slice(0, 12),
    reads: [
      { tool: 'summary', detail: `${summary.window.launches} launches, window ${window}, computed ${summary.computedAt}` },
      ...(input.cards ? [{ tool: 'list', detail: `${input.cards.length} cards in the incomplete-reading section` }] : []),
    ],
    assertions: {
      state: summary.window.launches > 0 ? 'measured' : 'not_measured',
      matched: total,
      complete: summary.window.complete,
      subjects: named.map((card) => symbolV1(card)),
      // The whole answer is about a reading Miorail did not finish, so a
      // narration that does not say whose limit it is has changed the subject.
      about: 'miorail',
    },
  };
}

// ---------------------------------------------------------------------------
// Research candidates — "what is worth looking at", without a ranking.
//
// The question this answers used to be refused, and the refusal read as the
// console not understanding a plain sentence. It IS answerable: not as a list
// of good tokens, which this product does not know and will not guess, but as
// named categories of already-measured properties a reader can go and inspect.
//
// The words that are absent are the design. There is no "best", no "top", no
// "promising" and no ordering across categories — each category is one measured
// property, stated in the same vocabulary the feed uses, and the reader decides
// what is interesting. Miorail supplies the evidence, not the shortlist.
// ---------------------------------------------------------------------------

export interface B20ResearchCategoryV1 {
  /** Reader-facing. Never a superlative. */
  label: string;
  /** What was measured to put a token in this category. */
  because: string;
  cards: readonly B20OpportunityCardV1[];
}

export function b20ResearchCandidatesAnswerV1(input: {
  categories: readonly B20ResearchCategoryV1[];
  /** Tokens with two comparable observations about 24h apart, already paired. */
  movers: readonly MeasuredMoverV1[];
}): B20ConsoleDeterministicV1 {
  const facts: B20ConsoleFactV1[] = [];
  const missingEvidence: string[] = [];
  const sentences: string[] = [];
  const reads: B20ConsoleReadV1[] = [];

  for (const category of input.categories) {
    reads.push({ tool: 'list', detail: `${category.cards.length} cards \u2014 ${category.label.toLowerCase()}` });
    if (category.cards.length === 0) {
      missingEvidence.push(`${category.label} \u2014 no launch in the current window carries this measurement.`);
      continue;
    }
    facts.push({
      label: category.label,
      value: category.cards.map((card) => symbolV1(card)).join(', '),
      tone: 'neutral',
    });
    sentences.push(`${category.label}: ${category.because}`);
  }

  reads.push({ tool: 'changes', detail: `${input.movers.length} launches with two comparable observations` });
  if (input.movers.length === 0) {
    missingEvidence.push(
      'Measured movement \u2014 no launch yet carries two comparable observations about 24 hours apart, so nothing can be shown as having moved.',
    );
  } else {
    facts.push({
      label: 'Measured movement',
      value: input.movers.map((mover) => mover.symbol || mover.tokenAddress).join(', '),
      tone: 'neutral',
    });
    sentences.push(
      'Measured movement: two Miorail quotes about 24 hours apart differ. The difference is between two measurements, not a price.',
    );
  }

  const lead = facts.length === 0
    ? 'Miorail has nothing to put forward for inspection in the current window: none of the measured categories it can offer has a launch in it right now. That is a state of the measurement, not a statement about any token.'
    : `Here is what Miorail measured that is worth inspecting, grouped by what the measurement found. This is not a ranking, not a score and not a shortlist to buy \u2014 each group is one measured property, and which of them is interesting is your call. ${sentences.join(' ')}`;

  const subjects = [
    ...input.categories.flatMap((category) => category.cards.map((card) => symbolV1(card))),
    ...input.movers.map((mover) => mover.symbol || mover.tokenAddress),
  ];
  return {
    answer: lead,
    facts: facts.slice(0, 16),
    missingEvidence: missingEvidence.slice(0, 20),
    caveats: [
      'These groups are measured properties, not a judgement of quality. Miorail does not rank tokens, score them, or hold a view about which is worth owning.',
      ...B20_CONSOLE_BASE_CAVEATS_V1,
    ],
    reads,
    assertions: {
      state: subjects.length > 0 ? 'measured' : 'not_measured',
      matched: subjects.length,
      complete: true,
      subjects,
      about: 'token',
    },
  };
}

// ---------------------------------------------------------------------------
// Fundamental — the claimed corpus, matched on one predicate.
//
// A separate answer shape from Explore, and that separation IS the feature. A
// fundamental question was previously answered by the explore builder, which
// opens every answer with how many launches were measured in a 48-hour window
// and which sections they fall into. None of that was read to answer the
// question, none of it bears on it, and printing it made a claim about a
// project look like a market statistic.
//
// So this function takes no summary. It cannot mention the measured universe,
// because it was never handed one.
//
// What it must say instead is the denominator, and say it in the reader's
// terms: a match count is against the VERIFIED CLAIMS, and the launches with no
// claim were never checked. Every branch below carries that sentence, including
// the one where nothing matched.
// ---------------------------------------------------------------------------

/** One token the predicate matched. The card is optional on purpose — see
 * `indexed`. */
export interface B20ConsoleProjectMatchV1 {
  tokenAddress: string;
  /** From the launch row when Discover has one. Null otherwise, and the answer
   * then names the token by address rather than inventing a symbol. */
  symbol: string | null;
  profile: B20FundamentalProfileV1;
  /**
   * Whether Discover holds a canonical launch row for this token.
   *
   * A verified project whose launch is not indexed is STILL a match. Identity,
   * ingestion and measurement are three axes, and dropping a claim because the
   * index has not caught up would publish a fact about Miorail as a fact about
   * the project.
   */
  indexed: boolean;
}

function matchNameV1(match: B20ConsoleProjectMatchV1): string {
  return match.symbol || match.tokenAddress;
}

/**
 * The corpus sentence, which every fundamental answer carries.
 *
 * Worded against the claims and not against the chain: a reader who is told
 * "1 of 28,806" will hear that 28,805 launches were examined and failed. They
 * were not examined at all — they are outside the corpus, and outside is not
 * below.
 */
/**
 * The base caveat for a fundamental answer, which is NOT the console's.
 *
 * `B20_CONSOLE_BASE_CAVEATS_V1` opens "this is a read of stored measurements",
 * and a fundamental answer reads no measurement at all — it reads project
 * evidence. Carrying the shared sentence would have told a reader the project
 * findings came out of the Exit-First layer, which is the exact confusion the
 * two-axis card design exists to prevent.
 */
export const B20_FUNDAMENTAL_BASE_CAVEAT_V1 =
  'This is a read of stored project evidence, not of market data. Nothing here is a recommendation, a valuation, or a claim about what a project will do next.';

function fundamentalCorpusSentenceV1(corpus: number): string {
  return `Launches without a verified project claim are outside this fundamental corpus and remain unknown — Miorail never checked them, and nothing here is a negative finding about them. The corpus is ${pluralV1(corpus, 'verified project claim', 'verified project claims')}.`;
}

export function b20FundamentalAnswerV1(input: {
  predicate: B20FundamentalPredicateV1;
  matches: readonly B20ConsoleProjectMatchV1[];
  /** Verified claims on this chain. The denominator, counted rather than
   * derived from the bounded page above. */
  corpus: number;
  /** False when this server does not run the claim layer at all — a different
   * statement from an empty corpus, and it must not be reported as one. */
  available: boolean;
}): B20ConsoleDeterministicV1 {
  const rule = B20_FUNDAMENTAL_PREDICATE_RULES_V1[input.predicate];
  const facts: B20ConsoleFactV1[] = [];
  const missingEvidence: string[] = [];
  const caveats = [
    rule.note,
    'A verified project link is a check on publication, not a review. Miorail did not read the project’s code, assess its team, or form any view about its token.',
    B20_FUNDAMENTAL_BASE_CAVEAT_V1,
  ];

  if (!input.available) {
    return {
      answer:
        'This server does not run the project-claim layer, so it cannot answer questions about project fundamentals. That is a fact about this deployment and not about any token.',
      facts: [],
      missingEvidence: ['The project-claim store this question reads.'],
      caveats: [B20_FUNDAMENTAL_BASE_CAVEAT_V1],
      reads: [],
      // Nothing was read, so `not_measured` is the truth here and a narration
      // saying so is correct rather than a replacement.
      assertions: { state: 'not_measured', matched: 0, complete: true, subjects: [], about: 'miorail' },
    };
  }

  // The denominator is a fact and not only a sentence, so a narrator has it in
  // the bundle: the verifier rejects any figure that is not, and an answer
  // whose corpus could not be quoted would fall back for every question.
  facts.push({
    label: 'Fundamental corpus',
    value: pluralV1(input.corpus, 'verified project claim', 'verified project claims'),
    tone: 'neutral',
  });

  for (const match of input.matches) {
    const name = matchNameV1(match);
    facts.push({
      label: `${name} — project`,
      value: `${match.profile.projectDomain} · ${B20_FUNDAMENTAL_STANDING_COPY_V1[match.profile.standing].label}`,
      tone: 'neutral',
    });
    const finding = b20PredicateFindingV1(input.predicate, match.profile);
    if (finding) {
      facts.push({
        label: `${name} — ${B20_FUNDAMENTAL_DIMENSION_LABEL_V1[finding.dimension].toLowerCase()}`,
        value: [
          finding.label,
          finding.provenance.replaceAll('_', ' '),
          // Minute precision, the same as the card's evidence fold. Seconds on
          // a probe timestamp imply a resolution the reading does not have.
          finding.observedAt ? finding.observedAt.replace('T', ' ').replace(/:\d{2}\.\d+Z$/, ' UTC') : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · '),
        tone: 'neutral',
      });
    }
    if (match.profile.missing.length > 0) {
      missingEvidence.push(
        `${name} — not established: ${match.profile.missing
          .map((dimension) => B20_FUNDAMENTAL_DIMENSION_LABEL_V1[dimension].toLowerCase())
          .join(', ')}.`,
      );
    }
    // Named per token rather than as a caveat, because it is a gap in ONE
    // answer and a reader needs to know which token it applies to.
    if (!match.indexed) {
      missingEvidence.push(
        `${name} — Miorail holds no canonical launch row for this token, so no measurement is shown beside its project evidence. The project claim is unaffected.`,
      );
    }
  }

  const corpusSentence = fundamentalCorpusSentenceV1(input.corpus);

  if (input.corpus === 0) {
    return {
      answer: `No project has verified a claim to a B20 token yet, so this question has an empty corpus rather than a negative answer. A project claims a token by serving a file on a domain it controls; until one does, there is nothing here to match against ${rule.label}.`,
      facts,
      missingEvidence,
      caveats,
      reads: [{ tool: 'projects', detail: `${rule.label}, matched 0 of an empty corpus` }],
      assertions: { state: 'not_measured', matched: 0, complete: true, subjects: [], about: 'token' },
    };
  }

  const answer =
    input.matches.length === 0
      // "None of them has a repository" asserts an ABSENCE, and Miorail does
      // not know that — it knows it did not establish one. The distinction is
      // the whole subject of this layer, and it has to survive into the
      // sentence a reader actually gets when nothing matched.
      ? `Miorail has not established ${rule.label} for ${
          // "any of the 1 verified project claim" is what a plural helper
          // produces and not what anybody says. The corpus is one claim today,
          // so this is the branch production actually renders.
          input.corpus === 1
            ? 'the one verified project claim it holds'
            : `any of the ${input.corpus} verified project claims it holds`
        }. ${corpusSentence}`
      : `${input.matches.length} matched among ${pluralV1(input.corpus, 'verified project claim', 'verified project claims')}: ${input.matches
          .map((match) => matchNameV1(match))
          .join(', ')} ${input.matches.length === 1 ? 'has' : 'have'} ${rule.label}. ${corpusSentence}`;

  return {
    answer,
    facts: facts.slice(0, 16),
    missingEvidence: missingEvidence.slice(0, 20),
    caveats: caveats.slice(0, 12),
    reads: [
      {
        tool: 'projects',
        detail: `${rule.label}, matched ${input.matches.length} of ${pluralV1(input.corpus, 'verified project claim', 'verified project claims')}`,
      },
    ],
    assertions: {
      // A non-empty corpus WAS read, whether or not the predicate matched. The
      // distinction matters: "none of the claims has a repository" is a result
      // and "nothing was measured" is not the same statement.
      state: 'measured',
      matched: input.matches.length,
      complete: true,
      subjects: input.matches.map((match) => matchNameV1(match)),
      about: 'token',
    },
  };
}

// ---------------------------------------------------------------------------
// Investigate
// ---------------------------------------------------------------------------

/**
 * Whether the tokens read may be compared, and why not when they may not.
 *
 * The rule is the market rail's, called through the shared helper rather than
 * restated: same profile, same quote asset, same reference position, same
 * measurement version. Two tokens measured against different reference
 * positions produce round trips that look comparable and are not.
 */
export function b20ComparabilityV1(reads: readonly B20ConsoleTokenReadV1[]): {
  comparable: boolean;
  reason: string | null;
} {
  const measured = reads.filter((read) => read.profile !== null);
  if (measured.length < 2) return { comparable: measured.length === reads.length, reason: null };
  const first = measured[0]!.profile!;
  for (const read of measured.slice(1)) {
    const mismatch = measurementProfileMismatchV1(first, read.profile!);
    if (mismatch === 'profile') {
      return {
        comparable: false,
        reason:
          'These tokens were measured against different reference positions, so their round trips and capacities are not comparable to each other. Each is stated on its own.',
      };
    }
    if (mismatch === 'version') {
      return {
        comparable: false,
        reason:
          'These tokens were measured by different versions of the measurement, so the figures do not mean the same thing. Each is stated on its own.',
      };
    }
  }
  return { comparable: true, reason: null };
}

/**
 * Project context, as console facts.
 *
 * The four questions this answers — is there a live product, is anyone working
 * on it, did the project exist first, what is missing — are all questions about
 * ONE card, so they are answered from the card the console already read rather
 * than from a second lookup.
 *
 * Two rules the fact shape enforces. An unverified identity produces exactly
 * one fact and no dimensions, because there is nothing attached to report. And
 * every missing dimension is named in `missingEvidence`, so "what fundamental
 * evidence is missing" is answerable without a special question kind.
 */
function projectFactsV1(
  card: B20OpportunityCardV1,
  symbol: string,
  facts: B20ConsoleFactV1[],
  sentences: string[],
  missingEvidence: string[],
  caveats: string[],
): void {
  const project = card.project;
  // Null means this server does not run the layer. Saying "unverified" from
  // that would be Miorail reporting its own configuration as a fact about a
  // project.
  if (!project) return;

  if (!project.identityVerified) {
    facts.push({ label: `${symbol} — project`, value: 'No verified project link', tone: 'neutral' });
    sentences.push(
      `No project has proven a link to ${symbol}, so Miorail attaches no project information to it. Most launches are never claimed.`,
    );
    return;
  }

  facts.push({
    label: `${symbol} — project`,
    value: `${project.projectDomain} · ${B20_FUNDAMENTAL_STANDING_COPY_V1[project.standing].label}`,
    tone: 'positive',
  });
  for (const finding of project.findings) {
    if (finding.dimension === 'project_identity') continue;
    facts.push({
      label: `${symbol} — ${B20_FUNDAMENTAL_DIMENSION_LABEL_V1[finding.dimension].toLowerCase()}`,
      value: `${finding.label} · ${finding.provenance.replaceAll('_', ' ')}${
        finding.observedAt ? ` · ${finding.observedAt.slice(0, 10)}` : ''
      }`,
      // Never `positive`: a fundamental state is not a good outcome, it is a
      // thing that was established. The measured rail owns tone; this does not.
      tone: 'neutral',
    });
  }
  sentences.push(`${symbol}: ${project.detail}`);
  for (const dimension of project.missing) {
    missingEvidence.push(
      `${B20_FUNDAMENTAL_DIMENSION_LABEL_V1[dimension]} for ${symbol} — the project declared nothing Miorail could check, or the check did not complete.`,
    );
  }
  caveats.push(
    'Project context comes from a file the project serves on its own domain and from probes of what that file declared. It is not a review of the project and not a statement about price.',
  );
}

/**
 * What happened when Miorail tried to take a reading for a named token.
 *
 * One sentence per outcome, and the split between them is the whole reason
 * this exists. "No stored measurement" was true of a token Miorail had never
 * once attempted, of a token whose endpoint did not answer, and of a token
 * whose reading was still running — three different facts wearing one
 * sentence, and a reader had no way to tell which they were being shown.
 *
 * None of these is a statement about the token. Every one of them names
 * Miorail as the subject, because Miorail is the subject.
 */
export const B20_READING_ATTEMPT_COPY_V1: Readonly<
  Record<string, { fact: string; sentence: (symbol: string) => string; missing: ((symbol: string) => string) | null }>
> = {
  measured: {
    fact: 'Reading taken for this question',
    sentence: (symbol) => `Miorail took an Exit-First reading of ${symbol} for this question, so the measurement below is current rather than stored from a background pass.`,
    missing: null,
  },
  measurement_incomplete: {
    fact: 'Reading taken, did not complete',
    sentence: (symbol) => `Miorail took a reading of ${symbol} for this question and could not complete it. What is stated below is what that reading established, and the gap is named beside it.`,
    missing: (symbol) => `A completed Exit-First reading for ${symbol} — the one Miorail just took did not finish, and the reason is on the card.`,
  },
  provider_unavailable: {
    fact: 'Reading attempted, endpoint did not answer',
    sentence: (symbol) => `Miorail tried to measure ${symbol} for this question and its Base endpoint did not answer, so nothing was stored. That is a fact about Miorail's reading, and it establishes nothing either way about the token.`,
    missing: (symbol) => `An Exit-First measurement for ${symbol}. Miorail attempted one now and the endpoint did not answer.`,
  },
  timed_out: {
    fact: 'Reading still running',
    sentence: (symbol) => `Miorail started a reading of ${symbol} for this question and it did not finish inside this request. It is still running, and the measurement will be here shortly — this is not a statement that ${symbol} has no measurement.`,
    missing: (symbol) => `An Exit-First measurement for ${symbol}. Miorail is taking one now; ask again in a moment.`,
  },
  failed: {
    fact: 'Reading attempted, did not complete',
    sentence: (symbol) => `Miorail attempted a reading of ${symbol} for this question and it did not complete. Nothing was stored, and nothing about the token was established.`,
    missing: (symbol) => `An Exit-First measurement for ${symbol}. Miorail attempted one now and it did not complete.`,
  },
  not_attempted: {
    fact: 'Not reached in this request',
    sentence: (symbol) => `Miorail did not reach ${symbol} in this request — the reading budget went to the tokens before it. Ask about ${symbol} on its own and it will be measured.`,
    missing: (symbol) => `An Exit-First measurement for ${symbol}. Miorail did not reach it in this request.`,
  },
  unavailable_here: {
    fact: 'This server cannot take readings',
    sentence: (symbol) => `Miorail cannot take a reading of ${symbol} on this deployment — it has no Base endpoint configured. That is a fact about this server, not about the token.`,
    missing: (symbol) => `An Exit-First measurement for ${symbol}. This deployment cannot take one.`,
  },
};

/** One attempt, as the console needs it. Structurally the targeted-measurement
 * result, restated so this module does not depend on the route it came from. */
export interface B20ReadingAttemptV1 {
  tokenAddress: string;
  outcome: string;
  /** The measurement's own reason code for an incomplete reading. */
  reason: string | null;
}

export function b20InvestigateAnswerV1(input: {
  reads: readonly B20ConsoleTokenReadV1[];
  /**
   * Readings Miorail took BECAUSE of this question, keyed by token.
   *
   * Absent when the server does not take them, and then this answer reads
   * exactly as it did before: a stored measurement or its absence. Present, it
   * is what lets "no stored measurement" stop covering for "the endpoint did
   * not answer" and "the reading is still running".
   */
  attempts?: readonly B20ReadingAttemptV1[];
}): B20ConsoleDeterministicV1 {
  const facts: B20ConsoleFactV1[] = [];
  const missingEvidence: string[] = [];
  const caveats: string[] = [...B20_CONSOLE_BASE_CAVEATS_V1];
  const sentences: string[] = [];

  const unknown = input.reads.filter((read) => read.card === null);
  const known = input.reads.filter((read) => read.card !== null);
  const attemptFor = new Map(
    (input.attempts ?? []).map((attempt) => [attempt.tokenAddress.toLowerCase(), attempt] as const),
  );

  /**
   * What Miorail did about this token's measurement, said before the
   * measurement itself.
   *
   * Returns whether an attempt was reported, so the caller can tell "Miorail
   * did not try" from "Miorail tried and this is what happened" — which is the
   * distinction the old single sentence collapsed.
   */
  const reportAttempt = (tokenAddress: string, symbol: string): boolean => {
    const attempt = attemptFor.get(tokenAddress.toLowerCase());
    if (!attempt) return false;
    const copy = B20_READING_ATTEMPT_COPY_V1[attempt.outcome];
    if (!copy) return false;
    facts.push({
      label: `${symbol} — reading`,
      value: attempt.reason ? `${copy.fact} · ${attempt.reason.replaceAll('_', ' ')}` : copy.fact,
      tone: attempt.outcome === 'measured' ? 'neutral' : 'warning',
    });
    sentences.push(copy.sentence(symbol));
    if (copy.missing) missingEvidence.push(copy.missing(symbol));
    return true;
  };

  for (const read of known) {
    const card = read.card!;
    const observation = card.observation;
    const symbol = symbolV1(card);
    const attempted = reportAttempt(read.tokenAddress, symbol);
    if (!observation) {
      // "No stored measurement" is only the whole truth when nothing was
      // attempted. When a reading WAS taken, `reportAttempt` has already said
      // what happened to it, and repeating this sentence would put Miorail's
      // outcome and Miorail's silence side by side as if they were the same.
      facts.push({
        label: symbol,
        value: attempted ? 'No measurement stored yet' : 'No stored measurement',
        tone: 'warning',
      });
      if (!attempted) {
        missingEvidence.push(`An Exit-First measurement for ${symbol}.`);
        sentences.push(`${symbol} is a canonical B20 launch with no stored observation.`);
      }
      continue;
    }
    const quote = b20QuoteAssetDisplayV1(observation.referenceQuoteAsset);
    const parts: string[] = [observation.standing.headline];
    if (observation.optimisticRoundTripBps !== null) {
      parts.push(`round trip ${bpsV1(observation.optimisticRoundTripBps)}`);
    }
    if (observation.largestPassingSizeAtomic !== null) {
      parts.push(`exit capacity at least ${b20AmountLabelV1(observation.largestPassingSizeAtomic, quote)}`);
    }
    facts.push({
      label: symbol,
      value: `${parts.join(' · ')} · block ${observation.observationBlockNumber} · ${observation.freshness}`,
      tone: observation.standing.aboutToken === false
        ? 'warning'
        : observation.standing.kind === 'two_sided'
          ? 'positive'
          : 'neutral',
    });
    sentences.push(`${symbol}: ${observation.standing.detail}`);
    projectFactsV1(card, symbol, facts, sentences, missingEvidence, caveats);
    if (!observation.exitRouteFound) missingEvidence.push(`A supported exit route for ${symbol}.`);
    if (read.historyCount < 2) missingEvidence.push(`A second comparable observation for ${symbol}.`);
    if (observation.standing.aboutToken === false) {
      caveats.push(
        `The finding for ${symbol} is about Miorail’s reading, not about the token. It is not evidence that the token cannot be sold.`,
      );
    }
  }

  for (const read of unknown) {
    const address = read.tokenAddress;
    reportAttempt(address, address);
    switch (read.indexStanding) {
      case 'confirmed_b20_not_indexed': {
        // Two facts, because two different things are true and only one of them
        // is a shortcoming of ours. Saying "not a canonical B20 launch" here
        // was Miorail denying its own token: MIO is confirmed by the factory
        // and launched before Discover began scanning.
        facts.push({ label: `${address} — B20 identity`, value: 'Confirmed by factory', tone: 'positive' });
        facts.push({ label: `${address} — Discover index`, value: 'Launch not indexed', tone: 'warning' });
        sentences.push(
          `${address} is a B20 token confirmed onchain, but its launch is not present in Miorail’s Discover index. Historical Discover measurements are unavailable for this token.`,
        );
        if (read.detection === 'b20_uninitialised') {
          facts.push({
            label: `${address} — factory state`,
            value: 'Created, not initialised',
            tone: 'warning',
          });
        }
        missingEvidence.push(`The canonical launch event for ${address} has not been ingested into Miorail Discover.`);
        break;
      }
      case 'not_b20': {
        // The factory answered. This is the only branch entitled to a negative,
        // and it is phrased as what the factory said rather than as what
        // Miorail holds.
        facts.push({ label: `${address} — B20 identity`, value: 'Not confirmed by factory', tone: 'warning' });
        sentences.push(`${address} was not confirmed as a B20 token by the B20 factory.`);
        break;
      }
      case 'identity_check_unavailable': {
        // Nothing was established. The sentence says both halves so it cannot
        // be read as either verdict.
        facts.push({ label: `${address} — B20 identity`, value: 'Check could not be completed', tone: 'warning' });
        facts.push({ label: `${address} — Discover index`, value: 'Launch not indexed', tone: 'warning' });
        sentences.push(
          `Miorail has no Discover launch for ${address}, and the B20 identity check could not be completed. This is not evidence either way about the token.`,
        );
        missingEvidence.push(`A completed B20 factory identity check for ${address}.`);
        break;
      }
      case 'indexed_b20': {
        // Unreachable by construction — `unknown` is the reads with no card.
        // Stated rather than assumed, so a future change that sets the standing
        // without a card produces a sentence instead of silence.
        facts.push({ label: `${address} — Discover index`, value: 'Launch not indexed', tone: 'warning' });
        sentences.push(`Miorail has no stored Discover launch for ${address}.`);
        break;
      }
    }
  }

  const comparability = b20ComparabilityV1(known);
  if (comparability.reason) caveats.push(comparability.reason);

  // Three counts, because the three states an Investigate read can be in are
  // exactly the three the narrator must not blur: measured, indexed but never
  // measured, and not in the index at all.
  const withObservation = known.filter((read) => read.card?.observation).length;
  return {
    answer: sentences.join(' '),
    facts: facts.slice(0, 16),
    missingEvidence: [...new Set(missingEvidence)].slice(0, 20),
    caveats: caveats.slice(0, 12),
    reads: input.reads.map((read) => ({
      tool: 'card',
      detail: `${read.tokenAddress} · ${read.card ? `${read.historyCount} stored observations` : 'no canonical launch'}`,
    })),
    assertions: {
      state:
        withObservation === 0
          ? 'not_measured'
          : withObservation === input.reads.length
            ? 'measured'
            : 'mixed',
      matched: withObservation,
      complete: true,
      subjects: [
        ...known.map((read) => symbolV1(read.card!)),
        ...unknown.map((read) => read.tokenAddress),
      ],
      about: known.some((read) => read.card?.observation?.standing.aboutToken === false)
        ? 'mixed'
        : 'token',
    },
  };
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

/**
 * The sentence this whole scope is built around.
 *
 * A holder asks "can I get out of MY position". Miorail has never measured
 * that position: every stored observation is one fixed reference size, chosen
 * so launches are comparable to each other. So the ranking below orders what
 * WAS measured, and this line goes with it everywhere — not as a disclaimer
 * under the fold, but as part of the answer.
 */
export const B20_PORTFOLIO_SIZE_CAVEAT_V1 =
  'Miorail measured each of these at one fixed reference size, not at the size you are holding. This orders what was measured; it does not say what your position would do.';

export const B20_PORTFOLIO_PRIVACY_CAVEAT_V1 =
  'This answer is built from your own token list and is never sent to a language model. It is not stored, and it is not cached for anyone else.';

/**
 * A holder's positions, hardest to close first.
 *
 * Three groups, because they are three different statements and ranking them
 * together would put an absence and a measurement in one ordering:
 *
 *   1. no sale priced at all — the hardest, and not a cost anybody measured;
 *   2. ranked by measured exit coverage, lowest first;
 *   3. not measurable or not comparable, each with its reason.
 *
 * The ordering key is measured exit capacity as a share of what the reference
 * entry bought — the same key the capacity rail already ranks by, because a
 * raw token amount cannot be ordered across different decimals.
 */
export function b20PortfolioAnswerV1(input: {
  reads: readonly B20ConsoleTokenReadV1[];
  /** Each position's stored exit assessment, by token address. */
  assessments: Readonly<Record<string, B20ExitAssessmentV1>>;
}): B20ConsoleDeterministicV1 {
  const facts: B20ConsoleFactV1[] = [];
  const missingEvidence: string[] = [];
  const caveats: string[] = [B20_PORTFOLIO_SIZE_CAVEAT_V1, B20_PORTFOLIO_PRIVACY_CAVEAT_V1];

  const noSale: string[] = [];
  const ranked: { symbol: string; coverageBps: number; capacityStable: boolean | null }[] = [];
  const unranked: { symbol: string; because: string }[] = [];

  for (const read of input.reads) {
    const card = read.card;
    if (!card) {
      // Phrased as what Miorail holds, not as what the token is. Portfolio does
      // NOT run the factory fallback that Investigate does: this scope is
      // private, and a per-holding onchain lookup would leak the shape of a
      // wallet to an RPC endpoint. Absent a check, the honest claim is the
      // narrow one.
      unranked.push({ symbol: read.tokenAddress, because: 'has no ingested Discover launch in Miorail' });
      continue;
    }
    const symbol = symbolV1(card);
    const assessment = input.assessments[read.tokenAddress] ?? { status: 'not_measured' as const };
    if (assessment.status === 'no_supported_exit_route') {
      noSale.push(symbol);
      missingEvidence.push(`A supported exit route for ${symbol}.`);
      continue;
    }
    if (assessment.status === 'not_measured') {
      unranked.push({ symbol, because: 'has no stored measurement yet' });
      missingEvidence.push(`An Exit-First measurement for ${symbol}.`);
      continue;
    }
    if (assessment.status === 'capacity_not_measured' || assessment.coverageBps === null || assessment.coverageBps === undefined) {
      unranked.push({ symbol, because: 'has no measured exit capacity to order by' });
      missingEvidence.push(`A passing exit-capacity probe for ${symbol}.`);
      continue;
    }
    ranked.push({ symbol, coverageBps: assessment.coverageBps, capacityStable: assessment.capacityStable ?? null });
  }

  // The comparability rule, on the same axis Investigate uses it: positions
  // measured against different reference positions cannot be ordered against
  // each other, whatever their coverage figures look like side by side.
  const comparability = b20ComparabilityV1(input.reads.filter((read) => read.card !== null));
  if (comparability.reason) caveats.push(comparability.reason);
  const orderable = comparability.comparable;

  ranked.sort((left, right) => left.coverageBps - right.coverageBps || left.symbol.localeCompare(right.symbol));

  for (const entry of noSale) {
    facts.push({ label: entry, value: 'No sale priced at the reference size', tone: 'warning' });
  }
  for (const entry of ranked) {
    facts.push({
      label: entry.symbol,
      value: `${bpsV1(entry.coverageBps)} of the reference entry could be sold${entry.capacityStable === false ? ' · ladder unstable' : ''}`,
      tone: entry.capacityStable === false ? 'warning' : 'neutral',
    });
  }
  for (const entry of unranked) {
    facts.push({ label: entry.symbol, value: `Not ranked — ${entry.because}`, tone: 'warning' });
  }

  const sentences: string[] = [];
  if (noSale.length > 0) {
    sentences.push(
      `${noSale.length === 1 ? 'One position' : `${noSale.length} positions`} priced no sale at all at the reference size: ${noSale.join(', ')}. That is the hardest thing this measurement can say, and it is not a cost — nothing was quoted to compare.`,
    );
  }
  if (ranked.length > 0) {
    // "Of the rest" only when there WAS a preceding group. Observed live
    // 2026-08-15: with no unsellable position the answer opened on a phrase
    // referring back to nothing.
    const rest = noSale.length > 0 ? 'Of the rest, hardest' : 'Hardest';
    // The figure is coverage, so a bigger number is an easier exit. Spelling
    // out what it is a share OF keeps 50% from reading as a cost.
    const list = ranked
      .map((entry) => `${entry.symbol} at ${bpsV1(entry.coverageBps)}`)
      .join(', ');
    sentences.push(
      orderable
        ? `${rest} to close first — the figure is how much of the reference entry could be sold, so a smaller share is a harder exit: ${list}.`
        // Not ordered, because ordering incomparable measurements is the exact
        // mistake the figures make easy.
        : `${noSale.length > 0 ? 'The rest were' : 'These were'} each measured, but not against the same reference position, so they are stated rather than ordered: ${list}.`,
    );
  }
  if (unranked.length > 0) {
    sentences.push(
      `${unranked.length === 1 ? 'One position could' : `${unranked.length} positions could`} not be ordered: ${unranked
        .map((entry) => `${entry.symbol} ${entry.because}`)
        .join(', ')}.`,
    );
  }
  if (sentences.length === 0) sentences.push('Miorail has no measured Discover launch for any of these tokens.');
  sentences.push(B20_PORTFOLIO_SIZE_CAVEAT_V1);

  // Never narrated — the route withholds the provider for this scope — so the
  // assertions here exist for one reason: to keep the shape total, so a future
  // caller cannot enable narration for Portfolio by forgetting a field. The
  // subjects are deliberately EMPTY: a holding list is the reader's, and it
  // does not go into a structure that travels beside a language provider.
  return {
    answer: sentences.join(' '),
    assertions: {
      state: facts.length > 0 ? 'measured' : 'not_measured',
      matched: facts.length,
      complete: true,
      subjects: [],
      about: 'token',
    },
    facts: facts.slice(0, 16),
    missingEvidence: [...new Set(missingEvidence)].slice(0, 20),
    caveats: caveats.slice(0, 12),
    // Deliberately not naming the addresses read: the response goes back to
    // the reader who sent them, and repeating a wallet's holdings into a
    // reads log is the one place this surface could leak them.
    reads: [{ tool: 'positions', detail: `${input.reads.length} held tokens, read from stored measurements only` }],
  };
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/** What each exclusion means in words. The rail already refuses to compare
 * these pairs; this is the same list said out loud, because "no movers" with
 * no reason is indistinguishable from a broken worker. */
const EXCLUSION_COPY_V1: Readonly<Record<MoverExclusionV1, string>> = {
  no_baseline: 'has only one stored measurement',
  baseline_outside_window: 'has no measurement near the comparison age',
  incompatible_profile: 'was measured against a different reference position',
  incompatible_version: 'was measured by a different version of the measurement',
  unknown_decimals: 'has no known token scale',
  below_minimum_capacity: 'has too little measured exit to compare',
  not_measured: 'has no comparable market measurement',
  unstable_ladder: 'has a capacity ladder that disagreed with itself',
};

export function b20ChangesAnswerV1(input: { changes: B20ConsoleChangesReadV1 }): B20ConsoleDeterministicV1 {
  const { changes } = input;
  const hours = Math.round(changes.baselineAgeMs / HOUR_MS_V1);
  const facts: B20ConsoleFactV1[] = [
    { label: 'Comparison', value: `two measurements about ${pluralV1(hours, 'hour', 'hours')} apart`, tone: 'neutral' },
    { label: 'Pairs considered', value: `${changes.pairsConsidered}`, tone: 'neutral' },
    { label: 'Comparable moves', value: `${changes.movers.length}`, tone: 'neutral' },
  ];

  for (const mover of changes.movers.slice(0, 8)) {
    facts.push({
      label: mover.symbol || mover.tokenAddress,
      value: `${signedBpsV1(mover.changeBps)} over ${Math.round(mover.intervalSeconds / 3600)}h · ${mover.freshness}`,
      tone: mover.profileStatus === 'outside_round_trip_reference' ? 'warning' : 'neutral',
    });
  }

  const byReason = new Map<MoverExclusionV1, number>();
  for (const entry of changes.excluded) byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
  const missingEvidence = [...byReason.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `${pluralV1(count, 'launch', 'launches')}: ${EXCLUSION_COPY_V1[reason]}.`);

  const caveats = [
    // The one sentence that keeps this rail from being read as a price feed.
    'A move is the difference between two quotes Miorail took itself, at the same reference position. It is not a price, and it is not a return anyone realised.',
    ...B20_CONSOLE_BASE_CAVEATS_V1,
  ];

  let answer: string;
  if (changes.movers.length > 0) {
    // "SYMBOL at CHANGE", not "SYMBOL CHANGE". Observed live 2026-08-15: a B20
    // token whose symbol is "40" rendered as "40 -27.93%" directly after the
    // sentence's own count of 40 launches, and the name read as a stray
    // number. A symbol is not an identifier and it is not always a word.
    const named = changes.movers
      .slice(0, 5)
      .map((mover) => `${mover.symbol || mover.tokenAddress} at ${signedBpsV1(mover.changeBps)}`)
      .join(', ');
    answer = `Of ${pluralV1(changes.pairsConsidered, 'launch', 'launches')} with stored history, ${changes.movers.length} could be compared across about ${pluralV1(hours, 'hour', 'hours')}: ${named}. A positive figure means the same reference position bought fewer tokens in the later quote.`;
  } else if (changes.collectingHistory) {
    answer = `Nothing can be compared across ${pluralV1(hours, 'hour', 'hours')} yet. Every launch Miorail measured is waiting on a second measurement at the right age — the only thing missing is time.`;
  } else {
    answer = `No launch has two measurements that can be compared across ${pluralV1(hours, 'hour', 'hours')}. This is not a statement that nothing moved: it means the pairs Miorail holds are not comparable to each other, and the reasons are listed.`;
  }

  return {
    answer,
    facts: facts.slice(0, 16),
    missingEvidence: missingEvidence.slice(0, 20),
    caveats: caveats.slice(0, 12),
    reads: [
      {
        tool: 'changes',
        detail: `${changes.pairsConsidered} launch pairs, baseline about ${hours}h before the latest measurement`,
      },
    ],
    assertions: {
      // A rail with no comparable pair has measured nothing about movement,
      // and saying so is the correct answer rather than a replacement for one.
      state: changes.movers.length > 0 ? 'measured' : 'not_measured',
      matched: changes.movers.length,
      complete: true,
      subjects: changes.movers.map((mover) => mover.symbol || mover.tokenAddress),
      // An empty rail is a fact about what Miorail could pair, not about the
      // tokens — the same distinction the answer's own last branch draws.
      about: changes.movers.length > 0 ? 'token' : 'miorail',
    },
  };
}
