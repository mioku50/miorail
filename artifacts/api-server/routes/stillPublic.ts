import { Router, type Request, type Response } from 'express';
import {
  SPEND_PRODUCT_TYPES_V1,
  createBitrefillGuestCatalogV1,
  spendCallingCodeV1,
  spendPhonePrefixesV1,
  type BitrefillGuestCatalogV1,
  type SpendFailureV1,
  type SpendProductTypeV1,
  type SpendProductV1,
} from '@mioagent/commerce-engine';
import { stillTerms } from '@mioagent/still-engine';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';

import { renderCardPngV1 } from '../lib/cardImage.js';
import { stillBrandCardSvgV1, stillSpendCardSvgV1, stillWalletCardSvgV1, type StillCardShapeV1 } from '../lib/stillCard.js';
import { STILL_OUTCOME_STATUS_V1, stillMirrorRuntimeV1 } from '../lib/stillMirror.js';
import { STILL_SPEND_CAP_ATOMIC_V1, spendBuyableV1, spendNeedsPhoneV1, stillBitrefillClientV1, stillSpendPayEnabledV1 } from '../lib/stillSpendOrders.js';
import { stillSpendShareWordsV1, verifyStillSpendShareV1 } from '../lib/stillSpendShare.js';
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

let spendCatalogV1: BitrefillGuestCatalogV1 | null = null;

export const publicStillRuntimeV1 = {
  limiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 30 }),
  service: () => stillMirrorRuntimeV1.service(),
  /** Bitrefill's catalogue, read as a guest of their MCP: Still Spend, stage 1. */
  spend: (): BitrefillGuestCatalogV1 => (spendCatalogV1 ??= createBitrefillGuestCatalogV1(stillBitrefillClientV1())),
  now: () => new Date(),
  renderPng: (svg: string): Promise<Uint8Array> => renderCardPngV1(svg),
  /** What signs a shared Still Spend purchase (stillSpendShare.ts). */
  secret: () => (process.env.SESSION_SECRET ?? '').trim(),
};

/** A wallet's card for ten minutes: a shared link is fetched by every client that shows it. */
const walletCardCacheV1 = createPublicReadCacheV1({ ttlMs: 10 * 60_000, max: 256 });
const brandCardCacheV1 = createPublicReadCacheV1({ ttlMs: 24 * 60 * 60_000, max: 2 });
/** A purchase card says only what its signed link says, so a day is as good as forever. */
const spendCardCacheV1 = createPublicReadCacheV1({ ttlMs: 24 * 60 * 60_000, max: 256 });

/** Bitrefill's catalogue moves in hours (they advise refreshing hourly), so a
 * search is kept half an hour and a product's prices a quarter of one. */
const spendSearchCacheV1 = createPublicReadCacheV1({ ttlMs: 30 * 60_000, max: 200 });
const spendProductCacheV1 = createPublicReadCacheV1({ ttlMs: 15 * 60_000, max: 400 });

/** Testing seam. */
export function resetStillCardCachesV1(): void {
  walletCardCacheV1.clear();
  brandCardCacheV1.clear();
  spendCardCacheV1.clear();
  spendSearchCacheV1.clear();
  spendProductCacheV1.clear();
}

export class SpendReadFailedV1 extends Error {
  constructor(readonly reason: SpendFailureV1) {
    super(reason);
  }
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

function sendCardPngV1(res: Response, png: Uint8Array, maxAge: number): void {
  res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.status(200).type('png').send(Buffer.from(png));
}
const brandCardPngV1 = (shape: StillCardShapeV1) => brandCardCacheV1.read(shape, () => publicStillRuntimeV1.renderPng(stillBrandCardSvgV1(shape)));

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
  const send = (png: Uint8Array, maxAge: number) => sendCardPngV1(res, png, maxAge);
  const brand = () => brandCardPngV1(shape);
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

/**
 * A shared Still Spend purchase (stillSpendShare.ts): the claim is in the link,
 * signed, so the picture reads nothing and is the same every time. A link this
 * server did not sign gets Still's own picture, which says nothing about it.
 */
publicStillRouter.get('/spend-card.png', async (req: Request, res: Response) => {
  const shape: StillCardShapeV1 = req.query.shape === 'tall' ? 'tall' : 'wide';
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  const share = verifyStillSpendShareV1(token, publicStillRuntimeV1.secret());
  try {
    if (!share) {
      sendCardPngV1(res, await brandCardPngV1(shape), 60);
      return;
    }
    sendCardPngV1(res, await spendCardCacheV1.read(`${token}|${shape}`, () => publicStillRuntimeV1.renderPng(stillSpendCardSvgV1(shape, share))), 86_400);
  } catch (error) {
    logger.warn('Still Spend card render failed', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(500).json({ outcome: 'internal_error' });
  }
});

/** The same claim in words, for the page a shared purchase link opens. */
publicStillRouter.get('/spend-share', (req: Request, res: Response) => {
  const share = verifyStillSpendShareV1(typeof req.query.t === 'string' ? req.query.t : '', publicStillRuntimeV1.secret());
  if (!share) {
    res.status(404).json({ outcome: 'share_invalid' });
    return;
  }
  const words = stillSpendShareWordsV1(share);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ outcome: 'share', share: { productName: share.productName, packageLabel: share.packageLabel, priceUsdc: words.priceUsdc,
    collateralLabel: words.collateralLabel, collateralName: words.collateralName, venueName: words.venueName } });
});

// ---------------------------------------------------------------------------
// Still Spend, stage 1: what a loan could pay for. Bitrefill's eSIMs, phone
// top-ups and gift cards with their prices in USDC, read as a guest. Nothing
// here can buy: the guest client calls search-products and get-product-details
// only. A failed read is Bitrefill's or ours and is never kept.
// ---------------------------------------------------------------------------

export const SPEND_QUERY_V1 = /^[\p{L}\p{N} .&'+-]{0,40}$/u;
export const SPEND_ID_V1 = /^[a-z0-9][a-z0-9_.-]{0,99}$/;
const spendStatusV1 = (reason: SpendFailureV1): number => (reason === 'bitrefill_product_not_found' ? 404 : 503);

/** A failed catalogue read, on record with Bitrefill's own words: the page and the assistants hear only the reason. */
function spendReadFailedV1(found: { reason: SpendFailureV1; detail?: string }): SpendReadFailedV1 {
  if (found.reason !== 'bitrefill_product_not_found') {
    logger.warn('Still Spend catalogue not read', { reason: found.reason, ...(found.detail ? { detail: found.detail } : {}) });
  }
  return new SpendReadFailedV1(found.reason);
}

/** One search, kept half an hour; the page and the assistants read the same one. Throws SpendReadFailedV1. */
export function readSpendSearchV1(input: { type: SpendProductTypeV1; country: string; query: string }) {
  return spendSearchCacheV1.read(`${input.type}|${input.country}|${input.query.toLowerCase()}`, async () => {
    const found = await publicStillRuntimeV1.spend().search({ type: input.type, country: input.country, query: input.query || undefined });
    if (!found.ok) throw spendReadFailedV1(found);
    return { outcome: 'products' as const, type: input.type, country: input.country, query: input.query, products: found.value, readAt: publicStillRuntimeV1.now().toISOString() };
  });
}

/** One product's packages and prices, kept a quarter of an hour. Throws SpendReadFailedV1. */
export function readSpendProductV1(id: string) {
  return spendProductCacheV1.read(id, async () => {
    const found = await publicStillRuntimeV1.spend().product(id);
    if (!found.ok) throw spendReadFailedV1(found);
    return { outcome: 'product' as const, product: found.value, readAt: publicStillRuntimeV1.now().toISOString() };
  });
}

/** Whether a product can be paid from Still now: read per request, never cached with the catalogue. */
export function spendProductCheckoutV1(product: SpendProductV1) {
  const enabled = stillSpendPayEnabledV1();
  const available = enabled && product.inStock && spendBuyableV1(product);
  // A top-up asks for the number it goes to: its calling code, and the
  // prefixes this country's numbers start with where countries share one.
  const callingCode = available && spendNeedsPhoneV1(product) ? spendCallingCodeV1(product.country) : null;
  const phone = callingCode ? { callingCode, prefixes: [...spendPhonePrefixesV1(product.country)!] } : null;
  return { enabled, available, capAtomic: STILL_SPEND_CAP_ATOMIC_V1.toString(), phone };
}

publicStillRouter.get('/spend/search', async (req: Request, res: Response) => {
  const type = typeof req.query.type === 'string' ? req.query.type : '';
  const country = typeof req.query.country === 'string' ? req.query.country.trim().toUpperCase() : '';
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!(SPEND_PRODUCT_TYPES_V1 as readonly string[]).includes(type) || !/^[A-Z]{2}$/.test(country) || !SPEND_QUERY_V1.test(query)) {
    res.status(400).json({ outcome: 'invalid' });
    return;
  }
  try {
    const body = await readSpendSearchV1({ type: type as SpendProductTypeV1, country, query });
    res.json({ ...body, checkout: { enabled: stillSpendPayEnabledV1() } });
  } catch (error) {
    const reason = error instanceof SpendReadFailedV1 ? error.reason : 'bitrefill_unreachable';
    if (!(error instanceof SpendReadFailedV1)) logger.warn('Still spend search failed', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(spendStatusV1(reason)).json({ outcome: 'unavailable', reason });
  }
});

publicStillRouter.get('/spend/product', async (req: Request, res: Response) => {
  const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
  if (!SPEND_ID_V1.test(id)) {
    res.status(400).json({ outcome: 'invalid' });
    return;
  }
  try {
    const body = await readSpendProductV1(id);
    res.json({ ...body, checkout: spendProductCheckoutV1(body.product) });
  } catch (error) {
    const reason = error instanceof SpendReadFailedV1 ? error.reason : 'bitrefill_unreachable';
    if (!(error instanceof SpendReadFailedV1)) logger.warn('Still spend product failed', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(spendStatusV1(reason)).json({ outcome: 'unavailable', reason });
  }
});
