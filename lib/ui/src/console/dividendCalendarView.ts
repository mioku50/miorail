import type {
  DividendWalletEventV1,
  DividendWalletHoldingV1,
  DividendWalletResponseV1,
} from '@mioagent/rwa-market-reality/dividend-wallet';
import {
  dividendReleasesReadV1,
  type DividendCalendarResponseV1,
  type DividendEventV1,
  type DividendNoticeV1,
  type DividendStockV1,
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
  /** The issuer's dividend notice in the token, not converted yet, or null. */
  notice: string | null;
}

/** One stock the signed-in wallet holds, or held when a dividend reached it. */
export interface MyDividendRowViewV1 {
  key: string;
  /** "GOOGLc · 4 held". */
  title: string;
  /** One sentence per dividend: ahead first, soonest first, then received. */
  lines: string[];
  /**
   * The one line worth showing beside the holding, or null.
   *
   * A $0.21 position read "less than $0.001" twice above everything else on
   * its card (2026-10-03). A sum under a cent is still in `lines`, in the
   * record a reader can open; it just does not lead.
   */
  lead: string | null;
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
  /** The stocks whose releases Miorail reads and that have no dividend on record, named once. */
  none: string | null;
  /** The stocks whose releases Miorail does not read: its gap, never "no dividend". */
  unread: string | null;
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

/** "A, B and C". */
function listV1(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

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

/** "Coinbase posted “Cash Dividend” in the AEOc contract on Oct 3." The words
 * in quotes are the issuer's own; nothing in the notice is an amount or a date. */
function noticeV1(notice: DividendNoticeV1, tokenSymbol: string): string {
  return `Coinbase posted “${notice.description}” in the ${tokenSymbol} contract on ${dayV1(notice.at.slice(0, 10))}.`;
}

/** A dollar sum too small to lead a holding's card: under one cent. */
function underACentV1(usd: string | null): boolean {
  return usd !== null && Number(usd) < 0.01;
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
    // A notice in the token leads: it is the dividend that reaches whoever
    // holds the token when it converts, and it has no sum to be too small.
    const notice = holding.notice
      ? `${noticeV1(holding.notice, holding.tokenSymbol)} It reaches whoever holds ${holding.tokenSymbol} when it converts; the amount is not published yet.`
      : null;
    const lines = [
      ...(notice ? [notice] : []),
      ...holding.upcoming.map((event) => aheadV1(event, holding)),
      ...holding.received.map((event) => receivedV1(event, holding)),
    ];
    const first = holding.upcoming[0] ?? holding.received[0] ?? null;
    return {
      key: holding.tokenAddress,
      lead: notice ?? (first && !underACentV1(first.usd) ? (lines[0] ?? null) : null),
      title: Number(holding.tokens) > 0 ? `${holding.tokenSymbol} · ${tokensV1(holding.tokens)} held` : `${holding.tokenSymbol} · none held now`,
      lines:
        lines.length > 0
          ? lines
          : [
              dividendReleasesReadV1(holding.underlyingKey)
                ? 'No dividend on record.'
                : `Not read: Miorail does not read ${holding.symbol}'s dividend releases yet.`,
            ],
    };
  });
  const received = Number(mine.data.receivedUsd);
  return {
    title: 'Your dividends',
    rows,
    total: received >= 0.01 ? `Reinvested into your tokens so far: ${walletUsdV1(mine.data.receivedUsd)}.` : null,
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
  const payers = response.stocks.filter((stock) => stock.next !== null || stock.history.length > 0 || Boolean(stock.notice));
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
        : stock.notice
          ? 'Amount and date not published'
          : '—',
      state: next ? STATE_LABELS_V1[next.state] : stock.notice ? 'Notice in the token' : 'None declared',
      effect: next
        ? effectV1(next, stock)
        : stock.notice
          ? `When it is paid, it converts into more ${stock.symbol} per ${stock.tokenSymbol}.`
          : null,
      source: next?.source ? { label: `${stock.company}'s release`, href: next.source.url } : null,
      last: last ? lastV1(last, stock) : null,
      notice: stock.notice ? noticeV1(stock.notice, stock.tokenSymbol) : null,
    };
  });
  const silent = response.stocks.filter((stock) => stock.next === null && stock.history.length === 0 && !stock.notice);
  const quiet = silent.filter((stock) => dividendReleasesReadV1(stock.underlyingKey)).map((stock) => stock.symbol);
  const unread = silent.filter((stock) => !dividendReleasesReadV1(stock.underlyingKey)).map((stock) => stock.symbol);
  const read = [...new Set(response.stocks.filter((stock) => dividendReleasesReadV1(stock.underlyingKey)).map((stock) => stock.symbol))].sort();
  // Everyone the sentence is about: every stock whose releases are not read,
  // the ones with a notice in the token included. Counting only the silent
  // ones said "the other 120" on a board of 127 (2026-10-10).
  const others = new Set(response.stocks.filter((stock) => !dividendReleasesReadV1(stock.underlyingKey)).map((stock) => stock.symbol)).size;
  const measured = response.passThrough.measuredOn;
  return {
    title: 'Dividends on Base',
    lede: "A company pays cash per share. A Coinbase token gets it as more shares per token, after withholding tax and Coinbase's fee — read from the token, never assumed.",
    mine: myDividendsViewV1(mine),
    rows,
    none: quiet.length > 0 ? `No dividend on record: ${quiet.join(', ')}.` : null,
    // A count, not a roll-call. The list of every unread ticker ran to 53
    // names on the board (2026-10-03) — a wall of "not" in front of the five
    // the board does read. The scope is kept: the others are not called
    // dividend-free, only not read.
    unread:
      unread.length > 0
        ? `Miorail reads the dividend releases of ${read.length > 0 ? listV1(read) : 'none of these companies'}. For ${others === 1 ? 'the other stock' : `the other ${others} stocks`} on this board it shows a dividend only when Coinbase posts a notice in the token before paying it.`
        : null,
    note: [
      "Declared: the company's own release. Estimate: not declared yet — the last dividend again, a quarter later.",
      response.passThrough.percent && measured.length > 0
        ? `Estimates use the median measured share of declared dividends that reached a token: ${response.passThrough.percent}%, from ${measured.map((row) => `${row.symbol} ${dayV1(row.payDate)}: ${row.percent}%`).join('; ')}. Each conversion is valued at its historical reference price. This is not a fixed withholding rate or fee.`
        : 'Per token: nothing has converted yet, so nothing is estimated.',
    ].join(' '),
  };
}
