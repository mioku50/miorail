import { createBitrefillGuestCheckoutV1, spendCallingCodeV1, type BitrefillGuestCheckoutV1, type SpendProductV1 } from '@mioagent/commerce-engine';
import { logger } from '@mioagent/utils';

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
export function spendBuyableV1(product: Pick<SpendProductV1, 'id' | 'recipientType' | 'country' | 'prepayment'>): boolean {
  // Bitrefill's prepayment steps are not offered to Still's guest client.
  if (product.prepayment) return false;
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
  /** The address Bitrefill sends the receipt and what was bought to, as it was given when the invoice
   * was opened. Its owner sees it on the review before paying (audit MCP-3, 2026-11-10: an assistant
   * names it, and the review showed nothing of it). Held with the open order only, half an hour, in
   * memory: no log, database or loan carries it. */
  email: string;
  /** The number a phone top-up goes to, in Bitrefill's digits; null for anything else.
   * Its owner sees it until the order is forgotten; no log, database or loan carries it. */
  refillTo: string | null;
  createdAt: string;
  expiresAt: string;
  accessToken: string;
  paymentLink: string | null;
}

export interface SpendOrderOwnerV1 { tenantId: string; walletAddress: string }

/** Where Bitrefill sends what this order buys, as its owner reads it on a review: the email in full,
 * and the number a top-up goes to. It was fixed when the invoice was opened; nothing here changes it. */
export interface SpendDeliveryV1 { email: string; phone: string | null }
export function spendDeliveryV1(order: Pick<SpendOrderV1, 'email' | 'refillTo'>): SpendDeliveryV1 {
  return { email: order.email, phone: order.refillTo === null ? null : `+${order.refillTo}` };
}

/** The same, for a surface that is not the owner's own browser (the review card inside an assistant): enough
 * for the person to know their own address and number by, and not the address or the number itself. */
export function spendDeliveryMaskedV1(delivery: SpendDeliveryV1): SpendDeliveryV1 {
  const at = delivery.email.lastIndexOf('@'), local = delivery.email.slice(0, at), domain = delivery.email.slice(at + 1);
  const shown = local.length <= 2 ? `${local.slice(0, 1)}…` : `${local.slice(0, 1)}…${local.slice(-1)}`;
  return { email: `${shown}@${domain}`, phone: delivery.phone === null ? null : `+…${delivery.phone.slice(-4)}` };
}

export interface SpendOrderStoreV1 {
  put(order: SpendOrderV1): void;
  get(owner: SpendOrderOwnerV1, orderId: string): SpendOrderV1 | null;
  /** Orders this owner opened in the last hour, and the ones being opened now, to refuse a script. */
  openedLastHour(owner: SpendOrderOwnerV1): number;
  /** One invoice is being opened for this owner: it counts until `done`, whether or not it opens. */
  opening(owner: SpendOrderOwnerV1): { done(): void };
}

export function createSpendOrderStoreV1(input: { now?: () => Date; ttlMs?: number } = {}): SpendOrderStoreV1 {
  const now = input.now ?? (() => new Date());
  const ttlMs = input.ttlMs ?? 30 * 60_000;
  const rows = new Map<string, SpendOrderV1>();
  const opened = new Map<string, number[]>();
  const underway = new Map<string, number>();
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
      return (opened.get(key(owner))?.length ?? 0) + (underway.get(key(owner)) ?? 0);
    },
    opening(owner) {
      const who = key(owner);
      underway.set(who, (underway.get(who) ?? 0) + 1);
      let counted = true;
      return {
        done() {
          if (!counted) return;
          counted = false;
          const left = (underway.get(who) ?? 1) - 1;
          if (left > 0) underway.set(who, left); else underway.delete(who);
        },
      };
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

/** Still's client registered at Bitrefill (2026-11-02), from the environment;
 * without one the guest client is the metadata document. Never logged. */
export function stillBitrefillClientV1(env: NodeJS.ProcessEnv = process.env): { clientId?: string; clientSecret?: string } {
  const clientId = env.STILL_BITREFILL_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.STILL_BITREFILL_CLIENT_SECRET?.trim() ?? '';
  if (!/^[A-Za-z0-9._:/-]{8,200}$/.test(clientId)) return {};
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

/** Which client Still presents to Bitrefill: its registered one, or the published document it falls back to,
 * which Bitrefill has not trusted since 2026-11-02 (every read is then refused). Never the id itself. */
export function stillBitrefillClientKindV1(env: NodeJS.ProcessEnv = process.env): 'registered' | 'registered_without_secret' | 'published_document' {
  const client = stillBitrefillClientV1(env);
  return !client.clientId ? 'published_document' : client.clientSecret ? 'registered' : 'registered_without_secret';
}

let checkoutV1: BitrefillGuestCheckoutV1 | null = null;
/** One guest checkout for the process: one token and one rate window. The first use says which client it is
 * (audit SPEND-5: a mistyped id fell back to the published document in silence, and Spend was simply refused). */
export const stillSpendCheckoutV1 = (): BitrefillGuestCheckoutV1 => {
  if (!checkoutV1) {
    const kind = stillBitrefillClientKindV1();
    const said = { client: kind, pay: stillSpendPayEnabledV1() ? 'on' : 'off', secretExpiryKnown: Number.isFinite(Date.parse((process.env.STILL_BITREFILL_CLIENT_SECRET_EXPIRES_AT ?? '').trim())) };
    if (kind === 'registered') logger.info('Still Spend presents its registered client to Bitrefill', said);
    else logger.warn('Still Spend has no registered client with a secret: Bitrefill may refuse its catalogue and invoices', said);
    checkoutV1 = createBitrefillGuestCheckoutV1(stillBitrefillClientV1());
  }
  return checkoutV1;
};
