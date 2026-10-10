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
//
// A thin market's price is not shown as the stock's price. On 2026-10-10 the
// board showed CAKE at $7,641 (the share: $108) and PFE at $143 (the share:
// $28), each from a pool of a few hundred dollars, with Buy beside it. Where a
// $1,000 buy-and-sell loses a fifth or more, or was never measured, the tile
// and the card say so instead, and the card warns before Buy.
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
  /** "Thin market" or "Depth not measured" where a price was measured and is
   * not shown as the stock's; null otherwise. */
  depthLabel: string | null;
  /** The sentence the card says in the price's place. */
  depthNote: string | null;
  /** Said above Buy while the market is thin or unmeasured. */
  buyWarning: string | null;
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
    // A reply from before the field is the old behaviour: shown.
    const depth = row.depth ?? { state: 'normal' as const, roundTripLossBps: null, measuredAt: null };
    const shown = row.priceUsd !== null && depth.state === 'normal';
    const withheld = row.priceUsd !== null && !shown;
    const loss = depth.roundTripLossBps === null ? null : `${Math.round(depth.roundTripLossBps / 100)}%`;
    views.set(row.underlyingKey, {
      tokenAddress: row.tokenAddress,
      iconPath: row.iconPath,
      companyName: row.companyName,
      tokenSymbol: row.tokenSymbol,
      priceUsd: shown ? row.priceUsd : null,
      price: shown ? stockPriceLabelV1(row.priceUsd!) : null,
      change: shown && row.change24h !== null ? stockChangeLabelV1(row.change24h) : null,
      priceAt: shown ? row.priceAt : null,
      depthLabel: withheld ? (depth.state === 'thin' ? 'Thin market' : 'Depth not measured') : null,
      depthNote: withheld
        ? depth.state === 'thin'
          ? `Thin market on Base: a $1,000 buy and sell here loses ${loss ?? 'a fifth or more'}. A price taken from a market this thin can be far from the share's own price, so none is shown.`
          : "Depth not measured: Miorail priced a $100 trade here but not a $1,000 one, so that price is not shown as the stock's."
        : null,
      buyWarning: withheld
        ? depth.state === 'thin'
          ? "Thin market: a buy here can cost far more than the share is worth, and a larger amount may not come back. Compare the quote with the share's own price before you sign."
          : "Depth not measured: a buy here can cost far more than the share is worth. Compare the quote with the share's own price before you sign."
        : null,
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
