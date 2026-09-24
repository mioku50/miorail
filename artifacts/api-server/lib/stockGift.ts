import type { AssetRefV1, RouteIntentV1 } from '@mioagent/route-domain';
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

  const who = await checkGiftRecipientAndDayV1({
    token,
    walletAddress: input.walletAddress,
    gift: input.gift,
    resolveName: input.resolveName,
    giftsApprovedToday: input.giftsApprovedToday,
    selfMessage: 'A gift goes to someone else. To buy for yourself, use Buy.',
  });
  return who.ok ? { ok: true, recipient: who.recipient } : who;
}

/** Who receives, and whether today still has room — the same for a gift that
 * is bought and one given from holdings. */
async function checkGiftRecipientAndDayV1(input: {
  token: string;
  walletAddress: string;
  gift: StockGiftRequestV1;
  resolveName: (name: string) => Promise<BaseNameResolutionV1>;
  giftsApprovedToday: () => Promise<number>;
  selfMessage: string;
}): Promise<
  | { ok: true; recipient: `0x${string}` }
  | { ok: false; code: 'gift_recipient_invalid' | 'gift_recipient_is_you' | 'gift_name_changed' | 'gift_daily_limit_reached'; message: string }
> {
  const recipient = input.gift.recipient.trim().toLowerCase();
  if (!ADDRESS_V1.test(recipient) || recipient === ZERO_ADDRESS_V1 || recipient === input.token || recipient === CANONICAL_BASE_USDC_V1) {
    return { ok: false, code: 'gift_recipient_invalid', message: 'The recipient must be a Base wallet address.' };
  }
  if (recipient === input.walletAddress.toLowerCase()) {
    return { ok: false, code: 'gift_recipient_is_you', message: input.selfMessage };
  }
  if (input.gift.recipientName) {
    // Resolved again, now: a name can be pointed elsewhere between the moment
    // it was typed and the moment the batch is built.
    const resolved = await input.resolveName(input.gift.recipientName);
    if (resolved.outcome !== 'resolved' || resolved.address.toLowerCase() !== recipient) {
      return {
        ok: false,
        code: 'gift_name_changed',
        message: `${input.gift.recipientName} no longer resolves to the address shown. Enter the recipient again.`,
      };
    }
  }
  if ((await input.giftsApprovedToday()) >= STOCK_GIFT_DAILY_LIMIT_V1) {
    return {
      ok: false,
      code: 'gift_daily_limit_reached',
      message: `This wallet has sent ${STOCK_GIFT_DAILY_LIMIT_V1} gifts today, the daily limit. It resets at 00:00 UTC.`,
    };
  }
  return { ok: true, recipient: recipient as `0x${string}` };
}

// ---------------------------------------------------------------------------
// A gift from what the wallet already holds.
//
// The same person, recipient and day rules as a bought gift, and a range read
// as what the amount would fetch in USDC right now, since nothing is paid for
// it. Two reads come first: the wallet's balance of the stock, and that value.
// When either cannot be read the gift is not offered, and the sentence says
// the failure was a read, not a fact about the wallet or the stock.
//
// The ceiling is the bought gift's, $100. The floor is lower, $0.05: a
// position bought at the $0.10 minimum fetches a little under $0.10 once the
// route has taken its cost (0.00044227 NVDAc on 2026-09-23), and a $0.10 floor
// on the way out would strand exactly the position the floor on the way in
// made — the same reason a Sell has no floor at all.
// ---------------------------------------------------------------------------

/** $0.05 in USDC atomic units: the smallest gift from holdings. */
export const STOCK_GIFT_SEND_MIN_USDC_ATOMIC_V1 = 50_000n;

/** One wallet's holding of one token, read at one block. */
export type StockHoldingReadV1 =
  | { ok: true; decimals: number; symbol: string; balanceAtomic: string; blockNumber: string }
  | { ok: false };

/** What an amount fetches in USDC now; null when no router would say. */
export type StockValuationV1 = { usdcAtomic: string; provider: string; observedAt: string } | null;

export type StockGiftSendRefusalCodeV1 =
  | 'gift_amount_invalid'
  | 'gift_not_a_reviewed_stock'
  | 'gift_recipient_invalid'
  | 'gift_recipient_is_you'
  | 'gift_name_changed'
  | 'gift_daily_limit_reached'
  | 'gift_balance_unavailable'
  | 'gift_balance_short'
  | 'gift_value_unavailable'
  | 'gift_value_out_of_range';

export type StockGiftSendCheckV1 =
  | {
      ok: true;
      recipient: `0x${string}`;
      token: AssetRefV1;
      balance: { balanceAtomic: string; blockNumber: string };
      valuation: NonNullable<StockValuationV1>;
    }
  | { ok: false; code: StockGiftSendRefusalCodeV1; message: string };

function unitsV1(atomic: string, decimals: number): string {
  if (decimals === 0) return atomic;
  const padded = atomic.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** USDC atomic as dollars and cents, rounded down: never a flattering figure. */
export function usdcDollarsV1(atomic: string): string {
  const cents = BigInt(atomic) / 10_000n;
  return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** The token a send moves, as the route domain names it. */
export function stockAssetRefV1(input: { tokenAddress: string; symbol: string; decimals: number }): AssetRefV1 {
  const address = input.tokenAddress.toLowerCase() as `0x${string}`;
  return {
    assetId: `eip155:8453/erc20:${address}`,
    chainId: 8453,
    kind: 'erc20',
    address,
    symbol: input.symbol,
    decimals: input.decimals,
  };
}

export async function checkStockGiftSendV1(input: {
  tokenAddress: string;
  amountAtomic: string;
  walletAddress: string;
  gift: StockGiftRequestV1;
  isGiftableStock: (tokenAddress: string) => Promise<boolean>;
  resolveName: (name: string) => Promise<BaseNameResolutionV1>;
  giftsApprovedToday: () => Promise<number>;
  readHolding: (tokenAddress: string, walletAddress: string) => Promise<StockHoldingReadV1>;
  valueInUsdc: (input: { token: AssetRefV1; amountAtomic: string }) => Promise<StockValuationV1>;
}): Promise<StockGiftSendCheckV1> {
  const refuse = (code: StockGiftSendRefusalCodeV1, message: string): StockGiftSendCheckV1 => ({ ok: false, code, message });
  const token = input.tokenAddress.trim().toLowerCase();
  if (!/^[1-9][0-9]{0,77}$/.test(input.amountAtomic)) {
    return refuse('gift_amount_invalid', 'Enter how much of the stock to give.');
  }
  if (!ADDRESS_V1.test(token) || !(await input.isGiftableStock(token))) {
    return refuse(
      'gift_not_a_reviewed_stock',
      'Only a Coinbase-issued tokenized stock Miorail has reviewed can be given here.',
    );
  }
  const who = await checkGiftRecipientAndDayV1({
    token,
    walletAddress: input.walletAddress,
    gift: input.gift,
    resolveName: input.resolveName,
    giftsApprovedToday: input.giftsApprovedToday,
    selfMessage: 'A gift goes to someone else; this stock is already in your wallet.',
  });
  if (!who.ok) return who;

  const holding = await input.readHolding(token, input.walletAddress.toLowerCase()).catch((): StockHoldingReadV1 => ({ ok: false }));
  if (!holding.ok) {
    return refuse(
      'gift_balance_unavailable',
      'Miorail could not read this wallet’s balance just now, so nothing was prepared. This says nothing about the wallet; try again in a moment.',
    );
  }
  const asset = stockAssetRefV1({ tokenAddress: token, symbol: holding.symbol, decimals: holding.decimals });
  const amount = `${unitsV1(input.amountAtomic, holding.decimals)} ${holding.symbol}`;
  if (BigInt(holding.balanceAtomic) < BigInt(input.amountAtomic)) {
    return refuse(
      'gift_balance_short',
      `This wallet holds ${unitsV1(holding.balanceAtomic, holding.decimals)} ${holding.symbol}, less than the ${amount} to give. Give less, or buy it with USDC instead.`,
    );
  }

  const valuation = await input.valueInUsdc({ token: asset, amountAtomic: input.amountAtomic }).catch((): StockValuationV1 => null);
  if (!valuation || !/^[0-9]+$/.test(valuation.usdcAtomic)) {
    return refuse(
      'gift_value_unavailable',
      `Miorail could not price ${amount} just now, and the gift range is in dollars, so nothing was prepared. This says nothing about the stock; try again in a moment.`,
    );
  }
  const value = BigInt(valuation.usdcAtomic);
  if (value < STOCK_GIFT_SEND_MIN_USDC_ATOMIC_V1 || value > STOCK_GIFT_MAX_USDC_ATOMIC_V1) {
    return refuse(
      'gift_value_out_of_range',
      `A gift from what you hold is worth from $0.05 to $100. ${amount} fetches about ${usdcDollarsV1(valuation.usdcAtomic)} in USDC right now.`,
    );
  }
  return {
    ok: true,
    recipient: who.recipient,
    token: asset,
    balance: { balanceAtomic: holding.balanceAtomic, blockNumber: holding.blockNumber },
    valuation,
  };
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
