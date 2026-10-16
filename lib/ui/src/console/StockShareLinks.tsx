import React from 'react';
import { giftShareLinksV1 } from './giftView';
import { ShareLinkV1 } from './shareHost';

void React;

/** Share the public stock card, never the viewer's wallet or a private quote.
 * The canonical web origin also works when the reader is in the Base App. */
export function stockShareLinksV1(symbol: string | null) {
  const ticker = symbol?.trim().toUpperCase();
  // Keep the same ticker boundary as the public /stocks/:symbol route.
  if (!ticker || !/^[A-Z0-9][A-Z0-9.-]{0,15}$/.test(ticker)) return null;
  const url = `https://miorail.xyz/stocks/${encodeURIComponent(ticker.toLowerCase())}`;
  return { ticker, ...giftShareLinksV1({
    url,
    text: `${ticker} on Base: check the issuer, dividends and the measured route out with Miorail.`,
  }) };
}

export function StockShareLinks({ symbol }: { symbol: string | null }) {
  const links = stockShareLinksV1(symbol);
  if (!links) return null;
  return <div className="gift-share-row stock-share-row" role="group" aria-label={`Share ${links.ticker} stock card`}>
    <ShareLinkV1 className="btn sec" href={links.x}>Post on X</ShareLinkV1>
    <ShareLinkV1 className="btn sec" href={links.farcaster}>Cast on Farcaster</ShareLinkV1>
  </div>;
}
