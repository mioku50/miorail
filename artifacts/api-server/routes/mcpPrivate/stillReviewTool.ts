import { z } from 'zod';

import { stillLoopOfExecutionV1 } from '../../lib/stillLoops.js';
import type { SpendInvoiceStatusNameV1 } from '@mioagent/commerce-engine';
import type { StillLoopV1 } from '@mioagent/route-storage';
import { LOOP_BRANDS_V1 } from '@mioagent/still-engine/loops';
import { LOAN_WALLET_SENT_NOTHING_V1, type LoanExecutionStoreV1, type LoanExecutionV1, type LoanOwnerV1 } from '../../lib/loanExecutionStore.js';
import { LOAN_STEPS_STOPPED_V1, loanPaymentMayStillBeSentV1 } from '../../lib/lendingSteps.js';
import { loanPositionMovedOutsideV1 } from '../../lib/loanExecutionStatus.js';
import { STILL_PUBLIC_ORIGIN_V1 } from '../../lib/stillOrigin.js';
import type { SpendInvoiceDisplayV1 } from '../../lib/stillSpendInvoiceReads.js';
import type { SpendOrderStoreV1, SpendOrderV1 } from '../../lib/stillSpendOrders.js';
import { loanExecutionShareV1, stillLoopSharePathV1 } from '../../lib/stillSpendShare.js';
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
  /** Repay all and take the stock back, confirmed: how much of the stock the receipt shows back in the wallet, in its own units. */
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
  invoice: (input: { wallet: string; order: Pick<SpendOrderV1, 'orderId' | 'accessToken'> }) => Promise<SpendInvoiceDisplayV1>;
  /** The invoice kept for a Loop brand's card once the open order is forgotten (audit LOOP-1); absent in older wiring. */
  keptInvoice?: (owner: LoanOwnerV1, orderId: string) => Promise<Pick<SpendOrderV1, 'orderId' | 'accessToken'> | null>;
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

/** The `_meta` key a status result carries when the purchase made a Loop: for the card, never the answer, which a
 * client may check against a tool list it cached (what an assistant sees is the answer and `next`). */
export const STILL_LOOP_META_KEY_V1 = 'xyz.miorail/loop';

/** A status result's `_meta` for the card: the Loop, when the purchase made one, with what its owner may do with it. */
export function stillLoopReplyMetaV1(loop: StillLoopV1 | null): { _meta?: Record<string, unknown> } {
  return loop && !loop.team ? { _meta: { [STILL_LOOP_META_KEY_V1]: {
    executionId: loop.executionId, loopNo: loop.loopNo, brand: loop.brand, complete: loop.deliveredAt !== null, undelivered: loop.undelivered, onWall: loop.onWall,
  } } } : {};
}

/** What the assistant is told of the Loop a purchase made, in its `next`. */
function loopWordsV1(loop: StillLoopV1 | null, origin: string): string {
  if (!loop || loop.team) return '';
  if (loop.undelivered) return ' Bitrefill did not deliver the card, so this purchase does not count as a Loop.';
  if (loop.deliveredAt === null) return ` Once Bitrefill says the card arrived, this purchase counts as Loop #${loop.loopNo}.`;
  const brand = LOOP_BRANDS_V1.find((row) => row.brand === loop.brand)!;
  return ` This purchase is Loop #${loop.loopNo}: ${brand.name} stock stayed and ${brand.article.toLowerCase()} ${brand.card} arrived.${loop.onWall ? ' It is on the Loop wall.'
    : ` Its owner can put it on the Loop wall, on Still’s review card or at ${origin}/loops: the wall shows the number, the brand, the card, the price to the dollar and the day, never the wallet or the transaction.`}`;
}

export async function stillReviewStatusV1(
  identity: { tenantId: string; walletAddress: string },
  args: z.infer<typeof StillReviewStatusInputV1Schema>,
  deps: StillReviewStatusDepsV1,
): Promise<z.infer<typeof StillReviewStatusOutputV1Schema>> {
  return (await stillReviewStatusAndLoopV1(identity, args, deps)).answer;
}

/** The status, and the Loop its purchase made for the card's `_meta` (stillLoopReplyMetaV1), never in the answer. */
export async function stillReviewStatusAndLoopV1(
  identity: { tenantId: string; walletAddress: string },
  args: z.infer<typeof StillReviewStatusInputV1Schema>,
  deps: StillReviewStatusDepsV1,
): Promise<{ answer: z.infer<typeof StillReviewStatusOutputV1Schema>; loop: StillLoopV1 | null }> {
  const owner = { tenantId: identity.tenantId, walletAddress: identity.walletAddress.toLowerCase() };
  const reviewId = args.reviewId.toLowerCase();
  const opened = await (await deps.store()).getByDraft({ owner, draftId: reviewId });
  if (!opened) {
    // A purchase paid from the wallet's own USDC is named by its invoice.
    const payment = deps.walletPayment ? await deps.walletPayment({ owner, orderId: reviewId }) : null;
    if (payment) return { answer: await walletPurchaseStatusV1(reviewId, payment, owner, deps), loop: null };
    const order = deps.orders.get(owner, reviewId);
    if (order) {
      return { answer: { reviewId, state: 'not_opened', paidFrom: 'wallet', purchase: { ...orderPurchaseV1(order), invoiceStatus: null, invoiceStatusError: null, shareUrl: null },
        next: WALLET_NEXT_V1.not_opened }, loop: null };
    }
    return { answer: { reviewId, state: 'not_opened', next: NEXT_V1.not_opened }, loop: null };
  }
  const record = await deps.refresh({ owner, executionId: opened.executionId }) ?? opened;
  const facts = record.run.facts;
  const origin = deps.origin ?? STILL_PUBLIC_ORIGIN_V1;
  let purchase: z.infer<typeof StillReviewStatusOutputV1Schema>['purchase'];
  let loop: StillLoopV1 | null = null;
  let loopShared = false;
  if (facts.operation === 'borrow' && facts.payment) {
    const payment = facts.payment;
    const invoice = await invoiceReadV1(owner, payment.orderId, record.state, deps);
    // A Loop's number, and Bitrefill's word on its card: kept, said in `next` and given to the card.
    loop = await stillLoopOfExecutionV1(record, invoice.invoiceStatusError === null ? invoice.invoiceStatus as SpendInvoiceStatusNameV1 | null : null);
    // Once Bitrefill said the card arrived, the link to share is the Loop's own, as on the review page.
    const loopShare = loop && loop.deliveredAt !== null && !loop.team
      ? stillLoopSharePathV1(record, { loopNo: loop.loopNo, brand: loop.brand, via: loop.via }, deps.secret) : null;
    loopShared = loopShare !== null;
    const share = loopShare ?? loanExecutionShareV1(record, deps.secret);
    purchase = {
      ...orderPurchaseV1({ ...payment, priceAtomic: payment.assets }), ...invoice,
      shareUrl: share ? `${origin}${share.path}` : null,
    };
  }
  const paid = record.state === 'confirmed' && purchase
    ? ` The loan paid Bitrefill’s invoice; ${invoiceWordsV1(purchase, 'it')}. shareUrl shares ${loopShared ? `Loop #${loop!.loopNo}` : 'the purchase'} without naming the wallet.${
      loopWordsV1(loop, origin)}`
    : '';
  // What came back and what is left are what the receipt proved, never what the plan expected (audit MCP-1,
  // 2026-11-18: the plan's return was said in every state, and "the loan is closed" beside a debt still owing).
  const effect = record.verification?.effect as { remainingDebtAssets?: unknown; collateralReturnedAssets?: unknown } | undefined;
  const provenReturn = record.state === 'confirmed' && typeof effect?.collateralReturnedAssets === 'string' && /^[1-9][0-9]{0,38}$/.test(effect.collateralReturnedAssets)
    ? effect.collateralReturnedAssets : null;
  const returned = provenReturn === null ? null : unitsTextV1(BigInt(provenReturn), facts.collateralDecimals);
  // What this review is to return once it lands: said as that, while it has not.
  const planned = facts.collateralReturnAssets !== undefined && (record.state === 'ready' || record.state === 'awaiting_wallet' || record.state === 'submitted')
    ? unitsTextV1(BigInt(facts.collateralReturnAssets), facts.collateralDecimals) : null;
  // What a confirmed repayment left owing, as the review page reads it from the same record.
  const leftRaw = record.state === 'confirmed' && typeof effect?.remainingDebtAssets === 'string' && /^[0-9]{1,39}$/.test(effect.remainingDebtAssets)
    ? BigInt(effect.remainingDebtAssets) : null;
  const left = leftRaw !== null && leftRaw > 0n ? leftRaw.toString() : null;
  const tail = facts.operation === 'repay' && facts.amountMode === 'all' ? left : null;
  // Closed only when the receipt shows the stock came back and nothing owing.
  const closed = returned !== null && leftRaw === 0n;
  // Confirmed, and another hand moved the position too around then (audit LM-1).
  const movedOutside = loanPositionMovedOutsideV1(record);
  return { loop, answer: {
    reviewId, state: record.state, operation: facts.operation, venue: facts.venue, collateral: facts.collateralSymbol,
    ...(returned === null ? {} : { collateralReturned: returned }),
    transactionHash: record.transactionHash, errorCode: record.errorCode, updatedAt: record.updatedAt,
    ...(purchase ? { purchase } : {}),
    next: `${record.state === 'failed' && record.errorCode === LOAN_STEPS_STOPPED_V1 ? `${STOPPED_NEXT_V1}${loanPaymentMayStillBeSentV1(record)
      ? ' The user stopped it after their wallet was asked for the payment, and that request may still be open in the wallet: confirmed, it pays this invoice from the loan’s USDC; declined, the USDC stays in the wallet. Paying the invoice from the wallet another way is not offered, so it is never paid twice.' : ''}`
      : record.state === 'failed' && record.errorCode === LOAN_WALLET_SENT_NOTHING_V1 ? RELEASED_NEXT_V1 : NEXT_V1[record.state]}${paid}${
      closed ? ` The loan is closed and ${returned} ${facts.collateralSymbol} is back in the wallet.`
        : returned !== null ? ` ${returned} ${facts.collateralSymbol} came back to the wallet.`
          : planned !== null ? ` Once it lands, this review returns ${planned} ${facts.collateralSymbol} to the wallet; nothing has come back yet.` : ''}${
      // A Repay all on Aave that landed and left interest owing (audit LEND-2): the loan is not closed yet.
      tail === null ? '' : movedOutside ? ` ${usdcTextV1(tail)} USDC is still owing after it: the loan is not closed until that is repaid too.`
        : ` Interest that added to the debt until the repayment landed left ${usdcTextV1(tail)} USDC owing: the loan is not closed until that is repaid too.`}${
      movedOutside ? ' The position also changed outside this review around then (a liquidation, a repayment or pledge someone else made for this wallet, or the user’s own action in the protocol’s app), so what it holds now differs from what the review showed: read it again before suggesting a next step.' : ''}`,
  } };
}

function orderPurchaseV1(order: Pick<SpendOrderV1, 'productName' | 'packageValue' | 'priceAtomic' | 'expiresAt'>) {
  return { productName: order.productName, packageValue: order.packageValue, priceUsdc: usdcTextV1(order.priceAtomic), invoiceExpiresAt: order.expiresAt };
}

/** Bitrefill's own word for an invoice: asked only once the payment may have been sent, and only while
 * Still still holds the open order with its access token, or keeps it for a Loop brand's card (audit LOOP-1). */
async function invoiceReadV1(owner: LoanOwnerV1, orderId: string, state: string, deps: StillReviewStatusDepsV1) {
  if (state !== 'submitted' && state !== 'unknown' && state !== 'confirmed') return { invoiceStatus: null, invoiceStatusError: null };
  const order = deps.orders.get(owner, orderId) ?? await deps.keptInvoice?.(owner, orderId) ?? null;
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
