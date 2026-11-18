// ---------------------------------------------------------------------------
// Where "/" sends a link that carries a query.
//
// "/" was the Stocks board before it was Still's Home, and a link to it carried
// the board's question in the query (`/?key=…&size=…`); such a link still lands
// on the board. Any other query asks the board nothing: `/?utm_source=base`, a
// campaign's own tag, opened Stocks instead of Home (audit P3 Home query,
// 2026-11-18). The names are the ones MarketRealityPage reads.
// ---------------------------------------------------------------------------

/** The query parameters the Stocks and Market boards read. */
export const STILL_BOARD_QUERY_PARAMS_V1 = ['key', 'view', 'direction', 'size', 'destination', 'history', 'weekend'] as const;

/** The board a link to "/" was written for, its whole query kept, or null for Home. */
export function stillHomeRedirectV1(search: string, signedIn: boolean): string | null {
  const params = new URLSearchParams(search);
  if (!STILL_BOARD_QUERY_PARAMS_V1.some((name) => params.has(name))) return null;
  return `${signedIn ? '/market' : '/stocks'}${search.startsWith('?') ? search : `?${search}`}`;
}
