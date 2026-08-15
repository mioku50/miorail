import {
  measurementProfileMismatchV1,
  type B20OpportunityCardV1,
  type MeasuredMoverV1,
  type MoverExclusionV1,
} from '@mioagent/opportunity-rail';
import { b20QuoteAssetDisplayV1 } from '@mioagent/opportunity-rail/quoteAsset';

import { b20AmountLabelV1 } from './b20Copilot.js';
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

  const lead = `Miorail has stored measurements for ${pluralV1(summary.window.launches, 'B20 launch', 'B20 launches')} detected in the last ${window}.`;
  const sectionSentence = summary.sections.length === 0
    ? ' None of them has reached a stored conclusion yet.'
    : ` They fall into ${pluralV1(summary.sections.length, 'group', 'groups')}: ${summary.sections
        .map((section) => `${section.label.toLowerCase()} (${section.count})`)
        .join(', ')}.`;

  const named = (input.cards ?? []).slice(0, 5);
  const namedSentence = named.length === 0
    ? ''
    : ` Named here: ${named.map((card) => symbolV1(card)).join(', ')}.`;
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

  return {
    answer: `${lead}${sectionSentence}${limitSentence}${namedSentence}`,
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
    facts.push({ label: read.tokenAddress, value: 'Not a canonical B20 launch in Miorail', tone: 'warning' });
    sentences.push(`${read.tokenAddress} is not a canonical B20 launch Miorail has ingested, so there is nothing stored to read.`);
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
    const named = changes.movers
      .slice(0, 5)
      .map((mover) => `${mover.symbol || mover.tokenAddress} ${signedBpsV1(mover.changeBps)}`)
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
