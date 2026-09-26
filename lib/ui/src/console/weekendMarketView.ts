import {
  weekendStampV1,
  type WeekendMarketResponseV1,
  type WeekendMarketStockV1,
} from '@mioagent/rwa-market-reality/weekend-market';

import { giftShareLinksV1 } from './giftView';

// ---------------------------------------------------------------------------
// The weekend card, in words.
//
// It says two things and never a third. While Wall Street is closed: where the
// tokens trade on Base against Friday's close. Once the feed prints again: where
// it reopened, and whether Base had been on the same side. It never says Base
// predicts Monday. Over four measured weekends it did not (19 of 30), and one
// weekend's hit is one weekend.
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
  /** Once reopened: which side of Friday's close Base had been on. */
  mark: string | null;
  off: boolean;
}

export interface WeekendMarketViewV1 {
  state: 'in_progress' | 'reopened';
  title: string;
  badge: string;
  lede: string;
  columns: { base: string; reopen: string | null };
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

function etLabelV1(iso: string): string {
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

function untilV1(iso: string, now: Date): string | null {
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
      lede: `Wall Street is closed until ${etLabelV1(response.window.expectedReopenAt)}${until ? ` (${until})` : ''}. These tokens keep trading on Base, and this is where they trade against Friday's close.`,
      columns: { base: 'On Base now', reopen: null },
      rows,
      note: "On Base: the median of Miorail's $100 quotes over the last six hours, with any quote more than 10% from the reference dropped. Friday's close: the Chainlink reference at the 16:00 ET bell. Where a market trades over the weekend is not a forecast of where it reopens.",
      share: giftShareLinksV1({
        url,
        text: `Wall Street is closed, and tokenized stocks on Base keep trading: ${top} against Friday's close.`,
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
      ? `Before it did, Base was on the same side of Friday's close as the reopen for ${called.sameDirection} of ${called.meaningful} stocks with a clear gap.`
      : "No stock reopened with a clear gap from Friday's close.";
  return {
    state: 'reopened',
    title: 'The weekend on Base, and the reopen',
    badge: 'Reopened',
    lede: `The reference feeds printed again${reopenedAt ? ` ${etLabelV1(reopenedAt)}` : ''}. ${tally}`,
    columns: { base: 'On Base before', reopen: 'Reopened at' },
    rows,
    note: "On Base before: the median of the six hours before the feed printed again. A gap under 0.20% has no direction and is not counted. This is one weekend, not a track record.",
    share: giftShareLinksV1({
      url,
      text:
        called && called.meaningful > 0
          ? `The weekend on Base: before Wall Street reopened, tokenized stocks on Base were on the same side of Friday's close as the reopen for ${called.sameDirection} of ${called.meaningful}.`
          : 'The weekend on Base, measured: where tokenized stocks traded while Wall Street was closed, and where they reopened.',
    }),
  };
}
