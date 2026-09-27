import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { InMemoryDividendDeclarationRepositoryV1, type ObservedDividendDeclarationV1 } from '../src/index.js';

function declaration(over: Partial<ObservedDividendDeclarationV1> = {}): ObservedDividendDeclarationV1 {
  return {
    underlyingKey: 'security:isin:US0378331005',
    symbol: 'AAPL',
    company: 'Apple',
    amountPerShare: '0.27',
    declaredOn: '2026-10-29',
    exDate: null,
    recordDate: '2026-11-09',
    payDate: '2026-11-12',
    source: {
      publisher: 'Apple Inc., Form 8-K, exhibit 99.1',
      url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/a8-kex991q4.htm',
      quote: 'declared a cash dividend of $0.27 per share of the Company’s common stock.',
    },
    sourceKind: 'sec_8k',
    publishedAt: '2026-10-29T20:30:12.000Z',
    observedAt: '2026-10-30T02:00:00.000Z',
    ...over,
  };
}

describe('dividend declarations Miorail read', () => {
  test('one per company and payment: the first is kept, the same again is known, a different one is a conflict', async () => {
    const repository = new InMemoryDividendDeclarationRepositoryV1();
    assert.equal(await repository.record(declaration()), 'recorded');
    assert.equal(await repository.record(declaration({ observedAt: '2026-10-30T04:00:00.000Z' })), 'already_recorded');
    assert.equal(await repository.record(declaration({ amountPerShare: '0.28' })), 'conflict');
    assert.equal(await repository.record(declaration({ recordDate: '2026-11-10' })), 'conflict');
    const rows = await repository.declarations();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.amountPerShare, '0.27');
    assert.equal(rows[0]!.observedAt, '2026-10-30T02:00:00.000Z');
  });

  test('refused the way Postgres refuses it', async () => {
    const repository = new InMemoryDividendDeclarationRepositoryV1();
    const cases: Array<[Partial<ObservedDividendDeclarationV1>, RegExp]> = [
      [{ amountPerShare: '0.3' }, /dividend_declaration_amount/],
      [{ recordDate: '2026-11-13' }, /dividend_declaration_record_after_pay/],
      [{ declaredOn: '2026-11-10' }, /dividend_declaration_declared_after_record/],
      [{ source: { publisher: 'x', url: 'http://example.com/x', quote: 'declared a cash dividend of $0.27' } }, /dividend_declaration_url/],
      [{ observedAt: '2026-10-29T20:00:00.000Z' }, /dividend_declaration_time/],
      [{ sourceKind: 'rumour' as never }, /dividend_declaration_kind/],
    ];
    for (const [over, error] of cases) await assert.rejects(repository.record(declaration(over)), error);
    assert.equal((await repository.declarations()).length, 0);
  });
});
