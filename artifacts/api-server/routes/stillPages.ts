import { Router, type Request, type Response } from 'express';
import { formatCents } from '@mioagent/still-engine/format';
import type { MirrorOutcome } from '@mioagent/still-engine';
import { logger } from '@mioagent/utils';

import { stillSpendShareWordsV1, verifyStillLoanShareV1, verifyStillSpendShareV1, type StillLoanShareV1, type StillSpendShareV1 } from '../lib/stillSpendShare.js';
import { publicStillRuntimeV1 } from './stillPublic.js';
import {
  indexHtmlV1,
  renderStockPageHtmlV1,
  sendDocumentV1,
  stockPagesRuntime,
  type StockPageMetaV1,
} from './stockPages.js';

// ---------------------------------------------------------------------------
// Still's wallet links, /w/<address or name>, with a head of their own.
//
// The app draws the page; X, Telegram and Farcaster run no script, so a shared
// link previews from the HTML alone. This writes that HTML's head: the wallet's
// modelled borrowing room at one Base block, and its card (stillPublic.ts
// /card.png). The head waits a little for the reading, as stills.lat's did, so
// a shared link unfurls with its number; a slow chain gets the general head
// and the card reads the wallet again when it is fetched.
//
// A Still Spend purchase someone shared, /spend/p/<token>, gets one too: the
// claim signed in its link, and its card (stillPublic.ts /spend-card.png). So
// does a plain loan, under the same address with its own token.
//
// nginx sends /w/ and /spend/p/ here and serves the static index.html when
// this cannot answer, so a head is an improvement to a page, never a
// precondition for it.
// ---------------------------------------------------------------------------

export const stillPagesRouter = Router();

export const stillPagesRuntimeV1 = {
  /** How long a head waits for the wallet before it goes without the number. */
  headBudgetMs: 2_500,
};

/**
 * A head read on stills.lat names stills.lat; every other host keeps the
 * canonical origin. Since 2026-11-03 stills.lat leads people to miorail.xyz
 * (a 302), so this matters only if it serves pages again.
 */
export function stillOriginForHostV1(host: string | undefined, canonical: string): string {
  const name = (host ?? '').toLowerCase().split(':')[0];
  return name === 'stills.lat' || name === 'www.stills.lat' ? 'https://stills.lat' : canonical;
}

function subjectOfV1(raw: string): string | null {
  const subject = raw.trim();
  const control = Array.from(subject).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  return subject.length > 0 && subject.length <= 256 && !subject.includes('/') && !subject.includes('\\') && !control ? subject : null;
}

export function stillWalletMetaV1(input: { origin: string; canonical: string; subject: string; outcome: MirrorOutcome | null }): { status: number; meta: StockPageMetaV1 } {
  const path = `/w/${encodeURIComponent(input.subject)}`;
  const card = (shape: 'wide' | 'tall') =>
    `${input.origin}/api/public/still/card.png?subject=${encodeURIComponent(input.subject)}${shape === 'tall' ? '&shape=tall' : ''}`;
  const base = {
    canonicalUrl: `${input.origin}${path}`,
    imageUrl: card('wide'),
    noindex: true,
    siteName: 'Still',
    miniApp: { imageUrl: card('tall'), buttonTitle: 'Check on Still', url: `${input.canonical}${path}` },
  };
  const outcome = input.outcome;
  if (outcome?.outcome === 'invalid_subject' || outcome?.outcome === 'name_not_found') {
    return {
      status: 404,
      meta: {
        ...base,
        canonicalUrl: null,
        imageUrl: `${input.origin}/og-still.png`,
        miniApp: { imageUrl: `${input.origin}/og-still-3x2.png`, buttonTitle: 'Open Still', url: `${input.canonical}/` },
        title: 'Not a Base wallet · Still',
        description: 'That is not a Base address or a name Still could find. Still models what a Base wallet could borrow against its tokenized stocks and crypto without selling them.',
      },
    };
  }
  if (outcome?.outcome === 'report') {
    const report = outcome.report;
    const who = report.subject.name ?? `${report.subject.address.slice(0, 6)}…${report.subject.address.slice(-4)}`;
    const block = Number(report.reading.block).toLocaleString('en-US');
    const available = report.headline.availableCents;
    const amount = available === null ? null : `${report.headline.complete ? '' : 'at least '}${formatCents(available)}`;
    return {
      status: 200,
      meta: {
        ...base,
        title: amount ? `${who}: ${amount} modelled borrowing room · Still` : `${who} · Still`,
        description: `Read from Base at block ${block}. Still models what a wallet could borrow against its tokenized stocks and crypto without selling them; a live loan needs a fresh review and the wallet's own signature.`,
        image: {
          width: 1200,
          height: 630,
          alt: amount ? `${who}: ${amount} modelled borrowing room on Still, read from Base at block ${block}.` : `${who} on Still.`,
        },
      },
    };
  }
  return {
    status: 200,
    meta: {
      ...base,
      title: `${input.subject} · Still`,
      description: 'What this Base wallet could borrow against its tokenized stocks and crypto without selling them, read from Base.',
    },
  };
}

stillPagesRouter.get('/w/:subject', async (req: Request, res: Response) => {
  let html: string;
  try {
    html = await indexHtmlV1();
  } catch (error) {
    // nginx serves the static document on a 5xx: the page still opens.
    logger.warn('Still page template unavailable', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(503).json({ outcome: 'template_unavailable' });
    return;
  }
  const canonical = stockPagesRuntime.origin();
  const origin = stillOriginForHostV1(req.headers.host, canonical);
  const subject = subjectOfV1(String(req.params.subject ?? ''));
  if (!subject) {
    const { status, meta } = stillWalletMetaV1({ origin, canonical, subject: '', outcome: { outcome: 'invalid_subject', input: '', reason: 'not_an_address_or_name' } });
    sendDocumentV1(res, status, renderStockPageHtmlV1(html, meta));
    return;
  }
  const allowed = await publicStillRuntimeV1.limiter.consume(`public-still:${req.ip || req.socket.remoteAddress || 'unknown'}`);
  let outcome: MirrorOutcome | null = null;
  if (allowed.success) {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), stillPagesRuntimeV1.headBudgetMs);
    });
    outcome = await Promise.race([publicStillRuntimeV1.service().check(subject).catch(() => null), late]);
    clearTimeout(timer);
  }
  const { status, meta } = stillWalletMetaV1({ origin, canonical, subject, outcome });
  sendDocumentV1(res, status, renderStockPageHtmlV1(html, meta));
});

/** A shared loan's head: what its signed link says. */
export function stillLoanShareMetaV1(input: { origin: string; canonical: string; token: string; loan: StillLoanShareV1 }): { status: number; meta: StockPageMetaV1 } {
  const words = stillSpendShareWordsV1({ priceAtomic: input.loan.borrowedAtomic, collateral: input.loan.collateral, venue: input.loan.venue });
  const path = `/spend/p/${input.token}`;
  const card = (shape: 'wide' | 'tall') =>
    `${input.origin}/api/public/still/spend-card.png?t=${encodeURIComponent(input.token)}${shape === 'tall' ? '&shape=tall' : ''}`;
  const kept = words.collateralKind === 'stock' ? 'stock' : words.collateralLabel === 'PAXG' ? 'gold' : 'coin';
  return {
    status: 200,
    meta: {
      canonicalUrl: `${input.origin}${path}`,
      imageUrl: card('wide'),
      noindex: true,
      siteName: 'Still',
      miniApp: { imageUrl: card('tall'), buttonTitle: 'Open on Still', url: `${input.canonical}${path}` },
      title: `Spent without selling: ${words.priceWords} · Still`,
      description: `${words.priceWords[0]!.toUpperCase()}${words.priceWords.slice(1)} borrowed against ${words.collateralLabel} through ${words.venueName} on Base. Nothing was sold: the ${kept} is the loan’s collateral.`,
      image: {
        width: 1200,
        height: 630,
        alt: `A loan of ${words.priceWords} against ${words.collateralLabel} through ${words.venueName}, on Still: nothing sold.`,
      },
    },
  };
}

/** A shared purchase's head: what the signed link says, or Still's own head and a 404. */
export function stillSpendShareMetaV1(input: { origin: string; canonical: string; token: string; share: StillSpendShareV1 | null }): { status: number; meta: StockPageMetaV1 } {
  if (!input.share) {
    return {
      status: 404,
      meta: {
        canonicalUrl: null,
        imageUrl: `${input.origin}/og-still.png`,
        noindex: true,
        siteName: 'Still',
        miniApp: { imageUrl: `${input.origin}/og-still-3x2.png`, buttonTitle: 'Open Still', url: `${input.canonical}/spend` },
        title: 'Spend · Still',
        description: 'This purchase card could not be verified. Still Spend shows what a loan against tokenized stocks and crypto on Base could pay for, without selling them.',
      },
    };
  }
  const share = input.share;
  const words = stillSpendShareWordsV1(share);
  const path = `/spend/p/${input.token}`;
  const card = (shape: 'wide' | 'tall') =>
    `${input.origin}/api/public/still/spend-card.png?t=${encodeURIComponent(input.token)}${shape === 'tall' ? '&shape=tall' : ''}`;
  return {
    status: 200,
    meta: {
      canonicalUrl: `${input.origin}${path}`,
      imageUrl: card('wide'),
      noindex: true,
      siteName: 'Still',
      miniApp: { imageUrl: card('tall'), buttonTitle: 'Open on Still', url: `${input.canonical}${path}` },
      title: `Paid with a loan: ${share.productName} · Still`,
      description: `${share.packageLabel} for ${words.priceWords}, borrowed against ${words.collateralLabel} through ${words.venueName} and paid to Bitrefill with that loan on Base. Nothing was sold.`,
      image: {
        width: 1200,
        height: 630,
        alt: `Paid for ${share.productName} (${share.packageLabel}, ${words.priceWords}) with a loan against ${words.collateralLabel} through ${words.venueName}, on Still.`,
      },
    },
  };
}

stillPagesRouter.get('/spend/p/:token', async (req: Request, res: Response) => {
  let html: string;
  try {
    html = await indexHtmlV1();
  } catch (error) {
    logger.warn('Still page template unavailable', { errorName: error instanceof Error ? error.name : typeof error });
    res.status(503).json({ outcome: 'template_unavailable' });
    return;
  }
  const canonical = stockPagesRuntime.origin();
  const token = String(req.params.token ?? '');
  const share = verifyStillSpendShareV1(token, publicStillRuntimeV1.secret());
  const loan = share ? null : verifyStillLoanShareV1(token, publicStillRuntimeV1.secret());
  const origin = stillOriginForHostV1(req.headers.host, canonical);
  const { status, meta } = loan ? stillLoanShareMetaV1({ origin, canonical, token, loan }) : stillSpendShareMetaV1({ origin, canonical, token, share });
  sendDocumentV1(res, status, renderStockPageHtmlV1(html, meta));
});
