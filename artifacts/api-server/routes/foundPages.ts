import { Router, type Request, type Response } from 'express';
import { isFoundShareCodeV1, type FoundShareV1 } from '@mioagent/route-storage';

import { InMemoryRateLimiter, logger } from '@mioagent/utils';
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
import { createPublicReadCacheV1 } from './publicStocks.js';
import { requestAddressKeyV1 } from '../middleware/rate-limit.js';

// ---------------------------------------------------------------------------
// Found's share pages: `/found/<code>` is the app under a head drawn from the
// card, so X and Farcaster preview the amount; `/found/<code>.png` (and
// `-3x2.png` for a Farcaster embed) is the card itself.
//
// A card never changes once made, so its picture may be held a day. An
// unknown code is a real 404, sent with the app and a noindex head.
//
// Drawing a picture is the costly part: the SVG is rasterised in this process,
// which serves nothing else meanwhile. Every request used to draw it again
// (audit AUTH-2, 2026-11-10). A picture is now drawn once and kept a day, by
// code and shape, and one address may have twenty new ones drawn a minute; a
// picture already kept is served to anyone, drawn or not by them.
// ---------------------------------------------------------------------------

export const foundPagesRouter = Router();
export const publicFoundRouter = Router();

export const foundPagesRuntime = {
  card: (code: string): Promise<FoundShareV1 | null> => foundShareRuntimeV1.shares().byCode(code),
  renderPng: renderCardPngV1,
  /** New pictures one address may have drawn in a minute. */
  drawLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 20 }),
};

/** Two hundred pictures of about a hundred kilobytes each, at most. */
const foundPictureCacheV1 = createPublicReadCacheV1({ ttlMs: 24 * 60 * 60_000, max: 200 });
/** Testing seam. */
export function resetFoundPictureCacheV1(): void {
  foundPictureCacheV1.clear();
}

/** Why a picture was not made; never kept, so the next request tries again. */
class FoundPictureErrorV1 extends Error {
  constructor(readonly reason: 'unread' | 'absent' | 'limited' | 'undrawn', readonly retryAfterSeconds = 60) {
    super(reason);
  }
}

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
    imageUrl: `${origin}/og-still-stocks.png`,
    noindex: true,
    miniApp: { imageUrl: `${origin}/og-still-stocks${cardFileSuffixV1('embed')}.png`, buttonTitle: 'Open Still' },
  };
}

foundPagesRouter.get('/found/:file', async (req: Request, res: Response) => {
  const file = String(req.params.file ?? '');
  const origin = stockPagesRuntime.origin();
  const picture = /^([A-Za-z0-9_-]{12})(-3x2)?\.png$/.exec(file);
  if (picture) {
    const shape: CardShapeV1 = picture[2] ? 'embed' : 'link';
    const fallback = `${origin}/og-stocks${cardFileSuffixV1(shape)}.png`;
    const code = picture[1]!;
    const address = requestAddressKeyV1(req);
    try {
      const png = await foundPictureCacheV1.read(`${code}|${shape}`, async () => {
        let share: FoundShareV1 | null;
        try {
          share = await foundPagesRuntime.card(code);
        } catch (error) {
          logger.warn('Found card could not be read', { errorName: error instanceof Error ? error.name : typeof error });
          throw new FoundPictureErrorV1('unread');
        }
        if (!share) throw new FoundPictureErrorV1('absent');
        const allowed = await foundPagesRuntime.drawLimiter.consume(`found-picture:${address}`);
        if (!allowed.success) throw new FoundPictureErrorV1('limited', Math.max(1, Math.ceil((allowed.resetTime - Date.now()) / 1000)));
        try {
          return Buffer.from(await foundPagesRuntime.renderPng(foundCardSvgV1(foundCardV1(share), shape)));
        } catch (error) {
          logger.warn('Found card could not be drawn', { errorName: error instanceof Error ? error.name : typeof error });
          throw new FoundPictureErrorV1('undrawn');
        }
      });
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.status(200).type('png').send(png);
    } catch (error) {
      const reason = error instanceof FoundPictureErrorV1 ? error.reason : 'undrawn';
      if (!(error instanceof FoundPictureErrorV1)) logger.warn('Found card picture failed', { errorName: error instanceof Error ? error.name : typeof error });
      if (reason === 'absent') {
        res.status(404).type('text/plain').send('no Found card under that code');
      } else if (reason === 'limited') {
        res.setHeader('Retry-After', String((error as FoundPictureErrorV1).retryAfterSeconds));
        res.status(429).type('text/plain').send('too many new Found pictures from this address; try again in a minute');
      } else {
        res.redirect(302, fallback);
      }
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
