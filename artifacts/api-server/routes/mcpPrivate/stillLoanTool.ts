import { z } from 'zod';
import { SPEND_EMAIL_V1 } from '@mioagent/commerce-engine';
import { ADDRESSES, CRYPTO, STOCKS } from '@mioagent/still-engine/registry';

import { issueLendingDraftV1 } from '../../lib/lendingDraft.js';
import { STILL_PUBLIC_ORIGIN_V1 } from '../../lib/stillOrigin.js';
import { STILL_SPEND_REVIEW_MARGIN_MS_V1, spendDraftPaymentV1 } from '../../lib/stillSpendOrders.js';
import { openSpendOrderV1, stillSpendRuntimeV1, type SpendOrderOpenedV1 } from '../stillSpend.js';
import { SPEND_ID_V1 } from '../stillPublic.js';

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

export const STILL_LOAN_COLLATERAL_V1 = ['AAPLc', 'AMZNc', 'GOOGLc', 'METAc', 'MSFTc', 'NVDAc', 'SPCXc', 'TSLAc', 'cbBTC', 'WETH', 'ETH'] as const;
type StillLoanCollateralV1 = (typeof STILL_LOAN_COLLATERAL_V1)[number];
/** A purchase and a repayment name a loan by its token: native ETH is pledged as WETH. */
export const STILL_TOKEN_COLLATERAL_V1 = ['AAPLc', 'AMZNc', 'GOOGLc', 'METAc', 'MSFTc', 'NVDAc', 'SPCXc', 'TSLAc', 'cbBTC', 'WETH'] as const;

const DECIMAL_V1 = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/;

export const StillPrepareLoanReviewInputV1Schema = z.object({
  collateral: z.enum(STILL_LOAN_COLLATERAL_V1)
    .describe('The collateral: a Coinbase stock token (AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, SPCXc, TSLAc) on Aave V4, or cbBTC, WETH, or native ETH (wrapped to WETH in the same transaction) on Morpho.'),
  addCollateral: z.string().regex(DECIMAL_V1)
    .describe('Tokens to pledge from this wallet with the loan, in whole-token units such as "0.05". "0" borrows against what is already pledged. For ETH, the exact ETH to wrap and pledge, above zero.'),
  borrowUsdc: z.string().regex(DECIMAL_V1).describe('USDC to borrow, such as "500".'),
}).strict();

/** Plain strings: SDK 1.29 serialises Zod's URL check as a pattern AJV refuses while listing tools. */
export const StillPrepareLoanReviewOutputV1Schema = z.object({
  reviewUrl: z.string(),
  /** For miorail_get_still_review_status, once the user has opened the link. */
  reviewId: z.string(),
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
    reviewUrl: `${deps.origin ?? STILL_PUBLIC_ORIGIN_V1}/lending/${issued.draft}`,
    reviewId: issued.draftId,
    expiresAt: issued.expiresAt,
    venue,
    collateral: args.collateral,
    addCollateral: args.addCollateral,
    borrowUsdc: args.borrowUsdc,
    next: 'Give the user this link. It opens a review for this wallet only, signed in with it, and works for five minutes. The page reads the position again, applies Still’s limit and simulates the exact calls before the user’s own wallet opens; if the limit does not allow this amount, the page says so. Nothing has been sent. After the user signs, miorail_get_still_review_status with reviewId reads what happened.',
  };
}

// ---------------------------------------------------------------------------
// A Still Spend purchase, prepared the same way: Bitrefill's invoice is opened
// for this wallet exactly as the Spend page opens it, and the link is the
// review of the loan that pays it, borrowing exactly its price. The email and
// a top-up's number go to Bitrefill only; neither is logged, kept with the
// loan or repeated back to the assistant.
// ---------------------------------------------------------------------------

export const StillPreparePurchaseInputV1Schema = z.object({
  productId: z.string().regex(SPEND_ID_V1).describe('The Bitrefill product id, from still_find_spend.'),
  packageValue: z.string().min(1).max(80).describe('One package’s value exactly as still_spend_product lists it, such as "10GB, 30 Days" or "50".'),
  email: z.string().max(254).regex(SPEND_EMAIL_V1)
    .describe('The email address the USER gave for Bitrefill’s receipt and order. Never guess one. It goes to Bitrefill and is not kept by Still.'),
  phone: z.string().min(1).max(32).optional()
    .describe('A phone top-up only: the number it goes to, as the USER gave it, in international format starting with the calling code still_spend_product lists. A top-up sent to a wrong number cannot be taken back.'),
  collateral: z.enum(STILL_TOKEN_COLLATERAL_V1)
    .describe('What the loan is against: a Coinbase stock token (AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, SPCXc, TSLAc) on Aave V4, or cbBTC or WETH on Morpho. Native ETH cannot pay a purchase; WETH can.'),
  addCollateral: z.string().regex(DECIMAL_V1)
    .describe('Tokens to pledge from this wallet with the loan, in whole-token units such as "0.05". "0" borrows against what is already pledged.'),
}).strict();

export const StillPreparePurchaseOutputV1Schema = z.object({
  reviewUrl: z.string(),
  reviewId: z.string(),
  expiresAt: z.string(),
  venue: z.enum(['aave-v4', 'morpho']),
  collateral: z.enum(STILL_TOKEN_COLLATERAL_V1),
  addCollateral: z.string(),
  borrowUsdc: z.string(),
  purchase: z.object({
    productId: z.string(),
    productName: z.string(),
    packageValue: z.string(),
    faceCurrency: z.string().nullable(),
    priceUsdc: z.string(),
    /** Bitrefill holds this price until then. */
    invoiceExpiresAt: z.string(),
  }).strict(),
  next: z.string(),
}).strict();

/** What each refusal means to the person, in the Spend page's terms. */
const SPEND_REFUSALS_V1: Readonly<Record<string, string>> = {
  spend_rate_limited: 'Still opens at most six Bitrefill invoices an hour for one wallet, and this wallet has opened six. This is Still’s own limit, not Bitrefill’s, and an invoice that was refused does not count. Wait before opening another; nothing was opened.',
  bitrefill_rate_limited: 'Bitrefill asked Still to slow down, so no invoice was opened. Nothing was paid; try again in a minute.',
  bitrefill_unreachable: 'Still could not reach Bitrefill just now, so no invoice was opened. Nothing was paid; try again in a minute.',
  bitrefill_invalid_response: 'Bitrefill answered in a way Still could not read, so Still kept no invoice. Nothing was paid; try again in a minute.',
  bitrefill_product_not_found: 'Bitrefill has no product with this id. Find it again with still_find_spend; nothing was opened.',
  spend_product_prepayment: 'Bitrefill sells this only after its prepayment steps, such as a game’s player ID, and it does not offer those steps to Still. Still cannot buy it; nothing was opened.',
  spend_product_not_buyable: 'Bitrefill has it out of stock, or it needs an account or a username, which Still does not send. Nothing was opened.',
  spend_request_invalid: 'This product is not a phone top-up, so it takes no number. Nothing was opened.',
  spend_phone_needed: 'A phone top-up needs the number it goes to, from the user, in international format. Nothing was opened.',
  spend_phone_invalid: 'The number does not start with the calling code of this top-up’s country (still_spend_product lists it), so it was not sent to Bitrefill. Nothing was opened.',
  spend_package_not_offered: 'Bitrefill does not offer this package at a price now. Read still_spend_product again and give a package value exactly as listed; nothing was opened.',
  spend_over_cap: 'One purchase is at most 100 USDC for now. Nothing was opened.',
  bitrefill_invoice_price_changed: 'Bitrefill’s invoice asked a different amount than the price it quoted a moment before, so Still did not keep it. Nothing was paid; read the product again.',
  spend_payee_refused: 'Bitrefill asked to be paid to this wallet itself, so Still did not keep the invoice. Nothing was paid.',
};

/** An invoice that was not opened, in the Spend page's terms, whose refusal it was included. */
function spendOrderRefusalV1(opened: Extract<SpendOrderOpenedV1, { ok: false }>): StillLoanRefusalV1 {
  // Bitrefill not letting Still in is about every product, and the words say so.
  return new StillLoanRefusalV1(opened.error, opened.error === 'bitrefill_guest_refused'
    ? `Bitrefill is not letting Still in right now${opened.detail ? `, and said: “${opened.detail}”` : ''}. Until that changes Still cannot open an invoice for any product: it is not about this one, and trying again will not help. Nothing was opened or paid.`
    : SPEND_REFUSALS_V1[opened.error] ?? (opened.detail
      ? `Bitrefill refused to open the invoice and said: “${opened.detail}” Nothing was paid.`
      : 'Bitrefill could not open the invoice right now. This is Bitrefill’s failure or ours; nothing was paid.'));
}

export async function stillPreparePurchaseV1(
  identity: { tenantId: string; walletAddress: string },
  args: z.infer<typeof StillPreparePurchaseInputV1Schema>,
  deps: { secret: string; now: Date; origin?: string },
): Promise<z.infer<typeof StillPreparePurchaseOutputV1Schema>> {
  // Everything that can be refused here is, before an invoice exists at Bitrefill.
  const { token, decimals, venue } = tokenOfV1(args.collateral);
  const supply = unitsV1(args.addCollateral, decimals);
  if (supply === null) {
    throw new StillLoanRefusalV1('still_loan_amount_invalid', `${args.collateral} has ${decimals} decimals; the amount to pledge has more.`);
  }
  if (deps.secret.length < 16) throw new StillLoanRefusalV1('still_loan_unavailable', 'Still cannot prepare a review on this server right now.');
  if (!stillSpendRuntimeV1.enabled()) {
    throw new StillLoanRefusalV1('spend_pay_off', 'Still does not pay Bitrefill from a loan on this server right now. Nothing was opened.');
  }
  const owner = { tenantId: identity.tenantId, walletAddress: identity.walletAddress.toLowerCase() };
  const opened = await openSpendOrderV1(owner, {
    productId: args.productId, packageValue: args.packageValue, email: args.email, ...(args.phone !== undefined ? { phone: args.phone } : {}),
  });
  if (!opened.ok) throw spendOrderRefusalV1(opened);
  const order = opened.order, payment = spendDraftPaymentV1(order, deps.now);
  if (!payment) throw new StillLoanRefusalV1('spend_order_expiring', 'Bitrefill holds this price too briefly for a review to be signed. Nothing was paid; prepare it again.');
  const issued = issueLendingDraftV1({
    tenantId: owner.tenantId,
    walletAddress: owner.walletAddress,
    question: { operation: 'borrow', collateralTokenAddress: token, borrowAssets: order.priceAtomic, collateralSupplyAssets: supply.toString(), payment },
    secret: deps.secret,
    now: deps.now,
  });
  const price = usdcTextV1(BigInt(order.priceAtomic));
  return {
    reviewUrl: `${deps.origin ?? STILL_PUBLIC_ORIGIN_V1}/lending/${issued.draft}`,
    reviewId: issued.draftId,
    expiresAt: issued.expiresAt,
    venue,
    collateral: args.collateral,
    addCollateral: args.addCollateral,
    borrowUsdc: price,
    purchase: {
      productId: order.productId, productName: order.productName, packageValue: order.packageValue, faceCurrency: order.faceCurrency,
      priceUsdc: price, invoiceExpiresAt: order.expiresAt,
    },
    next: 'Give the user this link. It opens a review for this wallet only, signed in with it, and works for five minutes; Bitrefill holds the price until purchase.invoiceExpiresAt. The review borrows exactly the price and pays the invoice from the loan, after reading the position again, applying Still’s limit and simulating the exact calls. A wallet that cannot send a batch (Rabby, or Coinbase Wallet with an imported key) takes a loan against a stock in steps, the payment last; against cbBTC or WETH it needs Base Account, Coinbase Wallet (Base App) or MetaMask. Bitrefill emails the receipt and the order to the address the user gave. Nothing has been borrowed or paid. After the user signs, miorail_get_still_review_status with reviewId reads what happened, Bitrefill’s invoice included.',
  };
}

// ---------------------------------------------------------------------------
// A purchase paid from the USDC already in the wallet, with no loan, as Spend
// pays it since 2026-11-03 (/spend/pay/<invoice>). The assistant gets the link
// to that page, which reads Bitrefill's invoice and the wallet again, simulates
// the one transfer of exactly the price to the invoice address, and has the
// owner's own wallet sign it. On 2026-11-04 an assistant asked to buy a $0.18
// card, with $0.14 left to borrow, could only offer to repay or pledge more:
// this surface paid only with a loan and did not show the wallet's USDC.
// ---------------------------------------------------------------------------

export const StillPrepareWalletPurchaseInputV1Schema = StillPreparePurchaseInputV1Schema.omit({ collateral: true, addCollateral: true });

export const StillPrepareWalletPurchaseOutputV1Schema = z.object({
  reviewUrl: z.string(),
  /** The invoice, for miorail_get_still_review_status once the user has opened the page. */
  reviewId: z.string(),
  /** Until then the page can prepare the payment; Bitrefill holds the price until purchase.invoiceExpiresAt. */
  expiresAt: z.string(),
  paidFrom: z.literal('wallet'),
  /** The wallet's own USDC, read at its own Base block before the invoice was opened. */
  walletUsdc: z.object({ usdc: z.string(), block: z.string() }).strict(),
  purchase: StillPreparePurchaseOutputV1Schema.shape.purchase,
  next: z.string(),
}).strict();

export async function stillPrepareWalletPurchaseV1(
  identity: { tenantId: string; walletAddress: string },
  args: z.infer<typeof StillPrepareWalletPurchaseInputV1Schema>,
  deps: { now: Date; origin?: string; readUsdc: (wallet: string) => Promise<{ raw: string; decimals: number; block: string } | null> },
): Promise<z.infer<typeof StillPrepareWalletPurchaseOutputV1Schema>> {
  if (!stillSpendRuntimeV1.enabled()) {
    throw new StillLoanRefusalV1('spend_pay_off', 'Still does not pay Bitrefill on this server right now. Nothing was opened.');
  }
  const owner = { tenantId: identity.tenantId, walletAddress: identity.walletAddress.toLowerCase() };
  // The wallet's USDC first: an invoice it cannot pay is not opened, and Still opens six an hour for one wallet.
  const held = await deps.readUsdc(owner.walletAddress).catch(() => null);
  if (!held || held.decimals !== 6 || !/^(0|[1-9][0-9]{0,77})$/.test(held.raw) || !/^[1-9][0-9]{0,15}$/.test(held.block)) {
    throw new StillLoanRefusalV1('spend_wallet_usdc_unread', 'This wallet’s USDC could not be read from Base just now, so no invoice was opened. This is our failure, not an empty wallet; try again in a minute.');
  }
  const balance = BigInt(held.raw);
  const opened = await openSpendOrderV1(owner, {
    productId: args.productId, packageValue: args.packageValue, email: args.email, ...(args.phone !== undefined ? { phone: args.phone } : {}),
  }, { payableAtomic: balance });
  if (!opened.ok) {
    if (opened.error === 'spend_wallet_usdc_short') {
      throw new StillLoanRefusalV1(opened.error, `This wallet holds ${usdcTextV1(balance)} USDC at Base block ${held.block}, and this package costs ${
        opened.priceAtomic ? `${usdcTextV1(BigInt(opened.priceAtomic))} USDC` : 'more'}, so no invoice was opened. A loan from Still can pay it instead (miorail_prepare_still_purchase), within what this wallet can borrow.`);
    }
    throw spendOrderRefusalV1(opened);
  }
  const order = opened.order;
  if (!spendDraftPaymentV1(order, deps.now)) {
    throw new StillLoanRefusalV1('spend_order_expiring', 'Bitrefill holds this price too briefly for the payment to be signed. Nothing was paid; prepare it again.');
  }
  const price = usdcTextV1(BigInt(order.priceAtomic));
  return {
    reviewUrl: `${deps.origin ?? STILL_PUBLIC_ORIGIN_V1}/spend/pay/${order.orderId}`,
    reviewId: order.orderId,
    // The page prepares a payment only while Bitrefill holds the price this much longer (spendDraftPaymentV1).
    expiresAt: new Date(Date.parse(order.expiresAt) - STILL_SPEND_REVIEW_MARGIN_MS_V1 - 60_000).toISOString(),
    paidFrom: 'wallet',
    walletUsdc: { usdc: usdcTextV1(balance), block: held.block },
    purchase: {
      productId: order.productId, productName: order.productName, packageValue: order.packageValue, faceCurrency: order.faceCurrency,
      priceUsdc: price, invoiceExpiresAt: order.expiresAt,
    },
    next: `Give the user this link. It opens Spend’s payment page for this wallet only, signed in with it: the page reads Bitrefill’s invoice and the wallet’s USDC again, simulates the one transfer of exactly ${price} USDC to the invoice address, and the user’s own wallet signs it. No loan is taken. The page can prepare the payment until expiresAt; Bitrefill holds the price until purchase.invoiceExpiresAt. Bitrefill emails the receipt and the order to the address the user gave. Nothing has been paid. After the user pays, miorail_get_still_review_status with reviewId reads what happened, Bitrefill’s invoice included.`,
  };
}

// ---------------------------------------------------------------------------
// A repayment, prepared the same way as Still's Repay page: an exact amount,
// or all of it up to a bound the user agreed to, because interest moves the
// exact debt between the reading and the block.
// ---------------------------------------------------------------------------

export const StillPrepareRepayInputV1Schema = z.object({
  collateral: z.enum(STILL_TOKEN_COLLATERAL_V1)
    .describe('The loan, by its collateral: a Coinbase stock token (AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, SPCXc, TSLAc) on Aave V4, or cbBTC or WETH on Morpho (WETH also for a loan opened with native ETH).'),
  repayUsdc: z.union([z.string().regex(DECIMAL_V1), z.literal('all')])
    .describe('USDC to pay back from this wallet, such as "50", or "all" to close the loan with its interest.'),
  maximumUsdc: z.string().regex(DECIMAL_V1).optional()
    .describe('With "all" only, and needed there: the most USDC the user agreed to pay, interest included. The review refuses if the debt has grown past it.'),
  returnCollateral: z.boolean().optional()
    .describe('true when the user asked for their collateral back: with "all", the same review then returns the whole collateral to this wallet, for a stock on Aave V4 or cbBTC or WETH on Morpho (a loan opened with native ETH comes back as WETH). When nothing is owed any more it only returns the collateral, and maximumUsdc may be "0".'),
}).strict();

export const StillPrepareRepayOutputV1Schema = z.object({
  reviewUrl: z.string(),
  reviewId: z.string(),
  expiresAt: z.string(),
  venue: z.enum(['aave-v4', 'morpho']),
  collateral: z.enum(STILL_TOKEN_COLLATERAL_V1),
  repayUsdc: z.string(),
  maximumUsdc: z.string(),
  returnCollateral: z.boolean(),
  next: z.string(),
}).strict();

export function stillPrepareRepayReviewV1(
  identity: { tenantId: string; walletAddress: string },
  args: z.infer<typeof StillPrepareRepayInputV1Schema>,
  deps: { secret: string; now: Date; origin?: string },
): z.infer<typeof StillPrepareRepayOutputV1Schema> {
  const { token, venue } = tokenOfV1(args.collateral);
  const all = args.repayUsdc === 'all', back = args.returnCollateral === true;
  if (back && !all) {
    throw new StillLoanRefusalV1('still_repay_amount_invalid', 'returnCollateral goes with "all": the collateral comes back once the whole loan is repaid.');
  }
  const repay = all ? null : unitsV1(args.repayUsdc, 6);
  if (!all && (repay === null || repay === 0n)) {
    throw new StillLoanRefusalV1('still_repay_amount_invalid', 'The USDC to pay back is an amount above zero with at most six decimals, or "all".');
  }
  if (!all && args.maximumUsdc !== undefined) {
    throw new StillLoanRefusalV1('still_repay_amount_invalid', 'maximumUsdc goes with "all" only: an exact repayment takes exactly its amount.');
  }
  const maximum = all ? (args.maximumUsdc === undefined ? null : unitsV1(args.maximumUsdc, 6)) : repay;
  if (maximum === null || (maximum === 0n && !back)) {
    throw new StillLoanRefusalV1('still_repay_amount_invalid', 'Repaying all needs maximumUsdc: the most USDC the user agreed to pay, interest included, above zero with at most six decimals.');
  }
  if (deps.secret.length < 16) throw new StillLoanRefusalV1('still_loan_unavailable', 'Still cannot prepare a review on this server right now.');
  const wallet = identity.walletAddress.toLowerCase();
  const issued = issueLendingDraftV1({
    tenantId: identity.tenantId,
    walletAddress: wallet,
    question: { operation: 'repay', collateralTokenAddress: token, amountMode: all ? 'all' : 'assets', repayAssets: repay === null ? null : repay.toString(), maximumAssets: maximum.toString(),
      ...(back ? { returnCollateral: true as const } : {}) },
    secret: deps.secret,
    now: deps.now,
  });
  return {
    reviewUrl: `${deps.origin ?? STILL_PUBLIC_ORIGIN_V1}/lending/${issued.draft}`,
    reviewId: issued.draftId,
    expiresAt: issued.expiresAt,
    venue,
    collateral: args.collateral,
    repayUsdc: args.repayUsdc,
    maximumUsdc: usdcTextV1(maximum),
    returnCollateral: back,
    next: 'Give the user this link. It opens a review for this wallet only, signed in with it, and works for five minutes. The page reads the loan again and simulates the exact calls before the user’s own wallet opens; the USDC comes from this wallet, and "all" closes the loan with its interest up to maximumUsdc. A wallet that cannot send a batch (Rabby, or Coinbase Wallet with an imported key) repays a stock loan in steps; cbBTC and WETH need one transaction. Nothing has been sent. After the user signs, miorail_get_still_review_status with reviewId reads what happened.',
  };
}

export function usdcTextV1(atomic: bigint): string {
  const fraction = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${atomic / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}
