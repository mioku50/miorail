import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { client } from '@mioagent/db';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';
import { createDatabaseReopenGameRepositoryV1, type ReopenGameRepositoryV1 } from '@mioagent/route-storage';
import { ISSUER_BY_REVIEWED_SOURCE_KIND_V1 } from '@mioagent/rwa-market-reality';
import {
  REOPEN_LINEUP_V1,
  ReopenPickRequestV1Schema,
  type ReopenGameResponseV1,
} from '@mioagent/rwa-market-reality/reopen-game';
import { weekendSlotStartV1, type WeekendMarketStockInputV1 } from '@mioagent/rwa-market-reality/weekend-market';

import { tenantUserFromRequest } from '../middleware/tenantAuth';
import { sessionWalletV1 } from '../lib/sessionWallet';
import {
  reopenGameForV1,
  reopenSharedStateV1,
  type ReopenGameDepsV1,
  type ReopenPlayerRefV1,
  type ReopenSharedStateV1,
} from '../lib/reopenGameRead';
import { databaseWeekendRunsV1 } from '../lib/weekendMarketRead';
import { createPublicReadCacheV1, publicStocksCachesV1, publicStocksRuntime } from './publicStocks';
import { rwaMarketRealityRuntime } from './rwaMarketReality';

// ---------------------------------------------------------------------------
// Call the reopen, over HTTP.
//
// Public, because the game is played without a wallet: a device that picks for
// the first time is handed a random token, keeps it, and sends it back in a
// header; only the token's SHA-256 is stored. A signed-in reader plays as their
// wallet, and `POST /api/reopen/claim` moves a device's picks over to it.
//
// Nothing here moves money or touches a wallet. The worst a forged request can
// do is make picks for a device it already holds the token of.
// ---------------------------------------------------------------------------

/** The header a device sends its token in. */
export const REOPEN_DEVICE_HEADER_V1 = 'x-miorail-reopen-device';
const DEVICE_TOKEN_V1 = /^[A-Za-z0-9_-]{43}$/;

export const reopenGameRuntime = {
  repository: (): ReopenGameRepositoryV1 => createDatabaseReopenGameRepositoryV1(client as never),
  /** Coinbase's lineup stocks with their stored runs: one issuer, because a
   * symbol is not an identifier. */
  stocks: async (since: Date, until: Date): Promise<WeekendMarketStockInputV1[]> => {
    const rows = await databaseWeekendRunsV1(since, until);
    const byToken = new Map<string, typeof rows>();
    for (const row of rows) byToken.set(row.token, [...(byToken.get(row.token) ?? []), row]);
    const stocks: WeekendMarketStockInputV1[] = [];
    for (const [token, runs] of byToken) {
      const found = await rwaMarketRealityRuntime.underlyings().underlyingOf({ chainId: 8453, tokenAddress: token });
      if (!found) continue;
      const issuer = found.binding.issuerId ?? ISSUER_BY_REVIEWED_SOURCE_KIND_V1[found.binding.sourceKind];
      const symbol = found.underlying.displaySymbol ?? found.underlying.canonicalName;
      if (issuer !== 'coinbase' || !(REOPEN_LINEUP_V1 as readonly string[]).includes(symbol)) continue;
      stocks.push({
        tokenAddress: token,
        symbol,
        name: found.underlying.canonicalName,
        runs: runs.map(({ at, mid, reference, referenceUpdatedAt }) => ({ at, mid, reference, referenceUpdatedAt })),
      });
    }
    return stocks;
  },
  /** The weekend card through the same five-minute cache its own route uses. */
  weekend: (now: Date) => {
    const slot = weekendSlotStartV1(now);
    return publicStocksCachesV1.weekend.read(`weekend|${slot.getTime()}`, () => publicStocksRuntime.readWeekend(slot));
  },
  storageAvailable: (): Promise<boolean> => publicStocksRuntime.storageAvailable(),
  enabled: (env: NodeJS.ProcessEnv): boolean => publicStocksRuntime.enabled(env),
  now: () => new Date(),
  newDeviceToken: (): string => randomBytes(32).toString('base64url'),
};

/** The round as everyone sees it, once per thirty seconds: the first reader in
 * a slot is the one who brings the round up to date. */
export const reopenGameCachesV1 = {
  shared: createPublicReadCacheV1({ ttlMs: 30_000, max: 4 }),
};

function depsV1(): ReopenGameDepsV1 {
  return {
    repository: reopenGameRuntime.repository(),
    stocks: reopenGameRuntime.stocks,
    weekend: reopenGameRuntime.weekend,
  };
}

function sharedStateV1(now: Date): Promise<ReopenSharedStateV1> {
  const slot = Math.floor(now.getTime() / 30_000);
  return reopenGameCachesV1.shared.read(`reopen|${slot}`, () => reopenSharedStateV1(now, depsV1()));
}

const readLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 90 });
const pickLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 20 });
/** New devices per address per hour: enough for a household, not for a farm. */
const deviceLimiter = new InMemoryRateLimiter({ windowMs: 60 * 60_000, max: 6 });
const claimLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 10 });

function refuse(res: Response, status: number, code: string): void {
  res.status(status).json({ error: code, code });
}

function sendPrivate(res: Response, body: unknown): void {
  // The answer carries the reader's own picks: never shared by a cache.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.status(200).json(body);
}

function ipOf(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/** A wallet a real sign-in proved, or null. Never the development user. */
function signedWalletV1(req: Request): string | null {
  const user = tenantUserFromRequest(req);
  const wallet = typeof user?.address === 'string' ? user.address.toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || user?.id !== `eip155:8453:${wallet}` || /^0x0{40}$/.test(wallet)) {
    return null;
  }
  return wallet;
}

function deviceHashOfV1(req: Request): string | null {
  const token = req.get(REOPEN_DEVICE_HEADER_V1);
  return token && DEVICE_TOKEN_V1.test(token) ? createHash('sha256').update(token).digest('hex') : null;
}

async function playerOfV1(req: Request, repository: ReopenGameRepositoryV1): Promise<ReopenPlayerRefV1 | null> {
  const wallet = signedWalletV1(req);
  if (wallet) return { playerId: `w:${wallet}`, signed: true };
  const hash = deviceHashOfV1(req);
  const playerId = hash ? await repository.devicePlayer(hash) : null;
  return playerId ? { playerId, signed: false } : null;
}

function failed(res: Response, read: string, error: unknown): void {
  logger.warn('Reopen game request failed', {
    read,
    errorName: error instanceof Error ? error.name : typeof error,
  });
  refuse(res, 500, 'reopen_game_failed');
}

export const reopenGameRouter = Router();

reopenGameRouter.use(async (req: Request, res: Response, next) => {
  if (!reopenGameRuntime.enabled(process.env)) {
    refuse(res, 404, 'route_intelligence_disabled');
    return;
  }
  const limiter = req.method === 'POST' ? pickLimiter : readLimiter;
  const allowed = await limiter.consume(`reopen:${ipOf(req)}`);
  if (!allowed.success) {
    refuse(res, 429, 'rate_limited');
    return;
  }
  next();
});

reopenGameRouter.get('/', async (req: Request, res: Response) => {
  try {
    if (!(await reopenGameRuntime.storageAvailable())) {
      refuse(res, 503, 'market_reality_storage_unavailable');
      return;
    }
    const now = reopenGameRuntime.now();
    const repository = reopenGameRuntime.repository();
    const [shared, player] = await Promise.all([sharedStateV1(now), playerOfV1(req, repository)]);
    sendPrivate(res, await reopenGameForV1({ shared, player, now, repository }));
  } catch (error) {
    failed(res, 'read', error);
  }
});

/**
 * Picks for the open round. The whole set is sent each time and replaces the
 * last one; the repository refuses it once the round has locked, in the same
 * statement that would write it.
 */
reopenGameRouter.post('/picks', async (req: Request, res: Response) => {
  const parsed = ReopenPickRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    refuse(res, 400, 'invalid_picks');
    return;
  }
  try {
    if (!(await reopenGameRuntime.storageAvailable())) {
      refuse(res, 503, 'market_reality_storage_unavailable');
      return;
    }
    const now = reopenGameRuntime.now();
    const repository = reopenGameRuntime.repository();
    const shared = await sharedStateV1(now);
    const round = shared.round;
    if (!round || round.roundId !== parsed.data.roundId) {
      refuse(res, 409, 'round_not_open');
      return;
    }
    if (round.state !== 'open' || now.getTime() >= Date.parse(round.locksAt)) {
      refuse(res, 409, 'round_locked');
      return;
    }
    const symbols = new Set(round.stocks.map((stock) => stock.symbol));
    if (Object.keys(parsed.data.picks).some((symbol) => !symbols.has(symbol))) {
      refuse(res, 400, 'unknown_stock');
      return;
    }

    let player = await playerOfV1(req, repository);
    let device: string | null = null;
    if (player?.signed) {
      await repository.walletPlayer({ wallet: player.playerId.slice(2), now });
    } else if (!player) {
      const allowed = await deviceLimiter.consume(`reopen-device:${ipOf(req)}`);
      if (!allowed.success) {
        refuse(res, 429, 'rate_limited');
        return;
      }
      device = reopenGameRuntime.newDeviceToken();
      const playerId = await repository.createDevicePlayer({
        tokenHash: createHash('sha256').update(device).digest('hex'),
        now,
      });
      player = { playerId, signed: false };
    }

    const saved = await repository.savePicks({
      roundId: round.roundId,
      playerId: player.playerId,
      picks: parsed.data.picks as Record<string, 'up' | 'down'>,
      now,
    });
    if (saved === 'locked') {
      refuse(res, 409, 'round_locked');
      return;
    }
    if (saved === 'unknown_round') {
      refuse(res, 409, 'round_not_open');
      return;
    }
    const game: ReopenGameResponseV1 = await reopenGameForV1({ shared, player, now, repository });
    sendPrivate(res, { game, device });
  } catch (error) {
    failed(res, 'picks', error);
  }
});

/** Behind the session: a device's picks become the signed-in wallet's. */
export const reopenClaimRouter = Router();

reopenClaimRouter.post('/claim', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  const allowed = await claimLimiter.consume(`reopen-claim:${wallet}`);
  if (!allowed.success) {
    refuse(res, 429, 'rate_limited');
    return;
  }
  const hash = deviceHashOfV1(req);
  if (!hash) {
    refuse(res, 400, 'device_token_required');
    return;
  }
  try {
    const repository = reopenGameRuntime.repository();
    const now = reopenGameRuntime.now();
    await repository.walletPlayer({ wallet, now });
    const merged = await repository.mergeDevice({ tokenHash: hash, wallet, now });
    sendPrivate(res, merged ? { merged: true, ...merged } : { merged: false, moved: 0, dropped: 0 });
  } catch (error) {
    failed(res, 'claim', error);
  }
});
