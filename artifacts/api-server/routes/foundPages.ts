import { Router, type Request, type Response } from 'express';
import { isFoundShareCodeV1, type FoundShareV1 } from '@mioagent/route-storage';

import { logger } from '@mioagent/utils';
import { renderCardPngV1 } from '../lib/cardImage.js';
import { cardFileSuffixV1, type CardShapeV1 } from '../lib/cardShape.js';
import { foundCardSvgV1, foundCardV1, foundShareRuntimeV1, foundShareTextV1 } from '../lib/foundShare.js';
import {
  indexHtmlV1,
  renderStockPageHtmlV1,
  sendDocumentV1,
  stockPagesRuntime,
  type StockPageMetaV1,
} from './stockPages.js';

// ---------------------------------------------------------------------------
// Found's share pages: `/found/<code>` is the app under a head drawn from the
// card, so X and Farcaster preview the amount; `/found/<code>.png` (and
// `-3x2.png` for a Farcaster embed) is the card itself.
//
// A card never changes once made, so its picture may be held a day. An
// unknown code is a real 404, sent with the app and a noindex head.
// ---------------------------------------------------------------------------

export const foundPagesRouter = Router();
export const publicFoundRouter = Router();

export const foundPagesRuntime = {
  card: (code: string): Promise<FoundShareV1 | null> => foundShareRuntimeV1.shares().byCode(code),
  renderPng: renderCardPngV1,
};

export function foundShareMetaV1(origin: string, share: FoundShareV1): StockPageMetaV1 {
  const card = foundCardV1(share);
  return {
    title: card.pageTitle,
    description: card.description,
    canonicalUrl: `${origin}/found/${share.code}`,
    imageUrl: `${origin}/found/${share.code}.png`,
    image: { width: 1200, height: 630, alt: card.alt },
    // One person's claim: shareable, not a page for search.
    noindex: true,
    miniApp: { imageUrl: `${origin}/found/${share.code}${cardFileSuffixV1('embed')}.png`, buttonTitle: 'Check yours' },
  };
}

function notFoundMetaV1(origin: string): StockPageMetaV1 {
  return {
    title: 'Card not found · Miorail',
    description: 'No Found card under this link. Miorail reads what your wallet can claim on Aerodrome and Uniswap, from Base itself.',
    canonicalUrl: null,
    imageUrl: `${origin}/og-stocks.png`,
    noindex: true,
    miniApp: { imageUrl: `${origin}/og-stocks${cardFileSuffixV1('embed')}.png`, buttonTitle: 'Open Miorail' },
  };
}

foundPagesRouter.get('/found/:file', async (req: Request, res: Response) => {
  const file = String(req.params.file ?? '');
  const origin = stockPagesRuntime.origin();
  const picture = /^([A-Za-z0-9_-]{12})(-3x2)?\.png$/.exec(file);
  if (picture) {
    const shape: CardShapeV1 = picture[2] ? 'embed' : 'link';
    const fallback = `${origin}/og-stocks${cardFileSuffixV1(shape)}.png`;
    let share: FoundShareV1 | null;
    try {
      share = await foundPagesRuntime.card(picture[1]!);
    } catch (error) {
      logger.warn('Found card could not be read', { errorName: error instanceof Error ? error.name : typeof error });
      res.redirect(302, fallback);
      return;
    }
    if (!share) {
      res.status(404).type('text/plain').send('no Found card under that code');
      return;
    }
    try {
      const png = Buffer.from(await foundPagesRuntime.renderPng(foundCardSvgV1(foundCardV1(share), shape)));
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.status(200).type('png').send(png);
    } catch (error) {
      logger.warn('Found card could not be drawn', { errorName: error instanceof Error ? error.name : typeof error });
      res.redirect(302, fallback);
    }
    return;
  }
  let html: string;
  try {
    html = await indexHtmlV1();
  } catch {
    // nginx serves the static document instead.
    res.status(503).type('text/plain').send('found page unavailable');
    return;
  }
  if (!isFoundShareCodeV1(file)) {
    sendDocumentV1(res, 404, renderStockPageHtmlV1(html, notFoundMetaV1(origin)));
    return;
  }
  try {
    const share = await foundPagesRuntime.card(file);
    sendDocumentV1(res, share ? 200 : 404, renderStockPageHtmlV1(html, share ? foundShareMetaV1(origin, share) : notFoundMetaV1(origin)));
  } catch (error) {
    logger.warn('Found page could not be read', { errorName: error instanceof Error ? error.name : typeof error });
    sendDocumentV1(res, 200, renderStockPageHtmlV1(html, notFoundMetaV1(origin)));
  }
});

/** The card's figures for the page itself: what the picture shows, nothing else. */
publicFoundRouter.get('/found/:code', async (req: Request, res: Response) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const code = String(req.params.code ?? '');
  if (!isFoundShareCodeV1(code)) {
    res.status(404).json({ error: 'found_card_not_found', code: 'found_card_not_found' });
    return;
  }
  try {
    const share = await foundPagesRuntime.card(code);
    if (!share) {
      res.status(404).json({ error: 'found_card_not_found', code: 'found_card_not_found' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ code: share.code, protocol: share.protocol, usdCents: share.usdCents, tokens: share.tokens,
      blockNumber: share.blockNumber, createdAt: share.createdAt, text: foundShareTextV1(share) });
  } catch (error) {
    logger.error('Public Found card read failed', { name: error instanceof Error ? error.name : 'unknown' });
    res.status(500).json({ error: 'found_card_failed', code: 'found_card_failed' });
  }
});
