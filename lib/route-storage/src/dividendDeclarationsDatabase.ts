import {
  assertObservedDividendDeclarationV1,
  sameDividendDeclarationV1,
  type DividendDeclarationRepositoryV1,
  type DividendDeclarationSourceKindV1,
  type ObservedDividendDeclarationV1,
} from './dividendDeclarations.js';
import type { SqlTemplateExecutor } from './types.js';

function isoV1(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function rowV1(row: Record<string, unknown>): ObservedDividendDeclarationV1 {
  return {
    underlyingKey: String(row.underlying_key),
    symbol: String(row.symbol),
    company: String(row.company),
    amountPerShare: String(row.amount_per_share),
    declaredOn: String(row.declared_on),
    exDate: row.ex_date === null ? null : String(row.ex_date),
    recordDate: String(row.record_date),
    payDate: String(row.pay_date),
    source: { publisher: String(row.source_publisher), url: String(row.source_url), quote: String(row.source_quote) },
    sourceKind: String(row.source_kind) as DividendDeclarationSourceKindV1,
    publishedAt: isoV1(row.published_at),
    observedAt: isoV1(row.observed_at),
  };
}

export function createDatabaseDividendDeclarationRepositoryV1(sql: SqlTemplateExecutor): DividendDeclarationRepositoryV1 {
  const select = (underlyingKey?: string, payDate?: string) =>
    underlyingKey && payDate
      ? sql`
          SELECT underlying_key, symbol, company, amount_per_share, declared_on::text AS declared_on,
                 ex_date::text AS ex_date, record_date::text AS record_date, pay_date::text AS pay_date,
                 source_kind, source_publisher, source_url, source_quote, published_at, observed_at
          FROM dividend_declarations
          WHERE underlying_key = ${underlyingKey} AND pay_date = ${payDate}::date`
      : sql`
          SELECT underlying_key, symbol, company, amount_per_share, declared_on::text AS declared_on,
                 ex_date::text AS ex_date, record_date::text AS record_date, pay_date::text AS pay_date,
                 source_kind, source_publisher, source_url, source_quote, published_at, observed_at
          FROM dividend_declarations
          ORDER BY pay_date, symbol`;
  return {
    async record(input) {
      assertObservedDividendDeclarationV1(input);
      const inserted = (await sql`
        INSERT INTO dividend_declarations (
          underlying_key, pay_date, record_date, ex_date, declared_on, amount_per_share, symbol, company,
          source_kind, source_publisher, source_url, source_quote, published_at, observed_at
        ) VALUES (
          ${input.underlyingKey}, ${input.payDate}::date, ${input.recordDate}::date, ${input.exDate}::date,
          ${input.declaredOn}::date, ${input.amountPerShare}, ${input.symbol}, ${input.company},
          ${input.sourceKind}, ${input.source.publisher}, ${input.source.url}, ${input.source.quote},
          ${input.publishedAt}, ${input.observedAt}
        )
        ON CONFLICT (underlying_key, pay_date) DO NOTHING
        RETURNING underlying_key`) as unknown[];
      if (inserted.length > 0) return 'recorded';
      const [existing] = ((await select(input.underlyingKey, input.payDate)) as Array<Record<string, unknown>>).map(rowV1);
      return existing && sameDividendDeclarationV1(existing, input) ? 'already_recorded' : 'conflict';
    },

    async declarations() {
      return ((await select()) as Array<Record<string, unknown>>).map(rowV1);
    },
  };
}
