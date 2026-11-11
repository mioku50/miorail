import { z } from 'zod';

import { LOAN_WALLET_SENT_NOTHING_V1, type LoanExecutionStoreV1, type LoanExecutionV1, type LoanOwnerV1 } from '../../lib/loanExecutionStore.js';
import { LOAN_STEPS_STOPPED_V1 } from '../../lib/lendingSteps.js';
import { STILL_PUBLIC_ORIGIN_V1 } from '../../lib/stillOrigin.js';
import type { SpendInvoiceDisplayV1 } from '../../lib/stillSpendInvoiceReads.js';
import type { SpendOrderStoreV1, SpendOrderV1 } from '../../lib/stillSpendOrders.js';
import { loanExecutionShareV1 } from '../../lib/stillSpendShare.js';
import type { SpendWalletPaymentV1 } from '../../lib/stillSpendWalletStore.js';

// ---------------------------------------------------------------------------
// What happened to a Still review an assistant prepared, by its reviewId.
//
// It is the review page's own status: the same record, refreshed from Base by
// the same reader, so "confirmed" means Still read the loan or repayment, and
// a purchase's payment, from the chain, never that a wallet said so. For a
// purchase it adds Bitrefill's own reading of the invoice while Still holds
// the open order (half an hour), and, once confirmed, the link that shares the
// purchase without naming the wallet. A purchase paid from the wallet's own
// USDC is named by its invoice, and read as its payment page reads it.
// ---------------------------------------------------------------------------

export const StillReviewStatusInputV1Schema = z.object({
  reviewId: z.string().uuid().describe('The reviewId a miorail_prepare_still_loan, _purchase, _wallet_purchase or _repay call returned.'),
}).strict();

export const StillReviewStatusOutputV1Schema = z.object({
  reviewId: z.string(),
  state: z.enum(['not_opened', 'ready', 'awaiting_wallet', 'submitted', 'unknown', 'confirmed', 'failed']),
  operation: z.enum(['borrow', 'repay']).optional(),
  venue: z.enum(['aave-v4', 'morpho']).optional(),
  collateral: z.string().optional(),
  /** Repay all and take the stock back: how much of the stock this review returns to the wallet, in its own units. */
  collateralReturned: z.string().optional(),
  transactionHash: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
  /** A purchase paid from the wallet's own USDC, with no loan. */
  paidFrom: z.literal('wallet').optional(),
  purchase: z.object({
    productName: z.string(),
    packageValue: z.string(),
    priceUsdc: z.string(),
    invoiceExpiresAt: z.string(),
    /** Bitrefill's own word for the invoice, or null when it was not read. */
    invoiceStatus: z.string().nullable(),
    invoiceStatusError: z.string().nullable(),
    shareUrl: z.string().nullable(),
  }).strict().optional(),
  next: z.string(),
}).strict();

export interface StillReviewStatusDepsV1 {
  store: () => Promise<LoanExecutionStoreV1>;
  /** The review page's refresh: reads Base and records what it proves. */
  refresh: (input: { owner: LoanOwnerV1; executionId: string }) => Promise<LoanExecutionV1 | null>;
  orders: SpendOrderStoreV1;
  /** Bitrefill's word for the invoice as the Spend page reads it: the same kept reading, under the same limit. */
  invoice: (input: { wallet: string; order: SpendOrderV1 }) => Promise<SpendInvoiceDisplayV1>;
  /** A purchase paid from the wallet's own USDC, by its invoice, refreshed from Base as its page refreshes it. */
  walletPayment?: (input: { owner: LoanOwnerV1; orderId: string }) => Promise<SpendWalletPaymentV1 | null>;
  secret: string;
  origin?: string;
}

const NEXT_V1: Readonly<Record<z.infer<typeof StillReviewStatusOutputV1Schema>['state'], string>> = {
  not_opened: 'No review from this link has been opened and found ready on this wallet. The link works for five minutes after it was prepared; if it lapsed, or the review refused (the page says why), prepare a new one. Nothing was sent.',
  ready: 'The review is open and ready; the user has not sent it from their wallet yet.',
  awaiting_wallet: 'The user’s wallet was asked to sign. Nothing is known to have been sent yet.',
  submitted: 'The wallet sent it. Still has not read the result from Base yet; read this again in a few seconds.',
  unknown: 'Still could not establish the result from Base yet (errorCode says why). This is not a failure of the transaction: read this again later, or open the review link.',
  confirmed: 'Confirmed onchain: Still read the expected result from Base.',
  failed: 'Base shows the transaction failed (errorCode). Open the review link to see what is in place before preparing another.',
};

/** Paid from the wallet's own USDC: the same states, said of its payment page. */
const WALLET_NEXT_V1: Readonly<Record<z.infer<typeof StillReviewStatusOutputV1Schema>['state'], string>> = {
  not_opened: 'The user has not opened the payment page yet, or it refused (it says why: the wallet’s USDC, Bitrefill’s invoice or the time left). It can prepare the payment until the expiresAt miorail_prepare_still_wallet_purchase returned; after that, prepare a new one. Nothing was sent.',
  ready: 'The payment page is open and ready; the user has not sent it from their wallet yet.',
  awaiting_wallet: NEXT_V1.awaiting_wallet,
  submitted: NEXT_V1.submitted,
  unknown: 'Still could not establish the payment from Base yet (errorCode says why). This is not a failure of the transaction: read this again later, or open the payment page.',
  confirmed: 'Confirmed onchain: Still read the wallet’s USDC transfer of exactly the price to Bitrefill’s invoice from Base. No loan was taken.',
  failed: 'Base shows the payment failed (errorCode). Open the payment page to see where it stands before preparing another.',
};

/** A loan in steps that stopped on purpose: final with what landed, and not a failed transaction. */
/** Released by its owner as never sent (lib/loanRelease.ts): no transaction exists, so nothing failed onchain. */
const RELEASED_NEXT_V1 = 'The user released this review as never sent, after Base showed their wallet had sent nothing since it: nothing was borrowed, repaid or paid by it, and no transaction failed. Prepare a new one if they still want it.';
const STOPPED_NEXT_V1 = 'Stopped part way: the steps that landed are on Base and the rest was never sent, so nothing more happens from this review. Where the loan step landed, the USDC is in the wallet: the user can repay it, or open a new invoice from Spend.';

function usdcTextV1(atomic: string): string {
  const value = BigInt(atomic), fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}

export async function stillReviewStatusV1(
  identity: { tenantId: string; walletAddress: string },
  args: z.infer<typeof StillReviewStatusInputV1Schema>,
  deps: StillReviewStatusDepsV1,
): Promise<z.infer<typeof StillReviewStatusOutputV1Schema>> {
  const owner = { tenantId: identity.tenantId, walletAddress: identity.walletAddress.toLowerCase() };
  const reviewId = args.reviewId.toLowerCase();
  const opened = await (await deps.store()).getByDraft({ owner, draftId: reviewId });
  if (!opened) {
    // A purchase paid from the wallet's own USDC is named by its invoice.
    const payment = deps.walletPayment ? await deps.walletPayment({ owner, orderId: reviewId }) : null;
    if (payment) return walletPurchaseStatusV1(reviewId, payment, owner, deps);
    const order = deps.orders.get(owner, reviewId);
    if (order) {
      return { reviewId, state: 'not_opened', paidFrom: 'wallet', purchase: { ...orderPurchaseV1(order), invoiceStatus: null, invoiceStatusError: null, shareUrl: null },
        next: WALLET_NEXT_V1.not_opened };
    }
    return { reviewId, state: 'not_opened', next: NEXT_V1.not_opened };
  }
  const record = await deps.refresh({ owner, executionId: opened.executionId }) ?? opened;
  const facts = record.run.facts;
  let purchase: z.infer<typeof StillReviewStatusOutputV1Schema>['purchase'];
  if (facts.operation === 'borrow' && facts.payment) {
    const payment = facts.payment;
    const share = loanExecutionShareV1(record, deps.secret);
    purchase = {
      ...orderPurchaseV1({ ...payment, priceAtomic: payment.assets }), ...await invoiceReadV1(owner, payment.orderId, record.state, deps),
      shareUrl: share ? `${deps.origin ?? STILL_PUBLIC_ORIGIN_V1}${share.path}` : null,
    };
  }
  const paid = record.state === 'confirmed' && purchase
    ? ` The loan paid Bitrefill’s invoice; ${invoiceWordsV1(purchase, 'it')}. shareUrl shares the purchase without naming the wallet.`
    : '';
  const returned = facts.collateralReturnAssets === undefined ? null : unitsTextV1(BigInt(facts.collateralReturnAssets), facts.collateralDecimals);
  return {
    reviewId, state: record.state, operation: facts.operation, venue: facts.venue, collateral: facts.collateralSymbol,
    ...(returned === null ? {} : { collateralReturned: returned }),
    transactionHash: record.transactionHash, errorCode: record.errorCode, updatedAt: record.updatedAt,
    ...(purchase ? { purchase } : {}),
    next: `${record.state === 'failed' && record.errorCode === LOAN_STEPS_STOPPED_V1 ? STOPPED_NEXT_V1
      : record.state === 'failed' && record.errorCode === LOAN_WALLET_SENT_NOTHING_V1 ? RELEASED_NEXT_V1 : NEXT_V1[record.state]}${paid}${
      record.state === 'confirmed' && returned !== null ? ` The loan is closed and ${returned} ${facts.collateralSymbol} is back in the wallet.` : ''}`,
  };
}

function orderPurchaseV1(order: Pick<SpendOrderV1, 'productName' | 'packageValue' | 'priceAtomic' | 'expiresAt'>) {
  return { productName: order.productName, packageValue: order.packageValue, priceUsdc: usdcTextV1(order.priceAtomic), invoiceExpiresAt: order.expiresAt };
}

/** Bitrefill's own word for an invoice: asked only once the payment may have been sent, and only while
 * Still still holds the open order with its access token. */
async function invoiceReadV1(owner: LoanOwnerV1, orderId: string, state: string, deps: StillReviewStatusDepsV1) {
  if (state !== 'submitted' && state !== 'unknown' && state !== 'confirmed') return { invoiceStatus: null, invoiceStatusError: null };
  const order = deps.orders.get(owner, orderId);
  if (!order) return { invoiceStatus: null, invoiceStatusError: 'spend_order_forgotten' };
  // A reading Bitrefill could not give again just now stays, with the reason beside it.
  const read = await deps.invoice({ wallet: owner.walletAddress, order });
  return { invoiceStatus: read.status?.status ?? null, invoiceStatusError: read.error };
}

/** What Bitrefill says of a paid invoice, in a sentence: its word now, its last word when it could not be asked again, or neither. */
function invoiceWordsV1(invoice: { invoiceStatus: string | null; invoiceStatusError: string | null }, subject: 'it' | 'the invoice'): string {
  if (invoice.invoiceStatus === null) {
    return `Bitrefill’s own reading of ${subject} was not available here, and its email to the user is the receipt`;
  }
  return invoice.invoiceStatusError === null ? `Bitrefill reads ${subject} as ${invoice.invoiceStatus}`
    : `Bitrefill last read ${subject} as ${invoice.invoiceStatus}, and could not be asked again just now`;
}

async function walletPurchaseStatusV1(reviewId: string, record: SpendWalletPaymentV1, owner: LoanOwnerV1, deps: StillReviewStatusDepsV1):
  Promise<z.infer<typeof StillReviewStatusOutputV1Schema>> {
  const payment = record.run.facts.payment;
  const invoice = await invoiceReadV1(owner, payment.orderId, record.state, deps);
  const paid = record.state === 'confirmed'
    ? ` ${invoiceWordsV1(invoice, 'the invoice')}.`
    : '';
  return {
    reviewId, state: record.state, paidFrom: 'wallet', transactionHash: record.transactionHash, errorCode: record.errorCode, updatedAt: record.updatedAt,
    purchase: { ...orderPurchaseV1({ ...payment, priceAtomic: payment.assets }), ...invoice, shareUrl: null },
    next: `${WALLET_NEXT_V1[record.state]}${paid}`,
  };
}

function unitsTextV1(atomic: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals), fraction = (atomic % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${atomic / scale}${fraction ? `.${fraction}` : ''}`;
}
