// The earnings calendar: when each stock reports, from the Aave V4 API, the calendar Aave's own app
// shows next to these reserves. It is offchain data owned by Aave Labs, so an entry is matched to a
// stock by its token address on Base, never by ticker, and a stock the answer leaves out is unread,
// not "nothing scheduled".
//
// Read at most once an hour. When a read fails, the last good calendar serves for up to a day
// (report dates are announced weeks ahead) and the read is retried after a pause; with nothing
// good to fall back on the calendar is unread, and every stock counts at the earnings rate.

import type { Address } from 'viem';
import { marketDate } from './policy.js';
import { BASE_CHAIN_ID, stockByToken, type StockId } from './registry.js';

export const AAVE_API_URL = 'https://api.v4.aave.com/graphql';

export interface EarningsCalendar {
  readAt: Date;
  /**
   * Recent and upcoming report dates per stock, New York days 'YYYY-MM-DD', ascending. An empty
   * list means none is scheduled; a stock missing from the map was not read.
   */
  dates: ReadonlyMap<StockId, readonly string[]>;
}

export type CalendarRead = { ok: true; calendar: EarningsCalendar } | { ok: false };

export interface CalendarSource {
  current(): Promise<CalendarRead>;
}

export interface CalendarOptions {
  url?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  ttlMs?: number;
  retryMs?: number;
  staleMs?: number;
  timeoutMs?: number;
}

const QUERY = `query StillEarnings($request: TokenizedStocksRequest!, $since: DateTime!) {
  tokenizedStocks(request: $request) {
    items { chainId address offchain { nextEarningsReport earnings(since: $since) { reportDate } } }
    pageInfo { next }
  }
}`;

/** Past reports matter for the day after them; older ones are dropped. */
const KEEP_PAST_DAYS = 7;
const MAX_PAGES = 5;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * A report date as a New York day. Aave writes dates as midnight New York time; a bare UTC
 * midnight is read as that UTC day, so a format change cannot move a report by a day.
 */
export function reportDay(value: string): string | null {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const utcMidnight = at.getUTCHours() === 0 && at.getUTCMinutes() === 0 && at.getUTCSeconds() === 0;
  return utcMidnight ? at.toISOString().slice(0, 10) : marketDate(at);
}

/** One stock's dates from an API item, or null when they cannot all be read. */
function datesOf(offchain: unknown, since: string): string[] | null {
  if (!isRecord(offchain) || !Array.isArray(offchain.earnings)) return null;
  const raw: unknown[] = [offchain.nextEarningsReport, ...offchain.earnings.map((e) => (isRecord(e) ? e.reportDate : undefined))];
  const days = new Set<string>();
  for (const value of raw) {
    if (value === null) continue; // nothing scheduled, or a report without a date yet
    if (typeof value !== 'string') return null;
    const day = reportDay(value);
    if (day === null) return null;
    if (day >= since) days.add(day);
  }
  return [...days].sort();
}

export async function readCalendar(url: string, fetchFn: typeof fetch, readAt: Date, timeoutMs: number): Promise<EarningsCalendar> {
  const sinceAt = new Date(readAt.getTime() - KEEP_PAST_DAYS * 86_400_000);
  const since = marketDate(sinceAt);
  const dates = new Map<StockId, string[]>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { request: { pageSize: 'FIFTY', ...(cursor ? { cursor } : {}) }, since: sinceAt.toISOString() } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`earnings calendar: HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || body.errors !== undefined || !isRecord(body.data)) throw new Error('earnings calendar: no data');
    const result = body.data.tokenizedStocks;
    if (!isRecord(result) || !Array.isArray(result.items)) throw new Error('earnings calendar: unexpected shape');
    for (const item of result.items) {
      if (!isRecord(item) || item.chainId !== BASE_CHAIN_ID || typeof item.address !== 'string') continue;
      const stock = stockByToken(item.address as Address);
      if (!stock) continue;
      const days = datesOf(item.offchain, since);
      if (days !== null) dates.set(stock.id, days);
    }
    const next = isRecord(result.pageInfo) ? result.pageInfo.next : null;
    if (typeof next !== 'string' || next === '') break;
    cursor = next;
  }
  return { readAt, dates };
}

export function createEarningsCalendar(options: CalendarOptions = {}): CalendarSource {
  const url = options.url ?? AAVE_API_URL;
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? 60 * 60_000;
  const retryMs = options.retryMs ?? 60_000;
  const staleMs = options.staleMs ?? 24 * 60 * 60_000;
  const timeoutMs = options.timeoutMs ?? 4_000;

  let good: EarningsCalendar | null = null;
  let failedAt: number | null = null;
  let loading: Promise<CalendarRead> | null = null;

  const fallback = (): CalendarRead =>
    good && now().getTime() - good.readAt.getTime() < staleMs ? { ok: true, calendar: good } : { ok: false };

  async function load(): Promise<CalendarRead> {
    try {
      good = await readCalendar(url, fetchFn, now(), timeoutMs);
      failedAt = null;
      return { ok: true, calendar: good };
    } catch {
      failedAt = now().getTime();
      return fallback();
    }
  }

  return {
    current() {
      const at = now().getTime();
      if (good && at - good.readAt.getTime() < ttlMs) return Promise.resolve({ ok: true, calendar: good });
      if (failedAt !== null && at - failedAt < retryMs) return Promise.resolve(fallback());
      loading ??= load().finally(() => {
        loading = null;
      });
      return loading;
    },
  };
}
