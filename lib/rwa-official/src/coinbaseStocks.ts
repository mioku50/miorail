import { isValidIsinV1 } from '@mioagent/route-storage';
import {
  TICKER_SHAPE_V1,
  type OfficialParseResultV1,
  type OfficialSourceAssetV1,
} from './sources.js';

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
