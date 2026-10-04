import {
  etTimeV1,
  etWeekdayV1,
  nextWeekendStartV1,
  weekendStampV1,
  type WeekendMarketResponseV1,
  type WeekendMarketStockV1,
} from '@mioagent/rwa-market-reality/weekend-market';

import { giftShareLinksV1 } from './giftView';

// ---------------------------------------------------------------------------
// The weekend card, in words.
//
// It says two things and never a third. While Wall Street is closed: where the
// tokens trade on Base against the last close. Once the feed prints again: where
// it reopened, and whether Base had been on the same side. It never says Base
// predicts Monday. Over four measured weekends it did not (19 of 30), and one
// weekend's hit is one weekend.
//
// The close is named by its day, because it is not always Friday's: before a
// holiday Friday it is Thursday's, and on a short day it is rung at 13:00.
// ---------------------------------------------------------------------------

export interface WeekendMarketRowViewV1 {
  key: string;
  symbol: string;
  name: string;
  close: string;
  base: string;
  move: string;
  reopen: string | null;
  gap: string | null;
  /** Once reopened: which side of the close Base had been on. */
  mark: string | null;
  off: boolean;
}

export interface WeekendMarketViewV1 {
  state: 'in_progress' | 'reopened';
  title: string;
  badge: string;
  lede: string;
  /** "Friday close", or "Thursday close" before a holiday Friday. */
  columns: { close: string; base: string; reopen: string | null };
  rows: WeekendMarketRowViewV1[];
  note: string;
  share: { x: string; farcaster: string };
}

const MINUS = '−';

function usdV1(value: string): string {
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function signedPercentV1(bps: number): string {
  const percent = (Math.abs(bps) / 100).toFixed(2);
  return bps > 0 ? `+${percent}%` : bps < 0 ? `${MINUS}${percent}%` : `${percent}%`;
}

/** "Sun 17:00 ET". */
export function etLabelV1(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('weekday')} ${value('hour')}:${value('minute')} ET`;
}

/** "in 3 h", or null once it has passed. */
export function untilV1(iso: string, now: Date): string | null {
  const minutes = Math.round((Date.parse(iso) - now.getTime()) / 60_000);
  if (minutes <= 0) return null;
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} days`;
}

const UNAVAILABLE_V1: Record<NonNullable<WeekendMarketStockV1['unavailable']>, string> = {
  no_close_reference: 'no close to measure from',
  too_few_measurements: 'too few measurements',
};

function rowV1(stock: WeekendMarketStockV1, reopened: boolean): WeekendMarketRowViewV1 {
  const mark =
    !reopened || !stock.reopen
      ? null
      : stock.reopen.sameDirection === true
        ? 'Base was on the same side'
        : stock.reopen.sameDirection === false
          ? 'Base was on the other side'
          : 'no clear gap';
  return {
    key: stock.tokenAddress,
    symbol: stock.symbol,
    name: stock.name,
    close: stock.close ? usdV1(stock.close) : '—',
    base: stock.base ? usdV1(stock.base.value) : '—',
    move: stock.base ? signedPercentV1(stock.base.moveBps) : stock.unavailable ? UNAVAILABLE_V1[stock.unavailable] : '',
    reopen: reopened ? (stock.reopen ? usdV1(stock.reopen.value) : '—') : null,
    gap: reopened ? (stock.reopen ? signedPercentV1(stock.reopen.gapBps) : 'no print yet') : null,
    mark,
    off: stock.base === null,
  };
}

/** Null when there is no quiet period to show, so the board shows nothing. */
export function weekendMarketViewV1(
  response: WeekendMarketResponseV1 | null | undefined,
  input: { now: Date; origin: string },
): WeekendMarketViewV1 | null {
  if (!response || response.state === 'none' || !response.window) return null;
  const measured = response.stocks.filter((stock) => stock.base !== null);
  if (measured.length === 0) return null;
  // The link names the slot these numbers were computed at, so the picture a
  // feed draws under the post shows the post's own numbers, with their clock.
  const stamp = weekendStampV1(response.generatedAt);
  const url = `${input.origin.replace(/\/+$/, '')}/stocks${stamp ? `?weekend=${stamp}` : ''}`;
  const reopened = response.state === 'reopened';
  const rows = response.stocks.map((stock) => rowV1(stock, reopened));
  const day = etWeekdayV1(response.window.closeAt);
  const close = `${day}'s close`;

  if (!reopened) {
    const until = untilV1(response.window.expectedReopenAt, input.now);
    const top = measured
      .slice(0, 3)
      .map((stock) => `${stock.symbol} ${signedPercentV1(stock.base!.moveBps)}`)
      .join(', ');
    return {
      state: 'in_progress',
      title: 'The weekend on Base',
      badge: 'Wall Street closed',
      lede: `Wall Street is closed until ${etLabelV1(response.window.expectedReopenAt)}${until ? ` (${until})` : ''}. These tokens keep trading on Base, and this is where they trade against ${close}.`,
      columns: { close: `${day} close`, base: 'On Base now', reopen: null },
      rows,
      note: `On Base: the median of Miorail's $100 quotes over the last six hours, with any quote more than 10% from the reference dropped. ${day}'s close: the Chainlink reference at the ${etTimeV1(response.window.closeAt)} ET bell. Where a market trades over the weekend is not a forecast of where it reopens.`,
      share: giftShareLinksV1({
        url,
        text: `Wall Street is closed, and tokenized stocks on Base keep trading: ${top} against ${close}.`,
      }),
    };
  }

  const reopenedAt = response.stocks
    .map((stock) => stock.reopen?.at)
    .filter((at): at is string => typeof at === 'string')
    .sort()[0];
  const called = response.called;
  const tally =
    called && called.meaningful > 0
      ? `Before it did, Base was on the same side of ${close} as the reopen for ${called.sameDirection} of ${called.meaningful} stocks with a clear gap.`
      : `No stock reopened with a clear gap from ${close}.`;
  return {
    state: 'reopened',
    title: 'The weekend on Base, and the reopen',
    badge: 'Reopened',
    lede: `The reference feeds printed again${reopenedAt ? ` ${etLabelV1(reopenedAt)}` : ''}. ${tally}`,
    columns: { close: `${day} close`, base: 'On Base before', reopen: 'Reopened at' },
    rows,
    note: "On Base before: the median of the six hours before the feed printed again. A gap under 0.20% has no direction and is not counted. This is one weekend, not a track record.",
    share: giftShareLinksV1({
      url,
      text:
        called && called.meaningful > 0
          ? `The weekend on Base: before Wall Street reopened, tokenized stocks on Base were on the same side of ${close} as the reopen for ${called.sameDirection} of ${called.meaningful}.`
          : 'The weekend on Base, measured: where tokenized stocks traded while Wall Street was closed, and where they reopened.',
    }),
  };
}

/** The Weekend tab between weekends: when the next one starts, and what the
 * tab shows then. Never a number: there is nothing measured to show. */
export interface WeekendQuietViewV1 {
  title: string;
  lede: string;
}

export function weekendQuietViewV1(now: Date): WeekendQuietViewV1 {
  const start = nextWeekendStartV1(now);
  const until = start ? untilV1(start, now) : null;
  const when = start ? `${etLabelV1(start)}${until ? ` (${until})` : ''}` : 'on Friday evening';
  // The weekend starts at 20:00 ET on the day of its close.
  const close = start ? `${etWeekdayV1(start)}'s close` : 'the last close';
  return {
    title: 'The weekend on Base',
    lede: `Wall Street is open now. It closes for the weekend ${when}. From then until the reopen, these tokens keep trading on Base, and this tab shows where they trade against ${close}, then where they reopened.`,
  };
}
