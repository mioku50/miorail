import type { B20ExitStandingKindV1 } from './exitStanding.js';

// ---------------------------------------------------------------------------
// The card a person reads, built from the card a measurement produced.
//
// Nothing here computes anything. Every field is a rewording of evidence that
// already exists, and the mapping is total over the standing kinds — so a kind
// added to the measurement cannot reach a screen without someone deciding what
// it says to a reader.
//
// WHAT THIS IS FOR
//
// Discover was showing `rejected` as a badge and `round_trip_above_tolerance`
// inside a sentence. Both are true, and neither is what they appear to be:
// `rejected` is the measurement profile's verdict about a REFERENCE THRESHOLD,
// and on screen it reads as "bad token, do not buy". The evidence was right and
// unreadable, which is a presentation defect, not a measurement one.
//
// WHAT IT MUST NOT DO
//
//   - No scoring, ranking, or forward-looking language. There is no field here
//     a caller could sort by to produce "best token", and that is deliberate.
//   - No LLM. Every string below is a constant or a formatted number.
//   - No collapsing of `aboutToken`. A standing that describes Miorail's limits
//     keeps its own tone and its own words in every branch.
//   - No `?? 0`. Null is unknown and stays unknown; a fact with no value is
//     omitted rather than rendered as zero.
// ---------------------------------------------------------------------------

/**
 * How the card should read at a glance. NOT a grade.
 *
 * `finding` is the product's actual result and the only tone that says Miorail
 * measured something notable about the token. `gap` is Miorail talking about
 * itself and must never share a section with the others.
 */
export type B20ConsumerToneV1 = 'finding' | 'measured' | 'absent' | 'gap';

export interface B20ConsumerFactV1 {
  label: string;
  value: string;
  /** A qualifier shown BESIDE the value, never in place of it. */
  note: string | null;
}

export interface B20ConsumerCardV1 {
  /** The chip that replaces the raw measurement state. */
  status: string;
  tone: B20ConsumerToneV1;
  /** One sentence: what was measured. */
  headline: string;
  /** One or two sentences. Contains no reason code and no state name. */
  body: string;
  /** Two to four rows for the collapsed card. */
  facts: readonly B20ConsumerFactV1[];
  /** Carried through unchanged from the standing. */
  aboutToken: boolean;
}

export interface B20ConsumerCardInputV1 {
  standing: { kind: B20ExitStandingKindV1; aboutToken: boolean };
  /** Round-trip cost of the stored measurement, in basis points. Null when the
   * round trip could not be priced — which is most of the feed. */
  roundTripBps: number | null;
  /** The profile's reference ceiling, in basis points. */
  referenceBps: number | null;
  /** Completed launch-window buyer count. NULL IS NOT ZERO: null means the
   * window has not closed, zero means it closed with nobody in it. */
  buyerCount: number | null;
  /** Pre-formatted by the caller, which already owns decimals and symbol. */
  exitCapacityLabel: string | null;
  /**
   * Pre-formatted age, e.g. "57 min ago", when the caller knows it.
   *
   * The Discover card wire does NOT carry a measurement timestamp — only
   * `freshness` — so this is null there and the freshness fact falls back to
   * the words. Inventing an age from an observation block number would be a
   * figure nobody measured.
   */
  measuredAgeLabel: string | null;
  fresh: boolean;
  /** False when nothing has been measured, so the freshness row is omitted
   * rather than claiming a stale reading that does not exist. */
  hasObservation: boolean;
}

const COPY_V1: Readonly<
  Record<B20ExitStandingKindV1, { status: string; tone: B20ConsumerToneV1; headline: string; body: string }>
> = {
  two_sided: {
    status: 'Both routes measured',
    tone: 'measured',
    headline: 'Entry and exit were both priced.',
    body: 'Miorail quoted a purchase and a sale against the same measured pool. Both quotes were taken before any entry moved that pool, so neither is executable.',
  },
  ruled_out: {
    // Deliberately the SAME status as `two_sided`. What was measured is
    // identical — both directions priced — and the difference is that the cost
    // sat above a threshold Miorail chose. That belongs in the round-trip fact,
    // where the number is, not in a chip that reads as a verdict on the token.
    status: 'Both routes measured',
    tone: 'measured',
    headline: 'Entry and exit were both priced.',
    body: 'Round-trip cost came out above the reference Miorail uses for this feed. That is a threshold this product set, not a fault found in the token.',
  },
  bought_not_sellable: {
    status: 'Bought · exit not priced',
    tone: 'finding',
    headline: 'Buyers were observed, and a sale did not price.',
    body: 'Miorail found entry pricing and observed real buyers in the launch window, but did not price a supported exit route in this measurement. A sale may still be possible at another venue or another size.',
  },
  no_buyers_yet: {
    status: 'No buyer activity',
    tone: 'absent',
    headline: 'Entry available · no buyer activity observed.',
    body: 'Nobody bought in the measured launch window, so the pool holds nothing to sell into and a sale cannot be priced. That is an absent market, not a defect found in the token.',
  },
  // ---- everything below is about MIORAIL, never about the token ----------
  sale_unpriced: {
    status: 'Market not fully measured',
    tone: 'gap',
    headline: 'Entry priced; the sale side was not established.',
    body: 'Miorail priced a purchase but not a sale, and the launch-buying window has not produced a completed count — so it cannot yet say whether nobody has bought this or whether a market exists that will not let you out.',
  },
  venue_not_found: {
    status: 'Market not fully measured',
    tone: 'gap',
    headline: 'Miorail did not resolve the B20 venue for this observation.',
    body: 'No pool Miorail reads could price a purchase. It searches a fixed set of venues in a fixed window after the launch, so this is a gap in what was searched.',
  },
  venue_not_searched: {
    status: 'Market not fully measured',
    tone: 'gap',
    headline: 'Miorail has not looked where this trades.',
    body: 'This reading did not search the venue where B20 tokens trade, so it cannot support any statement about where this token can be bought or sold.',
  },
  measurement_incomplete: {
    status: 'Measurement incomplete',
    tone: 'gap',
    headline: 'Miorail could not complete this observation.',
    body: 'A check this reading needs did not answer. Nothing was established either way.',
  },
  not_measured: {
    status: 'Not measured yet',
    tone: 'gap',
    headline: 'This launch has not been measured yet.',
    body: 'Miorail has found the launch but has not taken an Exit-First measurement of it.',
  },
};

/** Basis points as a percentage a person reads, e.g. 438 → "4.38%". */
export function b20PercentLabelV1(bps: number): string {
  const percent = bps / 100;
  // Whole numbers stay whole: "3%" not "3.00%", because the reference is
  // configured as a round figure and printing decimals on it invites the reader
  // to look for precision that is not there.
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(2)}%`;
}

/**
 * The consumer projection.
 *
 * Total over the standing kinds by construction: `COPY_V1` is a Record, so a
 * new kind fails to compile until it has words.
 */
export function b20ConsumerCardV1(input: B20ConsumerCardInputV1): B20ConsumerCardV1 {
  const copy = COPY_V1[input.standing.kind];
  const facts: B20ConsumerFactV1[] = [];

  // Round-trip first when it exists: it is the number the reader came for, and
  // on a `ruled_out` card it is the whole reason the card looks different.
  if (input.roundTripBps !== null) {
    facts.push({
      label: 'Round-trip cost',
      value: b20PercentLabelV1(input.roundTripBps),
      note:
        input.referenceBps === null
          ? null
          : input.roundTripBps > input.referenceBps
            ? `above ${b20PercentLabelV1(input.referenceBps)} reference`
            : `within ${b20PercentLabelV1(input.referenceBps)} reference`,
    });
  }

  // Buyers only when the window actually closed. A null count is a window still
  // running, and printing "0" for it would invent a measurement.
  if (input.buyerCount !== null) {
    facts.push({
      label: 'Buyers in launch window',
      value: String(input.buyerCount),
      note: input.buyerCount === 1 ? 'one wallet — the thinnest this evidence gets' : null,
    });
  }

  if (input.exitCapacityLabel !== null) {
    facts.push({
      label: 'Largest tested exit',
      value: input.exitCapacityLabel,
      // The `≥` in the label is a lower bound the caller already formatted;
      // this says why, so it cannot be read as a measured ceiling.
      note: 'lower bound — nothing above this was tested',
    });
  }

  // Freshness last, and only when something was measured. With an age it reads
  // as a time; without one it reads as the state, which is all the card wire
  // actually carries.
  if (input.measuredAgeLabel !== null) {
    facts.push({
      label: 'Measured',
      value: input.measuredAgeLabel,
      note: input.fresh ? null : 'past freshness window',
    });
  } else if (input.hasObservation) {
    facts.push({
      label: 'Freshness',
      value: input.fresh ? 'Within the freshness window' : 'Past the freshness window',
      // No note. The value is the whole statement here, and the card's own
      // action reason sits directly under these facts saying what to do about
      // a stale measurement — printing "re-measure before drawing anything from
      // it" above a sentence that says the same thing is how a card comes to
      // repeat itself.
      note: null,
    });
  }

  return {
    status: copy.status,
    tone: copy.tone,
    headline: copy.headline,
    body: copy.body,
    // Four is the ceiling for a collapsed card; the rest stays in the evidence
    // sections, which lost nothing.
    facts: facts.slice(0, 4),
    aboutToken: input.standing.aboutToken,
  };
}

/**
 * Consumer filters, in the language of what was measured.
 *
 * The internal measurement states (provisional / rejected / unmeasured) are not
 * removed — they move behind an Advanced control. These are the axis a reader
 * actually has a question about.
 */
export const B20_CONSUMER_MARKET_FILTERS_V1 = [
  { id: 'all', label: 'Everything' },
  { id: 'two_sided', label: 'Both routes measured' },
  { id: 'bought_not_sellable', label: 'Bought, exit not priced' },
  { id: 'no_buyers_yet', label: 'No buyer activity' },
  { id: 'miorail_limit', label: 'Measurement gaps' },
] as const;

export type B20ConsumerMarketFilterV1 = (typeof B20_CONSUMER_MARKET_FILTERS_V1)[number]['id'];
