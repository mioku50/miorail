// ---------------------------------------------------------------------------
// Dividend declarations Miorail read from the companies' own releases
// (migration 0076). One row per company and payment date, never rewritten: a
// second release for the same payment that says the same thing is already
// recorded, and one that says something else is a conflict, left for review
// rather than merged.
// ---------------------------------------------------------------------------

export type DividendDeclarationSourceKindV1 = 'sec_8k' | 'company_newsroom' | 'press_wire';

export interface ObservedDividendDeclarationV1 {
  underlyingKey: string;
  symbol: string;
  company: string;
  amountPerShare: string;
  declaredOn: string;
  /** Read this time from the release's own sentence, not from the day it went out. Never stored: it only
   * says whether a reading's declaredOn can contradict the row on file (audit DATA-1). */
  declaredOnStated?: boolean;
  exDate: string | null;
  recordDate: string;
  payDate: string;
  source: { publisher: string; url: string; quote: string };
  sourceKind: DividendDeclarationSourceKindV1;
  /** When the release went out, ISO. */
  publishedAt: string;
  /** When Miorail first read it, ISO. */
  observedAt: string;
}

export interface DividendDeclarationRepositoryV1 {
  record(input: ObservedDividendDeclarationV1): Promise<'recorded' | 'already_recorded' | 'conflict'>;
  /** Every one on file, oldest payment first. */
  declarations(): Promise<ObservedDividendDeclarationV1[]>;
}

const DATE_V1 = /^\d{4}-\d{2}-\d{2}$/;

export function assertObservedDividendDeclarationV1(input: ObservedDividendDeclarationV1): void {
  if (!/^[a-z]+:[a-z]+:[A-Za-z0-9]+$/.test(input.underlyingKey)) throw new Error('dividend_declaration_underlying');
  if (!/^\d+\.\d{2,4}$/.test(input.amountPerShare)) throw new Error('dividend_declaration_amount');
  for (const date of [input.declaredOn, input.recordDate, input.payDate, ...(input.exDate ? [input.exDate] : [])]) {
    if (!DATE_V1.test(date)) throw new Error('dividend_declaration_date');
  }
  if (input.recordDate > input.payDate) throw new Error('dividend_declaration_record_after_pay');
  if (input.declaredOn > input.recordDate) throw new Error('dividend_declaration_declared_after_record');
  if (!['sec_8k', 'company_newsroom', 'press_wire'].includes(input.sourceKind)) throw new Error('dividend_declaration_kind');
  if (!input.source.url.startsWith('https://')) throw new Error('dividend_declaration_url');
  if (input.source.quote.length < 20 || input.source.quote.length > 1200) throw new Error('dividend_declaration_quote');
  const published = Date.parse(input.publishedAt);
  const observed = Date.parse(input.observedAt);
  if (!Number.isFinite(published) || !Number.isFinite(observed) || observed < published) {
    throw new Error('dividend_declaration_time');
  }
}

/**
 * The same payment, said the same way: amount and all three dates, and the day it was declared when the
 * new reading's sentence states one (audit DATA-1, 2026-11-14). Wingstop's December dividend was stored
 * before the parser read the board's day from the sentence, with the day the release went out; every
 * reading after the fix found October 27 against October 28 on file and counted it "already recorded", so
 * the wrong day stayed with nothing to show it. A stated day that differs is now a conflict, left for
 * review like any other. A day taken from when a release went out is not compared: an 8-K and a wire
 * release of the same payment go out on different days.
 */
export function sameDividendDeclarationV1(
  a: Pick<ObservedDividendDeclarationV1, 'amountPerShare' | 'recordDate' | 'payDate' | 'exDate' | 'declaredOn'>,
  b: Pick<ObservedDividendDeclarationV1, 'amountPerShare' | 'recordDate' | 'payDate' | 'exDate' | 'declaredOn' | 'declaredOnStated'>,
): boolean {
  return a.amountPerShare === b.amountPerShare && a.recordDate === b.recordDate && a.payDate === b.payDate && a.exDate === b.exDate &&
    !(b.declaredOnStated === true && a.declaredOn !== b.declaredOn);
}
