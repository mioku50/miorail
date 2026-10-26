// Still's own terms. They are stricter than any protocol's and versioned, so a decision keeps the
// terms it was made under. 2026-10-25: Still's first terms, before it moved into this repo.
// 2026-10-26: the closed-market window follows the market calendar, holidays included.

import { nextWeekendStartV1, weekendWindowV1 } from '@mioagent/rwa-market-reality/weekend-market';
import { BPS, WAD, mulDiv } from './math.js';

export const TERMS = {
  version: '2026-10-26',
  /** Still lends at half the protocol's collateral factor: a fresh draw starts 50% from liquidation. */
  shareOfProtocolBps: 5_000n,
  /**
   * Stocks while Wall Street is closed: 40% of the protocol's factor. On weekends and market
   * holidays alike, the stock reference prices stand still while the tokens keep trading on Base
   * (operator, 2026-10-26). See `weekendWindow`.
   */
  weekendStockShareOfProtocolBps: 4_000n,
  /** The stock market's clock, which the closed-market and earnings windows run on. */
  marketZone: 'America/New_York',
  /** Past the reviewed market calendar only: Friday 20:00 to Sunday 20:00. */
  weekendStartsFriday: { hour: 20, minute: 0 },
  weekendEndsSunday: { hour: 20, minute: 0 },
  /**
   * A stock around its earnings report: 40% of the protocol's factor, as on weekends, never
   * stacked with them. The calendar gives only the date, and companies report before the open or
   * after the close, so the window runs from 00:00 the day before the report date to 20:00 the day
   * after it, New York time: it covers both, and the first session after a report.
   */
  earningsStockShareOfProtocolBps: 4_000n,
  earningsStartsDayBefore: { hour: 0, minute: 0 },
  earningsEndsDayAfter: { hour: 20, minute: 0 },
  /** Safety bands by margin, the share by which all collateral may fall before liquidation (from Draw). */
  watchBelowBps: 3_750n, // health factor 1.6
  actBelowBps: 2_000n, // health factor 1.25
  /** A headline under one dollar reads "less than $1", never "$0". */
  dustBelowCents: 100n,
  /**
   * Native ETH left in the wallet for network fees, never counted as collateral: 0.0005 ETH, about
   * a hundred Base transactions. Without it a wallet holding only gas money would read as a lender.
   */
  ethGasReserveWei: 500_000_000_000_000n,
} as const;

export type AssetKind = 'stock' | 'crypto';

/**
 * The share of the protocol's collateral factor Still lends at, for this kind of asset now. For a
 * stock inside the weekend or its earnings window the lower rate applies; the two never stack.
 */
export function stillShareBps(kind: AssetKind, weekend: boolean, earnings = false): bigint {
  let share: bigint = TERMS.shareOfProtocolBps;
  if (kind !== 'stock') return share;
  if (weekend && TERMS.weekendStockShareOfProtocolBps < share) share = TERMS.weekendStockShareOfProtocolBps;
  if (earnings && TERMS.earningsStockShareOfProtocolBps < share) share = TERMS.earningsStockShareOfProtocolBps;
  return share;
}

export type SafetyState = 'calm' | 'watch' | 'act' | 'liquidation';

/**
 * Margin to liquidation from a health factor: the share by which every collateral may fall together
 * before liquidation, 1 − 1/HF, rounded down. HF ≤ 1 means the position can be liquidated now.
 */
export function safetyFromHealthFactor(healthFactorWad: bigint): { marginBps: bigint; state: SafetyState } {
  if (healthFactorWad <= WAD) return { marginBps: 0n, state: 'liquidation' };
  const marginBps = BPS - mulDiv(BPS, WAD, healthFactorWad, 'up');
  if (marginBps < TERMS.actBelowBps) return { marginBps, state: 'act' };
  if (marginBps < TERMS.watchBelowBps) return { marginBps, state: 'watch' };
  return { marginBps, state: 'calm' };
}

export interface WeekendWindow {
  /** True while Wall Street is closed, Base is the only market for these stocks and their reference feeds hold. */
  active: boolean;
  /** The window that is open now, or the next one. */
  startsAt: Date;
  endsAt: Date;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface WallTime {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallTime(at: Date, zone: string): WallTime {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, format);
  }
  const parts = format.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
    weekday: WEEKDAYS.indexOf(part('weekday')),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
    second: Number(part('second')),
  };
}

/** Minutes the zone's wall clock is ahead of UTC at this instant. */
function offsetMinutes(at: Date, zone: string): number {
  const w = wallTime(at, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant a wall time happens in a zone. Neither 00:00 nor 20:00 falls in New York's daylight-saving gap. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, zone: string): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let instant = naive;
  for (let i = 0; i < 3; i += 1) {
    const next = naive - offsetMinutes(new Date(instant), zone) * 60_000;
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

/**
 * The closed-market window around an instant: the one open now, or the next one.
 *
 * It is Miorail's reviewed market calendar (rwa-market-reality's weekendMarket), the same one the
 * Stocks weekend card reads: from 20:00 New York time after the last session before a day without
 * one, to 20:00 on the evening before the next session. A weekend is one such window, Thanksgiving
 * is another (Wednesday 20:00 to Thursday 20:00), and a holiday Monday ends one at Monday 20:00.
 *
 * Past the reviewed calendar (it runs through 2027), Friday 20:00 to Sunday 20:00: the rule before
 * the calendar, which knows no holidays.
 */
export function weekendWindow(at: Date, zone: string = TERMS.marketZone): WeekendWindow {
  return reviewedWindow(at) ?? fixedWeekendWindow(at, zone);
}

function reviewedWindow(at: Date): WeekendWindow | null {
  const quiet = weekendWindowV1(at);
  if (quiet) {
    const startsAt = new Date(quiet.darkStartAt);
    const endsAt = new Date(quiet.expectedReopenAt);
    // The calendar answers with the window of the last close, which may already have ended.
    if (at < endsAt) return { active: at >= startsAt, startsAt, endsAt };
  }
  const next = nextWeekendStartV1(at);
  const upcoming = next === null ? null : weekendWindowV1(new Date(next));
  return upcoming ? { active: false, startsAt: new Date(upcoming.darkStartAt), endsAt: new Date(upcoming.expectedReopenAt) } : null;
}

/** Friday 20:00 to Sunday 20:00 local time, for a date the market calendar has not reviewed. */
function fixedWeekendWindow(at: Date, zone: string): WeekendWindow {
  const now = wallTime(at, zone);
  const { hour: startHour, minute: startMinute } = TERMS.weekendStartsFriday;
  const { hour: endHour, minute: endMinute } = TERMS.weekendEndsSunday;
  // Calendar arithmetic on the local date, done in UTC so no zone shifts the day.
  const localDate = (offsetDays: number) => {
    const d = new Date(Date.UTC(now.year, now.month - 1, now.day + offsetDays));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
  };
  const windowFrom = (friday: { year: number; month: number; day: number }) => {
    const sunday = new Date(Date.UTC(friday.year, friday.month - 1, friday.day + 2));
    return {
      startsAt: zonedTime(friday.year, friday.month, friday.day, startHour, startMinute, zone),
      endsAt: zonedTime(sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate(), endHour, endMinute, zone),
    };
  };
  // The Friday on or before today, then the one after it.
  const back = (now.weekday - 5 + 7) % 7;
  const current = windowFrom(localDate(-back));
  if (at >= current.startsAt && at < current.endsAt) return { active: true, ...current };
  const ahead = at < current.startsAt ? current : windowFrom(localDate(7 - back));
  return { active: false, ...ahead };
}

/** The New York calendar day of an instant, as 'YYYY-MM-DD'. */
export function marketDate(at: Date, zone: string = TERMS.marketZone): string {
  const w = wallTime(at, zone);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

export interface EarningsWindow {
  /** The report date, a New York calendar day 'YYYY-MM-DD'. */
  reportDate: string;
  startsAt: Date;
  endsAt: Date;
  active: boolean;
}

/** The window around one report date: 00:00 the day before to 20:00 the day after, New York time. */
export function earningsWindowOf(reportDate: string, zone: string = TERMS.marketZone): { startsAt: Date; endsAt: Date } {
  const [year, month, day] = reportDate.split('-').map(Number) as [number, number, number];
  const shifted = (days: number) => {
    const d = new Date(Date.UTC(year, month - 1, day + days));
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()] as const;
  };
  const { hour: startHour, minute: startMinute } = TERMS.earningsStartsDayBefore;
  const { hour: endHour, minute: endMinute } = TERMS.earningsEndsDayAfter;
  return {
    startsAt: zonedTime(...shifted(-1), startHour, startMinute, zone),
    endsAt: zonedTime(...shifted(1), endHour, endMinute, zone),
  };
}

/** Of a stock's report dates, the window open at this instant, else the next one, else null. */
export function earningsWindow(at: Date, reportDates: readonly string[], zone: string = TERMS.marketZone): EarningsWindow | null {
  let next: EarningsWindow | null = null;
  for (const reportDate of reportDates) {
    const { startsAt, endsAt } = earningsWindowOf(reportDate, zone);
    if (at >= startsAt && at < endsAt) return { reportDate, startsAt, endsAt, active: true };
    if (at < startsAt && (next === null || startsAt < next.startsAt)) next = { reportDate, startsAt, endsAt, active: false };
  }
  return next;
}
