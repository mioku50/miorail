import {
  CommerceOnchainPaymentV1Schema,
  stableHashV1,
  type CommerceOnchainPaymentV1,
  type CommercePaymentBlueprintV1,
} from '@mioagent/route-domain';
import { COMMERCE_USDC_ADDRESS_V1 } from './pinned-config.js';
import { normalizeAddressV1 } from './normalization.js';

// ---------------------------------------------------------------------------
// T64.3 §6 — the onchain payment proof.
//
// A successful receipt is NOT a payment. What proves a payment is an ERC-20
// Transfer log from the authenticated wallet, to the invoice's address, for
// the invoice's exact amount, emitted by canonical USDC. A receipt that
// succeeds without that log is `unverified` and forces reconciliation — never
// a completed payment.
//
// The reader is injected so this package opens no socket and unit tests never
// touch an RPC.
// ---------------------------------------------------------------------------

/** keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER_TOPIC_V1 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface CommerceReceiptLogV1 {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface CommerceReceiptV1 {
  transactionHash: string;
  status: 'success' | 'reverted' | 'unknown';
  blockNumber: string | null;
  gasUsed: string | null;
  chainId: number;
  logs: readonly CommerceReceiptLogV1[];
}

export interface CommerceReceiptReaderV1 {
  readReceipt(input: { transactionHash: string }): Promise<CommerceReceiptV1 | null>;
}

function topicAddress(topic: string | undefined): `0x${string}` | null {
  if (typeof topic !== 'string') return null;
  const value = topic.toLowerCase().replace(/^0x/, '');
  if (!/^0{24}[0-9a-f]{40}$/.test(value)) return null;
  return `0x${value.slice(24)}` as `0x${string}`;
}

/**
 * The one Transfer that settles this invoice, or null.
 *
 * Every field is matched: the emitting token, the sender, the recipient and
 * the amount. A Transfer of the right amount to the wrong address, or the
 * right address from the wrong wallet, is not this payment.
 */
export function findCommercePaymentTransferV1(input: {
  logs: readonly CommerceReceiptLogV1[];
  from: string;
  to: string;
  amountAtomic: string;
}): { recipient: `0x${string}`; sender: `0x${string}`; amountAtomic: string } | null {
  const expectedFrom = normalizeAddressV1(input.from);
  const expectedTo = normalizeAddressV1(input.to);
  if (expectedFrom === null || expectedTo === null) return null;

  for (const log of input.logs) {
    if (normalizeAddressV1(log.address) !== COMMERCE_USDC_ADDRESS_V1) continue;
    if ((log.topics[0] ?? '').toLowerCase() !== ERC20_TRANSFER_TOPIC_V1) continue;
    const sender = topicAddress(log.topics[1]);
    const recipient = topicAddress(log.topics[2]);
    if (sender === null || recipient === null) continue;
    if (sender !== expectedFrom || recipient !== expectedTo) continue;
    const data = log.data.toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(data)) continue;
    const amount = BigInt(`0x${data}`).toString();
    if (amount !== input.amountAtomic) continue;
    return { recipient, sender, amountAtomic: amount };
  }
  return null;
}

export type CommerceOnchainProofResultV1 =
  | { ok: true; payment: CommerceOnchainPaymentV1 }
  | { ok: false; reason: 'receipt_missing' | 'wrong_chain' | 'invalid_receipt' };

/**
 * Turns a receipt into the onchain leg.
 *
 * `verified` is reachable only through a matching Transfer log. A reverted
 * receipt is `reverted`; a successful one without the log is `unverified`,
 * which the proof layer treats as reconciliation_required.
 */
export function buildCommerceOnchainPaymentV1(input: {
  receipt: CommerceReceiptV1 | null;
  blueprint: CommercePaymentBlueprintV1;
  payer: string;
  now: Date;
}): CommerceOnchainProofResultV1 {
  const { receipt, blueprint } = input;
  if (!receipt) return { ok: false, reason: 'receipt_missing' };
  if (receipt.chainId !== blueprint.chainId) return { ok: false, reason: 'wrong_chain' };
  if (!/^0x[0-9a-f]{64}$/.test(receipt.transactionHash.toLowerCase())) {
    return { ok: false, reason: 'invalid_receipt' };
  }
  if (receipt.blockNumber === null || !/^(0|[1-9][0-9]*)$/.test(receipt.blockNumber)) {
    return { ok: false, reason: 'invalid_receipt' };
  }

  const transfer =
    receipt.status === 'success'
      ? findCommercePaymentTransferV1({
          logs: receipt.logs,
          from: input.payer,
          to: blueprint.recipient,
          amountAtomic: blueprint.exactAmountAtomic,
        })
      : null;

  const state: CommerceOnchainPaymentV1['state'] =
    receipt.status === 'reverted' ? 'reverted' : transfer ? 'verified' : 'unverified';

  const payment = {
    transactionHash: receipt.transactionHash.toLowerCase() as `0x${string}`,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    actualAmountAtomic: transfer?.amountAtomic ?? null,
    actualRecipient: transfer?.recipient ?? null,
    actualSender: transfer?.sender ?? null,
    // Bound to what was read, so the proof cannot drift from the receipt.
    receiptHash: stableHashV1('commerce-receipt/v1', {
      transactionHash: receipt.transactionHash.toLowerCase(),
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      chainId: receipt.chainId,
    }),
    state,
    observedAt: input.now.toISOString(),
  };
  const parsed = CommerceOnchainPaymentV1Schema.safeParse(payment);
  if (!parsed.success) return { ok: false, reason: 'invalid_receipt' };
  return { ok: true, payment: parsed.data };
}
