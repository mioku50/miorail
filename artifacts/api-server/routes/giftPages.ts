import { Router, type Request, type Response } from 'express';
import { client } from '@mioagent/db';
import { formatAtomicV1, giftOfPublicBundleV1, type PublicGiftV1 } from '@mioagent/proof-verifier';
import { createDatabaseUnderlyingAssetRepository } from '@mioagent/route-storage';
import { companyDisplayNameV1 } from '@mioagent/rwa-market-reality';
import { logger } from '@mioagent/utils';

import { reverseBaseNameV1 } from '../lib/baseNameResolver.js';
import { loadPublicBundleV1, publicProofRuntime } from './publicProof.js';
import { createPublicReadCacheV1 } from './publicStocks.js';
import {
  indexHtmlV1,
  renderStockPageHtmlV1,
  sendDocumentV1,
  stockPagesRuntime,
  type StockPageMetaV1,
} from './stockPages.js';

// ---------------------------------------------------------------------------
// Growth plan step 4: the page a gift is shared as — `/gift/<publicId>`.
//
// A gift link IS a public proof link: the same unguessable id, the same
// canonical bundle, revoked the same way. What this adds is the one thing a
// shared link lives or dies by on X and Farcaster — a preview. Unfurlers run
// no script, so the head is written here, from the bundle, the way
// `/stocks/<ticker>` writes its own.
//
// Everything a preview CLAIMS comes out of the bundle's approved calls (the
// transfer's own calldata) and its final status. The two names are labels:
// a Basename is shown only when it resolves back to the same address, and an
// address is always there to show instead.
//
// Nothing is cached that a revocation must reach. The bundle is read on every
// request; only the labels — a name per address, a company per token — are
// held for a few minutes.
// ---------------------------------------------------------------------------

export const giftPagesRouter = Router();
/** Mounted under /api/public, beside the public proof it describes. */
export const publicGiftRouter = Router();

const PUBLIC_ID_V1 = /^[0-9a-f]{48,}$/;

export type GiftStockLabelV1 = { ticker: string | null; companyName: string | null };

export type GiftSummaryV1 = {
  gift: PublicGiftV1;
  names: { giver: string | null; recipient: string | null };
  stock: GiftStockLabelV1 | null;
};

const nameCacheV1 = createPublicReadCacheV1({ ttlMs: 10 * 60_000, max: 500 });
const stockCacheV1 = createPublicReadCacheV1({ ttlMs: 10 * 60_000, max: 200 });

/** Testing seam. */
export function resetGiftPageCachesV1(): void {
  nameCacheV1.clear();
  stockCacheV1.clear();
}

/** A testing seam; production never replaces any of it. */
export const giftPagesRuntime = {
  enabled: (env: NodeJS.ProcessEnv): boolean => {
    const flags = publicProofRuntime.flags(env);
    return Boolean(flags.routeIntelligenceV1 && flags.publicProofV1);
  },
  migrationAvailable: (): Promise<boolean> => publicProofRuntime.migrationAvailable(),
  loadBundle: (publicId: string): Promise<unknown> => loadPublicBundleV1(publicId),
  reverseName: (address: string): Promise<string | null> => reverseBaseNameV1(address),
  stock: async (tokenAddress: string): Promise<GiftStockLabelV1 | null> => {
    const found = await createDatabaseUnderlyingAssetRepository(client).underlyingOf({ chainId: 8453, tokenAddress });
    if (!found) return null;
    const { underlying } = found;
    return {
      ticker: underlying.displaySymbol ?? null,
      companyName: companyDisplayNameV1({
        canonicalName: underlying.canonicalName,
        displaySymbol: underlying.displaySymbol ?? null,
        identifierScheme: underlying.identifierScheme ?? null,
        identifierValue: underlying.identifierValue ?? null,
      }),
    };
  },
};

/** A label is optional; a failure to read one is just no label. */
async function labelOr<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

/** The gift behind a public id, with its labels — or null for an unknown,
 * revoked or non-gift link, which every caller answers the same way. */
export async function readGiftSummaryV1(publicId: string): Promise<GiftSummaryV1 | null> {
  if (!PUBLIC_ID_V1.test(publicId)) return null;
  const bundle = await giftPagesRuntime.loadBundle(publicId);
  const gift = bundle ? giftOfPublicBundleV1(bundle) : null;
  if (!gift) return null;
  const [giver, recipient, stock] = await Promise.all([
    labelOr(() => nameCacheV1.read(gift.giver, () => giftPagesRuntime.reverseName(gift.giver)), null),
    labelOr(() => nameCacheV1.read(gift.recipient, () => giftPagesRuntime.reverseName(gift.recipient)), null),
    labelOr(() => stockCacheV1.read(gift.token.address, () => giftPagesRuntime.stock(gift.token.address)), null),
  ]);
  return { gift, names: { giver, recipient }, stock };
}

function shortAddressV1(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** What the preview says. Every clause is read from the bundle; the names are
 * the only thing that is not, and each falls back to its own address. */
export function giftPageMetaV1(input: { origin: string; summary: GiftSummaryV1 }): StockPageMetaV1 {
  const { gift, names, stock } = input.summary;
  const giver = names.giver ?? shortAddressV1(gift.giver);
  const recipient = names.recipient ?? shortAddressV1(gift.recipient);
  const amount = `${formatAtomicV1(gift.amountAtomic, gift.token.decimals)} ${gift.token.symbol}`;
  const company = stock?.companyName ?? stock?.ticker ?? gift.token.symbol;
  // "gave" only over a completed proof: the reconciler completes a gift only
  // when the receipt shows the transfer, so anything else was not given.
  const title = gift.delivered
    ? `${giver} gave ${recipient} ${company} stock · Miorail`
    : `A gift of ${company} stock that did not arrive · Miorail`;
  const description = gift.delivered
    ? `${amount}: tokenized ${company} stock, delivered on Base in one transaction. The record checks itself in your browser.`
    : `A gift of ${amount} from ${giver} to ${recipient} did not complete on Base, so nothing was delivered. The record says what happened.`;
  return {
    title,
    description,
    // A gift link is unguessable, not secret; a search engine must never turn
    // one into a page anybody can find.
    canonicalUrl: null,
    imageUrl: `${input.origin}/og-gift.png`,
    noindex: true,
  };
}

function notFoundMetaV1(origin: string): StockPageMetaV1 {
  return {
    title: 'Gift not found · Miorail',
    description: 'This gift link is not valid. It may have been revoked by the person who shared it.',
    canonicalUrl: null,
    imageUrl: `${origin}/og-gift.png`,
    noindex: true,
  };
}

function genericMetaV1(origin: string): StockPageMetaV1 {
  return {
    title: 'A gift of stock on Base · Miorail',
    description: 'A tokenized stock, given on Base. The record checks itself in your browser.',
    canonicalUrl: null,
    imageUrl: `${origin}/og-gift.png`,
    noindex: true,
  };
}

giftPagesRouter.get('/gift/:publicId', async (req: Request, res: Response) => {
  let html: string;
  try {
    html = await indexHtmlV1();
  } catch (error) {
    // nginx serves the static index.html on a 5xx, so the page still opens.
    logger.warn('Gift page could not be rendered', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(503).type('text/plain').send('gift page unavailable');
    return;
  }
  const origin = stockPagesRuntime.origin();
  const publicId = String(req.params.publicId ?? '');
  // Never indexed, like the proof it shows. (sendDocumentV1 also sends
  // no-store, so a revoked link stops previewing on the next unfurl.)
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (!PUBLIC_ID_V1.test(publicId) || !giftPagesRuntime.enabled(process.env)) {
    sendDocumentV1(res, 404, renderStockPageHtmlV1(html, notFoundMetaV1(origin)));
    return;
  }
  try {
    if (!(await giftPagesRuntime.migrationAvailable())) {
      sendDocumentV1(res, 200, renderStockPageHtmlV1(html, genericMetaV1(origin)));
      return;
    }
    const summary = await readGiftSummaryV1(publicId);
    if (!summary) {
      sendDocumentV1(res, 404, renderStockPageHtmlV1(html, notFoundMetaV1(origin)));
      return;
    }
    sendDocumentV1(res, 200, renderStockPageHtmlV1(html, giftPageMetaV1({ origin, summary })));
  } catch (error) {
    // The preview is an improvement, never a precondition: the app still opens.
    logger.warn('Gift page preview could not be read', { errorName: error instanceof Error ? error.name : typeof error });
    sendDocumentV1(res, 200, renderStockPageHtmlV1(html, genericMetaV1(origin)));
  }
});

/**
 * The labels the gift page shows beside what it reads from the bundle itself:
 * the two Basenames and the company. Nothing here is a fact the page relies on
 * — the page decodes the gift from the bundle it verified — so a label that
 * cannot be read is null, never an error.
 */
publicGiftRouter.get('/gifts/:publicId', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (!giftPagesRuntime.enabled(process.env)) {
    res.status(404).json({ error: 'public_proof_disabled', code: 'public_proof_disabled' });
    return;
  }
  try {
    if (!(await giftPagesRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'public_proof_unavailable', code: 'public_proof_unavailable' });
      return;
    }
    const summary = await readGiftSummaryV1(String(req.params.publicId ?? ''));
    if (!summary) {
      res.status(404).json({ error: 'gift_not_found', code: 'gift_not_found' });
      return;
    }
    res.json({ names: summary.names, stock: summary.stock });
  } catch (error) {
    logger.error('Public gift read failed', { name: error instanceof Error ? error.name : 'unknown' });
    res.status(500).json({ error: 'public_gift_failed', code: 'public_gift_failed' });
  }
});
