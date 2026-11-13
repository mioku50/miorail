import type { BitrefillGuestCheckoutV1, SpendCheckoutResultV1, SpendFailureV1, SpendInvoiceStatusV1 } from '@mioagent/commerce-engine';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';

// ---------------------------------------------------------------------------
// Reading a Bitrefill invoice, three ways (audit SPEND-2, 2026-11-10).
//
// Still's checkout has ten calls a minute at Bitrefill, for everyone. A page
// waiting for a delivery asked four times a minute for each order, and one
// wallet could ask twenty times, so two people waiting left a third unable to
// open an invoice or to pay one.
//
//  - display: what a page or an assistant shows. Bitrefill is asked once per
//    order in fifteen seconds, whoever asks, and at most four times a minute
//    for one wallet, from the ordinary part of the window only. When Bitrefill
//    cannot be asked, the last reading stands, with its time and the reason.
//  - payment: before a review that pays. Always Bitrefill's own answer, from
//    the part of the window kept for buying: three a minute for one wallet.
//  - step: before the next step of a loan already under way. Never limited by
//    wallet, because a refusal here ends a loan that has already moved money;
//    one failed read is tried once more. It and opening an invoice have the
//    last two of the ten to themselves: no review or page can take them
//    (audit SPEND-2, 2026-11-14).
//
// The caller has already found the order as its owner's: nothing here is
// reachable by an order id alone.
// ---------------------------------------------------------------------------

export interface SpendInvoiceDisplayV1 {
  /** Bitrefill's latest answer Still holds; null when it never gave one. */
  status: SpendInvoiceStatusV1 | null;
  /** When Bitrefill gave it. */
  readAt: string | null;
  /** Why the latest attempt read nothing; null when `status` is that attempt's answer, or a kept one still fresh. */
  error: SpendFailureV1 | null;
}

interface InvoiceRefV1 { orderId: string; accessToken: string }
type InvoiceReadV1 = SpendCheckoutResultV1<SpendInvoiceStatusV1>;
type CheckoutV1 = Pick<BitrefillGuestCheckoutV1, 'readInvoice'>;

interface KeptV1 { value: SpendInvoiceStatusV1 | null; at: number; pending: Promise<SpendInvoiceDisplayV1> | null }

/** A read that may succeed a moment later: Bitrefill did not answer, or a window was full. */
const passingV1 = (reason: SpendFailureV1): boolean => reason === 'bitrefill_unreachable' || reason === 'bitrefill_rate_limited';

export function createSpendInvoiceReadsV1(options: {
  now?: () => number; displayTtlMs?: number; max?: number; displayPerMinute?: number; paymentPerMinute?: number;
  /** Between the two reads before a loan's step. */
  wait?: (ms: number) => Promise<void>;
} = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.displayTtlMs ?? 15_000;
  const max = options.max ?? 500;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
  const displayLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: options.displayPerMinute ?? 4 });
  const paymentLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: options.paymentPerMinute ?? 3 });
  const kept = new Map<string, KeptV1>();

  function entryV1(orderId: string): KeptV1 {
    let entry = kept.get(orderId);
    if (!entry) {
      entry = { value: null, at: 0, pending: null };
      kept.set(orderId, entry);
      // An order lives half an hour; the oldest reading goes first.
      while (kept.size > max) {
        const oldest = kept.keys().next();
        if (oldest.done) break;
        kept.delete(oldest.value);
      }
    }
    return entry;
  }

  function remember(orderId: string, value: SpendInvoiceStatusV1): void {
    const entry = entryV1(orderId);
    entry.value = value;
    entry.at = now();
  }

  const ask = (checkout: CheckoutV1, order: InvoiceRefV1, purpose: 'display' | 'payment' | 'step'): Promise<InvoiceReadV1> =>
    checkout.readInvoice({ invoiceId: order.orderId, accessToken: order.accessToken }, { purpose })
      .catch((): InvoiceReadV1 => ({ ok: false, reason: 'bitrefill_unreachable' }));

  return {
    display(input: { wallet: string; order: InvoiceRefV1; checkout: CheckoutV1 }): Promise<SpendInvoiceDisplayV1> {
      const entry = entryV1(input.order.orderId);
      const held = (error: SpendFailureV1 | null): SpendInvoiceDisplayV1 =>
        ({ status: entry.value, readAt: entry.value ? new Date(entry.at).toISOString() : null, error });
      if (entry.value && now() - entry.at < ttlMs) return Promise.resolve(held(null));
      // One read at a time for one order: everyone asking meanwhile hears the same answer.
      if (entry.pending) return entry.pending;
      const pending = (async (): Promise<SpendInvoiceDisplayV1> => {
        try {
          if (!(await displayLimiter.consume(input.wallet)).success) return held('bitrefill_rate_limited');
          const read = await ask(input.checkout, input.order, 'display');
          if (read.ok) {
            entry.value = read.value;
            entry.at = now();
            return held(null);
          }
          if (read.shape) logger.warn('Still Spend invoice status unread', { reason: read.reason, shape: read.shape });
          return held(read.reason);
        } finally {
          entry.pending = null;
        }
      })();
      entry.pending = pending;
      return pending;
    },

    async payment(input: { wallet: string; order: InvoiceRefV1; checkout: CheckoutV1 }): Promise<InvoiceReadV1> {
      if (!(await paymentLimiter.consume(input.wallet)).success) return { ok: false, reason: 'bitrefill_rate_limited' };
      const read = await ask(input.checkout, input.order, 'payment');
      if (read.ok) remember(input.order.orderId, read.value);
      return read;
    },

    async step(input: { order: InvoiceRefV1; checkout: CheckoutV1 }): Promise<InvoiceReadV1> {
      // From the part of the window no review or page can take (audit SPEND-2, 2026-11-14).
      let read = await ask(input.checkout, input.order, 'step');
      if (!read.ok && passingV1(read.reason)) {
        await wait(1_000);
        read = await ask(input.checkout, input.order, 'step');
      }
      if (read.ok) remember(input.order.orderId, read.value);
      return read;
    },

    /** Testing seam. */
    clear(): void {
      kept.clear();
    },
  };
}

export type SpendInvoiceReadsV1 = ReturnType<typeof createSpendInvoiceReadsV1>;

/** One for the process, as there is one checkout window. */
export const spendInvoiceReadsV1: SpendInvoiceReadsV1 = createSpendInvoiceReadsV1();
