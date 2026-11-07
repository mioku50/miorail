export interface StockHoldingV1 {
  state: 'read' | 'unread';
  balanceAtomic?: string;
  decimals?: number;
  blockTag?: string;
}

export function tokenDecimalV1(atomic: string, decimals: number): string {
  if (decimals === 0) return atomic;
  const padded = atomic.padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return `${padded.slice(0, -decimals)}${fraction ? `.${fraction}` : ''}`;
}

/**
 * A typed decimal in one spelling: a phone's decimal keypad gives a comma where the language
 * writes one (an iPhone set to Russian has no dot key, 2026-11-07), so a lone comma is the
 * decimal point. One that could be a thousands separator ("1,000", "12,500") is not guessed at:
 * it stays, and the amount is refused with a request to write it again.
 */
export function decimalSpellingV1(text: string): string {
  const value = text.trim();
  if (!value.includes(',') || value.includes('.') || value.indexOf(',') !== value.lastIndexOf(',')) return value;
  if (/^[1-9][0-9]{0,2},[0-9]{3}$/.test(value)) return value;
  return value.replace(',', '.');
}

/** Convert user text exactly. Never round a position or pass it through Number. */
export function stockSellAmountV1(value: string, holding?: StockHoldingV1 | null): {
  atomic: string | null; balance: string | null; error: string | null;
} {
  const decimals = holding?.decimals;
  if (holding?.state !== 'read' || !Number.isInteger(decimals) || decimals! < 0 || decimals! > 255 ||
      !/^[0-9]{1,78}$/.test(holding.balanceAtomic ?? '')) {
    return { atomic: null, balance: null, error: 'The token balance could not be read. Refresh this review before confirming.' };
  }
  const balance = tokenDecimalV1(BigInt(holding.balanceAtomic!).toString(), decimals!);
  if (BigInt(holding.balanceAtomic!) === 0n) {
    return { atomic: null, balance, error: 'This wallet has no tokens of this exact contract to sell.' };
  }
  const text = decimalSpellingV1(value);
  if (!text) return { atomic: null, balance, error: 'Enter the exact token amount to sell.' };
  if (/^[1-9][0-9]{0,2},[0-9]{3}$/.test(text)) {
    return { atomic: null, balance, error: `Write ${text} again without the comma, or with a dot: it could be ${text.replace(',', '')} or ${text.replace(',', '.')}.` };
  }
  if (text.length > 336 || !/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(text)) {
    return { atomic: null, balance, error: 'Use a decimal amount such as 0.5 or 0,5, without thousands separators or exponents.' };
  }
  const [whole = '', fraction = ''] = text.split('.');
  if (fraction.length > decimals!) {
    return { atomic: null, balance, error: `This token supports at most ${decimals} decimal places. Nothing is rounded.` };
  }
  const atomic = BigInt(`${whole || '0'}${fraction.padEnd(decimals!, '0')}`).toString();
  if (atomic === '0') return { atomic: null, balance, error: 'Enter an amount greater than zero.' };
  if (BigInt(atomic) > BigInt(holding.balanceAtomic!)) {
    return { atomic: null, balance, error: 'The amount exceeds the balance read for this wallet.' };
  }
  return { atomic, balance, error: null };
}

// ---------------------------------------------------------------------------
// Phase 17.9 — terms belong to ONE amount, and the amount can change.
//
// Extracted as pure functions because this is the rule that decides whether a
// confirm button is live, and a rule that decides that should be readable and
// testable on its own rather than inline in a hook.
// ---------------------------------------------------------------------------

export type StockSellTermsStateV1 =
  /** No amount, or the terms on hand are for a different one. */
  | 'unasked'
  | 'pending'
  /** Routers answered for THIS amount and offered a route. */
  | 'established'
  /** Routers answered for THIS amount and none offered a route. Market. */
  | 'no_route'
  /** The measurement did not complete. Ours. */
  | 'not_established';

export function stockSellTermsStateV1(input: {
  /** The amount currently in the box, in atoms, or null when it is not valid. */
  amountAtomic: string | null;
  /** The amount the terms on hand were established for. */
  askedFor: string | null;
  pending: boolean;
  status: 'established' | 'no_route' | 'not_established' | null;
}): StockSellTermsStateV1 {
  if (input.pending) return 'pending';
  // Edit the amount and the match stops holding — which is exactly the truth:
  // those terms are for a different size. Nothing has to invalidate anything.
  if (!input.amountAtomic || input.askedFor !== input.amountAtomic) return 'unasked';
  return input.status ?? 'not_established';
}

/**
 * Whether a sell may be confirmed.
 *
 * Only `established` — for this exact amount — opens the button. The server
 * refuses the same way and does not trust this; the gate exists so a reader is
 * never offered a button whose meaning the page cannot yet state.
 */
export function stockSellConfirmAllowedV1(
  state: StockSellTermsStateV1,
  amountAtomic: string | null,
): boolean {
  return Boolean(amountAtomic) && state === 'established';
}

// ---------------------------------------------------------------------------
// Max, on a buy or a sell: the whole balance, exactly.
//
// A buy spends USDC and a sell spends the stock, so each is bounded by a
// different read: the wallet's USDC for a buy, its holding of this exact
// contract for a sell. Max writes that balance into the field in full, never
// rounded, and the field is then read like anything typed: the button still
// says the amount it sends, and the route is planned and quoted again at it.
// (Operator, 2026-11-05: a sell typed as 0.213 for a holding of 0.0213.)
// ---------------------------------------------------------------------------

export type TradeBalanceV1 =
  | { status: 'read'; symbol: string; decimals: number; atomic: string }
  | { status: 'none'; symbol: string }
  | { status: 'unavailable'; message: string };

/** What Max writes into the field, and the line that says where it came from. */
export function tradeMaxV1(balance: TradeBalanceV1 | null): { text: string | null; note: string | null } {
  if (balance === null) return { text: null, note: null };
  if (balance.status === 'unavailable') return { text: null, note: balance.message };
  if (balance.status === 'none' || !/^[0-9]+$/.test(balance.atomic) || !/[1-9]/.test(balance.atomic)) {
    return { text: null, note: `Your wallet holds no ${balance.symbol}.` };
  }
  const text = tokenDecimalV1(balance.atomic, balance.decimals);
  return { text, note: `In your wallet: ${text} ${balance.symbol}.` };
}
