// Dividend declarations are calendar facts, not evidence of an onchain distribution.
// Missing items, malformed rows, truncated paging and an empty list have different meanings.
import { AAVE_API_URL, reportDay } from './calendar.js';
import { BASE_CHAIN_ID, STOCKS, stockByToken, type StockId } from './registry.js';
import type { DividendDeclaration } from './dividend-report.js';

export interface DividendCalendar {
  readAt: string;
  since: string;
  stocks: ReadonlyMap<StockId, readonly DividendDeclaration[]>;
}
export interface DividendCalendarSource {
  current(): Promise<DividendCalendar | null>;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
export const DIVIDEND_QUERY = `query StillDividends($request: TokenizedStocksRequest!, $since: DateTime!) {
  tokenizedStocks(request: $request) {
    items { chainId address offchain { dividends(since: $since) { exDate recordDate paymentDate amount frequency } } }
    pageInfo { next }
  }
}`;

function day(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(value) ? reportDay(value) : null;
}

function declarations(value: unknown): DividendDeclaration[] | null {
  if (!Array.isArray(value)) return null;
  const result: DividendDeclaration[] = [];
  for (const row of value) {
    if (!record(row)) return null;
    const exDate = day(row.exDate),
      recordDate = day(row.recordDate),
      paymentDate = day(row.paymentDate);
    if (!exDate || (row.recordDate !== null && !recordDate) || (row.paymentDate !== null && !paymentDate)) return null;
    if (typeof row.amount !== 'string' || !/^\d+(\.\d{1,18})?$/.test(row.amount)) return null;
    if (row.frequency !== null && typeof row.frequency !== 'string') return null;
    result.push({ exDate, recordDate, paymentDate, amountUsd: row.amount, frequency: row.frequency });
  }
  return result.sort((a, b) => a.exDate.localeCompare(b.exDate));
}

export async function readDividendCalendar(fetchFn: typeof fetch, at: Date, timeoutMs = 4_000): Promise<DividendCalendar> {
  const since = new Date(at.getTime() - 366 * 86_400_000).toISOString();
  const stocks = new Map<StockId, readonly DividendDeclaration[]>();
  const seen = new Set<StockId>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const response = await fetchFn(AAVE_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: DIVIDEND_QUERY, variables: { request: { pageSize: 'FIFTY', ...(cursor ? { cursor } : {}) }, since } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('dividend calendar did not answer');
    const body: unknown = await response.json();
    if (!record(body) || body.errors !== undefined || !record(body.data) || !record(body.data.tokenizedStocks))
      throw new Error('dividend calendar unread');
    const result = body.data.tokenizedStocks;
    if (!Array.isArray(result.items) || !record(result.pageInfo) || !('next' in result.pageInfo))
      throw new Error('dividend calendar shape changed');
    for (const item of result.items) {
      if (!record(item) || item.chainId !== BASE_CHAIN_ID || typeof item.address !== 'string') continue;
      const stock = stockByToken(item.address as `0x${string}`);
      if (!stock) continue;
      const entries = record(item.offchain) ? declarations(item.offchain.dividends) : null;
      // A duplicate conflicting row cannot overwrite a read failure or create false certainty.
      if (entries === null || seen.has(stock.id)) {
        seen.add(stock.id);
        stocks.delete(stock.id);
        continue;
      }
      seen.add(stock.id);
      stocks.set(stock.id, entries);
    }
    const next = result.pageInfo.next;
    if (next === null || next === '') return { readAt: at.toISOString(), since, stocks };
    if (typeof next !== 'string' || cursors.has(next)) throw new Error('dividend calendar paging changed');
    cursors.add(next);
    cursor = next;
  }
  throw new Error(`dividend calendar still paging; expected ${STOCKS.length} registered stocks`);
}

export function createDividendCalendar(options: { fetch?: typeof fetch; now?: () => Date; ttlMs?: number } = {}): DividendCalendarSource {
  const now = options.now ?? (() => new Date());
  let good: DividendCalendar | null = null;
  let failedAt: number | null = null;
  let loading: Promise<DividendCalendar | null> | null = null;
  return {
    current() {
      const at = now().getTime();
      if (good && at - Date.parse(good.readAt) < (options.ttlMs ?? 3_600_000)) return Promise.resolve(good);
      if (failedAt !== null && at - failedAt < 60_000) return Promise.resolve(null);
      loading ??= readDividendCalendar(options.fetch ?? fetch, now())
        .then(
          (value) => {
            good = value;
            failedAt = null;
            return value;
          },
          () => {
            failedAt = at;
            return null;
          },
        )
        .finally(() => {
          loading = null;
        });
      return loading;
    },
  };
}
