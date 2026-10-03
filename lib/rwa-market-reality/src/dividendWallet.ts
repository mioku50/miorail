import { z } from 'zod';

import {
  DIVIDEND_CONVERSION_WINDOW_DAYS_V1,
  DIVIDEND_STATES_V1,
  DividendEventV1Schema,
  DividendNoticeV1Schema,
  newYorkDateV1,
  shiftDateV1,
  type DividendCalendarResponseV1,
  type DividendEventV1,
} from './dividends.js';

// ---------------------------------------------------------------------------
// One wallet's dividends: what reached the tokens it held, and what the next
// ones should bring to the tokens it holds now.
//
// A Coinbase token takes a dividend as a higher multiplier, and the multiplier
// is one number for every holder, while `balanceOf` never moves with it (Base's
// B20 spec: the multiplier "rescales only the UI/scaled view"). So a dividend
// reaches whoever holds the token at the moment the multiplier changes, not
// whoever held it on the record date. What a wallet received is its balance
// just before that change times the shares per token the change added. What
// it should receive next is its balance now times the calendar's figure for
// one token, and the kind says whether that figure is the issuer's schedule
// or Miorail's estimate.
//
// Pure: the server reads the balances at pinned blocks, and the calendar is
// the public one.
// ---------------------------------------------------------------------------

export const DIVIDEND_WALLET_SCHEMA_VERSION_V1 = 'dividend-wallet/v1' as const;

const IsoV1 = z.string().datetime({ offset: true });
const DateV1 = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const AmountV1 = z.string().regex(/^\d+(?:\.\d+)?$/);

export const DividendWalletEventV1Schema = z
  .object({
    state: z.enum(DIVIDEND_STATES_V1),
    reason: DividendEventV1Schema.shape.reason,
    amountPerShare: AmountV1,
    payDate: DateV1,
    payDateApproximate: z.boolean(),
    /** Where the figures come from: measured on the token, scheduled by the
     * issuer, Miorail's estimate, or nothing to say. */
    kind: z.enum(['measured', 'scheduled', 'estimate', 'none']),
    /** Tokens the wallet held: just before the multiplier changed, for one it
     * received; now, for one ahead. */
    tokens: AmountV1,
    /** Underlying shares those tokens gained, or should gain. */
    shares: AmountV1.nullable(),
    /** What that is worth in USD, at the reference price the calendar used. */
    usd: AmountV1.nullable(),
    /** When the multiplier changed, or is due to. */
    at: IsoV1.nullable(),
  })
  .strict();
export type DividendWalletEventV1 = z.infer<typeof DividendWalletEventV1Schema>;

export const DividendWalletHoldingV1Schema = z
  .object({
    underlyingKey: z.string().min(1),
    symbol: z.string().min(1).max(40),
    company: z.string().min(1).max(200),
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    tokenSymbol: z.string().min(1).max(40),
    /** Tokens held at the response's block. */
    tokens: AmountV1,
    /** Ahead, soonest first: paid and not in the token yet, then the next
     * one. Empty when nothing is held now. */
    upcoming: z.array(DividendWalletEventV1Schema),
    /** Reached this wallet, newest first. */
    received: z.array(DividendWalletEventV1Schema),
    /** The issuer's dividend notice in the token, while this wallet holds it
     * and nothing has converted since. Optional: older responses lack it. */
    notice: DividendNoticeV1Schema.nullable().optional(),
  })
  .strict();
export type DividendWalletHoldingV1 = z.infer<typeof DividendWalletHoldingV1Schema>;

export const DividendWalletResponseV1Schema = z
  .object({
    schemaVersion: z.literal(DIVIDEND_WALLET_SCHEMA_VERSION_V1),
    generatedAt: IsoV1,
    /** The block every balance held now was read at. */
    blockNumber: z.number().int().positive(),
    /** The stocks this wallet holds now, or held when a dividend reached them. */
    holdings: z.array(DividendWalletHoldingV1Schema),
    /** Every `received[].usd`, added up. */
    receivedUsd: AmountV1,
    /** The share of a dividend that has reached tokens so far; every estimate uses it. */
    passThroughPercent: AmountV1.nullable(),
  })
  .strict();
export type DividendWalletResponseV1 = z.infer<typeof DividendWalletResponseV1Schema>;

/** A conversion the token made, as the calendar measured it. */
function convertedV1(event: DividendEventV1): boolean {
  return event.state === 'effective' && event.token.kind === 'measured' && event.token.at !== null;
}

/** Paid or due, and not in the token yet: it still reaches whoever holds the
 * token when it converts. `not_reflected` only while a conversion could still
 * come, the same window the calendar matches in. */
function pendingV1(event: DividendEventV1, today: string): boolean {
  if (event.state === 'awaiting_confirmation' || event.state === 'scheduled') return true;
  if (event.state === 'not_reflected') return today <= shiftDateV1(event.payDate, DIVIDEND_CONVERSION_WINDOW_DAYS_V1);
  return false;
}

function eventsOfV1(stock: DividendCalendarResponseV1['stocks'][number]): DividendEventV1[] {
  return stock.next ? [stock.next, ...stock.history] : [...stock.history];
}

export function dividendWalletKeyV1(tokenAddress: string, at: string): string {
  return `${tokenAddress.toLowerCase()}|${at}`;
}

/** Every conversion on the calendar: the server reads the wallet's balance at
 * the last block before each one. */
export function dividendWalletConversionsV1(calendar: DividendCalendarResponseV1): Array<{ tokenAddress: string; at: string }> {
  return calendar.stocks.flatMap((stock) =>
    eventsOfV1(stock)
      .filter(convertedV1)
      .map((event) => ({ tokenAddress: stock.tokenAddress, at: event.token.at! })),
  );
}

/** "6113.6938" from 611369380000 and 8 decimals: exact, never a float. */
export function tokenAmountV1(atomic: bigint, decimals: number): string {
  const digits = atomic.toString();
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

function walletEventV1(event: DividendEventV1, atomic: bigint, decimals: number): DividendWalletEventV1 {
  const tokens = Number(atomic) / 10 ** decimals;
  const effect = event.token;
  let shares: number | null = null;
  let usd: number | null = null;
  if ((effect.kind === 'measured' || effect.kind === 'scheduled') && effect.multiplierFrom && effect.multiplierTo) {
    const added = Number(BigInt(effect.multiplierTo) - BigInt(effect.multiplierFrom)) / 1e18;
    // Only a rise is a dividend; anything else has no amount to state.
    if (added > 0) {
      shares = tokens * added;
      usd = effect.priceUsd === null ? null : shares * Number(effect.priceUsd);
    }
  } else if (effect.kind === 'estimate' && effect.perTokenUsd !== null) {
    usd = tokens * Number(effect.perTokenUsd);
    shares = effect.priceUsd === null ? null : usd / Number(effect.priceUsd);
  }
  return {
    state: event.state,
    reason: event.reason,
    amountPerShare: event.amountPerShare,
    payDate: event.payDate,
    payDateApproximate: event.payDateApproximate,
    kind: effect.kind,
    tokens: tokenAmountV1(atomic, decimals),
    shares: shares === null || !Number.isFinite(shares) ? null : shares.toFixed(8),
    usd: usd === null || !Number.isFinite(usd) ? null : usd.toFixed(4),
    at: effect.at,
  };
}

export function dividendWalletV1(input: {
  calendar: DividendCalendarResponseV1;
  now: Date;
  /** The block `balances` were read at. */
  blockNumber: number;
  decimals: ReadonlyMap<string, number>;
  /** Atomic balance at `blockNumber`, by token address. */
  balances: ReadonlyMap<string, bigint>;
  /** Atomic balance at the last block before each conversion, keyed by `dividendWalletKeyV1`. */
  balancesBefore: ReadonlyMap<string, bigint>;
}): DividendWalletResponseV1 {
  const today = newYorkDateV1(input.now);
  let receivedUsd = 0;
  const holdings: DividendWalletHoldingV1[] = [];
  for (const stock of input.calendar.stocks) {
    const decimals = input.decimals.get(stock.tokenAddress);
    const held = input.balances.get(stock.tokenAddress);
    // An unread balance is not a zero one: the caller fails instead.
    if (decimals === undefined || held === undefined) throw new Error('dividend_wallet_balance_unread');

    const received: DividendWalletEventV1[] = [];
    for (const event of eventsOfV1(stock).filter(convertedV1)) {
      const before = input.balancesBefore.get(dividendWalletKeyV1(stock.tokenAddress, event.token.at!));
      if (before === undefined) throw new Error('dividend_wallet_past_balance_unread');
      if (before === 0n) continue;
      const row = walletEventV1(event, before, decimals);
      if (row.usd !== null) receivedUsd += Number(row.usd);
      received.push(row);
    }

    const upcoming: DividendWalletEventV1[] = [];
    if (held > 0n) {
      for (const event of [...stock.history].reverse()) {
        if (pendingV1(event, today)) upcoming.push(walletEventV1(event, held, decimals));
      }
      if (stock.next && !convertedV1(stock.next)) upcoming.push(walletEventV1(stock.next, held, decimals));
    }

    if (held === 0n && received.length === 0) continue;
    holdings.push({
      underlyingKey: stock.underlyingKey,
      symbol: stock.symbol,
      company: stock.company,
      tokenAddress: stock.tokenAddress,
      tokenSymbol: stock.tokenSymbol,
      tokens: tokenAmountV1(held, decimals),
      upcoming,
      received,
      notice: held > 0n ? (stock.notice ?? null) : null,
    });
  }
  return {
    schemaVersion: DIVIDEND_WALLET_SCHEMA_VERSION_V1,
    generatedAt: input.now.toISOString(),
    blockNumber: input.blockNumber,
    holdings,
    receivedUsd: receivedUsd.toFixed(4),
    passThroughPercent: input.calendar.passThrough.percent,
  };
}
