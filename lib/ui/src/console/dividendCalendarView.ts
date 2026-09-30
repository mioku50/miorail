import type {
  DividendWalletEventV1,
  DividendWalletHoldingV1,
  DividendWalletResponseV1,
} from '@mioagent/rwa-market-reality/dividend-wallet';
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

/** One stock the signed-in wallet holds, or held when a dividend reached it. */
export interface MyDividendRowViewV1 {
  key: string;
  /** "GOOGLc · 4 held". */
  title: string;
  /** One sentence per dividend: ahead first, soonest first, then received. */
  lines: string[];
}

export interface MyDividendsViewV1 {
  title: string;
  rows: MyDividendRowViewV1[];
  /** What has been reinvested into this wallet's tokens so far, or null. */
  total: string | null;
  /** In place of rows: holds none of them, or could not be read. */
  empty: string | null;
  note: string;
}

export interface DividendCalendarViewV1 {
  title: string;
  lede: string;
  /** The signed-in wallet's own; null when signed out or not read yet. */
  mine: MyDividendsViewV1 | null;
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

/** "$0.33", "$0.003", or "less than $0.001" for a sliver of a token. */
function walletUsdV1(value: string): string {
  const number = Number(value);
  if (number > 0 && number < 0.001) return 'less than $0.001';
  return usdV1(value);
}

/** "about $0.33" ahead of time, but never "about less than". */
function aboutUsdV1(value: string): string {
  const said = walletUsdV1(value);
  return said.startsWith('$') ? `about ${said}` : said;
}

/** "4", "2.5", "0.012345". */
function tokensV1(value: string): string {
  const number = Number(value);
  return number.toLocaleString('en-US', { maximumFractionDigits: number < 1 ? 6 : 4 });
}

function aheadV1(event: DividendWalletEventV1, holding: DividendWalletHoldingV1): string {
  const day = event.payDateApproximate ? `Around ${dayV1(event.payDate)}` : dayV1(event.payDate);
  const yours = `your ${tokensV1(event.tokens)} ${holding.tokenSymbol}`;
  const about = event.usd === null ? null : `${aboutUsdV1(event.usd)} on ${yours}`;
  switch (event.state) {
    case 'estimated':
      return about
        ? `${day}: ${about} — an estimate, ${holding.company} has not declared it yet.`
        : `${day}: ${holding.company} has not declared it yet, and nothing has converted to estimate from.`;
    case 'announced':
      return about
        ? `${day}: ${about}${event.kind === 'estimate' ? ' (estimate)' : ''} — ${holding.company} declared $${event.amountPerShare} a share.`
        : `${day}: ${holding.company} declared $${event.amountPerShare} a share; what reaches a token is not measured yet.`;
    case 'scheduled':
      return `${event.at ? dayV1(event.at.slice(0, 10)) : day}: ${about ?? `more ${holding.symbol} per ${holding.tokenSymbol}`}, scheduled on Base by the issuer.`;
    case 'awaiting_confirmation':
    case 'not_reflected':
      return `${day}: ${holding.company} paid $${event.amountPerShare} a share; it is not in the token yet${about ? ` — ${about} when it is` : ''}.`;
    case 'not_entitled':
      return `${day}: not owed — ${holding.tokenSymbol} had no supply on the record date.`;
    default:
      return `${day}: $${event.amountPerShare} a share.`;
  }
}

function receivedV1(event: DividendWalletEventV1, holding: DividendWalletHoldingV1): string {
  const shares = event.shares === null ? '' : ` — ${Number(event.shares).toPrecision(2)} more ${holding.symbol} shares`;
  const worth = event.usd === null ? 'Reinvested' : `${walletUsdV1(event.usd)} reinvested`;
  return `${dayV1(event.payDate)}: ${worth}${shares} on the ${tokensV1(event.tokens)} ${holding.tokenSymbol} you held.`;
}

/**
 * The signed-in wallet's dividends, in words. Null while there is nothing to
 * say yet: signed out, or the first read has not answered.
 */
export function myDividendsViewV1(
  mine: { data: DividendWalletResponseV1 | null | undefined; failed: boolean } | null | undefined,
): MyDividendsViewV1 | null {
  if (!mine || (!mine.data && !mine.failed)) return null;
  const note = 'A dividend reaches whoever holds the token when its multiplier moves, not on the record date.';
  if (!mine.data) {
    return { title: 'Your dividends', rows: [], total: null, empty: 'Your dividends could not be read just now.', note };
  }
  const rows = mine.data.holdings.map((holding): MyDividendRowViewV1 => {
    const lines = [
      ...holding.upcoming.map((event) => aheadV1(event, holding)),
      ...holding.received.map((event) => receivedV1(event, holding)),
    ];
    return {
      key: holding.tokenAddress,
      title: Number(holding.tokens) > 0 ? `${holding.tokenSymbol} · ${tokensV1(holding.tokens)} held` : `${holding.tokenSymbol} · none held now`,
      lines: lines.length > 0 ? lines : ['No dividend on record.'],
    };
  });
  const received = Number(mine.data.receivedUsd);
  return {
    title: 'Your dividends',
    rows,
    total: received > 0 ? `Reinvested into your tokens so far: ${walletUsdV1(mine.data.receivedUsd)}.` : null,
    empty: rows.length === 0 ? 'This wallet holds none of these stocks.' : null,
    note,
  };
}

/** Null when no stock has a dividend on record, so the board shows nothing. */
export function dividendCalendarViewV1(
  response: DividendCalendarResponseV1 | null | undefined,
  mine?: { data: DividendWalletResponseV1 | null | undefined; failed: boolean } | null,
): DividendCalendarViewV1 | null {
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
  const measured = response.passThrough.measuredOn;
  return {
    title: 'Dividends on Base',
    lede: "A company pays cash per share. A Coinbase token gets it as more shares per token, after withholding tax and Coinbase's fee — read from the token, never assumed.",
    mine: myDividendsViewV1(mine),
    rows,
    none: quiet.length > 0 ? `No dividend on record: ${quiet.join(', ')}.` : null,
    note: [
      "Declared: the company's own release. Estimate: not declared yet — the last dividend again, a quarter later.",
      response.passThrough.percent && measured.length > 0
        ? `Estimates use the median measured share of declared dividends that reached a token: ${response.passThrough.percent}%, from ${measured.map((row) => `${row.symbol} ${dayV1(row.payDate)}: ${row.percent}%`).join('; ')}. Each conversion is valued at its historical reference price. This is not a fixed withholding rate or fee.`
        : 'Per token: nothing has converted yet, so nothing is estimated.',
    ].join(' '),
  };
}
