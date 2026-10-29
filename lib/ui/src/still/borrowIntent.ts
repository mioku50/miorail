import { CRYPTO, STOCKS, ADDRESSES } from '@mioagent/still-engine/registry';
import { tokenDecimalV1 } from '../console/stockSellAmount';
import type { StillBorrowAssetV1, StillBorrowModelV1 } from './StillBorrow';

/** The host accepts a label from a query, never an arbitrary token address. */
export function borrowAssetFromQueryV1(value: string | null): StillBorrowAssetV1 | null {
  return value === 'cbBTC' || value === 'WETH' ? value : STOCKS.find(stock => stock.id === value)?.id ?? null;
}

export function borrowCollateralTokenV1(asset: StillBorrowAssetV1): `0x${string}` {
  return [...STOCKS, ...CRYPTO].find(row => row.id === (asset === 'WETH' ? 'ETH' : asset))!.token;
}

export function borrowCollateralDecimalsV1(asset: StillBorrowAssetV1): number {
  return asset === 'WETH' ? 18 : 8;
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

/** Format the server's own allowance for the selected pledge. Missing data
 * remains unread; a different market/amount cannot become this form's quote. */
export function stillBorrowCapacityViewV1(payload: unknown, asset: StillBorrowAssetV1, collateralSupplyAtomic: string): {
  capacity: StillBorrowModelV1['capacity']; error: string | null;
} {
  const failed = { capacity: null, error: 'The borrowing limit could not be read. Read it again before continuing.' };
  if (!object(payload)) return failed;
  if (payload.state === 'refused') return { capacity: null, error: typeof payload.detail === 'string' ? payload.detail : 'The server could not establish a borrowing limit for this collateral.' };
  const stock = STOCKS.find(row => row.id === asset);
  if (payload.state !== 'read' || payload.marketScope !== (stock ? 'still_aave_spoke' : 'still_registered_market') || !Array.isArray(payload.markets)) return failed;
  const expected = stock ?? CRYPTO.find(row => row.id === (asset === 'WETH' ? 'ETH' : 'cbBTC'))!;
  const marketId = stock ? ADDRESSES.aaveSpoke.toLowerCase() : CRYPTO.find(row => row.token === expected.token)!.morphoMarket;
  const rows = payload.markets.filter(row => object(row) && row.marketId === marketId && (!stock || row.collateralTokenAddress === stock.token.toLowerCase()));
  if (rows.length !== 1) return failed;
  const row = rows[0] as Record<string, unknown>;
  if (row.collateralSupplyAtomic !== collateralSupplyAtomic || row.collateralDecimals !== expected.decimals || row.loanDecimals !== 6 ||
      !object(row.still) || !atomic(row.still.availableAtomic) ||
      row.still.scope !== (collateralSupplyAtomic === '0' ? 'existing_collateral' : 'selected_collateral') ||
      (row.walletCollateralAtomic !== null && !atomic(row.walletCollateralAtomic)) ||
      (row.collateralAtomic !== null && !atomic(row.collateralAtomic)) ||
      !Number.isSafeInteger(row.blockNumber) || (row.blockNumber as number) <= 0) return failed;
  return {
    capacity: {
      walletBalance: row.walletCollateralAtomic === null ? null : tokenDecimalV1(row.walletCollateralAtomic as string, expected.decimals),
      pledged: row.collateralAtomic === null ? null : tokenDecimalV1(row.collateralAtomic as string, expected.decimals),
      maximumUsdc: tokenDecimalV1(row.still.availableAtomic, 6), blockNumber: row.blockNumber as number,
    },
    error: null,
  };
}
