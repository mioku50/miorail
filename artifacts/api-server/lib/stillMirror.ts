import {
  ADDRESSES,
  ASSETS,
  STOCKS,
  TERMS,
  createEarningsCalendar,
  createMirrorService,
  createNames,
  createProviders,
  earningsWindow,
  formatTokenAmount,
  weekendWindow,
  type CalendarRead,
  type MirrorService,
} from '@mioagent/still-engine';

import { BASE_PUBLIC_RPC_V1 } from './aerodromeClaimReader.js';
import { ethereumMainnetRpcUrlV1 } from './baseNameResolver.js';
import { baseRpcUrlV1 } from './earnPreflight.js';

// ---------------------------------------------------------------------------
// Still's Mirror inside the API: what a wallet could borrow through Still
// without selling, by Still's own terms (lib/still-engine).
//
// It reads the way the rest of the API reads: the configured Base endpoint
// first, and Base's public endpoint as the second opinion when that one
// refuses. A check is a few Multicall3 batches at one block. The universe is
// held ten minutes and a complete report twenty seconds.
//
// Still's dividend reader is not exposed. Miorail's Stocks calendar answers
// dividend questions, and the two readers merge into one before a second
// source goes public.
// ---------------------------------------------------------------------------

export function stillRpcUrlsV1(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([baseRpcUrlV1(env), BASE_PUBLIC_RPC_V1])];
}

export function createStillMirrorServiceV1(env: NodeJS.ProcessEnv = process.env): MirrorService {
  const providers = createProviders(stillRpcUrlsV1(env), 'miorail-still/1');
  // Name lookups are one call per name, cached ten minutes, on Ethereum L1.
  const names = createNames(ethereumMainnetRpcUrlV1(env) ?? undefined, providers, 'miorail-still/1');
  return createMirrorService({ providers, names, calendar: createEarningsCalendar() });
}

let service: MirrorService | null = null;

export const stillMirrorRuntimeV1 = {
  /** One service per process: it holds the universe, report and name caches. */
  service(): MirrorService {
    service ??= createStillMirrorServiceV1();
    return service;
  },
};

/** Still's terms with no wallet: the shares, the windows open now and each stock's next report. */
export function stillTermsV1(read: CalendarRead, now: Date) {
  const weekend = weekendWindow(now);
  return {
    termsVersion: TERMS.version,
    sharePercentOfProtocol: Number(TERMS.shareOfProtocolBps) / 100,
    weekend: {
      stockSharePercentOfProtocol: Number(TERMS.weekendStockShareOfProtocolBps) / 100,
      window: 'Friday 20:00 to Sunday 20:00, New York time',
      activeNow: weekend.active,
      startsAt: weekend.startsAt.toISOString(),
      endsAt: weekend.endsAt.toISOString(),
    },
    earnings: {
      stockSharePercentOfProtocol: Number(TERMS.earningsStockShareOfProtocolBps) / 100,
      window: 'around each company’s earnings report: from 00:00 New York time the day before the report date to 20:00 the day after',
      calendar: 'Aave V4 API (api.v4.aave.com), the calendar Aave shows next to these reserves',
      calendarReadAt: read.ok ? read.calendar.readAt.toISOString() : null,
      stocks: STOCKS.map((stock) => {
        const dates = read.ok ? read.calendar.dates.get(stock.id) : undefined;
        // An unread calendar lowers the stock: the earnings rate is the safe side.
        if (dates === undefined) {
          return { id: stock.id, reportDate: null, windowStartsAt: null, windowEndsAt: null, countsAtEarningsRateNow: true, calendarRead: false };
        }
        const window = earningsWindow(now, dates);
        return {
          id: stock.id,
          reportDate: window?.reportDate ?? null,
          windowStartsAt: window?.startsAt.toISOString() ?? null,
          windowEndsAt: window?.endsAt.toISOString() ?? null,
          countsAtEarningsRateNow: window?.active ?? false,
          calendarRead: true,
        };
      }),
    },
    safety: { watchBelowMarginPercent: Number(TERMS.watchBelowBps) / 100, actBelowMarginPercent: Number(TERMS.actBelowBps) / 100 },
    gasReserveEth: formatTokenAmount(TERMS.ethGasReserveWei, 18, 4),
    assets: ASSETS.map((asset) => ({
      id: asset.id,
      name: asset.name,
      token: asset.token,
      venue: asset.kind === 'stock' ? 'Aave V4 Coinbase Stocks' : `Morpho ${asset.symbol === 'ETH' ? 'WETH' : asset.symbol}/USDC`,
      isin: asset.kind === 'stock' ? asset.isin : null,
    })),
    venues: [
      { name: 'Aave V4 Coinbase Stocks spoke', address: ADDRESSES.aaveSpoke },
      { name: 'Morpho Blue', address: ADDRESSES.morpho },
    ],
    notOfferedTo: 'US persons',
  };
}

export type StillTermsV1 = ReturnType<typeof stillTermsV1>;
