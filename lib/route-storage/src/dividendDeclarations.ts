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

/** The same payment, said the same way: amount and all three dates. */
export function sameDividendDeclarationV1(
  a: Pick<ObservedDividendDeclarationV1, 'amountPerShare' | 'recordDate' | 'payDate' | 'exDate'>,
  b: Pick<ObservedDividendDeclarationV1, 'amountPerShare' | 'recordDate' | 'payDate' | 'exDate'>,
): boolean {
  return a.amountPerShare === b.amountPerShare && a.recordDate === b.recordDate && a.payDate === b.payDate && a.exDate === b.exDate;
}
