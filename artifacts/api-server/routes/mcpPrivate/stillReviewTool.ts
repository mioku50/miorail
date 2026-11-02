import { z } from 'zod';
import type { BitrefillGuestCheckoutV1 } from '@mioagent/commerce-engine';

import type { LoanExecutionStoreV1, LoanExecutionV1, LoanOwnerV1 } from '../../lib/loanExecutionStore.js';
import type { SpendOrderStoreV1 } from '../../lib/stillSpendOrders.js';
import { loanExecutionShareV1 } from '../../lib/stillSpendShare.js';

// ---------------------------------------------------------------------------
// What happened to a Still review an assistant prepared, by its reviewId.
//
// It is the review page's own status: the same record, refreshed from Base by
// the same reader, so "confirmed" means Still read the loan or repayment, and
// a purchase's payment, from the chain, never that a wallet said so. For a
// purchase it adds Bitrefill's own reading of the invoice while Still holds
// the open order (half an hour), and, once confirmed, the link that shares the
// purchase without naming the wallet.
// ---------------------------------------------------------------------------

export const StillReviewStatusInputV1Schema = z.object({
  reviewId: z.string().uuid().describe('The reviewId a miorail_prepare_still_loan, _purchase or _repay call returned.'),
}).strict();

export const StillReviewStatusOutputV1Schema = z.object({
  reviewId: z.string(),
  state: z.enum(['not_opened', 'ready', 'awaiting_wallet', 'submitted', 'unknown', 'confirmed', 'failed']),
  operation: z.enum(['borrow', 'repay']).optional(),
  venue: z.enum(['aave-v4', 'morpho']).optional(),
  collateral: z.string().optional(),
  transactionHash: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
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
  checkout: () => BitrefillGuestCheckoutV1;
  /** The Spend page's own limit on invoice reads, shared with it. */
  allowInvoiceRead: (wallet: string) => Promise<boolean>;
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
  if (!opened) return { reviewId, state: 'not_opened', next: NEXT_V1.not_opened };
  const record = await deps.refresh({ owner, executionId: opened.executionId }) ?? opened;
  const facts = record.run.facts;
  let purchase: z.infer<typeof StillReviewStatusOutputV1Schema>['purchase'];
  if (facts.operation === 'borrow' && facts.payment) {
    const payment = facts.payment;
    // Bitrefill is asked only once the payment may have been sent, and only
    // while Still still holds the open order with its access token.
    let invoiceStatus: string | null = null, invoiceStatusError: string | null = null;
    if (record.state === 'submitted' || record.state === 'unknown' || record.state === 'confirmed') {
      const order = deps.orders.get(owner, payment.orderId);
      if (!order) invoiceStatusError = 'spend_order_forgotten';
      else if (!(await deps.allowInvoiceRead(owner.walletAddress))) invoiceStatusError = 'bitrefill_rate_limited';
      else {
        const read = await deps.checkout().readInvoice({ invoiceId: order.orderId, accessToken: order.accessToken });
        if (read.ok) invoiceStatus = read.value.status; else invoiceStatusError = read.reason;
      }
    }
    const share = loanExecutionShareV1(record, deps.secret);
    purchase = {
      productName: payment.productName, packageValue: payment.packageValue, priceUsdc: usdcTextV1(payment.assets), invoiceExpiresAt: payment.expiresAt,
      invoiceStatus, invoiceStatusError, shareUrl: share ? `${deps.origin ?? 'https://stills.lat'}${share.path}` : null,
    };
  }
  const paid = record.state === 'confirmed' && purchase
    ? ` The loan paid Bitrefill’s invoice; ${purchase.invoiceStatus === null ? 'Bitrefill’s own reading of it was not available here, and its email to the user is the receipt' : `Bitrefill reads it as ${purchase.invoiceStatus}`}. shareUrl shares the purchase without naming the wallet.`
    : '';
  return {
    reviewId, state: record.state, operation: facts.operation, venue: facts.venue, collateral: facts.collateralSymbol,
    transactionHash: record.transactionHash, errorCode: record.errorCode, updatedAt: record.updatedAt,
    ...(purchase ? { purchase } : {}),
    next: `${NEXT_V1[record.state]}${paid}`,
  };
}
