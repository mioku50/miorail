import { Router, type Request, type Response } from 'express';
import { CASH_EXIT_DEFAULT_USDC_SIZES_ATOMIC_V1 } from '@mioagent/route-storage';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';
import { weekendSlotStartV1 } from '@mioagent/rwa-market-reality/weekend-market';

import {
  historyWindowFromRequestV1,
  indexQueryFromRequestV1,
  marketRealityChainConfiguredV1,
  questionFromRequestV1,
  readMarketRealityHistoryV1,
  readMarketRealityIndexV1,
  readMarketRealityV1,
  readUseAccessV1,
  rwaMarketRealityRuntime,
} from './rwaMarketReality.js';
import { readOfficialAssetDossierV1, rwaDossierRuntime } from './rwaDossier.js';
import { databaseWeekendRunsV1, readWeekendMarketV1 } from '../lib/weekendMarketRead.js';

// ---------------------------------------------------------------------------
// The Stocks board, readable without a wallet.
//
// Found 2026-09-22 by rendering miorail.xyz with no wallet: the whole page was
// "Continue with your wallet", on the web and in the Base App alike. Every
// Stocks read sat behind the tenant gate — while the public MCP tools answered
// the same questions, from the same assembly, to anybody. The website was
// stricter with people than the API was with bots.
//
// These are the SAME five reads the signed-in board makes, through the same
// functions (`readMarketRealityV1` and friends), mounted before the tenant
// middleware. What the session adds is kept out of here on purpose:
//
//   * no wallet: Use & access runs no wallet checks and says `wallet: null`;
//   * no tenant: the dossier carries the public ladder, never a position run;
//   * no measuring, no watching, no narrator — each spends router calls, a
//     tenant row or a model call, and all three stay behind the session.
//
// What a public door adds is a cost nobody controls, so every read is cached
// per exact question, a failure is never cached, sizes are held to the four
// rungs the background ladder measures, and addresses to the reviewed corpus.
// The questions an anonymous caller can ask are therefore a bounded set, and
// repeating one costs a map lookup.
// ---------------------------------------------------------------------------

export const publicStocksRouter = Router();

/**
 * Keyed by IP, and below the global limit on purpose.
 *
 * One signed-out view reads the chooser, one comparison and up to five ladders,
 * plus five venue readings when Use & access is opened: about a dozen reads.
 * Ninety a minute is several views a minute from one address — more than a
 * reader, far less than a crawl — and it leaves headroom under the global
 * hundred for the same visitor signing in.
 */
function publicStocksLimiterV1() {
  return new InMemoryRateLimiter({ windowMs: 60_000, max: 90 });
}

type CacheEntryV1 = { at: number; value: Promise<unknown> };

/**
 * A short-lived, single-flight cache for one kind of public read.
 *
 * Single-flight because a link shared in a busy channel arrives as a burst:
 * the first request pays and the rest wait on the same promise. A failure is
 * dropped the moment it settles — holding an outage for the whole TTL would
 * turn one bad upstream call into a minute of refusals for everybody.
 */
export function createPublicReadCacheV1(options: { ttlMs: number; max: number; now?: () => number }) {
  const entries = new Map<string, CacheEntryV1>();
  const clock = options.now ?? Date.now;
  return {
    read<T>(key: string, work: () => Promise<T>): Promise<T> {
      const at = clock();
      const cached = entries.get(key);
      if (cached && at - cached.at < options.ttlMs) return cached.value as Promise<T>;
      const value = work();
      entries.set(key, { at, value });
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      // Oldest insertion goes first. The key space is bounded by the reviewed
      // corpus, so this is headroom rather than a policy.
      while (entries.size > options.max) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return value;
    },
    clear(): void {
      entries.clear();
    },
  };
}

/**
 * TTLs, per read, set by how fast the evidence under them moves.
 *
 * The comparison carries a reference-feed read, so it is the one that costs
 * chain calls per request; a minute keeps a burst to one read without letting
 * a stale price sit longer than the background sampler already does. The
 * chooser moves when an issuer publishes an instrument. Venue listings move on
 * governance time.
 */
export const publicStocksCachesV1 = {
  index: createPublicReadCacheV1({ ttlMs: 5 * 60_000, max: 8 }),
  reality: createPublicReadCacheV1({ ttlMs: 60_000, max: 1_024 }),
  history: createPublicReadCacheV1({ ttlMs: 60_000, max: 1_024 }),
  dossier: createPublicReadCacheV1({ ttlMs: 2 * 60_000, max: 256 }),
  useAccess: createPublicReadCacheV1({ ttlMs: 5 * 60_000, max: 256 }),
  // The weekend sampler runs about hourly, so five minutes loses nothing.
  weekend: createPublicReadCacheV1({ ttlMs: 5 * 60_000, max: 4 }),
};

/** A testing seam; production never replaces any of it. */
export const publicStocksRuntime = {
  limiter: publicStocksLimiterV1(),
  enabled: (env: NodeJS.ProcessEnv): boolean => rwaMarketRealityRuntime.enabled(env),
  storageAvailable: (): Promise<boolean> => rwaMarketRealityRuntime.migrationAvailable(),
  dossierStorageAvailable: (): Promise<boolean> => rwaDossierRuntime.migrationAvailable(),
  chainConfigured: marketRealityChainConfiguredV1,
  reviewed: async (tokenAddress: string): Promise<boolean> =>
    (await rwaMarketRealityRuntime.underlyings().underlyingOf({ chainId: 8453, tokenAddress })) !==
    null,
  readIndex: readMarketRealityIndexV1,
  readReality: readMarketRealityV1,
  readHistory: readMarketRealityHistoryV1,
  readDossier: readOfficialAssetDossierV1,
  readUseAccess: readUseAccessV1,
  readWeekend: (now: Date) =>
    readWeekendMarketV1(now, {
      runs: databaseWeekendRunsV1,
      identify: async (tokenAddress: string) => {
        const found = await rwaMarketRealityRuntime.underlyings().underlyingOf({ chainId: 8453, tokenAddress });
        if (!found) return null;
        return {
          symbol: found.underlying.displaySymbol ?? found.underlying.canonicalName,
          name: found.underlying.canonicalName,
        };
      },
    }),
  now: () => new Date(),
};

const PUBLIC_LADDER_SIZES_V1: readonly string[] = CASH_EXIT_DEFAULT_USDC_SIZES_ATOMIC_V1;

function refuse(res: Response, status: number, code: string, detail?: string): void {
  res.status(status).json({ error: code, code, ...(detail ? { detail } : {}) });
}

/**
 * Shared headers for a public read.
 *
 * `noindex` because these are the data behind a page, not the page: a search
 * result that opens raw JSON is worse than no result.
 */
function sendPublic(res: Response, body: unknown): void {
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=30');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.status(200).json(body);
}

/**
 * The failure a reader may see, and the one an operator needs.
 *
 * The response is a stable code and never the upstream message: provider and
 * database errors can carry connection material. The log gets the error's
 * type and nothing it says.
 */
function failed(res: Response, read: string, code: string, error: unknown): void {
  logger.warn('Public stocks read failed', {
    read,
    errorName: error instanceof Error ? error.name : typeof error,
  });
  refuse(res, 500, code);
}

publicStocksRouter.use(async (req: Request, res: Response, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const allowed = await publicStocksRuntime.limiter.consume(`public-stocks:${ip}`);
  res.setHeader('X-RateLimit-Limit', allowed.limit);
  res.setHeader('X-RateLimit-Remaining', allowed.remaining);
  if (!allowed.success) {
    refuse(res, 429, 'rate_limited');
    return;
  }
  // The same switch as the signed-in board. A public door onto a surface the
  // operator turned off would be a way around the switch.
  if (!publicStocksRuntime.enabled(process.env)) {
    refuse(res, 404, 'route_intelligence_disabled');
    return;
  }
  next();
});

/**
 * The weekend on Base: while Wall Street is closed, where the tokens trade
 * against the close at the bell, and once the feed prints again, where it
 * reopened. `state: 'none'` outside a quiet period, so the board can ask at
 * any time and show nothing when there is nothing to show.
 */
publicStocksRouter.get('/weekend', async (_req: Request, res: Response) => {
  try {
    if (!(await publicStocksRuntime.storageAvailable())) {
      refuse(res, 503, 'market_reality_storage_unavailable');
      return;
    }
    // One answer per five-minute slot, computed at the slot's start: a burst of
    // readers is one read, and a link that names the slot gets the same answer.
    const slot = weekendSlotStartV1(publicStocksRuntime.now());
    sendPublic(
      res,
      await publicStocksCachesV1.weekend.read(`weekend|${slot.getTime()}`, () => publicStocksRuntime.readWeekend(slot)),
    );
  } catch (error) {
    failed(res, 'weekend', 'weekend_market_failed', error);
  }
});

publicStocksRouter.get('/underlyings', async (req: Request, res: Response) => {
  const query = indexQueryFromRequestV1(req);
  try {
    if (!(await publicStocksRuntime.storageAvailable())) {
      refuse(res, 503, 'market_reality_storage_unavailable');
      return;
    }
    sendPublic(
      res,
      await publicStocksCachesV1.index.read(`${query.scope ?? 'default'}|${query.limit}`, () =>
        publicStocksRuntime.readIndex(query),
      ),
    );
  } catch (error) {
    failed(res, 'index', 'market_reality_failed', error);
  }
});

/**
 * The exact question, held to the public ladder.
 *
 * The board only ever offers these four sizes, and they are the only ones the
 * background pass measures. Any other size would be a fresh cache key per
 * request — a way to make every call pay the chain reads the cache exists to
 * absorb — for an answer that could only say "not measured".
 */
function publicQuestionV1(req: Request, res: Response) {
  const question = questionFromRequestV1(req);
  if (!question.ok) {
    refuse(res, 400, question.code, question.detail);
    return null;
  }
  if (!PUBLIC_LADDER_SIZES_V1.includes(question.requestedCashAtomic)) {
    refuse(
      res,
      400,
      'size_not_on_public_ladder',
      `Without a session this board answers at the four sizes Miorail measures in the background: ${PUBLIC_LADDER_SIZES_V1.join(', ')} (USDC atomic units).`,
    );
    return null;
  }
  return question;
}

publicStocksRouter.get('/market-reality/:underlyingKey', async (req: Request, res: Response) => {
  const question = publicQuestionV1(req, res);
  if (!question) return;
  try {
    if (!(await publicStocksRuntime.storageAvailable())) {
      refuse(res, 503, 'market_reality_storage_unavailable');
      return;
    }
    const key = [
      question.underlyingKey,
      question.direction,
      question.requestedCashAtomic,
      question.destination,
    ].join('|');
    sendPublic(
      res,
      await publicStocksCachesV1.reality.read(key, () => publicStocksRuntime.readReality(question)),
    );
  } catch (error) {
    failed(res, 'reality', 'market_reality_failed', error);
  }
});

publicStocksRouter.get(
  '/market-reality/:underlyingKey/history',
  async (req: Request, res: Response) => {
    const question = publicQuestionV1(req, res);
    if (!question) return;
    const window = historyWindowFromRequestV1(req);
    if (!window.ok) {
      refuse(res, 400, 'invalid_history_window', window.detail);
      return;
    }
    try {
      if (!(await publicStocksRuntime.storageAvailable())) {
        refuse(res, 503, 'market_reality_storage_unavailable');
        return;
      }
      const key = [
        question.underlyingKey,
        question.direction,
        question.requestedCashAtomic,
        question.destination,
        window.window,
      ].join('|');
      sendPublic(
        res,
        await publicStocksCachesV1.history.read(key, () =>
          publicStocksRuntime.readHistory(question, window.window),
        ),
      );
    } catch (error) {
      failed(res, 'history', 'market_reality_failed', error);
    }
  },
);

publicStocksRouter.get('/official/:tokenAddress/dossier', async (req: Request, res: Response) => {
  const tokenAddress = String(req.params.tokenAddress ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(tokenAddress)) {
    refuse(
      res,
      400,
      'invalid_official_asset_address',
      'An exact Base contract address is required; symbols are display metadata only.',
    );
    return;
  }
  try {
    if (!(await publicStocksRuntime.dossierStorageAvailable())) {
      refuse(res, 503, 'official_asset_dossier_storage_unavailable');
      return;
    }
    // An address outside the reviewed corpus is answered by the dossier itself
    // with a typed `not_in_reviewed_corpus` from two stored lookups, before any
    // chain read — so it is safe to accept, and refusing it here would hide
    // that answer from the only readers who ask it.
    sendPublic(
      res,
      await publicStocksCachesV1.dossier.read(tokenAddress, () =>
        publicStocksRuntime.readDossier({ tokenAddress, tenantId: null }),
      ),
    );
  } catch (error) {
    failed(res, 'dossier', 'official_asset_dossier_failed', error);
  }
});

publicStocksRouter.get('/use-access/:tokenAddress', async (req: Request, res: Response) => {
  const tokenAddress = String(req.params.tokenAddress ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(tokenAddress)) {
    refuse(res, 400, 'exact_address_required');
    return;
  }
  if (!publicStocksRuntime.chainConfigured()) {
    refuse(res, 503, 'market_reality_chain_unavailable');
    return;
  }
  try {
    if (!(await publicStocksRuntime.storageAvailable())) {
      refuse(res, 503, 'market_reality_storage_unavailable');
      return;
    }
    // Reviewed addresses only. This read fans out to chain calls and venue
    // fetches, so an arbitrary address would be a way to aim them.
    if (!(await publicStocksRuntime.reviewed(tokenAddress))) {
      refuse(
        res,
        404,
        'representation_not_reviewed',
        'Miorail holds no reviewed binding for that exact Base address. This is a statement about Miorail’s corpus, never about the token.',
      );
      return;
    }
    sendPublic(
      res,
      await publicStocksCachesV1.useAccess.read(tokenAddress, () =>
        // No wallet, and not as a default: this door has no session to take
        // one from, and a request field is never where a wallet comes from.
        publicStocksRuntime.readUseAccess({ tokenAddress, walletAddress: null }),
      ),
    );
  } catch (error) {
    // Same code as the session route, so both boards read one failure alike.
    logger.warn('Public stocks read failed', {
      read: 'use_access',
      errorName: error instanceof Error ? error.name : typeof error,
    });
    refuse(res, 502, 'use_access_unavailable');
  }
});
