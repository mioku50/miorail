// The Still review card in an assistant's chat (MCP Apps): what was prepared,
// and where it stands, in the person's words. Pure, so the words are tested
// without a host. The server's own fields are the only source: nothing here
// estimates, and every state the status tool can return has its own line.

export type StillCardKindV1 = 'loan' | 'purchase' | 'repay';

export interface StillCardPreparedV1 {
  kind: StillCardKindV1;
  reviewId: string;
  /** Null when the card shows a status read, which carries no link. */
  reviewUrl: string | null;
  expiresAt: string | null;
  title: string;
  detail: string;
}

export type StillCardPhaseV1 = 'waiting' | 'expired' | 'open' | 'wallet' | 'sent' | 'unknown' | 'confirmed' | 'failed';

export interface StillCardStatusV1 {
  phase: StillCardPhaseV1;
  line: string;
  /** Nothing more will change: stop reading. */
  settled: boolean;
  bitrefill: string | null;
  shareUrl: string | null;
  transactionHash: string | null;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVIEW_URL = /^https:\/\/(?:stills\.lat|miorail\.xyz)\/lending\/miorail-lending-v[123]\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const venueName = (venue: unknown) => (venue === 'morpho' ? 'Morpho' : 'Aave V4');
const pledge = (amount: unknown, collateral: string) => (text(amount, 40) && amount !== '0' ? `, pledging ${amount} ${collateral}` : '');

/** The prepared review from a prepare tool's structured result; null for anything else. */
export function stillCardPreparedV1(structured: unknown): StillCardPreparedV1 | null {
  if (!object(structured) || !text(structured.reviewId, 36) || !UUID.test(structured.reviewId)) return null;
  const reviewUrl = text(structured.reviewUrl, 6000) && REVIEW_URL.test(structured.reviewUrl) ? structured.reviewUrl : null;
  const expiresAt = text(structured.expiresAt, 40) && Number.isFinite(Date.parse(structured.expiresAt)) ? structured.expiresAt : null;
  const collateral = text(structured.collateral, 12) ? structured.collateral : null;
  if (!reviewUrl || !collateral) return null;
  const base = { reviewId: structured.reviewId, reviewUrl, expiresAt };
  if (object(structured.purchase) && text(structured.purchase.productName, 120) && text(structured.purchase.priceUsdc, 24)) {
    const p = structured.purchase;
    const face = text(p.faceCurrency, 3) && typeof p.packageValue === 'string' && /^\d+(?:\.\d+)?$/.test(p.packageValue.trim()) ? ` ${p.faceCurrency}` : '';
    return { ...base, kind: 'purchase', title: `${p.productName}${text(p.packageValue, 80) ? ` · ${p.packageValue}${face}` : ''}`,
      detail: `${p.priceUsdc} USDC, borrowed against ${collateral} on ${venueName(structured.venue)}${pledge(structured.addCollateral, collateral)}, and paid to Bitrefill in the same review.` };
  }
  if (text(structured.borrowUsdc, 24)) {
    return { ...base, kind: 'loan', title: `Borrow ${structured.borrowUsdc} USDC against ${collateral}`,
      detail: `On ${venueName(structured.venue)}${pledge(structured.addCollateral, collateral)}.` };
  }
  if (text(structured.repayUsdc, 24)) {
    const all = structured.repayUsdc === 'all';
    return { ...base, kind: 'repay', title: all ? `Repay all of the ${collateral} loan` : `Repay ${structured.repayUsdc} USDC on the ${collateral} loan`,
      detail: all && text(structured.maximumUsdc, 24) ? `At most ${structured.maximumUsdc} USDC from your wallet, interest included, on ${venueName(structured.venue)}.`
        : `From your wallet's USDC, on ${venueName(structured.venue)}.` };
  }
  return null;
}

const BITREFILL_V1: Record<string, string> = {
  unpaid: 'Bitrefill has not seen the payment yet.',
  payment_detected: 'Bitrefill has seen the payment and is processing the order.',
  payment_confirmed: 'Bitrefill confirmed the payment and is processing the order.',
  pending: 'Bitrefill is processing the order.',
  complete: 'Bitrefill completed the order. Its email has the receipt.',
};

/** Where the review stands, from miorail_get_still_review_status. */
export function stillCardStatusV1(status: unknown, prepared: Pick<StillCardPreparedV1, 'expiresAt' | 'kind'>, now: Date): StillCardStatusV1 | null {
  if (!object(status) || !text(status.state, 20)) return null;
  const purchase = object(status.purchase) ? status.purchase : null;
  const word = purchase && text(purchase.invoiceStatus, 40) ? purchase.invoiceStatus : null;
  const bitrefill = word === null ? null : BITREFILL_V1[word] ?? `Bitrefill reports the order as ${word.replace(/_/g, ' ')}. Its email says what happens next.`;
  const shareUrl = purchase && text(purchase.shareUrl, 2000) && /^https:\/\/stills\.lat\/spend\/p\/ss1\./.test(purchase.shareUrl) ? purchase.shareUrl : null;
  const transactionHash = text(status.transactionHash, 66) && /^0x[0-9a-f]{64}$/.test(status.transactionHash) ? status.transactionHash : null;
  const out = (phase: StillCardPhaseV1, line: string, settled: boolean): StillCardStatusV1 => ({ phase, line, settled, bitrefill, shareUrl, transactionHash });
  switch (status.state) {
    case 'not_opened': {
      const lapsed = prepared.expiresAt !== null && Date.parse(prepared.expiresAt) <= now.getTime();
      return lapsed ? out('expired', 'The link expired before the review was opened. Nothing was sent. Ask your assistant to prepare it again.', true)
        : out('waiting', 'Open the review to check it and sign in your own wallet. Nothing has been sent.', false);
    }
    case 'ready': return out('open', 'The review is open. Your wallet has not been asked yet.', false);
    case 'awaiting_wallet': return out('wallet', 'Waiting for your wallet.', false);
    case 'submitted': return out('sent', 'Sent. Still is reading the result from Base.', false);
    case 'unknown': return out('unknown', 'Still could not read the result from Base yet and is checking again. This is not a failure.', false);
    case 'confirmed': {
      const done = prepared.kind === 'purchase' ? 'Confirmed onchain: the loan paid Bitrefill.' : prepared.kind === 'repay' ? 'Confirmed onchain: the repayment is in.' : 'Confirmed onchain: the USDC is in your wallet.';
      // A purchase settles when Bitrefill finishes, or when Still no longer holds the order to ask.
      const settled = prepared.kind !== 'purchase' || word === 'complete' || (purchase !== null && purchase.invoiceStatusError === 'spend_order_forgotten');
      return out('confirmed', done, settled);
    }
    case 'failed': return out('failed', 'Base shows the transaction failed. Open the review to see what is in place before preparing another.', true);
    default: return null;
  }
}

/** A status result drawn as the card: what it was, from the status's own facts. */
export function stillCardFromStatusV1(structured: unknown, now: Date): { prepared: StillCardPreparedV1; status: StillCardStatusV1 } | null {
  if (!object(structured) || !text(structured.reviewId, 36) || !UUID.test(structured.reviewId) || !text(structured.state, 20)) return null;
  const purchase = object(structured.purchase) ? structured.purchase : null;
  const collateral = text(structured.collateral, 12) ? structured.collateral : null;
  const kind: StillCardKindV1 = purchase ? 'purchase' : structured.operation === 'repay' ? 'repay' : 'loan';
  const title = purchase && text(purchase.productName, 120) ? `${purchase.productName}${text(purchase.packageValue, 80) ? ` · ${purchase.packageValue}` : ''}`
    : collateral ? (kind === 'repay' ? `Repayment on the ${collateral} loan` : `Loan against ${collateral}`) : 'Still review';
  const detail = purchase && text(purchase.priceUsdc, 24) && collateral ? `${purchase.priceUsdc} USDC, borrowed against ${collateral} on ${venueName(structured.venue)}.`
    : collateral ? `On ${venueName(structured.venue)}.` : 'Prepared by your assistant.';
  const prepared: StillCardPreparedV1 = { kind, reviewId: structured.reviewId, reviewUrl: null, expiresAt: null, title, detail };
  const status = stillCardStatusV1(structured, prepared, now);
  return status ? { prepared, status } : null;
}
