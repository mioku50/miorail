import {
  assertObservedDividendDeclarationV1,
  sameDividendDeclarationV1,
  type DividendDeclarationRepositoryV1,
  type ObservedDividendDeclarationV1,
} from './dividendDeclarations.js';

/** The same refusals, the same first-write-wins and the same conflict as Postgres. */
export class InMemoryDividendDeclarationRepositoryV1 implements DividendDeclarationRepositoryV1 {
  private readonly rows = new Map<string, ObservedDividendDeclarationV1>();

  async record(input: ObservedDividendDeclarationV1): Promise<'recorded' | 'already_recorded' | 'conflict'> {
    assertObservedDividendDeclarationV1(input);
    const key = `${input.underlyingKey}|${input.payDate}`;
    const existing = this.rows.get(key);
    if (existing) return sameDividendDeclarationV1(existing, input) ? 'already_recorded' : 'conflict';
    this.rows.set(key, { ...input, source: { ...input.source } });
    return 'recorded';
  }

  async declarations(): Promise<ObservedDividendDeclarationV1[]> {
    return [...this.rows.values()]
      .sort((a, b) => a.payDate.localeCompare(b.payDate) || a.symbol.localeCompare(b.symbol))
      .map((row) => ({ ...row, source: { ...row.source } }));
  }
}
