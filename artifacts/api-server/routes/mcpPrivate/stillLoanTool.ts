import { z } from 'zod';
import { ADDRESSES, CRYPTO, STOCKS } from '@mioagent/still-engine/registry';

import { issueLendingDraftV1 } from '../../lib/lendingDraft.js';

// ---------------------------------------------------------------------------
// A Still loan, prepared for the owner to review: stocks on Aave V4, cbBTC and
// WETH (or native ETH wrapped in the same transaction) on Morpho.
//
// The assistant gets a link and never a call. The link is the same signed,
// wallet-bound question Get money issues on the page, and opening it runs the
// whole gate again on a fresh block: the venue's state, Still's share, the
// simulation. Until 2026-11-01 the connected surface could prepare a review
// for the two Morpho markets only, so an assistant asked for a loan against
// NVDAc, Still's main case, had no way to start one.
// ---------------------------------------------------------------------------

export const STILL_LOAN_COLLATERAL_V1 = ['AAPLc', 'AMZNc', 'GOOGLc', 'METAc', 'MSFTc', 'NVDAc', 'TSLAc', 'cbBTC', 'WETH', 'ETH'] as const;
type StillLoanCollateralV1 = (typeof STILL_LOAN_COLLATERAL_V1)[number];

const DECIMAL_V1 = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/;

export const StillPrepareLoanReviewInputV1Schema = z.object({
  collateral: z.enum(STILL_LOAN_COLLATERAL_V1)
    .describe('The collateral: a Coinbase stock token (AAPLc … TSLAc) on Aave V4, or cbBTC, WETH, or native ETH (wrapped to WETH in the same transaction) on Morpho.'),
  addCollateral: z.string().regex(DECIMAL_V1)
    .describe('Tokens to pledge from this wallet with the loan, in whole-token units such as "0.05". "0" borrows against what is already pledged. For ETH, the exact ETH to wrap and pledge, above zero.'),
  borrowUsdc: z.string().regex(DECIMAL_V1).describe('USDC to borrow, such as "500".'),
}).strict();

/** Plain strings: SDK 1.29 serialises Zod's URL check as a pattern AJV refuses while listing tools. */
export const StillPrepareLoanReviewOutputV1Schema = z.object({
  reviewUrl: z.string(),
  expiresAt: z.string(),
  venue: z.enum(['aave-v4', 'morpho']),
  collateral: z.enum(STILL_LOAN_COLLATERAL_V1),
  addCollateral: z.string(),
  borrowUsdc: z.string(),
  next: z.string(),
}).strict();

export class StillLoanRefusalV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function unitsV1(text: string, decimals: number): bigint | null {
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
}

function tokenOfV1(collateral: StillLoanCollateralV1): { token: string; decimals: number; venue: 'aave-v4' | 'morpho' } {
  const stock = STOCKS.find((row) => row.id === collateral);
  if (stock) return { token: stock.token.toLowerCase(), decimals: stock.decimals, venue: 'aave-v4' };
  const crypto = CRYPTO.find((row) => row.id === (collateral === 'cbBTC' ? 'cbBTC' : 'ETH'))!;
  return { token: crypto.token.toLowerCase(), decimals: crypto.decimals, venue: 'morpho' };
}

export function stillPrepareLoanReviewV1(
  identity: { tenantId: string; walletAddress: string },
  args: z.infer<typeof StillPrepareLoanReviewInputV1Schema>,
  deps: { secret: string; now: Date; origin?: string },
): z.infer<typeof StillPrepareLoanReviewOutputV1Schema> {
  const { token, decimals, venue } = tokenOfV1(args.collateral);
  const supply = unitsV1(args.addCollateral, decimals);
  if (supply === null) {
    throw new StillLoanRefusalV1('still_loan_amount_invalid', `${args.collateral} has ${decimals} decimals; the amount to pledge has more.`);
  }
  const borrow = unitsV1(args.borrowUsdc, 6);
  if (borrow === null || borrow === 0n) {
    throw new StillLoanRefusalV1('still_loan_amount_invalid', 'The USDC to borrow is an amount above zero with at most six decimals.');
  }
  const native = args.collateral === 'ETH';
  if (native && supply === 0n) {
    throw new StillLoanRefusalV1('still_loan_amount_invalid', 'Native ETH is pledged by wrapping it in the same transaction, so its amount is above zero. To use WETH already pledged, choose WETH.');
  }
  if (native && token !== ADDRESSES.weth.toLowerCase()) throw new StillLoanRefusalV1('still_loan_unavailable', 'The WETH market is not the registered one.');
  if (deps.secret.length < 16) throw new StillLoanRefusalV1('still_loan_unavailable', 'Still cannot prepare a review on this server right now.');
  const wallet = identity.walletAddress.toLowerCase();
  const issued = issueLendingDraftV1({
    tenantId: identity.tenantId,
    walletAddress: wallet,
    question: {
      operation: 'borrow', collateralTokenAddress: token, borrowAssets: borrow.toString(), collateralSupplyAssets: supply.toString(),
      ...(native ? { nativeFundingAssets: supply.toString() } : {}),
    },
    secret: deps.secret,
    now: deps.now,
  });
  return {
    reviewUrl: `${deps.origin ?? 'https://stills.lat'}/lending/${issued.draft}`,
    expiresAt: issued.expiresAt,
    venue,
    collateral: args.collateral,
    addCollateral: args.addCollateral,
    borrowUsdc: args.borrowUsdc,
    next: 'Give the user this link. It opens a review for this wallet only, signed in with it, and works for five minutes. The page reads the position again, applies Still’s limit and simulates the exact calls before the user’s own wallet opens; if the limit does not allow this amount, the page says so. Nothing has been sent.',
  };
}
