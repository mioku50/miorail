import { newYorkDateV1, type DividendDeclarationV1 } from './dividends.js';

// ---------------------------------------------------------------------------
// A company's dividend declaration, read from its own release.
//
// Every company declares a dividend in the same sentence every quarter, so
// each has a pattern for that sentence, and only a full match counts as a
// declaration. A near miss counts as nothing. Alphabet declares a preferred
// and a common dividend in one paragraph, and "the nearest date after the
// amount" gives the common dividend the preferred one's dates. When a company
// rewords its release, the pattern stops matching and the watcher reports
// the document it could not read. It never guesses.
// ---------------------------------------------------------------------------

export type DividendSourceKindV1 = 'sec_8k' | 'company_newsroom' | 'press_wire';

export interface DividendIssuerV1 {
  underlyingKey: string;
  symbol: string;
  company: string;
  /** SEC Central Index Key, when the company files its declaration as an 8-K exhibit. */
  cik: string | null;
  /** A feed that lists the company's own release, when it is not on EDGAR. */
  feed: { kind: 'company_newsroom' | 'press_wire'; url: string; title: RegExp; publisher: string } | null;
  /** Who published an 8-K exhibit, as the calendar names it. */
  filer: string | null;
  /** The declaration sentence, with named groups amount, pay, record, and ex when it has one. */
  patterns: readonly RegExp[];
}

const MONTH_V1 =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.|Feb\\.|Mar\\.|Apr\\.|Aug\\.|Sept\\.|Sep\\.|Oct\\.|Nov\\.|Dec\\.)';
const DATE_V1 = `${MONTH_V1} \\d{1,2}, \\d{4}`;
const AMOUNT_V1 = '\\$(?<amount>\\d+\\.\\d{2,4})';

function patternV1(source: string): RegExp {
  return new RegExp(source.replaceAll('DATE', DATE_V1).replaceAll('AMOUNT', AMOUNT_V1));
}

/** The five that pay, with the sentence each one used in 2026. */
export const DIVIDEND_ISSUERS_V1: readonly DividendIssuerV1[] = [
  {
    underlyingKey: 'security:isin:US0378331005',
    symbol: 'AAPL',
    company: 'Apple',
    cik: '320193',
    feed: null,
    filer: 'Apple Inc., Form 8-K, exhibit 99.1',
    patterns: [
      patternV1(
        "declared a cash dividend of AMOUNT per share of the Company's common stock\\. The dividend is payable on (?<pay>DATE),? to shareholders of record as of the close of business on (?<record>DATE)\\.",
      ),
    ],
  },
  {
    underlyingKey: 'security:isin:US02079K3059',
    symbol: 'GOOGL',
    company: 'Alphabet',
    cik: '1652044',
    feed: null,
    filer: 'Alphabet Inc., Form 8-K, exhibit 99.1',
    patterns: [
      // The common dividend's own dates, past the preferred one's, and no
      // other amount in between.
      patternV1(
        "a quarterly cash dividend of AMOUNT per share on our Class A, Class B,? and Class C stock\\.(?:(?!\\$\\d).){0,600}?the common stock dividend is payable on (?<pay>DATE),? to stockholders of record for each of the company's Class A, Class B,? and Class C shares as of (?<record>DATE)\\.",
      ),
    ],
  },
  {
    underlyingKey: 'security:isin:US30303M1027',
    symbol: 'META',
    company: 'Meta',
    cik: '1326801',
    feed: {
      kind: 'press_wire',
      url: 'https://www.prnewswire.com/rss/financial-services-latest-news/dividends-list.rss',
      title: /^Meta Announces Quarterly Cash Dividend$/i,
      publisher: 'Meta Platforms, Inc., press release via PR Newswire',
    },
    filer: 'Meta Platforms, Inc., Form 8-K, exhibit 99.1',
    patterns: [
      patternV1(
        "declared a quarterly cash dividend of AMOUNT per share of the company's outstanding Class A common stock and Class B common stock, payable on (?<pay>DATE),? to stockholders of record as of the close of business on (?<record>DATE)\\.",
      ),
    ],
  },
  {
    underlyingKey: 'security:isin:US5949181045',
    symbol: 'MSFT',
    company: 'Microsoft',
    cik: '789019',
    feed: {
      kind: 'company_newsroom',
      url: 'https://news.microsoft.com/source/?s=quarterly+dividend&feed=rss2',
      title: /^Microsoft announces quarterly dividend/i,
      publisher: 'Microsoft Corp., press release',
    },
    filer: 'Microsoft Corp., Form 8-K, exhibit 99.1',
    patterns: [
      patternV1(
        'declared a quarterly dividend of AMOUNT per share[^.]*\\. The dividend is payable (?<pay>DATE),? to shareholders of record on (?<record>DATE)\\.(?: The ex-dividend date will be (?<ex>DATE)\\.)?',
      ),
    ],
  },
  {
    underlyingKey: 'security:isin:US67066G1040',
    symbol: 'NVDA',
    company: 'NVIDIA',
    cik: '1045810',
    feed: null,
    filer: 'NVIDIA Corp., Form 8-K, exhibit 99.1',
    patterns: [
      patternV1(
        'NVIDIA will pay its next quarterly cash dividend of AMOUNT per share on (?<pay>DATE),? to all shareholders of record on (?<record>DATE)\\.',
      ),
    ],
  },
];

const ENTITIES_V1: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

/** A release as its reader sees it: no markup, entities decoded, one space
 * between words, and straight quotes, so one pattern reads every typography. */
export function releaseTextV1(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES_V1[name.toLowerCase()] ?? whole;
    })
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTHS_V1: Readonly<Record<string, number>> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, july: 7,
  august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

/** "September 14, 2026" or "Sept. 10, 2026", as 2026-09-14. Null for anything else, including a day the month does not have. */
export function usDateV1(text: string): string | null {
  const match = /^([A-Za-z]+)\.? (\d{1,2}), (\d{4})$/.exec(text.trim());
  if (!match) return null;
  const month = MONTHS_V1[match[1]!.toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function daysBetweenV1(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

export interface DividendReadingV1 {
  declarations: DividendDeclarationV1[];
  /** Why a matched sentence was still not taken. */
  refused: string[];
}

/**
 * Every declaration one release makes, in the company's own sentence.
 *
 * `publishedAt` is when the release went out; its New York date is the
 * declaration date the calendar shows, and nothing may be declared after its
 * own record date.
 */
export function readDividendReleaseV1(input: {
  issuer: DividendIssuerV1;
  text: string;
  publishedAt: Date;
  url: string;
  publisher: string;
}): DividendReadingV1 {
  const declaredOn = newYorkDateV1(input.publishedAt);
  const found = new Map<string, DividendDeclarationV1>();
  const refused: string[] = [];
  for (const pattern of input.issuer.patterns) {
    for (const match of input.text.matchAll(new RegExp(pattern.source, 'g'))) {
      const groups = match.groups ?? {};
      const amount = groups.amount ?? '';
      const payDate = usDateV1(groups.pay ?? '');
      const recordDate = usDateV1(groups.record ?? '');
      const exDate = groups.ex ? usDateV1(groups.ex) : null;
      const why =
        !(Number(amount) > 0 && Number(amount) < 50)
          ? 'amount'
          : !payDate || !recordDate || (groups.ex && !exDate)
            ? 'date'
            : daysBetweenV1(recordDate, payDate) < 0 || daysBetweenV1(recordDate, payDate) > 60
              ? 'record_after_pay'
              : daysBetweenV1(declaredOn, recordDate) < 0
                ? 'declared_after_record'
                : exDate && (daysBetweenV1(exDate, recordDate) < 0 || daysBetweenV1(exDate, payDate) < 0)
                  ? 'ex_date'
                  : null;
      if (why) {
        refused.push(`${input.issuer.symbol}:${why}`);
        continue;
      }
      found.set(`${payDate}|${amount}`, {
        underlyingKey: input.issuer.underlyingKey,
        symbol: input.issuer.symbol,
        company: input.issuer.company,
        amountPerShare: amount,
        declaredOn,
        exDate,
        recordDate: recordDate!,
        payDate: payDate!,
        source: { publisher: input.publisher, url: input.url, quote: match[0] },
      });
    }
  }
  return { declarations: [...found.values()], refused };
}

/**
 * The registry and what the watcher found, as one list: a declaration is its
 * company and its payment date. The registry's reviewed entry wins a tie,
 * and a found one that disagrees with it is left out, not merged.
 */
export function mergeDividendDeclarationsV1(
  registry: readonly DividendDeclarationV1[],
  observed: readonly DividendDeclarationV1[],
): DividendDeclarationV1[] {
  const key = (row: DividendDeclarationV1) => `${row.underlyingKey}|${row.payDate}`;
  const merged = new Map(registry.map((row) => [key(row), row]));
  for (const row of observed) if (!merged.has(key(row))) merged.set(key(row), row);
  return [...merged.values()].sort((a, b) => a.payDate.localeCompare(b.payDate) || a.symbol.localeCompare(b.symbol));
}
