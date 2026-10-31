import { Router, type Request, type Response } from 'express';
import { stillTerms } from '@mioagent/still-engine';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';

import { renderCardPngV1 } from '../lib/cardImage.js';
import { stillBrandCardSvgV1, stillWalletCardSvgV1, type StillCardShapeV1 } from '../lib/stillCard.js';
import { STILL_OUTCOME_STATUS_V1, stillMirrorRuntimeV1 } from '../lib/stillMirror.js';
import { createPublicReadCacheV1 } from './publicStocks.js';

// ---------------------------------------------------------------------------
// Still's public door: any Base wallet, by address or name, and how much it
// could borrow through Still without selling. It is the same check stills.lat
// has answered since 2026-10-25, now served by this API.
//
// It reads public chain state only, the way an explorer does, so it needs no
// session. What a public door adds is a cost nobody controls. Every read here
// is a live chain read, so the limit is per address: thirty a minute is a
// person checking wallets, not a crawler.
// ---------------------------------------------------------------------------

export const publicStillRouter = Router();

export const publicStillRuntimeV1 = {
  limiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 30 }),
  service: () => stillMirrorRuntimeV1.service(),
  now: () => new Date(),
  renderPng: (svg: string): Promise<Uint8Array> => renderCardPngV1(svg),
};

/** A wallet's card for ten minutes: a shared link is fetched by every client that shows it. */
const walletCardCacheV1 = createPublicReadCacheV1({ ttlMs: 10 * 60_000, max: 256 });
const brandCardCacheV1 = createPublicReadCacheV1({ ttlMs: 24 * 60 * 60_000, max: 2 });

/** Testing seam. */
export function resetStillCardCachesV1(): void {
  walletCardCacheV1.clear();
  brandCardCacheV1.clear();
}

publicStillRouter.use(async (req: Request, res: Response, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const allowed = await publicStillRuntimeV1.limiter.consume(`public-still:${ip}`);
  res.setHeader('X-RateLimit-Limit', allowed.limit);
  res.setHeader('X-RateLimit-Remaining', allowed.remaining);
  if (!allowed.success) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((allowed.resetTime - Date.now()) / 1000))));
    res.status(429).json({ outcome: 'rate_limited' });
    return;
  }
  next();
});

publicStillRouter.get('/mirror', async (req: Request, res: Response) => {
  const subject = typeof req.query.subject === 'string' ? req.query.subject : '';
  if (subject.length > 256) {
    res.status(400).json({ outcome: 'invalid_subject', input: '', reason: 'not_an_address_or_name' });
    return;
  }
  try {
    const outcome = await publicStillRuntimeV1.service().check(subject);
    res.status(STILL_OUTCOME_STATUS_V1[outcome.outcome]).json(outcome);
  } catch (error) {
    logger.warn('Still mirror read failed', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(500).json({ outcome: 'internal_error' });
  }
});

publicStillRouter.get('/terms', async (_req: Request, res: Response) => {
  try {
    // The calendar never rejects: an unread one comes back as `ok: false` and
    // every stock then counts at the earnings rate.
    const read = await publicStillRuntimeV1.service().earnings();
    res.json(stillTerms(read, publicStillRuntimeV1.now()));
  } catch (error) {
    logger.warn('Still terms read failed', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(500).json({ outcome: 'internal_error' });
  }
});

/**
 * The picture a shared /w/ link previews as: 1200 x 630 for X and link
 * previews, `shape=tall` (3:2) for a Farcaster cast. It is the public check
 * Home answers for any address or name, drawn as Home draws it. A subject that
 * cannot be read now gets Still's own picture, which says nothing about any
 * wallet, and is not kept: the next fetch tries the wallet again.
 */
publicStillRouter.get('/card.png', async (req: Request, res: Response) => {
  const subject = typeof req.query.subject === 'string' ? req.query.subject.trim() : '';
  const shape: StillCardShapeV1 = req.query.shape === 'tall' ? 'tall' : 'wide';
  if (subject.length > 256) {
    res.status(400).json({ outcome: 'invalid_subject', input: '', reason: 'not_an_address_or_name' });
    return;
  }
  const send = (png: Uint8Array, maxAge: number) => {
    res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(200).type('png').send(Buffer.from(png));
  };
  const brand = () => brandCardCacheV1.read(shape, () => publicStillRuntimeV1.renderPng(stillBrandCardSvgV1(shape)));
  try {
    if (!subject) {
      send(await brand(), 86_400);
      return;
    }
    const png = await walletCardCacheV1
      .read(`${subject.toLowerCase()}|${shape}`, async () => {
        const outcome = await publicStillRuntimeV1.service().check(subject);
        if (outcome.outcome !== 'report') throw new Error(`still_card_${outcome.outcome}`);
        return publicStillRuntimeV1.renderPng(stillWalletCardSvgV1(shape, outcome.report, publicStillRuntimeV1.now()));
      })
      .catch(() => null);
    if (png) send(png, 600);
    else send(await brand(), 60);
  } catch (error) {
    logger.warn('Still card render failed', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(500).json({ outcome: 'internal_error' });
  }
});
