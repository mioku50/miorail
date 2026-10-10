// ---------------------------------------------------------------------------
// Stocks, in four tabs.
//
// Stocks was five things on one page: My stocks today, the weekend, dividends,
// Telegram, then the list and the card. On a 390 px phone a holder scrolled 3.6
// screens to reach the list of stocks and 4 to reach Buy (2026-10-03). The
// main menu stays at four pages, so Stocks gets its own four tabs instead.
//
// The web keeps the tab in the path (`/stocks/dividends`), so a link opens the
// same tab. The Base App has no address bar and keeps it in state. Both render
// the same screen.
// ---------------------------------------------------------------------------

export const STOCKS_SECTIONS_V1 = ['market', 'mine', 'dividends', 'weekend'] as const;
export type StocksSectionV1 = (typeof STOCKS_SECTIONS_V1)[number];

export const STOCKS_SECTION_LABELS_V1: Readonly<Record<StocksSectionV1, string>> = {
  market: 'Market',
  mine: 'My stocks',
  dividends: 'Dividends',
  weekend: 'Weekend',
};

/**
 * Each tab's address on the web. `/stocks/<ticker>` stays the market's.
 *
 * None of the three words can be a US ticker: a ticker is one to five letters,
 * and "mine" is the only one that short. No Coinbase stock is MINE; if one
 * ever is, its card stays reachable at `/market?key=…`.
 */
export const STOCKS_SECTION_PATHS_V1: Readonly<Record<StocksSectionV1, string>> = {
  market: '/stocks',
  mine: '/stocks/mine',
  dividends: '/stocks/dividends',
  weekend: '/stocks/weekend',
};

/** The tab a `/stocks/<segment>` path names, or null for a ticker. */
export function stocksSectionOfSegmentV1(segment: string | null | undefined): StocksSectionV1 | null {
  const word = (segment ?? '').toLowerCase();
  return word !== 'market' && (STOCKS_SECTIONS_V1 as readonly string[]).includes(word)
    ? (word as StocksSectionV1)
    : null;
}

export interface StocksSectionTabV1 {
  key: StocksSectionV1;
  label: string;
  /** "2 new" unread updates, or "live" while Wall Street is closed. Words, never a
   * colour: a dot that means "news" would also be read as "good" or "bad". */
  note: string | null;
  /** Where the tab lives, on a surface with addresses. Null in the Base App. */
  href: string | null;
}

export interface StocksSectionsModelV1 {
  current: StocksSectionV1;
  tabs: readonly StocksSectionTabV1[];
  onSection: (section: StocksSectionV1) => void;
}

export function stocksSectionTabsV1(input: {
  /** Unread updates about the reader's stocks, or null when none are read. */
  unread: number | null;
  /** More unread updates exist past the ones counted. */
  unreadMore?: boolean;
  /** Wall Street is closed and the weekend card is measuring. */
  weekendLive: boolean;
  href?: ((section: StocksSectionV1) => string) | null;
}): StocksSectionTabV1[] {
  return STOCKS_SECTIONS_V1.map((key) => ({
    key,
    label: STOCKS_SECTION_LABELS_V1[key],
    note:
      key === 'mine' && input.unread !== null && input.unread > 0
        ? // "new", because a bare "4" beside "My stocks" read as four stocks
          // held, on a wallet that held one (2026-10-10).
          `${input.unread}${input.unreadMore ? '+' : ''} new`
        : key === 'weekend' && input.weekendLive
          ? 'live'
          : null,
    href: input.href ? input.href(key) : null,
  }));
}
