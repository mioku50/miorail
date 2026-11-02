import { createBitrefillGuestCheckoutV1, spendCallingCodeV1, type BitrefillGuestCheckoutV1, type SpendProductV1 } from '@mioagent/commerce-engine';

import type { LendingPaymentV1 } from './lendingDraft.js';

// ---------------------------------------------------------------------------
// Still Spend, stage 3: the Bitrefill invoices people opened, held in memory.
//
// An invoice holds its price for fifteen minutes and a loan needs a few of
// them to be read, reviewed and signed, so an order lives here half an hour
// and no longer. A restart forgets every open order: the person creates
// another, and nothing can be paid from a forgotten one, because a review of
// the payment needs it. Nothing about an order is written to the database;
// the loan that pays it is, with the payment inside its own facts.
//
// The access token is the buyer's handle on the purchase. It stays here for
// the status read and goes back to its owner only.
// ---------------------------------------------------------------------------

/** One purchase at most this much, while Bitrefill's refund handling for
 * these invoices is unconfirmed. Gift cards are also how people are scammed. */
export const STILL_SPEND_CAP_ATOMIC_V1 = 100_000_000n;

/** A review must leave this long for the wallet and the block. */
export const STILL_SPEND_REVIEW_MARGIN_MS_V1 = 120_000;

/** Paying is off until the operator turns it on: STILL_SPEND_PAY_V1=on. */
export function stillSpendPayEnabledV1(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.STILL_SPEND_PAY_V1 ?? '').trim().toLowerCase() === 'on';
}

/** A phone top-up: Bitrefill needs the number it goes to. */
export function spendNeedsPhoneV1(product: Pick<SpendProductV1, 'recipientType'>): boolean {
  return /^phone/.test((product.recipientType ?? '').toLowerCase());
}

/** What Bitrefill needs besides an email: a phone number, an account, a
 * username. Still sends a phone number, checked against the calling code of
 * the operator's country, and nothing else, so a product needing an account
 * or a username is not bought here. An eSIM reports "mixed" and needs nothing more. */
export function spendBuyableV1(product: Pick<SpendProductV1, 'id' | 'recipientType' | 'country'>): boolean {
  const recipient = (product.recipientType ?? '').toLowerCase();
  if (recipient === '' || recipient === 'none') return true;
  if (spendNeedsPhoneV1(product)) return spendCallingCodeV1(product.country) !== null;
  return !/mixed|account|email|user|phone/.test(recipient) || /esim/i.test(product.id);
}

/** USDC base units of a decimal price, exactly, or null. */
export function spendPriceAtomicV1(price: string): bigint | null {
  const match = /^(0|[1-9]\d{0,9})(?:\.(\d{1,6}))?$/.exec(price);
  return match ? BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0')) : null;
}

export interface SpendOrderV1 {
  /** Bitrefill's invoice id. */
  orderId: string;
  tenantId: string;
  walletAddress: string;
  productId: string;
  productName: string;
  packageValue: string;
  faceCurrency: string | null;
  priceAtomic: string;
  payTo: string;
  /** The number a phone top-up goes to, in Bitrefill's digits; null for anything else.
   * Its owner sees it until the order is forgotten; no log, database or loan carries it. */
  refillTo: string | null;
  createdAt: string;
  expiresAt: string;
  accessToken: string;
  paymentLink: string | null;
}

export interface SpendOrderOwnerV1 { tenantId: string; walletAddress: string }

export interface SpendOrderStoreV1 {
  put(order: SpendOrderV1): void;
  get(owner: SpendOrderOwnerV1, orderId: string): SpendOrderV1 | null;
  /** Orders this owner opened in the last hour, to refuse a script. */
  openedLastHour(owner: SpendOrderOwnerV1): number;
}

export function createSpendOrderStoreV1(input: { now?: () => Date; ttlMs?: number } = {}): SpendOrderStoreV1 {
  const now = input.now ?? (() => new Date());
  const ttlMs = input.ttlMs ?? 30 * 60_000;
  const rows = new Map<string, SpendOrderV1>();
  const opened = new Map<string, number[]>();
  const key = (owner: SpendOrderOwnerV1) => `${owner.tenantId}|${owner.walletAddress}`;
  const prune = () => {
    const at = now().getTime();
    for (const [id, row] of rows) if (at - Date.parse(row.createdAt) > ttlMs) rows.delete(id);
    for (const [owner, times] of opened) {
      const kept = times.filter((time) => at - time < 3_600_000);
      if (kept.length) opened.set(owner, kept); else opened.delete(owner);
    }
  };
  return {
    put(order) {
      prune();
      rows.set(order.orderId, structuredClone(order));
      const owner = key(order);
      opened.set(owner, [...(opened.get(owner) ?? []), Date.parse(order.createdAt)]);
    },
    get(owner, orderId) {
      prune();
      const row = rows.get(orderId.toLowerCase());
      return row && row.tenantId === owner.tenantId && row.walletAddress === owner.walletAddress ? structuredClone(row) : null;
    },
    openedLastHour(owner) {
      prune();
      return opened.get(key(owner))?.length ?? 0;
    },
  };
}

export const spendOrderStoreV1 = createSpendOrderStoreV1();

/** The invoice a loan's review pays, as the server read it: the loan is
 * exactly its price. Null when it would lapse before a review is signed. */
export function spendDraftPaymentV1(order: SpendOrderV1, now: Date): LendingPaymentV1 | null {
  if (Date.parse(order.expiresAt) - now.getTime() < STILL_SPEND_REVIEW_MARGIN_MS_V1 + 60_000) return null;
  return { merchant: 'bitrefill', orderId: order.orderId, payTo: order.payTo, assets: order.priceAtomic, productName: order.productName,
    packageValue: order.packageValue, faceCurrency: order.faceCurrency, expiresAt: order.expiresAt };
}

let checkoutV1: BitrefillGuestCheckoutV1 | null = null;
/** One guest checkout for the process: one token and one rate window. */
export const stillSpendCheckoutV1 = (): BitrefillGuestCheckoutV1 => (checkoutV1 ??= createBitrefillGuestCheckoutV1());
