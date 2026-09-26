import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import { CASH_EXIT_DEFAULT_USDC_SIZES_ATOMIC_V1 } from '@mioagent/route-storage';
import { assembleCashExitLadderV1 } from '@mioagent/rwa-cash-exit';
import { companyDisplayNameV1 } from '@mioagent/rwa-market-reality';
import { weekendStampInstantV1, type WeekendMarketResponseV1 } from '@mioagent/rwa-market-reality/weekend-market';
import { logger } from '@mioagent/utils';

import { renderCardPngV1 } from '../lib/cardImage.js';
import { WEEKEND_CARD_HEIGHT_V1, WEEKEND_CARD_WIDTH_V1, weekendCardSvgV1, weekendCardV1 } from '../lib/weekendCard.js';
import { createPublicReadCacheV1, publicStocksCachesV1, publicStocksRuntime } from './publicStocks.js';
import { readMarketRealityIndexV1, rwaMarketRealityRuntime } from './rwaMarketReality.js';

// ---------------------------------------------------------------------------
// One address per stock, with a preview a link can carry.
//
// The web app is a single-page bundle: every path gets the same index.html and
// the page is drawn in the browser. A person gets the right screen that way. A
// link preview does not — X, Telegram and every other unfurler read the HTML
// they were sent and run no script, so a shared `/market?key=…` previewed as
// the word "Miorail" and nothing else. The one measurement nobody else
// publishes never left the page it was measured on.
//
// So `/stocks/<ticker>` comes here first. This serves the SAME index.html the
// static server would, with the head rewritten for that stock: a title a search
// finds, and a description that carries the last measured round trip WITH ITS
// AGE. The browser then boots the ordinary app, which reads the board through
// the public stocks router. If anything here fails, nginx falls back to the
// plain index.html, so this can make a preview better and never make a page
// worse.
//
// Nothing here reaches the chain: the chooser is a stored corpus, and the
// round trip is the stored public ladder run the board itself reads.
// ---------------------------------------------------------------------------

export const stockPagesRouter = Router();

/** The size a preview quotes. The middle rung: the one most readers mean. */
const PREVIEW_SIZE_ATOMIC_V1 = '1000000000';
/** Past this, a round trip is history, and a preview is no place for history. */
const PREVIEW_MAX_AGE_MS_V1 = 3 * 24 * 60 * 60 * 1000;

const SYMBOL_PATTERN_V1 = /^[A-Za-z0-9][A-Za-z0-9.-]{0,15}$/;

/**
 * Two stored reads per page view, held for a minute.
 *
 * A link posted in a busy channel is unfurled by every client that sees it, and
 * the ladder under the preview moves on the background sampler's clock, not
 * per request. Only reviewed securities reach this cache: an unknown ticker is
 * answered before it.
 */
const previewRoundTripCacheV1 = createPublicReadCacheV1({ ttlMs: 60_000, max: 64 });

/**
 * A shared weekend link, read and drawn once per slot it names.
 *
 * X, Telegram and Farcaster each unfurl a posted link, some of them several
 * times, and a slot's answer does not change, so a read and a picture are
 * held. A slot is five minutes, so the links that can exist are bounded too.
 */
const weekendShareCacheV1 = createPublicReadCacheV1({ ttlMs: 10 * 60_000, max: 16 });
const weekendImageCacheV1 = createPublicReadCacheV1({ ttlMs: 60 * 60_000, max: 8 });

/** A weekend link older than this is history: it previews as the board. */
const WEEKEND_SHARE_MAX_AGE_MS_V1 = 10 * 24 * 60 * 60 * 1000;

/** Testing seam. */
export function resetStockPagesPreviewCacheV1(): void {
  previewRoundTripCacheV1.clear();
  weekendShareCacheV1.clear();
  weekendImageCacheV1.clear();
}

export type StockPageEntryV1 = {
  symbol: string;
  /** The company as a reader writes it, or null when only the ticker is known. */
  companyName: string | null;
  underlyingKey: string;
  coinbaseIssued: boolean;
};

export type StockPageRoundTripV1 = { roundTripCostBps: string; observedAt: string };

/** A testing seam; production never replaces any of it. */
export const stockPagesRuntime = {
  enabled: (env: NodeJS.ProcessEnv): boolean => rwaMarketRealityRuntime.enabled(env),
  indexHtmlPath: (): string =>
    (process.env.MIORAIL_WEB_INDEX_HTML ?? '').trim() || '/var/www/miorail/index.html',
  origin: (): string =>
    (process.env.MIORAIL_PUBLIC_ORIGIN ?? 'https://miorail.xyz').trim().replace(/\/+$/, ''),
  stat: (path: string) => fs.stat(path),
  readFile: (path: string) => fs.readFile(path, 'utf8'),
  /** Every reviewed equity, Coinbase-issued or not, from the cached chooser. */
  stocks: async (): Promise<StockPageEntryV1[]> => {
    const index = await publicStocksCachesV1.index.read('all_representations|500', () =>
      readMarketRealityIndexV1({ limit: 500, scope: 'all_representations' }),
    );
    return index.entries
      .filter((entry) => entry.assetClass === 'equity' && entry.displaySymbol)
      .map((entry) => ({
        symbol: entry.displaySymbol!,
        companyName: companyDisplayNameV1(entry),
        underlyingKey: entry.underlyingKey,
        coinbaseIssued: entry.coinbaseIssued,
      }));
  },
  /**
   * The last completed public round trip at the preview size, for the Coinbase
   * representation, or null. The open quote first and the last completed
   * measurement second, exactly as the board's exit line reads them — never a
   * derived rung, whose number belongs to a smaller size.
   */
  roundTrip: async (underlyingKey: string): Promise<StockPageRoundTripV1 | null> => {
    const bindings = await rwaMarketRealityRuntime
      .underlyings()
      .representationsOf({ chainId: 8453, underlyingKey });
    const coinbase = bindings.find((row) => row.issuerId === 'coinbase');
    if (!coinbase) return null;
    const run = await rwaMarketRealityRuntime.cashExit().latestCompletedRun({
      chainId: 8453,
      tokenAddress: coinbase.tokenAddress,
      scope: 'public_ladder',
      containingAllRequestedCashAtomic: CASH_EXIT_DEFAULT_USDC_SIZES_ATOMIC_V1,
    });
    if (!run) return null;
    const ladder = assembleCashExitLadderV1({ publicRun: run, now: rwaMarketRealityRuntime.now() });
    const rung = ladder.rungs.find(
      (row) =>
        row.sizeKind === 'cash_equivalent' &&
        row.destination === 'USDC' &&
        row.requestedCashAtomic === PREVIEW_SIZE_ATOMIC_V1,
    );
    if (!rung) return null;
    if (rung.status === 'full' && rung.roundTripCostBps !== null && rung.observedAt) {
      return { roundTripCostBps: rung.roundTripCostBps, observedAt: rung.observedAt };
    }
    const last = rung.lastMeasured ?? null;
    if (last && last.status === 'full' && last.roundTripCostBps !== null) {
      return { roundTripCostBps: last.roundTripCostBps, observedAt: last.observedAt };
    }
    return null;
  },
  /** The weekend board at one slot's start: the read the board itself makes. */
  weekend: (at: Date): Promise<WeekendMarketResponseV1> => publicStocksRuntime.readWeekend(at),
  renderPng: (svg: string): Promise<Uint8Array> => renderCardPngV1(svg),
  now: (): Date => new Date(),
};

// ---------------------------------------------------------------------------
// The template.
// ---------------------------------------------------------------------------

let templateV1: { path: string; mtimeMs: number; html: string } | null = null;

/** Re-read whenever the deploy replaced the file, and not otherwise. Shared
 * with the gift pages, which serve the same document under their own head. */
export async function indexHtmlV1(): Promise<string> {
  const path = stockPagesRuntime.indexHtmlPath();
  const stat = await stockPagesRuntime.stat(path);
  if (templateV1 && templateV1.path === path && templateV1.mtimeMs === stat.mtimeMs) {
    return templateV1.html;
  }
  const html = await stockPagesRuntime.readFile(path);
  if (!/<\/head>/i.test(html)) throw new Error('index_html_has_no_head');
  templateV1 = { path, mtimeMs: stat.mtimeMs, html };
  return html;
}

/** Testing seam. */
export function resetStockPagesTemplateV1(): void {
  templateV1 = null;
}

export function escapeHtmlV1(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type StockPageMetaV1 = {
  title: string;
  description: string;
  /** Absolute. Omitted for a page that must not be indexed. */
  canonicalUrl: string | null;
  imageUrl: string;
  /** Said when the image is drawn from data: its size and what it shows. */
  image?: { width: number; height: number; alt: string };
  noindex: boolean;
};

/**
 * The same document with a different head.
 *
 * The existing title and description are REPLACED, not joined by a second
 * pair: an unfurler that meets two descriptions picks one, and which one is
 * not ours to guess.
 */
export function renderStockPageHtmlV1(template: string, meta: StockPageMetaV1): string {
  const tags = [
    `<meta name="description" content="${escapeHtmlV1(meta.description)}" />`,
    meta.noindex ? '<meta name="robots" content="noindex" />' : null,
    meta.canonicalUrl ? `<link rel="canonical" href="${escapeHtmlV1(meta.canonicalUrl)}" />` : null,
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Miorail" />',
    `<meta property="og:title" content="${escapeHtmlV1(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtmlV1(meta.description)}" />`,
    meta.canonicalUrl ? `<meta property="og:url" content="${escapeHtmlV1(meta.canonicalUrl)}" />` : null,
    `<meta property="og:image" content="${escapeHtmlV1(meta.imageUrl)}" />`,
    meta.image ? `<meta property="og:image:width" content="${meta.image.width}" />` : null,
    meta.image ? `<meta property="og:image:height" content="${meta.image.height}" />` : null,
    meta.image ? `<meta property="og:image:alt" content="${escapeHtmlV1(meta.image.alt)}" />` : null,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeHtmlV1(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtmlV1(meta.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtmlV1(meta.imageUrl)}" />`,
    meta.image ? `<meta name="twitter:image:alt" content="${escapeHtmlV1(meta.image.alt)}" />` : null,
  ].filter((tag): tag is string => tag !== null);
  return template
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtmlV1(meta.title)}</title>`)
    .replace(/<meta\s+name=["']description["'][^>]*>\s*/gi, '')
    .replace(/<\/head>/i, `    ${tags.join('\n    ')}\n  </head>`);
}

/** "0.11%" from basis points, as the board prints a round trip. */
function percentFromBpsV1(bps: string): string {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

/** "measured 2 h ago" — the clock travels with the number, always. */
function measuredAgoV1(observedAt: string, now: Date): string | null {
  const age = now.getTime() - Date.parse(observedAt);
  if (!Number.isFinite(age) || age < 0 || age > PREVIEW_MAX_AGE_MS_V1) return null;
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return 'measured just now';
  if (minutes < 60) return `measured ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `measured ${hours} h ago`;
  return `measured ${Math.floor(hours / 24)} days ago`;
}

export function stockPageMetaV1(input: {
  origin: string;
  entry: StockPageEntryV1;
  roundTrip: StockPageRoundTripV1 | null;
  now: Date;
}): StockPageMetaV1 {
  const symbol = input.entry.symbol.toUpperCase();
  const named = input.entry.companyName ? `${input.entry.companyName} (${symbol})` : symbol;
  const age = input.roundTrip ? measuredAgoV1(input.roundTrip.observedAt, input.now) : null;
  // A number goes out only with its age. A preview is read long after it was
  // rendered, so a round trip with no clock would be a stale quote dressed as
  // a current one — the exact failure this product exists to prevent.
  const measured =
    input.roundTrip && age
      ? ` Round trip at $1,000: ${percentFromBpsV1(input.roundTrip.roundTripCostBps)}, ${age}.`
      : '';
  return {
    title: `${named} on Base · Miorail`,
    description: `${named} as a tokenized stock on Base: the price against the real share, what it costs to get back out, and which contract is official.${measured} No wallet needed to look.`,
    canonicalUrl: `${input.origin}/stocks/${symbol.toLowerCase()}`,
    imageUrl: `${input.origin}/og-stocks.png`,
    noindex: false,
  };
}

function listMetaV1(origin: string): StockPageMetaV1 {
  return {
    title: 'Tokenized stocks on Base, measured · Miorail',
    description:
      'Every Coinbase tokenized stock on Base: what it costs to get in and back out at $100 to $100k, the price against the real share, and which contract is official. No wallet needed to look.',
    canonicalUrl: `${origin}/stocks`,
    imageUrl: `${origin}/og-stocks.png`,
    noindex: false,
  };
}

function notFoundMetaV1(origin: string): StockPageMetaV1 {
  return {
    title: 'No reviewed stock under that ticker · Miorail',
    description:
      'Miorail has no reviewed tokenized stock under that ticker. That is a statement about Miorail’s corpus, not about what exists on Base.',
    canonicalUrl: null,
    imageUrl: `${origin}/og-stocks.png`,
    noindex: true,
  };
}

/**
 * A shared weekend post's page: the board, under a head that shows the slot
 * the post was written from. Kept out of search: it is one five-minute answer
 * among many, and the board is the page that lasts.
 */
export function weekendShareMetaV1(input: {
  origin: string;
  stamp: string;
  response: WeekendMarketResponseV1;
}): StockPageMetaV1 | null {
  const card = weekendCardV1(input.response);
  if (!card) return null;
  return {
    title: `${card.title}, as of ${card.asOf} · Miorail`,
    description: card.description,
    canonicalUrl: `${input.origin}/stocks?weekend=${input.stamp}`,
    imageUrl: `${input.origin}/stocks/weekend/${input.stamp}.png`,
    image: { width: WEEKEND_CARD_WIDTH_V1, height: WEEKEND_CARD_HEIGHT_V1, alt: card.alt },
    noindex: true,
  };
}

/**
 * The weekend a link names, or null when it names none: not a slot, a slot
 * still to come, one older than the links this answers, or one with nothing
 * measured to draw. The stamp is the only thing read from the request, and it
 * picks a time, never a number.
 */
async function weekendShareV1(stamp: string): Promise<WeekendMarketResponseV1 | null> {
  const at = weekendStampInstantV1(stamp);
  if (!at) return null;
  const age = stockPagesRuntime.now().getTime() - at.getTime();
  if (age < 0 || age > WEEKEND_SHARE_MAX_AGE_MS_V1) return null;
  if (!stockPagesRuntime.enabled(process.env)) return null;
  const response = await weekendShareCacheV1.read(stamp, () => stockPagesRuntime.weekend(at));
  return weekendCardV1(response) ? response : null;
}

/**
 * The headers nginx sends with index.html, and not the API's.
 *
 * Helmet's defaults suit JSON, not this document: its CSP would block the
 * wallet connectors and the font host the page loads, which the static copy of
 * the same file has never been subject to. Same bytes, same rules.
 */
export function sendDocumentV1(res: Response, status: number, html: string): void {
  res.removeHeader('Content-Security-Policy');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(status).type('html').send(html);
}

/** The template is the one thing this cannot do without; say so with a 503 so
 * nginx serves the static index.html instead. */
function unavailableV1(res: Response, error: unknown): void {
  logger.warn('Stock page could not be rendered', {
    errorName: error instanceof Error ? error.name : typeof error,
  });
  res.status(503).type('text/plain').send('stock page unavailable');
}

stockPagesRouter.get('/stocks', async (req: Request, res: Response) => {
  let html: string;
  try {
    html = await indexHtmlV1();
  } catch (error) {
    unavailableV1(res, error);
    return;
  }
  const origin = stockPagesRuntime.origin();
  // A shared weekend post names its slot. Whatever else the query holds is the
  // app's business, and a link that names no slot previews as the board.
  const stamp = typeof req.query.weekend === 'string' ? req.query.weekend : null;
  if (stamp !== null) {
    try {
      const response = await weekendShareV1(stamp);
      const meta = response ? weekendShareMetaV1({ origin, stamp, response }) : null;
      if (meta) {
        sendDocumentV1(res, 200, renderStockPageHtmlV1(html, meta));
        return;
      }
    } catch (error) {
      logger.warn('Weekend share could not be read', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  sendDocumentV1(res, 200, renderStockPageHtmlV1(html, listMetaV1(origin)));
});

/**
 * The picture a shared weekend post previews as.
 *
 * Its address names the slot, so what it shows never changes, and it may be
 * held a day. A name that is not a slot with something to draw is a 404. A
 * slot that cannot be read or drawn right now answers with the board's own
 * picture rather than none: a feed keeps the first picture it gets.
 */
stockPagesRouter.get('/stocks/weekend/:file', async (req: Request, res: Response) => {
  const stamp = /^(\d{8}T\d{4}Z)\.png$/.exec(String(req.params.file ?? ''))?.[1] ?? null;
  const fallback = `${stockPagesRuntime.origin()}/og-stocks.png`;
  let response: WeekendMarketResponseV1 | null;
  try {
    response = stamp ? await weekendShareV1(stamp) : null;
  } catch (error) {
    logger.warn('Weekend card could not be read', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    res.redirect(302, fallback);
    return;
  }
  const card = response ? weekendCardV1(response) : null;
  if (!stamp || !card) {
    res.status(404).type('text/plain').send('no weekend card for that time');
    return;
  }
  try {
    const png = await weekendImageCacheV1.read(stamp, async () =>
      Buffer.from(await stockPagesRuntime.renderPng(weekendCardSvgV1(card))),
    );
    // Shown by whoever unfurls the link, from their own page: helmet's
    // same-origin resource policy would stop one that shows it directly.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).type('png').send(png);
  } catch (error) {
    logger.warn('Weekend card could not be drawn', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    res.redirect(302, fallback);
  }
});

stockPagesRouter.get('/stocks/:symbol', async (req: Request, res: Response) => {
  let html: string;
  try {
    html = await indexHtmlV1();
  } catch (error) {
    unavailableV1(res, error);
    return;
  }
  const origin = stockPagesRuntime.origin();
  const symbol = String(req.params.symbol ?? '');
  if (!SYMBOL_PATTERN_V1.test(symbol)) {
    sendDocumentV1(res, 404, renderStockPageHtmlV1(html, notFoundMetaV1(origin)));
    return;
  }
  // Everything past the template is an improvement to the preview, never a
  // precondition for the page: a corpus that will not answer still serves the
  // app, under the generic head, with the status that head implies.
  try {
    if (!stockPagesRuntime.enabled(process.env)) {
      sendDocumentV1(res, 200, renderStockPageHtmlV1(html, listMetaV1(origin)));
      return;
    }
    const stocks = await stockPagesRuntime.stocks();
    const matches = stocks.filter((row) => row.symbol.toLowerCase() === symbol.toLowerCase());
    // One ticker, one security, in practice. Should two ever share it, the
    // Coinbase-issued one is the one this page opens on — the same default the
    // board itself opens with.
    const entry = matches.find((row) => row.coinbaseIssued) ?? matches[0] ?? null;
    if (!entry) {
      sendDocumentV1(res, 404, renderStockPageHtmlV1(html, notFoundMetaV1(origin)));
      return;
    }
    let roundTrip: StockPageRoundTripV1 | null = null;
    try {
      roundTrip = await previewRoundTripCacheV1.read(entry.underlyingKey, () =>
        stockPagesRuntime.roundTrip(entry.underlyingKey),
      );
    } catch {
      // No number is a preview without a number, not a failed page.
      roundTrip = null;
    }
    sendDocumentV1(
      res,
      200,
      renderStockPageHtmlV1(
        html,
        stockPageMetaV1({ origin, entry, roundTrip, now: stockPagesRuntime.now() }),
      ),
    );
  } catch (error) {
    logger.warn('Stock page preview could not be read', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    sendDocumentV1(res, 200, renderStockPageHtmlV1(html, listMetaV1(origin)));
  }
});

/**
 * Where a search engine finds the pages it cannot discover by clicking.
 *
 * The Coinbase-issued stocks only: those are the pages with a market behind
 * them. The rest stay reachable by link and search, and absent from a list
 * that asks a crawler to spend time on them.
 */
stockPagesRouter.get('/sitemap.xml', async (_req: Request, res: Response) => {
  const origin = stockPagesRuntime.origin();
  const paths = ['/stocks', '/is-it-real'];
  try {
    if (stockPagesRuntime.enabled(process.env)) {
      const stocks = await stockPagesRuntime.stocks();
      const symbols = [
        ...new Set(stocks.filter((row) => row.coinbaseIssued).map((row) => row.symbol.toLowerCase())),
      ].sort();
      paths.splice(1, 0, ...symbols.map((symbol) => `/stocks/${symbol}`));
    }
  } catch (error) {
    // A sitemap with the two fixed pages is still a true one.
    logger.warn('Sitemap could not read the stock corpus', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map((path) => `  <url><loc>${escapeHtmlV1(`${origin}${path}`)}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).type('application/xml').send(body);
});
