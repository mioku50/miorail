import { z } from 'zod';

import { etInstantV1 } from './weekendMarket.js';

// ---------------------------------------------------------------------------
// Dividends on Coinbase's tokenized stocks.
//
// A company pays a cash dividend per share. A Coinbase B20 token never pays
// cash: Coinbase turns what its shares received into more shares and raises the
// token's multiplier, "net of dividend withholding tax and a Coinbase fee"
// (Base's B20 announcement). So one dividend is two facts from two parties:
//
//   the DECLARATION, by the company: an amount per share, a record date and a
//   payment date, in the company's own press release or SEC filing;
//
//   the CONVERSION, by the token: a multiplier change, read from the token.
//
// This module joins them and never derives one from the other. A declaration
// is not a conversion: Apple paid on 2026-08-13, and AAPLc had no supply at
// Apple's record date, so nothing was owed to it. A conversion is not a
// declaration either, and a multiplier rise too large to be a dividend is left
// alone.
//
// Measured 2026-09-27 on the thirteen:
//   * GOOGLc's multiplier rose from 1 to 1.000377118676784179 at 18:29 UTC on
//     2026-09-14, Alphabet's payment date for $0.22. At the $347.10 reference
//     that is $0.131 per token, so 59.5% of the declared dividend reached a
//     token. Base publishes neither the withholding rate nor the fee, so the
//     share is measured, never assumed.
//   * AAPLc (Apple, record date 2026-08-10) and MSFTc (Microsoft, record date
//     2026-08-20) had zero supply at their record dates. Nothing was owed, and
//     nothing failed.
//   * Nothing else has converted. META pays 2026-09-28 and NVDA 2026-10-01.
//
// STATES are derived on every read and never stored, like the multiplier
// lifecycle (lib/b20-control/src/multiplierLifecycle.ts):
//   estimated              not declared yet: the last dividend, one quarter on
//   announced              declared, and the payment is ahead or today
//   scheduled              the issuer published the multiplier change ahead
//                          (Cobalt's updateUIMultiplier)
//   effective              the multiplier changed, and a reading confirms it
//   awaiting_confirmation  OUR gap: the payment passed and we have not read the
//                          token since, or have not read its supply at the
//                          record date
//   not_entitled           the token had no supply at the record date
//   not_reflected          owed and paid, the token was read afterwards, and the
//                          multiplier has not moved
// ---------------------------------------------------------------------------

export const DIVIDEND_CALENDAR_SCHEMA_VERSION_V1 = 'dividend-calendar/v1' as const;

export const DIVIDEND_STATES_V1 = [
  'estimated',
  'announced',
  'scheduled',
  'effective',
  'awaiting_confirmation',
  'not_entitled',
  'not_reflected',
] as const;
export type DividendStateV1 = (typeof DIVIDEND_STATES_V1)[number];

/** A multiplier change larger than this is not a quarterly dividend. The
 * notifier draws the same line before it says "dividend" (scripts/baseAppNotify.ts). */
export const DIVIDEND_MAX_MULTIPLIER_RISE_V1 = 0.05;

/** How long after the payment date a conversion is still matched to it. */
export const DIVIDEND_CONVERSION_WINDOW_DAYS_V1 = 14;

// ---------------------------------------------------------------------------
// The declarations, from the companies' own words.
//
// Each one carries the sentence it was read from. The test for this file
// checks that the amount and both dates appear in that sentence, so a number
// cannot enter this list without the source saying it. SEC filings are fetched
// from sec.gov. Press releases come from the company's newsroom, or from the
// wire service the company published through when its investor site refuses
// automated reads (Meta's does).
// ---------------------------------------------------------------------------

/**
 * The companies whose own dividend releases Miorail reads, by underlying key.
 * `DIVIDEND_ISSUERS_V1` in dividendSources.ts is the reader; its test pins the
 * two lists together.
 *
 * For every other stock on the calendar nothing about dividends has been read,
 * and that is Miorail's gap, not the company's policy. The calendar grew from
 * thirteen stocks to sixty when the issuer API was added, and the board then
 * said "No dividend on record" for Pfizer, Philip Morris and Broadcom.
 */
export const DIVIDEND_RELEASES_READ_V1: readonly string[] = [
  'security:isin:US0378331005', // AAPL
  'security:isin:US02079K3059', // GOOGL
  'security:isin:US30303M1027', // META
  'security:isin:US5949181045', // MSFT
  'security:isin:US67066G1040', // NVDA
];

export function dividendReleasesReadV1(underlyingKey: string): boolean {
  return DIVIDEND_RELEASES_READ_V1.includes(underlyingKey);
}

export interface DividendSourceV1 {
  publisher: string;
  url: string;
  /** Verbatim, elisions marked with "…". */
  quote: string;
}

export interface DividendDeclarationV1 {
  underlyingKey: string;
  symbol: string;
  company: string;
  /** USD per share, as declared. */
  amountPerShare: string;
  /** New York dates, YYYY-MM-DD. */
  declaredOn: string;
  /** Only when the source states it. */
  exDate: string | null;
  recordDate: string;
  payDate: string;
  source: DividendSourceV1;
}

export const DIVIDEND_DECLARATIONS_V1: readonly DividendDeclarationV1[] = [
  {
    underlyingKey: 'security:isin:US0378331005',
    symbol: 'AAPL',
    company: 'Apple',
    amountPerShare: '0.27',
    declaredOn: '2026-07-30',
    exDate: null,
    recordDate: '2026-08-10',
    payDate: '2026-08-13',
    source: {
      publisher: 'Apple Inc., Form 8-K, exhibit 99.1',
      url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/a8-kex991q3202606272026.htm',
      quote:
        'Apple’s board of directors has declared a cash dividend of $0.27 per share of the Company’s common stock. The dividend is payable on August 13, 2026, to shareholders of record as of the close of business on August 10, 2026.',
    },
  },
  {
    underlyingKey: 'security:isin:US02079K3059',
    symbol: 'GOOGL',
    company: 'Alphabet',
    amountPerShare: '0.22',
    declaredOn: '2026-07-22',
    exDate: null,
    recordDate: '2026-09-07',
    payDate: '2026-09-14',
    source: {
      publisher: 'Alphabet Inc., Form 8-K, exhibit 99.1',
      url: 'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000066/googexhibit991q22026.htm',
      quote:
        "In July 2026, the company's Board of Directors declared … a quarterly cash dividend of $0.22 per share on our Class A, Class B, and Class C stock. … the common stock dividend is payable on September 14, 2026 to stockholders of record for each of the company's Class A, Class B, and Class C shares as of September 7, 2026.",
    },
  },
  {
    underlyingKey: 'security:isin:US30303M1027',
    symbol: 'META',
    company: 'Meta',
    amountPerShare: '0.525',
    declaredOn: '2026-09-10',
    exDate: null,
    recordDate: '2026-09-21',
    payDate: '2026-09-28',
    source: {
      publisher: 'Meta Platforms, Inc., press release via PR Newswire',
      url: 'https://www.prnewswire.com/news-releases/meta-announces-quarterly-cash-dividend-302875821.html',
      quote:
        "The Meta Platforms, Inc. (Nasdaq: META) board of directors today declared a quarterly cash dividend of $0.525 per share of the company's outstanding Class A common stock and Class B common stock, payable on September 28, 2026 to stockholders of record as of the close of business on September 21, 2026.",
    },
  },
  {
    underlyingKey: 'security:isin:US5949181045',
    symbol: 'MSFT',
    company: 'Microsoft',
    amountPerShare: '0.91',
    declaredOn: '2026-06-10',
    exDate: '2026-08-20',
    recordDate: '2026-08-20',
    payDate: '2026-09-10',
    source: {
      publisher: 'Microsoft Corp., press release',
      url: 'https://news.microsoft.com/source/2026/06/10/microsoft-announces-quarterly-dividend-29/',
      quote:
        'Microsoft Corp. on Tuesday announced that its board of directors declared a quarterly dividend of $0.91 per share. The dividend is payable Sept. 10, 2026, to shareholders of record on Aug. 20, 2026. The ex-dividend date will be Aug. 20, 2026.',
    },
  },
  {
    underlyingKey: 'security:isin:US5949181045',
    symbol: 'MSFT',
    company: 'Microsoft',
    amountPerShare: '0.98',
    declaredOn: '2026-09-15',
    exDate: '2026-11-19',
    recordDate: '2026-11-19',
    payDate: '2026-12-10',
    source: {
      publisher: 'Microsoft Corp., press release',
      url: 'https://news.microsoft.com/source/2026/09/15/microsoft-announces-quarterly-dividend-increase-7/',
      quote:
        'Microsoft Corp. on Tuesday announced that its board of directors declared a quarterly dividend of $0.98 per share, reflecting a 7 cent or 8% increase over the previous quarter’s dividend. The dividend is payable Dec. 10, 2026, to shareholders of record on Nov. 19, 2026. The ex-dividend date will be Nov. 19, 2026.',
    },
  },
  {
    underlyingKey: 'security:isin:US67066G1040',
    symbol: 'NVDA',
    company: 'NVIDIA',
    amountPerShare: '0.25',
    declaredOn: '2026-08-26',
    exDate: null,
    recordDate: '2026-09-10',
    payDate: '2026-10-01',
    source: {
      publisher: 'NVIDIA Corp., Form 8-K, exhibit 99.1',
      url: 'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm',
      quote:
        'NVIDIA will pay its next quarterly cash dividend of $0.25 per share on October 1, 2026, to all shareholders of record on September 10, 2026.',
    },
  },
];

// ---------------------------------------------------------------------------
// The response.
// ---------------------------------------------------------------------------

const IsoV1 = z.string().datetime({ offset: true });
const DateV1 = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DecimalV1 = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const WadV1 = z.string().regex(/^\d+$/);

export const DividendTokenEffectV1Schema = z
  .object({
    /** measured: read from the token after the fact. scheduled: published by
     * the issuer ahead. estimate: our arithmetic. none: nothing to say. */
    kind: z.enum(['measured', 'scheduled', 'estimate', 'none']),
    multiplierFrom: WadV1.nullable(),
    multiplierTo: WadV1.nullable(),
    /** How many more underlying shares one token tracks, in percent. */
    increasePercent: DecimalV1.nullable(),
    /** What that is worth per token, in USD, at `priceUsd`. */
    perTokenUsd: DecimalV1.nullable(),
    /** `perTokenUsd` as a share of the declared amount, in percent. */
    passThroughPercent: DecimalV1.nullable(),
    /** When the multiplier changed, or is due to. */
    at: IsoV1.nullable(),
    /** The reference price per share the arithmetic used. */
    priceUsd: DecimalV1.nullable(),
  })
  .strict();
export type DividendTokenEffectV1 = z.infer<typeof DividendTokenEffectV1Schema>;

export const DividendEventV1Schema = z
  .object({
    state: z.enum(DIVIDEND_STATES_V1),
    /** Why `awaiting_confirmation`: our gap, named. */
    reason: z.enum(['not_read_since_payment', 'supply_at_record_unread', 'scheduled_not_confirmed']).nullable(),
    amountPerShare: DecimalV1,
    declaredOn: DateV1.nullable(),
    exDate: DateV1.nullable(),
    recordDate: DateV1.nullable(),
    payDate: DateV1,
    /** True for an estimate: the date is a quarter after the last payment. */
    payDateApproximate: z.boolean(),
    source: z.object({ publisher: z.string(), url: z.string().url(), quote: z.string() }).strict().nullable(),
    /** For an estimate, what it rests on. */
    basis: z.string().nullable(),
    token: DividendTokenEffectV1Schema,
    /** Tokens in existence at the close of business on the record date. */
    supplyAtRecord: DecimalV1.nullable(),
  })
  .strict();
export type DividendEventV1 = z.infer<typeof DividendEventV1Schema>;

export const DividendStockV1Schema = z
  .object({
    underlyingKey: z.string().min(1),
    symbol: z.string().min(1).max(40),
    company: z.string().min(1).max(200),
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    tokenSymbol: z.string().min(1).max(40),
    /** The next payment: declared, scheduled or estimated. */
    next: DividendEventV1Schema.nullable(),
    /** Past payments, newest first. */
    history: z.array(DividendEventV1Schema),
    /** When Miorail last read this token's multiplier. */
    lastReadAt: IsoV1.nullable(),
  })
  .strict();
export type DividendStockV1 = z.infer<typeof DividendStockV1Schema>;

export const DividendCalendarResponseV1Schema = z
  .object({
    schemaVersion: z.literal(DIVIDEND_CALENDAR_SCHEMA_VERSION_V1),
    generatedAt: IsoV1,
    /** The measured share of a dividend that reached a token, which every
     * estimate uses, and the conversions it was measured on. */
    passThrough: z
      .object({
        percent: DecimalV1.nullable(),
        measuredOn: z.array(z.object({ symbol: z.string(), payDate: DateV1, percent: DecimalV1 }).strict()),
      })
      .strict(),
    stocks: z.array(DividendStockV1Schema),
  })
  .strict();
export type DividendCalendarResponseV1 = z.infer<typeof DividendCalendarResponseV1Schema>;

// ---------------------------------------------------------------------------
// The inputs: what the token did, read by the server.
// ---------------------------------------------------------------------------

export interface DividendMultiplierChangeV1 {
  fromWad: string;
  toWad: string;
  /** When the token began converting at `toWad`. */
  at: string;
  /** A reading at or after `at` returned `toWad`. */
  confirmed: boolean;
  /** The reference price per share at `at`, or null. */
  priceAt: number | null;
}

export interface DividendTokenV1 {
  tokenAddress: string;
  tokenSymbol: string;
  underlyingKey: string;
  symbol: string;
  company: string;
  /** The token's own `multiplier()` reading. Null: never read. */
  reading: { multiplierWad: string; readAt: string } | null;
  /** Every change the token made, oldest first. */
  changes: readonly DividendMultiplierChangeV1[];
  /** Changes the issuer published ahead and has not withdrawn. */
  scheduled: readonly { multiplierWad: string; effectiveAt: string }[];
  /** Tokens in existence at 16:00 New York on a record date, keyed by the date. */
  supplyAtRecord: Readonly<Record<string, string>>;
  /** The reference price per share now. */
  priceNow: number | null;
}

// ---------------------------------------------------------------------------
// Dates. Every date above is a New York date.
// ---------------------------------------------------------------------------

/** A New York date, `days` later (or earlier). */
export function shiftDateV1(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/** The New York date an instant falls on. */
export function newYorkDateV1(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** 16:00 New York on the record date: "the close of business". */
export function recordCloseV1(recordDate: string): Date {
  return etInstantV1(recordDate, 16 * 60);
}

/** The first instant after the New York day ends. */
function dayEndV1(date: string): number {
  return etInstantV1(shiftDateV1(date, 1), 0).getTime();
}

// ---------------------------------------------------------------------------
// Arithmetic.
// ---------------------------------------------------------------------------

function riseOfV1(fromWad: string, toWad: string): number | null {
  try {
    const from = BigInt(fromWad);
    const to = BigInt(toWad);
    if (from <= 0n) return null;
    return Number(to - from) / Number(from);
  } catch {
    return null;
  }
}

function fixedV1(value: number, digits: number): string {
  return value.toFixed(digits);
}

function medianV1(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const NO_EFFECT_V1: DividendTokenEffectV1 = {
  kind: 'none',
  multiplierFrom: null,
  multiplierTo: null,
  increasePercent: null,
  perTokenUsd: null,
  passThroughPercent: null,
  at: null,
  priceUsd: null,
};

/** A change or a plan, as the token sees it: from, to, and what it is worth. */
function effectOfV1(input: {
  kind: 'measured' | 'scheduled';
  fromWad: string;
  toWad: string;
  at: string;
  price: number | null;
  amountPerShare: string;
}): DividendTokenEffectV1 {
  const rise = riseOfV1(input.fromWad, input.toWad);
  const from = Number(BigInt(input.fromWad)) / 1e18;
  const perToken = rise !== null && input.price !== null ? rise * from * input.price : null;
  const amount = Number(input.amountPerShare);
  return {
    kind: input.kind,
    multiplierFrom: input.fromWad,
    multiplierTo: input.toWad,
    increasePercent: rise === null ? null : fixedV1(rise * 100, 4),
    perTokenUsd: perToken === null ? null : fixedV1(perToken, 4),
    // Measured against the dividend on the shares one token tracked before.
    passThroughPercent: perToken === null || !(amount > 0) ? null : fixedV1((perToken / (amount * from)) * 100, 1),
    at: input.at,
    priceUsd: input.price === null ? null : fixedV1(input.price, 2),
  };
}

/** What a declared dividend should do to one token, from the share that
 * reached tokens before. Never a promise: the kind says so. */
function estimateOfV1(input: {
  amountPerShare: string;
  passThrough: number | null;
  price: number | null;
  reading: DividendTokenV1['reading'];
}): DividendTokenEffectV1 {
  const amount = Number(input.amountPerShare);
  if (input.passThrough === null || input.price === null || !(input.price > 0) || !(amount > 0)) return NO_EFFECT_V1;
  // A token tracks `from` shares, so it is owed the dividend on that many.
  const from = input.reading ? Number(BigInt(input.reading.multiplierWad)) / 1e18 : 1;
  const perToken = amount * input.passThrough * from;
  const rise = (amount * input.passThrough) / input.price;
  return {
    kind: 'estimate',
    multiplierFrom: input.reading?.multiplierWad ?? null,
    multiplierTo: null,
    increasePercent: fixedV1(rise * 100, 4),
    perTokenUsd: fixedV1(perToken, 4),
    passThroughPercent: fixedV1(input.passThrough * 100, 1),
    at: null,
    priceUsd: fixedV1(input.price, 2),
  };
}

// ---------------------------------------------------------------------------
// The calendar.
// ---------------------------------------------------------------------------

interface MatchedV1 {
  declaration: DividendDeclarationV1;
  change: DividendMultiplierChangeV1 | null;
  plan: { multiplierWad: string; effectiveAt: string } | null;
}

/** Each change and each plan belongs to at most one declaration: the earliest
 * whose window it falls in, from the record date's close to two weeks after
 * the payment. A rise too large to be a dividend belongs to none. */
function matchV1(declarations: readonly DividendDeclarationV1[], token: DividendTokenV1): MatchedV1[] {
  const usedChanges = new Set<number>();
  const usedPlans = new Set<number>();
  return declarations.map((declaration) => {
    const opens = recordCloseV1(declaration.recordDate).getTime();
    const closes = dayEndV1(declaration.payDate) + DIVIDEND_CONVERSION_WINDOW_DAYS_V1 * 86_400_000;
    const within = (iso: string) => {
      const at = Date.parse(iso);
      return Number.isFinite(at) && at >= opens && at < closes;
    };
    const changeIndex = token.changes.findIndex((change, index) => {
      if (usedChanges.has(index) || !within(change.at)) return false;
      const rise = riseOfV1(change.fromWad, change.toWad);
      return rise !== null && rise > 0 && rise <= DIVIDEND_MAX_MULTIPLIER_RISE_V1;
    });
    if (changeIndex >= 0) usedChanges.add(changeIndex);
    const planIndex = token.scheduled.findIndex((plan, index) => !usedPlans.has(index) && within(plan.effectiveAt));
    if (planIndex >= 0) usedPlans.add(planIndex);
    return {
      declaration,
      change: changeIndex >= 0 ? token.changes[changeIndex]! : null,
      plan: planIndex >= 0 ? token.scheduled[planIndex]! : null,
    };
  });
}

function eventOfV1(
  matched: MatchedV1,
  token: DividendTokenV1,
  input: { now: number; passThrough: number | null },
): DividendEventV1 {
  const { declaration, change, plan } = matched;
  const base = {
    reason: null,
    amountPerShare: declaration.amountPerShare,
    declaredOn: declaration.declaredOn,
    exDate: declaration.exDate,
    recordDate: declaration.recordDate,
    payDate: declaration.payDate,
    payDateApproximate: false,
    source: { ...declaration.source },
    basis: null,
    supplyAtRecord: token.supplyAtRecord[declaration.recordDate] ?? null,
  } as const;
  const recordPassed = input.now >= recordCloseV1(declaration.recordDate).getTime();
  const paid = input.now >= dayEndV1(declaration.payDate);
  const supply = base.supplyAtRecord;
  const owedNothing = recordPassed && supply !== null && Number(supply) === 0;
  const currentWad = token.reading?.multiplierWad ?? null;

  if (change) {
    const effect = effectOfV1({
      kind: 'measured',
      fromWad: change.fromWad,
      toWad: change.toWad,
      at: change.at,
      price: change.priceAt,
      amountPerShare: declaration.amountPerShare,
    });
    return change.confirmed
      ? { ...base, state: 'effective', token: effect }
      : { ...base, state: 'awaiting_confirmation', reason: 'scheduled_not_confirmed', token: effect };
  }
  if (owedNothing) return { ...base, state: 'not_entitled', token: NO_EFFECT_V1 };
  if (plan && currentWad) {
    const effect = effectOfV1({
      kind: 'scheduled',
      fromWad: currentWad,
      toWad: plan.multiplierWad,
      at: plan.effectiveAt,
      price: token.priceNow,
      amountPerShare: declaration.amountPerShare,
    });
    if (Date.parse(plan.effectiveAt) > input.now) return { ...base, state: 'scheduled', token: effect };
    return { ...base, state: 'awaiting_confirmation', reason: 'scheduled_not_confirmed', token: effect };
  }
  const estimate = estimateOfV1({
    amountPerShare: declaration.amountPerShare,
    passThrough: input.passThrough,
    price: token.priceNow,
    reading: token.reading,
  });
  if (!paid) return { ...base, state: 'announced', token: estimate };
  // Paid, and the token has not moved. Whose gap that is decides the state.
  if (supply === null) return { ...base, state: 'awaiting_confirmation', reason: 'supply_at_record_unread', token: estimate };
  const readAt = token.reading ? Date.parse(token.reading.readAt) : Number.NaN;
  if (!(readAt >= dayEndV1(declaration.payDate))) {
    return { ...base, state: 'awaiting_confirmation', reason: 'not_read_since_payment', token: estimate };
  }
  return { ...base, state: 'not_reflected', token: estimate };
}

/** Not declared yet: the last dividend again, a quarter after the last
 * payment. Only for a company whose last payment is recent enough to have a
 * rhythm worth extending, and never while a declaration is outstanding. */
function estimatedNextV1(
  declarations: readonly DividendDeclarationV1[],
  token: DividendTokenV1,
  input: { now: number; passThrough: number | null },
): DividendEventV1 | null {
  const last = declarations[declarations.length - 1];
  if (!last) return null;
  if (dayEndV1(last.payDate) > input.now) return null;
  const approximate = shiftDateV1(last.payDate, 91);
  if (Date.parse(`${last.payDate}T12:00:00Z`) < input.now - 150 * 86_400_000) return null;
  return {
    state: 'estimated',
    reason: null,
    amountPerShare: last.amountPerShare,
    declaredOn: null,
    exDate: null,
    recordDate: null,
    payDate: approximate,
    payDateApproximate: true,
    source: null,
    basis: `Not declared yet. ${last.company} last paid $${last.amountPerShare} per share on ${last.payDate}; the same again a quarter later would be paid around ${approximate}.`,
    token: estimateOfV1({
      amountPerShare: last.amountPerShare,
      passThrough: input.passThrough,
      price: token.priceNow,
      reading: token.reading,
    }),
    supplyAtRecord: null,
  };
}

export function dividendCalendarV1(input: {
  now: Date;
  tokens: readonly DividendTokenV1[];
  declarations?: readonly DividendDeclarationV1[];
}): DividendCalendarResponseV1 {
  const now = input.now.getTime();
  const all = input.declarations ?? DIVIDEND_DECLARATIONS_V1;
  const today = newYorkDateV1(input.now);
  const byUnderlying = (key: string) =>
    all.filter((declaration) => declaration.underlyingKey === key).sort((a, b) => a.payDate.localeCompare(b.payDate));

  // First the measurements, from every token: the estimate for any one stock
  // is the share that reached tokens across all of them.
  const matched = new Map<string, MatchedV1[]>();
  const measuredOn: { symbol: string; payDate: string; share: number }[] = [];
  for (const token of input.tokens) {
    const rows = matchV1(byUnderlying(token.underlyingKey), token);
    matched.set(token.tokenAddress, rows);
    for (const row of rows) {
      if (!row.change?.confirmed || row.change.priceAt === null) continue;
      const effect = effectOfV1({
        kind: 'measured',
        fromWad: row.change.fromWad,
        toWad: row.change.toWad,
        at: row.change.at,
        price: row.change.priceAt,
        amountPerShare: row.declaration.amountPerShare,
      });
      if (effect.passThroughPercent !== null) {
        measuredOn.push({ symbol: token.symbol, payDate: row.declaration.payDate, share: Number(effect.passThroughPercent) / 100 });
      }
    }
  }
  measuredOn.sort((a, b) => a.payDate.localeCompare(b.payDate) || a.symbol.localeCompare(b.symbol));
  const passThrough = medianV1(measuredOn.map((row) => row.share));

  const stocks: DividendStockV1[] = input.tokens.map((token) => {
    const events = (matched.get(token.tokenAddress) ?? []).map((row) => eventOfV1(row, token, { now, passThrough }));
    const upcoming = events.filter((event) => event.payDate >= today);
    const past = events.filter((event) => event.payDate < today).reverse();
    const estimated = upcoming.length === 0 ? estimatedNextV1(byUnderlying(token.underlyingKey), token, { now, passThrough }) : null;
    return {
      underlyingKey: token.underlyingKey,
      symbol: token.symbol,
      company: token.company,
      tokenAddress: token.tokenAddress.toLowerCase(),
      tokenSymbol: token.tokenSymbol,
      next: upcoming[0] ?? estimated,
      history: past,
      lastReadAt: token.reading?.readAt ?? null,
    };
  });
  // Payers first, soonest payment first; the rest by symbol.
  stocks.sort((a, b) => {
    if ((a.next === null) !== (b.next === null)) return a.next === null ? 1 : -1;
    if (a.next && b.next && a.next.payDate !== b.next.payDate) return a.next.payDate.localeCompare(b.next.payDate);
    return a.symbol.localeCompare(b.symbol);
  });

  return {
    schemaVersion: DIVIDEND_CALENDAR_SCHEMA_VERSION_V1,
    generatedAt: input.now.toISOString(),
    passThrough: {
      percent: passThrough === null ? null : fixedV1(passThrough * 100, 1),
      measuredOn: measuredOn.map((row) => ({ symbol: row.symbol, payDate: row.payDate, percent: fixedV1(row.share * 100, 1) })),
    },
    stocks,
  };
}
