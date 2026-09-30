import { Router, type Request, type Response } from 'express';
import { createB20ReaderV1, type B20ReaderV1 } from '@mioagent/b20-control';
import type { DividendCalendarResponseV1 } from '@mioagent/rwa-market-reality/dividends';
import { logger } from '@mioagent/utils';

import { createDividendWalletCachesV1, readDividendWalletV1 } from '../lib/dividendWalletRead.js';
import { sessionWalletV1 } from '../lib/sessionWallet';
import { createPublicReadCacheV1, dividendCalendarForSlotV1, publicStocksRuntime } from './publicStocks';

// ---------------------------------------------------------------------------
// "When do my stocks pay next, about how much, and how much has already been
// reinvested?" — for the signed-in wallet only, never for an address the
// client names. The calendar is the public one; the balances are this
// wallet's, read from the chain.
// ---------------------------------------------------------------------------

/** A testing seam; production never replaces any of it. */
export const stocksDividendsRuntime = {
  now: (): Date => new Date(),
  storageAvailable: (): Promise<boolean> => publicStocksRuntime.storageAvailable(),
  calendar: (now: Date): Promise<DividendCalendarResponseV1> => dividendCalendarForSlotV1(now),
  reader: (): B20ReaderV1 | null => {
    const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
    return rpcUrl ? createB20ReaderV1({ rpcUrl }) : null;
  },
  caches: createDividendWalletCachesV1(),
};

/** One wallet's answer for half a minute: a burst of reloads reads the chain
 * once, and a purchase shows within the minute. */
export const stocksDividendsCacheV1 = createPublicReadCacheV1({ ttlMs: 30_000, max: 1_024 });

/** Shared by the web dividend card and the connected personal brief. */
export async function myDividendWalletV1(wallet: string, now: Date) {
  const reader = stocksDividendsRuntime.reader();
  if (!reader) throw new Error('dividend_wallet_chain_unconfigured');
  return stocksDividendsCacheV1.read(wallet.toLowerCase(), async () =>
    readDividendWalletV1({ wallet, now, calendar: await stocksDividendsRuntime.calendar(now), reader, caches: stocksDividendsRuntime.caches }),
  );
}

/** Our own failure codes only: an RPC or database message can carry a URL. */
function failureCodeV1(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : '';
  return /^dividend_[a-z0-9_]{1,80}$/.test(message) ? message : 'error';
}

export const stocksDividendsRouter = Router();

stocksDividendsRouter.get('/mine', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  res.set('Cache-Control', 'private, no-store');
  try {
    if (!(await stocksDividendsRuntime.storageAvailable())) {
      res.status(503).json({ error: 'market_reality_storage_unavailable', code: 'market_reality_storage_unavailable' });
      return;
    }
    const reader = stocksDividendsRuntime.reader();
    if (!reader) {
      res.status(503).json({ error: 'chain_read_unconfigured', code: 'chain_read_unconfigured' });
      return;
    }
    const now = stocksDividendsRuntime.now();
    res.json(
      await myDividendWalletV1(wallet, now),
    );
  } catch (cause) {
    logger.warn('Dividend wallet read failed', { code: failureCodeV1(cause) });
    res.status(503).json({ error: 'dividend_wallet_unread', code: 'dividend_wallet_unread' });
  }
});
