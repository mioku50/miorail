import { BITREFILL_AFFILIATE_CODE_V1, createBitrefillGuestCheckoutV1, spendCallingCodeV1, type BitrefillGuestCheckoutV1, type SpendProductV1 } from '@mioagent/commerce-engine';
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
  /** Opened through a checkout that carries Still's affiliate code: Bitrefill may pay Still a commission
   * on it. Its review says so; the price is Bitrefill's either way. */
  commission?: boolean;
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
  /**
   * One fresh quote asked of Bitrefill for this owner, counted before it is asked whatever it answers;
   * null when this owner has asked for as many as the limits allow. `unspent` gives it back when nothing
   * was asked after all (Bitrefill's own window was already full here).
   */
  quote(owner: SpendOrderOwnerV1): { unspent(): void } | null;
}

/**
 * Fresh quotes asked of Bitrefill for one wallet (audit N13-6, 2026-11-13). Each comes from the part of
 * Bitrefill's window kept for buying, and an invoice that was refused after it was none of the six an
 * hour: one wallet asking for a top-up with no number nineteen times in a minute took the whole window,
 * and the next person's purchase was refused by Bitrefill's limit. Counted with the refused ones, and
 * apart from the six invoices an hour, which count only invoices that opened.
 */
export const SPEND_QUOTES_PER_MINUTE_V1 = 3;
export const SPEND_QUOTES_PER_HOUR_V1 = 12;

export function createSpendOrderStoreV1(input: { now?: () => Date; ttlMs?: number } = {}): SpendOrderStoreV1 {
  const now = input.now ?? (() => new Date());
  const ttlMs = input.ttlMs ?? 30 * 60_000;
  const rows = new Map<string, SpendOrderV1>();
  const opened = new Map<string, number[]>();
  const quotes = new Map<string, number[]>();
  const underway = new Map<string, number>();
  const key = (owner: SpendOrderOwnerV1) => `${owner.tenantId}|${owner.walletAddress}`;
  const prune = () => {
    const at = now().getTime();
    for (const [id, row] of rows) if (at - Date.parse(row.createdAt) > ttlMs) rows.delete(id);
    for (const times of [opened, quotes]) {
      for (const [owner, list] of times) {
        const kept = list.filter((time) => at - time < 3_600_000);
        if (kept.length) times.set(owner, kept); else times.delete(owner);
      }
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
    quote(owner) {
      prune();
      const who = key(owner);
      const times = quotes.get(who) ?? [];
      const at = now().getTime();
      if (times.length >= SPEND_QUOTES_PER_HOUR_V1 || times.filter((time) => at - time < 60_000).length >= SPEND_QUOTES_PER_MINUTE_V1) return null;
      // Counted at once, before any await: requests sent together are counted together (audit SPEND-3).
      quotes.set(who, [...times, at]);
      let counted = true;
      return {
        unspent() {
          if (!counted) return;
          counted = false;
          const list = quotes.get(who) ?? [];
          const index = list.lastIndexOf(at);
          if (index >= 0) list.splice(index, 1);
          if (list.length) quotes.set(who, list); else quotes.delete(who);
        },
      };
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

/** Still's affiliate code at Bitrefill (the operator's partner account, 2026-11-13), from the environment only:
 * the public code base names none, so a copy of it run by somebody else credits nobody. `malformed` is a value
 * that breaks Bitrefill's own rule, which Bitrefill would drop in silence; Still then sends none and says so. */
export function stillBitrefillAffiliateV1(env: NodeJS.ProcessEnv = process.env): { state: 'attached'; code: string } | { state: 'unset' | 'malformed' } {
  const code = env.STILL_BITREFILL_AFFILIATE_CODE?.trim() ?? '';
  if (!code) return { state: 'unset' };
  return BITREFILL_AFFILIATE_CODE_V1.test(code) ? { state: 'attached', code } : { state: 'malformed' };
}

/** Whether Bitrefill may pay Still a commission on what is bought here: its affiliate code goes with every
 * invoice this process opens. A review says so in one line (STILL_SPEND_COMMISSION_NOTE_V1). */
export const stillSpendCommissionV1 = (env: NodeJS.ProcessEnv = process.env): boolean => stillBitrefillAffiliateV1(env).state === 'attached';

/** Still's client registered at Bitrefill (2026-11-02), from the environment;
 * without one the guest client is the metadata document. Never logged. The affiliate code
 * travels with whichever client it is. */
export function stillBitrefillClientV1(env: NodeJS.ProcessEnv = process.env): { clientId?: string; clientSecret?: string; affiliateCode?: string } {
  const clientId = env.STILL_BITREFILL_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.STILL_BITREFILL_CLIENT_SECRET?.trim() ?? '';
  const affiliate = stillBitrefillAffiliateV1(env);
  const code = affiliate.state === 'attached' ? { affiliateCode: affiliate.code } : {};
  if (!/^[A-Za-z0-9._:/-]{8,200}$/.test(clientId)) return code;
  return { clientId, ...(clientSecret ? { clientSecret } : {}), ...code };
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
    const affiliate = stillBitrefillAffiliateV1().state;
    const said = { client: kind, pay: stillSpendPayEnabledV1() ? 'on' : 'off', secretExpiryKnown: Number.isFinite(Date.parse((process.env.STILL_BITREFILL_CLIENT_SECRET_EXPIRES_AT ?? '').trim())), affiliate };
    if (kind === 'registered') logger.info('Still Spend presents its registered client to Bitrefill', said);
    else logger.warn('Still Spend has no registered client with a secret: Bitrefill may refuse its catalogue and invoices', said);
    if (affiliate === 'malformed') logger.warn('STILL_BITREFILL_AFFILIATE_CODE is not 6 to 16 letters and digits: Still sends no affiliate code, and no purchase is attributed', { affiliate });
    checkoutV1 = createBitrefillGuestCheckoutV1(stillBitrefillClientV1());
  }
  return checkoutV1;
};
