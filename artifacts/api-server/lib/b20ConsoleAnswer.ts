import {
  measurementProfileMismatchV1,
  type B20OpportunityCardV1,
  type MeasuredMoverV1,
  type MoverExclusionV1,
} from '@mioagent/opportunity-rail';
import { b20QuoteAssetDisplayV1 } from '@mioagent/opportunity-rail/quoteAsset';
import type { B20DetectionOutcomeV1, B20TokenIndexStandingV1 } from '@mioagent/b20-control';

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
  const facts: B20ConsoleFactV1[] = [
    {
      label: 'Launches read',
      value: `${summary.window.launches} in the last ${window}`,
      tone: 'neutral',
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
  if (!summary.window.complete) {
    caveats.push(
      'The scan limit was reached before the window ran out, so these are counts of the newest launches rather than of every launch in the window.',
    );
  }

  const context = `Miorail has stored measurements for ${pluralV1(summary.window.launches, 'B20 launch', 'B20 launches')} detected in the last ${window}.`;
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
  if (finding) {
    const count = finding.standingKind
      ? summary.standing.find((entry) => entry.kind === finding.standingKind)?.count ?? 0
      : summary.sections.find((section) => section.group === finding.group)?.count ?? 0;
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

export function b20InvestigateAnswerV1(input: {
  reads: readonly B20ConsoleTokenReadV1[];
}): B20ConsoleDeterministicV1 {
  const facts: B20ConsoleFactV1[] = [];
  const missingEvidence: string[] = [];
  const caveats: string[] = [...B20_CONSOLE_BASE_CAVEATS_V1];
  const sentences: string[] = [];

  const unknown = input.reads.filter((read) => read.card === null);
  const known = input.reads.filter((read) => read.card !== null);

  for (const read of known) {
    const card = read.card!;
    const observation = card.observation;
    const symbol = symbolV1(card);
    if (!observation) {
      facts.push({ label: symbol, value: 'No stored measurement', tone: 'warning' });
      missingEvidence.push(`An Exit-First measurement for ${symbol}.`);
      sentences.push(`${symbol} is a canonical B20 launch with no stored observation.`);
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

  return {
    answer: sentences.join(' '),
    facts: facts.slice(0, 16),
    missingEvidence: [...new Set(missingEvidence)].slice(0, 20),
    caveats: caveats.slice(0, 12),
    reads: input.reads.map((read) => ({
      tool: 'card',
      detail: `${read.tokenAddress} · ${read.card ? `${read.historyCount} stored observations` : 'no canonical launch'}`,
    })),
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

  return {
    answer: sentences.join(' '),
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
  };
}
