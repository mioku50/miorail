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
  /** The collateral deposited (a stock on Aave V4, cbBTC, WETH or PAXG on Morpho), which Repay all can take back. */
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
/** Whether a typed exact amount is the whole debt read, or more. An exact
 * repayment repays part of a loan; all of it is Repay all's (2026-11-07: Max
 * put the Morpho debt shown, 0.840001 USDC, in Exact USDC, and the review was
 * refused, since that debt's shares were worth a little less). */
export function repayExactCoversDebtV1(amount: string, debtAtomic: string): boolean {
  const exact = parseBorrowDecimalV1(amount, 6);
  return exact.atomic !== null && atomic(debtAtomic) && BigInt(debtAtomic) > BigInt(0) && BigInt(exact.atomic) >= BigInt(debtAtomic);
}

/** Why an exact amount at or above the debt is not offered, in the position's own numbers. */
export function repayExactWholeDebtTextV1(read: Pick<RepayCapacityWireV1, 'debtAtomic' | 'blockNumber' | 'venue'>): string {
  return `That is the whole debt, or more: ${usdcTextV1(read.debtAtomic)} at block ${read.blockNumber.toLocaleString('en-US')}. `
    + 'An exact amount repays part of a loan, so it has to be less than the debt'
    + (read.venue === 'morpho' ? '. Morpho keeps a debt as shares, and the debt shown is rounded up, so this exact amount is more than what is owed. ' : '. ')
    + 'To repay all of it, choose Repay all debt: it pays what is owed when your transaction lands, interest included, and leaves nothing behind.';
}

export function repayIntentAmountsV1(input: { mode: RepayModeV1; amount: string; maximum: string; walletUsdcAtomic: string; debtAtomic?: string; blockNumber?: number; venue?: RepayCapacityWireV1['venue'] }): {
  intent: { amountMode: 'assets' | 'all'; repayAmountAtomic: string | null; maximumUsdcAtomic: string; returnCollateral?: true } | null; error: string | null;
} {
  // Nothing owed: taking the stock back spends no USDC, so no maximum is asked.
  if (input.mode === 'return' && input.debtAtomic === '0') return { intent: { amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '0', returnCollateral: true }, error: null };
  const exact = parseBorrowDecimalV1(input.mode === 'assets' ? input.amount : input.maximum, 6);
  if (exact.atomic === null) return { intent: null, error: exact.error };
  if (!atomic(input.walletUsdcAtomic)) return { intent: null, error: 'The wallet USDC balance has not been read.' };
  if (input.mode === 'assets' && input.debtAtomic !== undefined && repayExactCoversDebtV1(input.amount, input.debtAtomic)) {
    return { intent: null, error: repayExactWholeDebtTextV1({ debtAtomic: input.debtAtomic, blockNumber: input.blockNumber ?? 0, venue: input.venue ?? 'morpho' }) };
  }
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

/** The bound Max offers for Repay all: the debt read, rounded up to the cent,
 * and a margin for the interest that accrues until the transaction lands. The
 * margin is one cent, or 0.1% of the debt when that is more, rounded up to the
 * cent; 0.1% is about three and a half days of interest at 10% a year. The
 * contract takes what is owed when it lands and the rest stays in the wallet,
 * so a bound only has to be enough, and one near the debt leaves a small
 * allowance behind (2026-11-10, the operator: Max put all 171.8 USDC of the
 * wallet in as the bound for a debt of 0.850328 USDC). */
export function repayAllBoundAtomicV1(debtAtomic: string): bigint {
  const debt = BigInt(debtAtomic), cent = BigInt(10_000);
  const upToCent = (value: bigint) => ((value + cent - BigInt(1)) / cent) * cent;
  const perMille = upToCent((debt + BigInt(999)) / BigInt(1_000));
  return upToCent(debt) + (perMille > cent ? perMille : cent);
}

/** What Max does on Repay, from the position just read. For Repay all, the
 * debt and its margin for interest (repayAllBoundAtomicV1) go in as the bound,
 * or the wallet's USDC when it holds less. For an exact amount, the wallet's
 * USDC when it is short of the debt; when it covers the debt, the most it can
 * repay is all of it, which only Repay all does, so Max moves there with that
 * bound. Interest moves the exact debt every second, and a Morpho debt shown
 * is rounded up from its shares: an exact amount equal to it is refused, and
 * on Aave it would leave the interest since the read. */
export function repayMaxV1(read: Pick<RepayCapacityWireV1, 'debtAtomic' | 'walletUsdcAtomic'>, mode: RepayModeV1): { mode: RepayModeV1; atomic: string } {
  const wallet = BigInt(read.walletUsdcAtomic), debt = BigInt(read.debtAtomic);
  const next = mode === 'assets' && wallet >= debt ? 'all' : mode;
  if (next === 'assets') return { mode: next, atomic: wallet.toString() };
  const bound = repayAllBoundAtomicV1(read.debtAtomic);
  return { mode: next, atomic: (bound < wallet ? bound : wallet).toString() };
}

const usdcTextV1 = (atomicUsdc: string | bigint) => `${tokenDecimalV1(atomicUsdc.toString(), 6)} USDC`;

/** What a wallet short of its debt adds before Repay all: the shortfall rounded up to the
 * cent, and one cent more for the interest that keeps accruing until it is signed. */
export function repayTopUpAtomicV1(read: Pick<RepayCapacityWireV1, 'debtAtomic' | 'walletUsdcAtomic'>): bigint | null {
  const short = BigInt(read.debtAtomic) - BigInt(read.walletUsdcAtomic), cent = BigInt(10_000);
  return short > BigInt(0) ? ((short + cent - BigInt(1)) / cent) * cent + cent : null;
}

/** Why Repay all cannot be prepared from this wallet yet, in its own numbers (2026-11-03: a
 * wallet holding the 2 USDC it borrowed owed 2.000003 eleven minutes later). It says where the
 * USDC goes: on 2026-11-07 a wallet holding the 0.85 USDC it had just borrowed owed 0.850001,
 * and "add a little more" read as an error, not as USDC to send to the wallet. */
export function repayShortTextV1(read: Pick<RepayCapacityWireV1, 'debtAtomic' | 'walletUsdcAtomic'>): string | null {
  const add = repayTopUpAtomicV1(read);
  if (add === null) return null;
  const short = BigInt(read.debtAtomic) - BigInt(read.walletUsdcAtomic);
  // Under a cent short, the wallet holds about what it borrowed: the debt passed it by rounding and interest alone.
  const send = short < BigInt(10_000)
    ? 'A debt is counted rounded up and grows every second, so the USDC a loan paid out never quite covers it. Send this wallet a little more USDC'
    : 'Interest adds to the debt every second, so send this wallet a little more USDC than that';
  return `This wallet holds ${usdcTextV1(read.walletUsdcAtomic)} and the debt is ${usdcTextV1(read.debtAtomic)} now, ${usdcTextV1(short)} short. `
    + `${send}, for example ${usdcTextV1(add)}, then read the position again.`;
}

