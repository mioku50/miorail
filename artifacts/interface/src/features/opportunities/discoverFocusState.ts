// ---------------------------------------------------------------------------
// What the focused-measurement panel should say, before it says anything.
//
// Four outcomes look the same to a component that only checks for a card:
// still loading, this server does not run Discover, no canonical launch at this
// address, and the read failed. Only the third is a fact about the token, and a
// panel that renders "no measurement" for all four publishes Miorail's own
// failures under a token's name.
//
// A pure function so those four can be pinned by test rather than by clicking.
// ---------------------------------------------------------------------------

export interface DiscoverFocusStateV1 {
  loading: boolean;
  /** The index holds no canonical launch at this address. */
  notFound: boolean;
  /** A transport or server failure. Never set together with `notFound`. */
  error: string | null;
}

/** The exact code the detail endpoint returns when it knows no such launch. */
export const DISCOVER_FOCUS_NOT_FOUND_CODE_V1 = 'launch_not_found';

export const DISCOVER_FOCUS_OFF_COPY_V1 =
  'B20 Discover is off on this server, so there is no measurement to open. This is not a statement about this token.';

export const DISCOVER_FOCUS_FAILED_COPY_V1 =
  'This token’s measurement could not be read. That is about the request, not about the token.';

export function discoverFocusStateV1(input: {
  tokenAddress: string | null;
  discoverOn: boolean;
  /** True when the feed page already holds this card — then nothing is fetched. */
  inFeed: boolean;
  detailPending: boolean;
  detailError: string | null;
  hasCard: boolean;
}): DiscoverFocusStateV1 {
  if (input.tokenAddress === null) return { loading: false, notFound: false, error: null };
  if (!input.discoverOn) return { loading: false, notFound: false, error: DISCOVER_FOCUS_OFF_COPY_V1 };
  if (input.inFeed || input.hasCard) return { loading: false, notFound: false, error: null };
  if (input.detailError !== null) {
    // The 404 is a fact about the index and gets its own sentence; everything
    // else is Miorail's failure and is worded as one.
    return input.detailError.includes(DISCOVER_FOCUS_NOT_FOUND_CODE_V1)
      ? { loading: false, notFound: true, error: null }
      : { loading: false, notFound: false, error: DISCOVER_FOCUS_FAILED_COPY_V1 };
  }
  if (input.detailPending) return { loading: true, notFound: false, error: null };
  // Not pending, no error and no card: the read finished with nothing in it.
  return { loading: false, notFound: true, error: null };
}
