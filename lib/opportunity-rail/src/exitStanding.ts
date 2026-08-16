// ---------------------------------------------------------------------------
// What a Discover card actually says about a token.
//
// The headline used to come from a four-entry table keyed on the observation
// state, so all 4,067 rejected launches said one sentence: "Ruled out by public
// evidence for the feed's reference profile." Measured 2026-08-15, that one
// sentence was covering at least four different things, and only two of them
// are facts about the token at all:
//
//   892  Miorail never found a pool — its own blind spot, worded as a verdict
//   311  the measurement did not complete — likewise
// 1,769  entry priced, sale did not, and NOBODY HAS EVER BOUGHT the token, so
//        its pool holds no quote asset to sell into
//   190  entry priced, sale did not, and people DID buy — the one group worth
//        a user's attention, and the Exit-First thesis paying off
//
// The split is derivable from fields the card already carries. Exit prices
// where buyers exist (41 launches, mean 77 buyers) and fails where they do not
// (2,519 launches, mean 0.37) — so the buyer aggregate is what separates "no
// market yet" from "a market that will not let you out".
//
// `aboutToken` is the honesty flag: false whenever the card is describing what
// MIORAIL could not do. A card that cannot tell the two apart says so.
// ---------------------------------------------------------------------------

import { b20VenueCoverageV1 } from './venues.js';

export type B20ExitStandingKindV1 =
  | 'not_measured'
  | 'measurement_incomplete'
  /** The search never asked the venue where these tokens trade. A stronger
   * statement about Miorail's limits than `venue_not_found`, and it must not
   * be collapsed into it: one says "we looked and found nothing", the other
   * says "we did not look". */
  | 'venue_not_searched'
  | 'venue_not_found'
  | 'no_buyers_yet'
  | 'bought_not_sellable'
  | 'sale_unpriced'
  | 'ruled_out'
  | 'two_sided';

/** Every conclusion, for a caller that filters on one. Kept beside the type so
 * a new kind cannot be added without becoming filterable. */
export const B20_EXIT_STANDING_KINDS_V1 = [
  'not_measured',
  'measurement_incomplete',
  'venue_not_searched',
  'venue_not_found',
  'no_buyers_yet',
  'bought_not_sellable',
  'sale_unpriced',
  'ruled_out',
  'two_sided',
] as const;

export interface B20ExitStandingV1 {
  kind: B20ExitStandingKindV1;
  /** One sentence a person can act on, in place of the old state copy. */
  headline: string;
  /** What that sentence rests on, and what it does not claim. */
  detail: string;
  /** True only when the sentence is about the TOKEN rather than about the
   * limits of the measurement. Never let a false one be counted as a finding. */
  aboutToken: boolean;
}

export interface B20ExitStandingInputV1 {
  /** Null when nothing has been measured for this launch yet. */
  observation: {
    state: 'candidate' | 'provisional' | 'rejected' | 'unmeasured';
    reasonCode: string | null;
    entryRouteFound: boolean;
    exitRouteFound: boolean;
    /** Which venue families this reading actually asked. Null or absent on
     * every observation written before the field existed — 1,662 of which are
     * frozen at a verdict produced before Uniswap v4 was in the pipeline at
     * all. Null means UNKNOWN, never "none". */
    venuesConsulted?: readonly string[] | null;
  } | null;
  /** The completed launch-window buyer aggregate, or null when the window has
   * not closed or was never measured. Null is NOT zero. */
  buyerCount: number | null;
}

const NOT_A_RECOMMENDATION_V1 =
  'This describes one stored measurement, not a recommendation.';

// ---------------------------------------------------------------------------
// The four sections a reader actually needs.
//
// Eight kinds is the right resolution for a measurement and the wrong one for a
// screen. Measured against the live 48-hour feed on 2026-08-15 (1,139 canonical
// launches):
//
//   715  no_buyers_yet           nobody has bought it
//   278  venue_not_found     ─┐
//    51  sale_unpriced        ├─ 346 cards describing MIORAIL, not a token
//    17  measurement_incomplete ─┘
//    70  bought_not_sellable     buyers exist and a sale would not price
//     8  ruled_out               both directions priced, reference check failed
//     0  two_sided
//
// Two facts follow from those numbers and both shape the grouping. Thirty per
// cent of the feed is Miorail talking about itself, and it belongs in a section
// that says so. And the 70 cards that carry the product's actual finding are
// spread across roughly 46 pages of 25, so a section header alone would never
// put one in front of anybody — which is why the feed read takes a group filter
// rather than leaving the split to the client.
//
// The order is not a ranking of tokens. It is how much of the card is about the
// token at all, strongest first.
// ---------------------------------------------------------------------------

export type B20StandingGroupV1 =
  | 'bought_not_sellable'
  | 'two_sided'
  | 'no_buyers_yet'
  | 'miorail_limit';

/** Display order. Exported so a screen cannot invent its own. */
export const B20_STANDING_GROUPS_V1 = [
  'bought_not_sellable',
  'two_sided',
  'no_buyers_yet',
  'miorail_limit',
] as const;

/**
 * Which section a standing belongs to.
 *
 * `aboutToken` is checked FIRST and decides the answer on its own. A kind that
 * describes Miorail's own limits can never reach a token section, whatever else
 * is true of it — that is the property the whole split exists to guarantee, and
 * putting the check anywhere else would make it depend on the kind list staying
 * in sync by hand.
 */
export function b20StandingGroupV1(standing: {
  kind: B20ExitStandingKindV1;
  aboutToken: boolean;
}): B20StandingGroupV1 {
  if (!standing.aboutToken) return 'miorail_limit';
  if (standing.kind === 'bought_not_sellable') return 'bought_not_sellable';
  if (standing.kind === 'no_buyers_yet') return 'no_buyers_yet';
  // `ruled_out` and `two_sided` are one section: both mean a purchase AND a
  // sale priced against the same pool. They differ in the verdict, which the
  // card's own headline states.
  return 'two_sided';
}

/**
 * The same answer for a whole card, including one that has no observation.
 *
 * A stored launch nobody has measured is `not_measured`, which is a limit of
 * Miorail's own coverage — so it belongs in the section that says so, never in
 * a section a reader would take as a finding.
 */
export function b20CardStandingGroupV1(card: {
  observation: { standing: { kind: B20ExitStandingKindV1; aboutToken: boolean } } | null;
}): B20StandingGroupV1 {
  if (!card.observation) return 'miorail_limit';
  return b20StandingGroupV1(card.observation.standing);
}

export const B20_STANDING_GROUP_COPY_V1: Readonly<
  Record<B20StandingGroupV1, { label: string; chip: string; note: string }>
> = {
  bought_not_sellable: {
    label: 'Bought, and a sale would not price',
    chip: 'Bought, no sale',
    note: 'Wallets bought these in the launch window, and Miorail could not price a sale back at its reference size. This is the measurement Exit-First exists to make. It is not an accusation about the token and not a recommendation about it.',
  },
  two_sided: {
    label: 'Both directions priced',
    chip: 'Both priced',
    note: 'Miorail quoted a purchase and a sale against the same measured pool. Every quote here was taken before an entry moved that pool, so none of them is an executable quote.',
  },
  no_buyers_yet: {
    label: 'No buyer yet',
    chip: 'No buyer yet',
    note: 'Nobody bought in the measured launch window, so the pool holds no quote asset to sell into and a sale cannot be priced. That is an absent market, not a defect found in the token.',
  },
  miorail_limit: {
    // "Miorail could not measure these" is accurate and, at 25 cards on a
    // page, turns the product into a list of its own errors. The section is
    // about what is MISSING from the evidence, and saying that keeps the
    // invariant intact — the sentence below is still explicitly about Miorail,
    // and still refuses to be read as a verdict on a token.
    label: 'Needs more evidence',
    chip: 'Needs evidence',
    note: 'Miorail could not fully establish the market conditions for these launches yet — a venue it did not find, a call that did not answer, a buyer window still counting. These are measurement gaps, not findings about the tokens.',
  },
};

export function b20ExitStandingV1(input: B20ExitStandingInputV1): B20ExitStandingV1 {
  const observation = input.observation;

  if (!observation) {
    return {
      kind: 'not_measured',
      headline: 'Not measured yet.',
      // Deliberately not an echo of the headline. The sentence under a verdict
      // has to add something; one unmeasured card once said "not measured"
      // five separate times, and a card that repeats itself reads as a card
      // with nothing to say.
      detail: 'Miorail has stored this launch and has taken no reading of it yet. Nothing here is a statement about the token.',
      aboutToken: false,
    };
  }

  // Our own failure, first — before anything that could be read as a property
  // of the token. `route_search_degraded` names an unanswered call, not a
  // finding, and an unmeasured state says the same at the top level.
  if (observation.state === 'unmeasured' || observation.reasonCode === 'route_search_degraded') {
    return {
      kind: 'measurement_incomplete',
      headline: 'Miorail could not finish measuring this.',
      detail: 'A check this needs did not answer, so the reading is incomplete. This says nothing about the token — it says Miorail did not get an answer.',
      aboutToken: false,
    };
  }

  if (!observation.entryRouteFound) {
    // "We looked and found nothing" and "we did not look" are different
    // sentences, and only one of them was ever being said. 1,581 stored
    // observations claim complete route coverage over a venue set that did not
    // include Uniswap v4 — where 2,161 of 2,171 resolved B20 pools live.
    const venues = b20VenueCoverageV1(observation.venuesConsulted);
    if (!venues.searchedPrimary) {
      return {
        kind: 'venue_not_searched',
        headline: 'Miorail has not looked where this trades.',
        detail: venues.unknown
          ? 'This reading does not record which venues it searched, and it predates Uniswap v4 entering Miorail’s route search — which is where B20 tokens trade. It cannot support any statement about where this token can be bought or sold. Nothing here is about the token.'
          : `This reading searched ${venues.venues.join(', ')} and not Uniswap v4, which is where B20 tokens trade. It cannot support any statement about where this token can be bought or sold. Nothing here is about the token.`,
        aboutToken: false,
      };
    }
    return {
      kind: 'venue_not_found',
      headline: 'Miorail has not found where this trades.',
      detail: 'No pool Miorail reads could price a purchase. Miorail searches a fixed set of venues in a fixed window after the launch, so this is a gap in what was searched, not proof that the token trades nowhere.',
      aboutToken: false,
    };
  }

  if (!observation.exitRouteFound) {
    if (input.buyerCount === null) {
      return {
        kind: 'sale_unpriced',
        headline: 'A purchase priced; a sale did not.',
        detail: `Miorail could price buying this token but not selling it back. The launch-buying window has not produced a completed count, so Miorail cannot yet say whether that is because nobody has bought it or because a market exists and will not let you out. ${NOT_A_RECOMMENDATION_V1}`,
        aboutToken: false,
      };
    }
    if (input.buyerCount === 0) {
      return {
        kind: 'no_buyers_yet',
        headline: 'Nobody has bought this yet.',
        detail: `No buyer appeared in the measured launch window, so the pool holds nothing to sell into and a sale cannot be priced. That is an absence of a market, not a defect found in the token. ${NOT_A_RECOMMENDATION_V1}`,
        aboutToken: true,
      };
    }
    const wallets = input.buyerCount === 1 ? '1 wallet' : `${input.buyerCount} wallets`;
    // 44 of the 61 launches in this position in the live 48-hour window had
    // exactly ONE buyer. "1 wallet bought this" carries far more weight in a
    // reader's head than one wallet deserves, so the card says how thin it is
    // rather than leaving the count to imply a market.
    const thin =
      input.buyerCount === 1
        ? ' One wallet is the thinnest form this evidence takes, and Miorail did not check whose wallet it is.'
        : '';
    return {
      kind: 'bought_not_sellable',
      headline: `${wallets} bought this, and Miorail could not price a sale.`,
      detail: `A purchase priced against the measured pool and a sale did not, while the launch window recorded real buyers.${thin} Miorail measured that it could not sell at the reference size; it did not establish why, and a sale may still be possible at another venue or another size. ${NOT_A_RECOMMENDATION_V1}`,
      aboutToken: true,
    };
  }

  if (observation.state === 'rejected') {
    return {
      kind: 'ruled_out',
      headline: 'Buying and selling both priced, but a reference check failed.',
      detail: `Both directions quoted. The launch was still ruled out for the feed's reference profile${observation.reasonCode ? ` (${observation.reasonCode})` : ''}. ${NOT_A_RECOMMENDATION_V1}`,
      aboutToken: true,
    };
  }

  return {
    kind: 'two_sided',
    headline: 'Buying and selling both priced.',
    detail: `Miorail quoted a purchase and a sale back against the same measured pool. Both quotes were taken before any entry moved the pool, so this is not an executable quote and not a guarantee that a sale will fill. ${NOT_A_RECOMMENDATION_V1}`,
    aboutToken: true,
  };
}
