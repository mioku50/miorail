import { CRYPTO, STOCKS } from '@mioagent/still-engine/registry';
import { parseBorrowDecimalV1 } from '../still/borrowIntent';

export const REPAY_COLLATERALS_V1 = [
  ...CRYPTO.map(asset => ({ id: asset.id === 'ETH' ? 'WETH' : asset.id, symbol: asset.id === 'ETH' ? 'WETH' : asset.id,
    token: asset.token.toLowerCase(), decimals: asset.decimals, venue: 'morpho' as const })),
  ...STOCKS.map(asset => ({ id: asset.id, symbol: asset.id, token: asset.token.toLowerCase(), decimals: asset.decimals, venue: 'aave-v4' as const })),
] as const;
export interface RepayCapacityWireV1 {
  venue: 'morpho' | 'aave-v4'; marketId: string; collateralTokenAddress: string; collateralSymbol: string;
  collateralDecimals: number; debtAtomic: string; walletUsdcAtomic: string; blockNumber: number;
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const atomic = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(v);

export function repayInitialAssetV1(search: string): string | null {
  const params = new URLSearchParams(search), raw = params.get('asset'), requested = raw === 'ETH' ? 'WETH' : raw, token = params.get('token')?.toLowerCase();
  return REPAY_COLLATERALS_V1.find(asset => asset.id === requested || asset.token === token)?.id ?? null;
}
export function repayCapacityViewV1(payload: unknown, token: string): { read: RepayCapacityWireV1 | null; error: string | null } {
  const fail = { read: null, error: 'The repayment position could not be read. Read it again before preparing a review.' };
  const known = REPAY_COLLATERALS_V1.find(asset => asset.token === token.toLowerCase());
  if (!known || !object(payload)) return fail;
  if (payload.state === 'refused') return { read: null, error: typeof payload.detail === 'string' ? payload.detail : 'The server could not establish this repayment position.' };
  const row = payload.read;
  if (payload.state !== 'read' || !object(row) || row.venue !== known.venue || row.collateralTokenAddress !== known.token ||
      row.collateralSymbol !== known.symbol || row.collateralDecimals !== known.decimals || typeof row.marketId !== 'string' ||
      !atomic(row.debtAtomic) || !atomic(row.walletUsdcAtomic) || !Number.isSafeInteger(row.blockNumber) || (row.blockNumber as number) <= 0) return fail;
  return { read: row as unknown as RepayCapacityWireV1, error: null };
}
export function repayIntentAmountsV1(input: { mode: 'assets' | 'all'; amount: string; maximum: string; walletUsdcAtomic: string }): {
  intent: { amountMode: 'assets' | 'all'; repayAmountAtomic: string | null; maximumUsdcAtomic: string } | null; error: string | null;
} {
  const exact = parseBorrowDecimalV1(input.mode === 'assets' ? input.amount : input.maximum, 6);
  if (exact.atomic === null) return { intent: null, error: exact.error };
  if (!atomic(input.walletUsdcAtomic)) return { intent: null, error: 'The wallet USDC balance has not been read.' };
  if (BigInt(exact.atomic) > BigInt(input.walletUsdcAtomic)) return { intent: null, error: 'The chosen USDC funding exceeds the balance read for this wallet.' };
  return { intent: { amountMode: input.mode, repayAmountAtomic: input.mode === 'assets' ? exact.atomic : null, maximumUsdcAtomic: exact.atomic }, error: null };
}
