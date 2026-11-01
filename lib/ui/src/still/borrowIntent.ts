import { CRYPTO, STOCKS, ADDRESSES } from '@mioagent/still-engine/registry';
import { formatCents, formatPercentBps } from '@mioagent/still-engine/format';
import { tokenDecimalV1 } from '../console/stockSellAmount';
import { STILL_SHARES_V1, newYorkMomentV1 } from './skyState';
import type { StillBorrowAssetV1, StillBorrowComparisonV1, StillBorrowModelV1 } from './StillBorrow';

/** The host accepts a label from a query, never an arbitrary token address. */
export function borrowAssetFromQueryV1(value: string | null): StillBorrowAssetV1 | null {
  return value === 'cbBTC' || value === 'WETH' || value === 'ETH' ? value : STOCKS.find(stock => stock.id === value)?.id ?? null;
}

export function borrowCollateralTokenV1(asset: StillBorrowAssetV1): `0x${string}` {
  return [...STOCKS, ...CRYPTO].find(row => row.id === (asset === 'WETH' ? 'ETH' : asset))!.token;
}

export function borrowCollateralDecimalsV1(asset: StillBorrowAssetV1): number {
  return asset === 'WETH' || asset === 'ETH' ? 18 : 8;
}

/** Interpret text exactly; no risk calculation, balance assumption or rounding. */
export function parseBorrowDecimalV1(text: string, decimals: number, allowZero = false): { atomic: string | null; error: string | null } {
  const value = text.trim();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || value.length > 120 ||
      !/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(value)) {
    return { atomic: null, error: 'Enter a decimal amount with a dot, without commas or exponents.' };
  }
  const [whole = '', fraction = ''] = value.split('.');
  if (fraction.length > decimals) return { atomic: null, error: `Use at most ${decimals} decimal places. Amounts are never rounded.` };
  const atomic = `${whole || '0'}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=[0-9])/, '');
  if (atomic.length > 39) return { atomic: null, error: 'This amount is too large to review.' };
  if (atomic === '0' && !allowZero) return { atomic: null, error: 'Enter an amount greater than zero.' };
  return { atomic, error: null };
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const atomic = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value);

/** "1,234.56" from USDC base units, rounded down to the cent. */
const usdcV1 = (value: string) => formatCents(BigInt(value) / 10_000n).slice(1);
const REPORT_DAY_V1 = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const bps = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000;

/** Why the selected stock counts at a lower share now; null at the full
 * share; undefined when the server's reason cannot be read exactly. */
function loweredSentenceV1(lowered: unknown, asset: StillBorrowAssetV1, share: string): string | null | undefined {
  if (lowered === null) return null;
  const stock = STOCKS.find(row => row.id === asset);
  if (!object(lowered) || !stock) return undefined;
  const full = `${STILL_SHARES_V1.full}%`;
  if (lowered.reason === 'market_closed' && instant(lowered.until)) {
    return `Stocks count at ${share}, not ${full}, until ${newYorkMomentV1(lowered.until)} New York time: Wall Street is closed, and a stock can open far from the price its token trades at on Base.`;
  }
  if (lowered.reason === 'earnings' && instant(lowered.until) && typeof lowered.reportDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(lowered.reportDate)) {
    const day = REPORT_DAY_V1.format(new Date(`${lowered.reportDate}T12:00:00Z`));
    return `${stock.id} counts at ${share}, not ${full}, until ${newYorkMomentV1(lowered.until)} New York time: ${stock.name} reports earnings on ${day}, and the price can jump either way.`;
  }
  if (lowered.reason === 'earnings_unread') {
    return `${stock.id} counts at ${share}, not ${full}: Still could not read the earnings calendar just now, so it counts the stock as if a report were near. Read the limit again later.`;
  }
  return undefined;
}

/** Still's limit beside the protocol's own, both measured by the server.
 * Anything that cannot be read exactly leaves the comparison out. */
export function stillBorrowComparisonViewV1(value: unknown, asset: StillBorrowAssetV1): StillBorrowComparisonV1 | null {
  if (!object(value)) return null;
  const stock = STOCKS.some(row => row.id === asset);
  const protocol = stock ? 'Aave V4' : 'Morpho';
  const { protocolLimitAtomic: protocolLimit, stillLimitAtomic: stillLimit, shareBps, marginAtStillLimitBps: margin } = value;
  if (value.protocol !== protocol || !atomic(protocolLimit) || !atomic(stillLimit) || !bps(shareBps) || shareBps === 0 || !bps(margin) ||
      BigInt(protocolLimit) === 0n || BigInt(stillLimit) > BigInt(protocolLimit)) return null;
  const sharePercent = formatPercentBps(shareBps);
  const lowered = loweredSentenceV1(value.lowered, asset, sharePercent);
  if (lowered === undefined) return null;
  return { protocol, protocolLimitUsdc: usdcV1(protocolLimit), stillLimitUsdc: usdcV1(stillLimit), sharePercent, marginPercent: formatPercentBps(margin), lowered };
}

/** The most this wallet can pledge of the asset now, from the server's read:
 * the wallet's tokens, or for native ETH its balance less the fee reserve.
 * An unread balance is said, never filled in as zero. */
export function stillBorrowBalanceViewV1(payload: unknown, asset: StillBorrowAssetV1): { maxAtomic: string | null; error: string | null } {
  const failed = { maxAtomic: null, error: 'Your balance could not be read just now. Enter the amount yourself, or press Max again.' };
  if (!object(payload)) return failed;
  if (payload.state === 'refused') {
    // The server's own figure: ETH it can add after the fee reserve, zero included.
    if (asset === 'ETH' && payload.refusal === 'native_fee_reserve_insufficient' && atomic(payload.maximumNativeAtomic)) {
      return { maxAtomic: payload.maximumNativeAtomic, error: null };
    }
    return { maxAtomic: null, error: typeof payload.detail === 'string' ? payload.detail : failed.error };
  }
  const stock = STOCKS.find(row => row.id === asset);
  if (payload.state !== 'read' || payload.marketScope !== (stock ? 'still_aave_spoke' : 'still_registered_market') || !Array.isArray(payload.markets)) return failed;
  const marketId = stock ? ADDRESSES.aaveSpoke.toLowerCase() : CRYPTO.find(row => row.id === (asset === 'cbBTC' ? 'cbBTC' : 'ETH'))!.morphoMarket;
  const rows = payload.markets.filter(row => object(row) && row.marketId === marketId && (!stock || row.collateralTokenAddress === stock.token.toLowerCase()));
  if (rows.length !== 1) return failed;
  const row = rows[0] as Record<string, unknown>;
  if (!atomic(row.walletCollateralAtomic)) return failed;
  if (asset !== 'ETH') return { maxAtomic: row.walletCollateralAtomic, error: null };
  if (row.funding !== 'native' || !atomic(row.nativeReserveAtomic)) return failed;
  const left = BigInt(row.walletCollateralAtomic) - BigInt(row.nativeReserveAtomic);
  return { maxAtomic: left > 0n ? left.toString() : '0', error: null };
}

/** Format the server's own allowance for the selected pledge. Missing data
 * remains unread; a different market/amount cannot become this form's quote. */
export function stillBorrowCapacityViewV1(payload: unknown, asset: StillBorrowAssetV1, collateralSupplyAtomic: string): {
  capacity: StillBorrowModelV1['capacity']; error: string | null;
  /** The ETH the server says this wallet can pledge, when it refused more. */
  suggestedAmount?: string;
} {
  const failed = { capacity: null, error: 'The borrowing limit could not be read. Read it again before continuing.' };
  if (!object(payload)) return failed;
  if (payload.state === 'refused') {
    const error = typeof payload.detail === 'string' ? payload.detail : 'The server could not establish a borrowing limit for this collateral.';
    // The server's own figure, below what was asked; never one this page works out.
    const maximum = payload.maximumNativeAtomic;
    return asset === 'ETH' && payload.refusal === 'native_fee_reserve_insufficient' && atomic(maximum) && maximum !== '0' &&
      BigInt(maximum) < BigInt(collateralSupplyAtomic)
      ? { capacity: null, error, suggestedAmount: tokenDecimalV1(maximum, 18) }
      : { capacity: null, error };
  }
  const stock = STOCKS.find(row => row.id === asset);
  if (payload.state !== 'read' || payload.marketScope !== (stock ? 'still_aave_spoke' : 'still_registered_market') || !Array.isArray(payload.markets)) return failed;
  const expected = stock ?? CRYPTO.find(row => row.id === (asset === 'WETH' || asset === 'ETH' ? 'ETH' : 'cbBTC'))!;
  const marketId = stock ? ADDRESSES.aaveSpoke.toLowerCase() : CRYPTO.find(row => row.token === expected.token)!.morphoMarket;
  const rows = payload.markets.filter(row => object(row) && row.marketId === marketId && (!stock || row.collateralTokenAddress === stock.token.toLowerCase()));
  if (rows.length !== 1) return failed;
  const row = rows[0] as Record<string, unknown>;
  if (row.collateralSupplyAtomic !== collateralSupplyAtomic || row.collateralDecimals !== expected.decimals || row.loanDecimals !== 6 ||
      !object(row.still) || !atomic(row.still.availableAtomic) ||
      (row.still.debtAtomic !== undefined && !atomic(row.still.debtAtomic)) ||
      row.still.scope !== (collateralSupplyAtomic === '0' ? 'existing_collateral' : 'selected_collateral') ||
      (row.walletCollateralAtomic !== null && !atomic(row.walletCollateralAtomic)) ||
      (row.collateralAtomic !== null && !atomic(row.collateralAtomic)) ||
      !Number.isSafeInteger(row.blockNumber) || (row.blockNumber as number) <= 0) return failed;
  if (asset === 'ETH' && (collateralSupplyAtomic === '0' || row.funding !== 'native' || !atomic(row.nativeReserveAtomic) || row.nativeReserveAtomic === '0' || row.feeQuoteState !== 'wallet_quote_required')) return failed;
  if (asset !== 'ETH' && row.funding !== undefined) return failed;
  return {
    capacity: {
      ...(asset === 'ETH' ? { nativeReserve: tokenDecimalV1(row.nativeReserveAtomic as string, 18) } : {}),
      ...(atomic(row.still.debtAtomic) && row.still.debtAtomic !== '0'
        ? { existingDebt: tokenDecimalV1(row.still.debtAtomic, 6) }
        : {}),
      walletBalance: row.walletCollateralAtomic === null ? null : tokenDecimalV1(row.walletCollateralAtomic as string, expected.decimals),
      pledged: row.collateralAtomic === null ? null : tokenDecimalV1(row.collateralAtomic as string, expected.decimals),
      maximumUsdc: tokenDecimalV1(row.still.availableAtomic, 6), blockNumber: row.blockNumber as number,
      comparison: stillBorrowComparisonViewV1(row.comparison, asset),
    },
    error: null,
  };
}
