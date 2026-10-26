// Still's terms with no wallet: the shares, the windows open now and each stock's next report.
//
// One builder for every door that states them: the API's /terms, the assistant tools and the
// page's sky. The schema is the same shape in zod, for a client that checks what it was sent
// before it draws a cloud from it; a compile-time check keeps the two from drifting apart.

import type { Address } from 'viem';
import { z } from 'zod';

import type { CalendarRead } from './calendar.js';
import { formatTokenAmount } from './format.js';
import { TERMS, earningsWindow, weekendWindow } from './policy.js';
import { ADDRESSES, ASSETS, STOCKS } from './registry.js';

export function stillTerms(read: CalendarRead, now: Date) {
  const weekend = weekendWindow(now);
  // Plain strings in the shape: a client built before a change of terms still reads the new ones.
  const termsVersion: string = TERMS.version;
  const venues: Array<{ name: string; address: Address }> = [
    { name: 'Aave V4 Coinbase Stocks spoke', address: ADDRESSES.aaveSpoke },
    { name: 'Morpho Blue', address: ADDRESSES.morpho },
  ];
  return {
    termsVersion,
    sharePercentOfProtocol: Number(TERMS.shareOfProtocolBps) / 100,
    weekend: {
      stockSharePercentOfProtocol: Number(TERMS.weekendStockShareOfProtocolBps) / 100,
      window: 'while Wall Street is closed, weekends and market holidays alike: from 20:00 New York time after the last session to 20:00 before the next',
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
    venues,
    notOfferedTo: 'US persons' as const,
  };
}

export type StillTerms = ReturnType<typeof stillTerms>;

const ISO = z.string().datetime();
const ADDRESS = z.custom<Address>((value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value), 'not an address');
const STOCK_ID = z.enum(['AAPLc', 'AMZNc', 'GOOGLc', 'METAc', 'MSFTc', 'NVDAc', 'TSLAc']);

export const StillTermsSchema = z
  .object({
    termsVersion: z.string(),
    sharePercentOfProtocol: z.number(),
    weekend: z
      .object({ stockSharePercentOfProtocol: z.number(), window: z.string(), activeNow: z.boolean(), startsAt: ISO, endsAt: ISO })
      .strict(),
    earnings: z
      .object({
        stockSharePercentOfProtocol: z.number(),
        window: z.string(),
        calendar: z.string(),
        calendarReadAt: ISO.nullable(),
        stocks: z.array(
          z
            .object({
              id: STOCK_ID,
              reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
              windowStartsAt: ISO.nullable(),
              windowEndsAt: ISO.nullable(),
              countsAtEarningsRateNow: z.boolean(),
              calendarRead: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
    safety: z.object({ watchBelowMarginPercent: z.number(), actBelowMarginPercent: z.number() }).strict(),
    gasReserveEth: z.string(),
    assets: z.array(
      z
        .object({
          id: z.enum(['AAPLc', 'AMZNc', 'GOOGLc', 'METAc', 'MSFTc', 'NVDAc', 'TSLAc', 'cbBTC', 'ETH']),
          name: z.string(),
          token: ADDRESS,
          venue: z.string(),
          isin: z.string().nullable(),
        })
        .strict(),
    ),
    venues: z.array(z.object({ name: z.string(), address: ADDRESS }).strict()),
    notOfferedTo: z.literal('US persons'),
  })
  .strict();

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameShape: Same<z.infer<typeof StillTermsSchema>, StillTerms> = true;
void sameShape;
