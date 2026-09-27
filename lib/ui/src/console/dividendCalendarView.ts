import type {
  DividendCalendarResponseV1,
  DividendEventV1,
  DividendStockV1,
} from '@mioagent/rwa-market-reality/dividends';

// ---------------------------------------------------------------------------
// The dividend card, in words.
//
// A company pays cash per share, and a Coinbase token receives it as more
// shares per token. So each row says two things and keeps them apart: what the
// company declared, in its own release, and what reached the token, read from
// the token. An estimate is called one, and so is a gap in Miorail's own
// reading. No colour says good or bad: the words carry the state.
// ---------------------------------------------------------------------------

export interface DividendRowViewV1 {
  key: string;
  symbol: string;
  tokenSymbol: string;
  /** "$0.525 · Sep 28", or "≈ $0.22 · around Dec 14". */
  next: string;
  /** Declared, Estimate, Scheduled on Base… */
  state: string;
  /** What the next one does to a token, or null. */
  effect: string | null;
  /** The company's own release, for a declared dividend. */
  source: { label: string; href: string } | null;
  /** The last one, in a sentence, or null. */
  last: string | null;
}

export interface DividendCalendarViewV1 {
  title: string;
  lede: string;
  rows: DividendRowViewV1[];
  /** The stocks with no dividend on record, named once. */
  none: string | null;
  note: string;
}

const STATE_LABELS_V1: Record<DividendEventV1['state'], string> = {
  estimated: 'Estimate',
  announced: 'Declared',
  scheduled: 'Scheduled on Base',
  effective: 'Reinvested',
  awaiting_confirmation: 'Paid, not read yet',
  not_entitled: 'Not owed',
  not_reflected: 'Not in the token yet',
};

/** "Sep 28" from a New York date. */
function dayV1(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
}

/** "0.0417" -> "0.042%": two significant places after the first non-zero. */
function percentV1(value: string): string {
  const number = Number(value);
  const digits = number >= 0.1 ? 2 : number >= 0.01 ? 3 : 4;
  return `${number.toFixed(digits)}%`;
}

function usdV1(value: string): string {
  const number = Number(value);
  return `$${number < 1 ? number.toFixed(3) : number.toFixed(2)}`;
}

function effectV1(event: DividendEventV1, stock: DividendStockV1): string | null {
  const token = event.token;
  if (token.kind === 'none' || token.increasePercent === null) return null;
  const more = `+${percentV1(token.increasePercent)} ${stock.symbol} per ${stock.tokenSymbol}`;
  if (token.kind === 'scheduled') {
    return `${more} from ${token.at ? `${dayV1(token.at.slice(0, 10))}, ` : ''}published on Base by the issuer`;
  }
  if (token.kind === 'estimate') {
    return `≈ ${more}${token.perTokenUsd ? `, about ${usdV1(token.perTokenUsd)} a token` : ''} (estimate)`;
  }
  return more;
}

function lastV1(event: DividendEventV1, stock: DividendStockV1): string {
  const day = dayV1(event.payDate);
  switch (event.state) {
    case 'effective': {
      const token = event.token;
      const worth = token.perTokenUsd ? `, worth ${usdV1(token.perTokenUsd)}` : '';
      const share = token.passThroughPercent ? ` — ${token.passThroughPercent}% of the $${event.amountPerShare} declared` : '';
      return `${day}: ${effectV1(event, stock) ?? 'reinvested'}${worth}${share}.`;
    }
    case 'not_entitled':
      return `${day}: $${event.amountPerShare} paid, not owed — ${stock.tokenSymbol} had no supply on the record date.`;
    case 'not_reflected':
      return `${day}: $${event.amountPerShare} paid; ${stock.tokenSymbol}'s multiplier has not moved since.`;
    case 'awaiting_confirmation':
      return `${day}: $${event.amountPerShare} paid; Miorail has not read ${stock.tokenSymbol} since.`;
    default:
      return `${day}: $${event.amountPerShare}.`;
  }
}

/** Null when no stock has a dividend on record, so the board shows nothing. */
export function dividendCalendarViewV1(response: DividendCalendarResponseV1 | null | undefined): DividendCalendarViewV1 | null {
  if (!response) return null;
  const payers = response.stocks.filter((stock) => stock.next !== null || stock.history.length > 0);
  if (payers.length === 0) return null;
  const rows = payers.map((stock): DividendRowViewV1 => {
    const next = stock.next;
    const last = stock.history[0] ?? null;
    return {
      key: stock.tokenAddress,
      symbol: stock.symbol,
      tokenSymbol: stock.tokenSymbol,
      next: next
        ? next.payDateApproximate
          ? `≈ $${next.amountPerShare} · around ${dayV1(next.payDate)}`
          : `$${next.amountPerShare} · ${dayV1(next.payDate)}`
        : '—',
      state: next ? STATE_LABELS_V1[next.state] : 'None declared',
      effect: next ? effectV1(next, stock) : null,
      source: next?.source ? { label: `${stock.company}'s release`, href: next.source.url } : null,
      last: last ? lastV1(last, stock) : null,
    };
  });
  const quiet = response.stocks.filter((stock) => stock.next === null && stock.history.length === 0).map((stock) => stock.symbol);
  const measured = response.passThrough.measuredOn[0];
  return {
    title: 'Dividends on Base',
    lede: "A company pays cash per share. A Coinbase token gets it as more shares per token, after withholding tax and Coinbase's fee — read from the token, never assumed.",
    rows,
    none: quiet.length > 0 ? `No dividend on record: ${quiet.join(', ')}.` : null,
    note: [
      "Declared: the company's own release. Estimate: not declared yet — the last dividend again, a quarter later.",
      response.passThrough.percent && measured
        ? `Per token: ${response.passThrough.percent}% of a dividend has reached a token so far (${measured.symbol}, ${dayV1(measured.payDate)}), at the latest reference price.`
        : 'Per token: nothing has converted yet, so nothing is estimated.',
    ].join(' '),
  };
}
