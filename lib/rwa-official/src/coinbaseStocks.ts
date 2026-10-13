import { isValidIsinV1 } from '@mioagent/route-storage';
import type { OfficialFetchResultV1 } from './fetchSource.js';
import {
  TICKER_SHAPE_V1,
  type OfficialParseResultV1,
  type OfficialSourceAssetV1,
} from './sources.js';

/** Ten pages of 100 is twice the 500 records the parser accepts. */
export const COINBASE_STOCKS_MAX_PAGES_V1 = 10;

/**
 * Every page of the issuer's list, handed to the parser as one document.
 *
 * Coinbase began answering in pages of 100 on 2026-10-12: `tokens` plus a
 * `next_page_token`, sent back as `page_token`. A page that cannot be fetched
 * makes the whole read unreachable. A list that cannot be followed to its end
 * keeps its `next_page_token`, which the parser refuses. Either way the
 * previous complete snapshot stays, and no address is withdrawn because a
 * request failed.
 */
export async function readCoinbaseStocksApiV1(input: {
  url: string;
  fetchPage: (url: string) => Promise<OfficialFetchResultV1>;
  maxPages?: number;
}): Promise<OfficialFetchResultV1> {
  const maxPages = input.maxPages ?? COINBASE_STOCKS_MAX_PAGES_V1;
  const tokens: unknown[] = [];
  const followed = new Set<string>();
  let next: string | null = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const fetched = await input.fetchPage(
      next === null ? input.url : `${input.url}?page_token=${encodeURIComponent(next)}`,
    );
    if (!fetched.ok) {
      return page === 1 ? fetched : { ok: false, detail: `page ${page}: ${fetched.detail}` };
    }
    let value: { tokens?: unknown; next_page_token?: unknown } | null;
    try {
      value = JSON.parse(fetched.body);
    } catch {
      // The parser names what is wrong with this page.
      return fetched;
    }
    if (!value || typeof value !== 'object' || !Array.isArray(value.tokens)) return fetched;
    tokens.push(...value.tokens);
    const token = value.next_page_token;
    if (token == null || token === '') return { ok: true, body: JSON.stringify({ tokens }) };
    if (typeof token !== 'string' || followed.has(token)) {
      return { ok: true, body: JSON.stringify({ tokens, next_page_token: token }) };
    }
    followed.add(token);
    next = token;
  }
  return { ok: true, body: JSON.stringify({ tokens, next_page_token: next }) };
}

/** The issuer API is a separate trust root from Base's illustrative tables.
 * Accept the whole response or refuse it; a truncated/malformed row must never
 * withdraw other addresses. Optional market data does not gate membership.
 * Supply and multiplier are normalized numbers here, not atomic units/WADs.
 * They are deliberately NOT written into our independently pinned chain reads.
 */
export function parseCoinbaseStocksApiV1(body: string): OfficialParseResultV1 {
  const refuse = (detail: string): OfficialParseResultV1 => ({
    ok: false,
    refusal: 'invalid_coinbase_stocks_response',
    detail,
  });
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return refuse('response is not JSON');
  }
  // The API answers in pages since 2026-10-12, which its OpenAPI document does
  // not say: `next_page_token` names the next one. A page is not the list.
  // Read as the list, page one withdrew the 35 stocks on page two for a night,
  // so a document that says it continues is refused and nothing moves.
  // `readCoinbaseStocksApiV1` follows the pages and hands over one document.
  if (
    value &&
    typeof value === 'object' &&
    'next_page_token' in value &&
    value.next_page_token != null &&
    value.next_page_token !== ''
  ) {
    return refuse('the list continues on another page (next_page_token is set); one page is not the list');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('tokens' in value) ||
    !Array.isArray(value.tokens) ||
    value.tokens.length === 0 ||
    value.tokens.length > 500
  ) {
    return refuse('expected a nonempty tokens array of at most 500 records');
  }
  const assets: OfficialSourceAssetV1[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.tokens.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return refuse(`record ${index} is not an object`);
    const row = raw as Record<string, unknown>;
    if (
      typeof row.contract_address !== 'string' ||
      !/^0xb200[0-9a-f]{36}$/i.test(row.contract_address) ||
      typeof row.symbol !== 'string' ||
      !TICKER_SHAPE_V1.test(row.symbol) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > 120 ||
      typeof row.isin !== 'string' ||
      !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(row.isin) ||
      !isValidIsinV1(row.isin) ||
      typeof row.decimals !== 'number' ||
      !Number.isInteger(row.decimals) ||
      row.decimals < 0 ||
      row.decimals > 255 ||
      typeof row.multiplier !== 'number' ||
      !Number.isFinite(row.multiplier) ||
      row.multiplier <= 0
    ) {
      return refuse(`record ${index} has invalid address, identifier or metadata`);
    }
    // Protobuf JSON omits zero-valued optional scalars. Missing NAV is ordinary
    // for new listings; a price of zero is never manufactured from its absence.
    for (const key of ['total_supply', 'nav_price']) {
      const n = row[key];
      if (n != null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
        return refuse(`record ${index} has invalid ${key}`);
      }
    }
    if (
      row.nav_price_updated_at != null &&
      (typeof row.nav_price_updated_at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T/.test(row.nav_price_updated_at) ||
        !Number.isFinite(Date.parse(row.nav_price_updated_at)))
    ) {
      return refuse(`record ${index} has invalid NAV timestamp`);
    }
    if (row.redeem_paused != null && typeof row.redeem_paused !== 'boolean') {
      return refuse(`record ${index} has invalid redemption flag`);
    }
    const tokenAddress = row.contract_address.toLowerCase();
    if (seen.has(tokenAddress)) return refuse(`record ${index} repeats an address`);
    seen.add(tokenAddress);
    assets.push({
      tokenAddress,
      ticker: row.symbol,
      displayName: row.name.trim(),
      referenceFeedAddress: null,
      underlyingIsin: row.isin,
      tokenDecimals: row.decimals,
      referenceValuePublished: row.nav_price != null,
    });
  }
  return { ok: true, assets, otherEntries: [] };
}
