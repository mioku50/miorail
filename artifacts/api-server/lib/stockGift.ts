import type { RouteIntentV1 } from '@mioagent/route-domain';
import type { BaseNameResolutionV1 } from './baseNameResolver.js';

// ---------------------------------------------------------------------------
// Growth plan step 4: give someone a tokenized stock.
//
// What may be given, decided here before anything is built: a Coinbase-issued
// B20 stock from Miorail's reviewed corpus, bought with canonical USDC, for
// $0.10 to $100 (the operator's range, 2026-09-23), to an address that is not
// the giver's own — at most five a day per wallet. A Basename the person typed
// is resolved again here and must still name the same address the review
// shows: the address is what the chain pays, the name is only how the person
// recognised it.
//
// The batch itself — the swap to the giver, then one transfer of exactly the
// swap's guaranteed minimum to the recipient — is built by the composer and
// checked by the Safety Kernel; nothing here touches calldata.
// ---------------------------------------------------------------------------

export const CANONICAL_BASE_USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** $0.10 in USDC atomic units. */
export const STOCK_GIFT_MIN_USDC_ATOMIC_V1 = 100_000n;
/** $100 in USDC atomic units. */
export const STOCK_GIFT_MAX_USDC_ATOMIC_V1 = 100_000_000n;
/** Approved gifts per wallet per UTC day. */
export const STOCK_GIFT_DAILY_LIMIT_V1 = 5;

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS_V1 = '0x0000000000000000000000000000000000000000';

export interface StockGiftRequestV1 {
  recipient: string;
  /** The Basename the person typed, when they typed one. */
  recipientName: string | null;
}

export type StockGiftRefusalCodeV1 =
  | 'gift_input_not_usdc'
  | 'gift_amount_out_of_range'
  | 'gift_not_a_reviewed_stock'
  | 'gift_recipient_invalid'
  | 'gift_recipient_is_you'
  | 'gift_name_changed'
  | 'gift_daily_limit_reached';

export type StockGiftCheckV1 =
  | { ok: true; recipient: `0x${string}` }
  | { ok: false; code: StockGiftRefusalCodeV1; message: string };

/** The whole gift policy, with its reads injected. */
export async function checkStockGiftV1(input: {
  intent: RouteIntentV1;
  walletAddress: string;
  gift: StockGiftRequestV1;
  /** True only for a Coinbase-issued B20 stock in the reviewed corpus. */
  isGiftableStock: (tokenAddress: string) => Promise<boolean>;
  resolveName: (name: string) => Promise<BaseNameResolutionV1>;
  /** Gifts this wallet already approved today (UTC). */
  giftsApprovedToday: () => Promise<number>;
}): Promise<StockGiftCheckV1> {
  const refuse = (code: StockGiftRefusalCodeV1, message: string): StockGiftCheckV1 => ({ ok: false, code, message });
  const { intent } = input;

  if (intent.fromAsset?.kind !== 'erc20' || intent.fromAsset.address?.toLowerCase() !== CANONICAL_BASE_USDC_V1) {
    return refuse('gift_input_not_usdc', 'A gift is bought with USDC.');
  }
  const amount = /^[0-9]+$/.test(intent.amount.amountAtomic) ? BigInt(intent.amount.amountAtomic) : -1n;
  if (amount < STOCK_GIFT_MIN_USDC_ATOMIC_V1 || amount > STOCK_GIFT_MAX_USDC_ATOMIC_V1) {
    return refuse('gift_amount_out_of_range', 'A gift is from 0.1 to 100 USDC.');
  }
  const token = intent.toAsset?.kind === 'erc20' ? intent.toAsset.address?.toLowerCase() ?? null : null;
  if (!token || !(await input.isGiftableStock(token))) {
    return refuse(
      'gift_not_a_reviewed_stock',
      'Only a Coinbase-issued tokenized stock Miorail has reviewed can be given here.',
    );
  }

  const recipient = input.gift.recipient.trim().toLowerCase();
  if (!ADDRESS_V1.test(recipient) || recipient === ZERO_ADDRESS_V1 || recipient === token || recipient === CANONICAL_BASE_USDC_V1) {
    return refuse('gift_recipient_invalid', 'The recipient must be a Base wallet address.');
  }
  if (recipient === input.walletAddress.toLowerCase()) {
    return refuse('gift_recipient_is_you', 'A gift goes to someone else. To buy for yourself, use Buy.');
  }
  if (input.gift.recipientName) {
    // Resolved again, now: a name can be pointed elsewhere between the moment
    // it was typed and the moment the batch is built.
    const resolved = await input.resolveName(input.gift.recipientName);
    if (resolved.outcome !== 'resolved' || resolved.address.toLowerCase() !== recipient) {
      return refuse(
        'gift_name_changed',
        `${input.gift.recipientName} no longer resolves to the address shown. Enter the recipient again.`,
      );
    }
  }
  if ((await input.giftsApprovedToday()) >= STOCK_GIFT_DAILY_LIMIT_V1) {
    return refuse(
      'gift_daily_limit_reached',
      `This wallet has sent ${STOCK_GIFT_DAILY_LIMIT_V1} gifts today, the daily limit. It resets at 00:00 UTC.`,
    );
  }
  return { ok: true, recipient: recipient as `0x${string}` };
}

/** The recipient a person typed, made into an address — or why it is not one. */
export type GiftRecipientResolutionV1 =
  | { outcome: 'resolved'; address: `0x${string}`; name: string | null }
  | { outcome: 'refused'; code: 'recipient_invalid' | 'recipient_is_you' | 'name_unresolved' | 'resolver_unavailable'; message: string };

export async function resolveGiftRecipientV1(input: {
  value: string;
  walletAddress: string;
  resolveName: (name: string) => Promise<BaseNameResolutionV1>;
}): Promise<GiftRecipientResolutionV1> {
  const value = input.value.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    const address = value.toLowerCase() as `0x${string}`;
    if (address === ZERO_ADDRESS_V1) {
      return { outcome: 'refused', code: 'recipient_invalid', message: 'That is the zero address; nothing sent there can be spent.' };
    }
    if (address === input.walletAddress.toLowerCase()) {
      return { outcome: 'refused', code: 'recipient_is_you', message: 'That is your own wallet. A gift goes to someone else.' };
    }
    return { outcome: 'resolved', address, name: null };
  }
  if (!/^[^\s]{1,255}\.base\.eth$/i.test(value)) {
    return {
      outcome: 'refused',
      code: 'recipient_invalid',
      message: 'Enter a Basename such as alice.base.eth, or a Base address starting with 0x.',
    };
  }
  const resolved = await input.resolveName(value);
  if (resolved.outcome !== 'resolved') {
    return resolved.outcome === 'not_configured' || resolved.outcome === 'unavailable'
      ? { outcome: 'refused', code: 'resolver_unavailable', message: 'Basenames cannot be looked up right now. Paste the 0x address instead.' }
      : { outcome: 'refused', code: 'name_unresolved', message: `${value} does not resolve to a Base address.` };
  }
  const address = resolved.address.toLowerCase() as `0x${string}`;
  if (address === input.walletAddress.toLowerCase()) {
    return { outcome: 'refused', code: 'recipient_is_you', message: `${resolved.name} is your own wallet. A gift goes to someone else.` };
  }
  return { outcome: 'resolved', address, name: resolved.name };
}
