import { CRYPTO, STOCKS } from '@mioagent/still-engine/registry';
import { parseBorrowDecimalV1 } from '../still/borrowIntent';
import { tokenDecimalV1 } from './stockSellAmount';

export const REPAY_COLLATERALS_V1 = [
  ...CRYPTO.map(asset => ({ id: asset.id === 'ETH' ? 'WETH' : asset.id, symbol: asset.id === 'ETH' ? 'WETH' : asset.id,
    token: asset.token.toLowerCase(), decimals: asset.decimals, venue: 'morpho' as const })),
  ...STOCKS.map(asset => ({ id: asset.id, symbol: asset.id, token: asset.token.toLowerCase(), decimals: asset.decimals, venue: 'aave-v4' as const })),
] as const;
export interface RepayCapacityWireV1 {
  venue: 'morpho' | 'aave-v4'; marketId: string; collateralTokenAddress: string; collateralSymbol: string;
  collateralDecimals: number; debtAtomic: string; walletUsdcAtomic: string; blockNumber: number;
  /** The collateral deposited (a stock on Aave V4, cbBTC or WETH on Morpho), which Repay all can take back. */
  collateralAtomic?: string;
}
/** How a repayment is asked: an exact amount, all of it, or all of it and the stock back. */
export type RepayModeV1 = 'assets' | 'all' | 'return';

/** Whether this read offers the collateral back: some is deposited. */
export function repayCanReturnV1(read: Pick<RepayCapacityWireV1, 'collateralAtomic'> | null): boolean {
  return read?.collateralAtomic !== undefined && BigInt(read.collateralAtomic) > BigInt(0);
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
      !atomic(row.debtAtomic) || !atomic(row.walletUsdcAtomic) || !Number.isSafeInteger(row.blockNumber) || (row.blockNumber as number) <= 0 ||
      (row.collateralAtomic !== undefined && !atomic(row.collateralAtomic))) return fail;
  return { read: row as unknown as RepayCapacityWireV1, error: null };
}
export function repayIntentAmountsV1(input: { mode: RepayModeV1; amount: string; maximum: string; walletUsdcAtomic: string; debtAtomic?: string }): {
  intent: { amountMode: 'assets' | 'all'; repayAmountAtomic: string | null; maximumUsdcAtomic: string; returnCollateral?: true } | null; error: string | null;
} {
  // Nothing owed: taking the stock back spends no USDC, so no maximum is asked.
  if (input.mode === 'return' && input.debtAtomic === '0') return { intent: { amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '0', returnCollateral: true }, error: null };
  const exact = parseBorrowDecimalV1(input.mode === 'assets' ? input.amount : input.maximum, 6);
  if (exact.atomic === null) return { intent: null, error: exact.error };
  if (!atomic(input.walletUsdcAtomic)) return { intent: null, error: 'The wallet USDC balance has not been read.' };
  // Repay all closes the loan, so its bound must cover the debt the wallet holds the USDC for.
  if (input.mode !== 'assets' && input.debtAtomic !== undefined && atomic(input.debtAtomic) && BigInt(input.debtAtomic) > BigInt(0)) {
    const short = repayShortTextV1({ debtAtomic: input.debtAtomic, walletUsdcAtomic: input.walletUsdcAtomic });
    if (short) return { intent: null, error: short };
    if (BigInt(exact.atomic) < BigInt(input.debtAtomic)) {
      return { intent: null, error: `The debt is ${usdcTextV1(input.debtAtomic)} now, more than this maximum of ${usdcTextV1(exact.atomic)}: interest adds to it every second. Set the maximum to at least the debt; what is not needed stays in your wallet.` };
    }
  }
  if (BigInt(exact.atomic) > BigInt(input.walletUsdcAtomic)) return { intent: null, error: 'The chosen USDC funding exceeds the balance read for this wallet.' };
  return { intent: { amountMode: input.mode === 'assets' ? 'assets' : 'all', repayAmountAtomic: input.mode === 'assets' ? exact.atomic : null, maximumUsdcAtomic: exact.atomic,
    ...(input.mode === 'return' ? { returnCollateral: true as const } : {}) }, error: null };
}

/** What Max fills on Repay, from the position just read: the smaller of the
 * debt and the wallet's USDC, or for Repay all the wallet's USDC as the bound.
 * Interest can move the exact debt before the transaction, which is why
 * Repay all, with a bound, is the way to close a loan completely. */
export function repayMaxV1(read: Pick<RepayCapacityWireV1, 'debtAtomic' | 'walletUsdcAtomic'>, mode: RepayModeV1): string {
  const wallet = BigInt(read.walletUsdcAtomic), debt = BigInt(read.debtAtomic);
  return (mode !== 'assets' || wallet < debt ? wallet : debt).toString();
}

const usdcTextV1 = (atomicUsdc: string | bigint) => `${tokenDecimalV1(atomicUsdc.toString(), 6)} USDC`;

/** What a wallet short of its debt adds before Repay all: the shortfall rounded up to the
 * cent, and one cent more for the interest that keeps accruing until it is signed. */
export function repayTopUpAtomicV1(read: Pick<RepayCapacityWireV1, 'debtAtomic' | 'walletUsdcAtomic'>): bigint | null {
  const short = BigInt(read.debtAtomic) - BigInt(read.walletUsdcAtomic), cent = BigInt(10_000);
  return short > BigInt(0) ? ((short + cent - BigInt(1)) / cent) * cent + cent : null;
}

/** Why Repay all cannot be prepared from this wallet yet, in its own numbers (2026-11-03: a
 * wallet holding the 2 USDC it borrowed owed 2.000003 eleven minutes later). */
export function repayShortTextV1(read: Pick<RepayCapacityWireV1, 'debtAtomic' | 'walletUsdcAtomic'>): string | null {
  const add = repayTopUpAtomicV1(read);
  if (add === null) return null;
  const short = BigInt(read.debtAtomic) - BigInt(read.walletUsdcAtomic);
  return `This wallet holds ${usdcTextV1(read.walletUsdcAtomic)} and the debt is ${usdcTextV1(read.debtAtomic)} now, ${usdcTextV1(short)} short. `
    + `Interest adds to the debt every second, so add a little more than that, for example ${usdcTextV1(add)}, then read the position again.`;
}

