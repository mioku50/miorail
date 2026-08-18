// ---------------------------------------------------------------------------
// Opening one token's measurement, without leaving Discover.
//
// The rail's "View measurement" used to navigate to `/portfolio?token=0x…`.
// Two things were wrong with that, and only the first one is visible on screen:
// Portfolio is the wallet-bound surface and owns no Discover measurement, and
// nothing on that page has ever read `?token=` — so the click was a plain jump
// to a different product area, with the address dropped on the way.
//
// The selection now lives in the URL of the surface that owns the measurement,
// which is what makes it survive a refresh and a Back press. Everything about
// it is validated here rather than at the call sites: a `token` a stranger can
// type into a link is untrusted text, and a surface that renders whatever it
// finds in the query string would happily focus a string that is not an
// address at all.
// ---------------------------------------------------------------------------

/** The only view this focus can name. Not an open list: a query parameter is
 * something a stranger can write, and every value it may take is spelled here. */
export const DISCOVER_FOCUS_VIEWS_V1 = ['measurement'] as const;
export type DiscoverFocusViewV1 = (typeof DISCOVER_FOCUS_VIEWS_V1)[number];

export interface DiscoverFocusV1 {
  /** Lowercased 20-byte address, or null when the URL names none. */
  tokenAddress: string | null;
  /** Null when no known view was named — never a guessed default, because a
   * link with a token and a misspelled view is a link that asked for something
   * this build does not have. */
  view: DiscoverFocusViewV1 | null;
}

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;

/** A token address as it may appear in a URL. Case is normalised; anything
 * that is not a 20-byte hex address is refused rather than passed through. */
export function discoverFocusTokenV1(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return ADDRESS_V1.test(value) ? value : null;
}

/**
 * What the current URL is asking Discover to focus.
 *
 * Accepts the raw `window.location.search`, with or without its leading `?`,
 * so a caller never has to remember which of the two it holds.
 */
export function parseDiscoverFocusV1(search: string | null | undefined): DiscoverFocusV1 {
  const params = new URLSearchParams((search ?? '').replace(/^\?/, ''));
  const tokenAddress = discoverFocusTokenV1(params.get('token'));
  // A view without a token focuses nothing, so it is not carried either. That
  // keeps `tokenAddress === null` the single test for "nothing is focused".
  if (tokenAddress === null) return { tokenAddress: null, view: null };
  const viewRaw = params.get('view');
  const view = (DISCOVER_FOCUS_VIEWS_V1 as readonly string[]).includes(String(viewRaw))
    ? (viewRaw as DiscoverFocusViewV1)
    : null;
  return { tokenAddress, view };
}

/**
 * The link that hands one token to a console surface.
 *
 * Built from the section path the caller passes rather than from a literal, so
 * this module cannot become a second place where a console path is decided —
 * and it is the ONLY builder, so `?token=` cannot be spelled one way by the
 * surface that writes it and read another way by the surface that receives it.
 * That is exactly how Discover came to point at `/portfolio?token=…` for years
 * while Portfolio read nothing.
 *
 * `view: null` omits the parameter, for a surface that has only one thing to do
 * with a token. Omitting `view` entirely keeps the measurement default.
 */
export function discoverFocusHrefV1(input: {
  sectionPath: string;
  tokenAddress: string;
  view?: DiscoverFocusViewV1 | null;
}): string {
  const token = discoverFocusTokenV1(input.tokenAddress);
  if (token === null) return input.sectionPath;
  const view = input.view === undefined ? 'measurement' : input.view;
  const params = new URLSearchParams(view === null ? { token } : { token, view });
  return `${input.sectionPath}?${params.toString()}`;
}

/** The DOM id of a feed card, so a focused token can be scrolled to. */
export function discoverCardDomIdV1(tokenAddress: string): string {
  return `b20-card-${tokenAddress.toLowerCase()}`;
}
