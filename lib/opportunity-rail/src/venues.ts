// ---------------------------------------------------------------------------
// Which venues a measurement actually asked.
//
// Measured 2026-08-15, across every stored latest observation:
//
//   2,622  quoted against native ETH  — the Uniswap v4 path
//   1,891  quoted against USDC        — and only TEN USDC pools exist
//
// So a USDC-denominated observation is not a USDC pool. It is the fingerprint
// of the AERODROME FALLBACK: the v4 lookup found nothing, so the measurement
// asked Aerodrome, whose profile is denominated in USDC. That part is honest.
//
// What is not honest is what those rows claim. 1,581 of them carry
// `routeCoverage: 'complete'`, and 1,662 of them were last measured before
// 2026-08-10, which is when the v4 path went live at all. For those launches
// Miorail never asked the venue where B20 tokens actually trade — and nothing
// in the row recorded that, because `measurement_version` is the same string
// for both paths.
//
// A verdict is only as wide as the venues behind it. This records them.
// ---------------------------------------------------------------------------

/** The venue families a B20 measurement can consult. Stable strings: they are
 * stored on every observation and read back by surfaces that must not have to
 * guess what an old row meant. */
export const B20_VENUE_UNISWAP_V4_V1 = 'uniswap-v4' as const;
export const B20_VENUE_AERODROME_V1 = 'aerodrome' as const;

export const B20_VENUES_V1 = [B20_VENUE_UNISWAP_V4_V1, B20_VENUE_AERODROME_V1] as const;
export type B20VenueV1 = (typeof B20_VENUES_V1)[number];

/**
 * The venue B20 tokens actually trade on.
 *
 * Not a preference. 2,161 of 2,925 resolved pool rows are Uniswap v4 and ten
 * are anything else, so a route search that skipped v4 searched the wrong
 * chain of venues and cannot support "this token has no route".
 */
export const B20_PRIMARY_VENUE_V1 = B20_VENUE_UNISWAP_V4_V1;

export interface B20VenueCoverageV1 {
  /** True when the search included the venue where these tokens trade. */
  searchedPrimary: boolean;
  /** True when the row records no venue set at all — every observation written
   * before this field existed. Distinct from "searched nothing": nobody asked
   * the question then, so nothing is known either way. */
  unknown: boolean;
  /** For display, in the order they were asked. */
  venues: readonly string[];
}

/**
 * Reads an observation's stored venue set.
 *
 * Null and empty both mean UNKNOWN, not "none". A legacy row was written by a
 * build that did not record this, and treating its silence as "searched no
 * venues" would invent a fact in the other direction.
 */
export function b20VenueCoverageV1(venues: readonly string[] | null | undefined): B20VenueCoverageV1 {
  if (!venues || venues.length === 0) {
    return { searchedPrimary: false, unknown: true, venues: [] };
  }
  return {
    searchedPrimary: venues.includes(B20_PRIMARY_VENUE_V1),
    unknown: false,
    venues,
  };
}

const VENUE_LABEL_V1: Readonly<Record<string, string>> = {
  [B20_VENUE_UNISWAP_V4_V1]: 'Uniswap v4',
  [B20_VENUE_AERODROME_V1]: 'Aerodrome',
};

/** Venue names for a card, or null when the row does not record them. The row
 * says "not recorded" rather than naming a set nobody stored. */
export function b20VenueLabelV1(venues: readonly string[] | null | undefined): string | null {
  const coverage = b20VenueCoverageV1(venues);
  if (coverage.unknown) return null;
  return coverage.venues.map((venue) => VENUE_LABEL_V1[venue] ?? venue).join(' + ');
}
