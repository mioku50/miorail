import type { StockQuotesResponseV1 } from '@mioagent/rwa-market-reality/stock-quotes';

// ---------------------------------------------------------------------------
// The Stocks list's prices, in a reader's words.
//
// A price here is a price ON BASE: the middle of Miorail's $100 buy and sell
// quotes. It is said as one wherever it is shown, and a stock with no price is
// shown without one — never with $0 and never with an old number.
//
// The change takes no colour. The weekend card set the rule: one accent, and
// the sign says which way. Green and red would be a verdict on a stock, and the
// board makes none.
// ---------------------------------------------------------------------------

export interface StockQuoteViewV1 {
  tokenAddress: string;
  iconPath: string | null;
  companyName: string | null;
  tokenSymbol: string | null;
  priceUsd: number | null;
  /** `$234.31`, or null when nothing priced it. */
  price: string | null;
  /** `+0.42%` or `−0.40%` over 24 hours, or null. */
  change: string | null;
  /** When the price was taken, for the line that says what it is. */
  priceAt: string | null;
}

/** `$1,722.70`, `$234.31`, `$0.4421`: cents for a dollar and up, four
 * decimals below one, because a 30-cent stock rounded to cents loses its move. */
export function stockPriceLabelV1(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const digits = value >= 1 ? 2 : 4;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** `+0.42%`, `−0.40%`, `0.00%`: a real minus sign, like the weekend card. */
export function stockChangeLabelV1(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—';
  const percent = Math.round(fraction * 10_000) / 100;
  if (percent === 0) return '0.00%';
  return `${percent > 0 ? '+' : '−'}${Math.abs(percent).toFixed(2)}%`;
}

export function stockQuoteViewsByKeyV1(
  response: StockQuotesResponseV1 | null,
): ReadonlyMap<string, StockQuoteViewV1> {
  const views = new Map<string, StockQuoteViewV1>();
  for (const row of response?.rows ?? []) {
    // One security, one tile: when two rows name the same company, the priced
    // one is the one a reader can act on.
    const existing = views.get(row.underlyingKey);
    if (existing && existing.priceUsd !== null && row.priceUsd === null) continue;
    views.set(row.underlyingKey, {
      tokenAddress: row.tokenAddress,
      iconPath: row.iconPath,
      companyName: row.companyName,
      tokenSymbol: row.tokenSymbol,
      priceUsd: row.priceUsd,
      price: row.priceUsd === null ? null : stockPriceLabelV1(row.priceUsd),
      change: row.change24h === null ? null : stockChangeLabelV1(row.change24h),
      priceAt: row.priceAt,
    });
  }
  return views;
}

/** "Price on Base · 14 min ago": what the number is, and its age. */
export function stockPriceNoteV1(priceAt: string | null, now: Date): string | null {
  if (!priceAt) return null;
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(priceAt)) / 60_000));
  const age = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
  return `Price on Base · ${age}`;
}
