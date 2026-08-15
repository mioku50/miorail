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

export type B20ExitStandingKindV1 =
  | 'not_measured'
  | 'measurement_incomplete'
  | 'venue_not_found'
  | 'no_buyers_yet'
  | 'bought_not_sellable'
  | 'sale_unpriced'
  | 'ruled_out'
  | 'two_sided';

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
  } | null;
  /** The completed launch-window buyer aggregate, or null when the window has
   * not closed or was never measured. Null is NOT zero. */
  buyerCount: number | null;
}

const NOT_A_RECOMMENDATION_V1 =
  'This describes one stored measurement, not a recommendation.';

export function b20ExitStandingV1(input: B20ExitStandingInputV1): B20ExitStandingV1 {
  const observation = input.observation;

  if (!observation) {
    return {
      kind: 'not_measured',
      headline: 'Not measured yet.',
      detail: 'Miorail has stored this launch but has not measured it. Nothing here is a statement about the token.',
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
    return {
      kind: 'bought_not_sellable',
      headline: `${wallets} bought this, and Miorail could not price a sale.`,
      detail: `A purchase priced against the measured pool and a sale did not, while the launch window recorded real buyers. Miorail measured that it could not sell at the reference size; it did not establish why, and a sale may still be possible at another venue or another size. ${NOT_A_RECOMMENDATION_V1}`,
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
