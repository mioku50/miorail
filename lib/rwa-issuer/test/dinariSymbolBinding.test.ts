import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { DinariStockV1 } from '../src/dinariStockApi.js';
import { joinDinariBySymbolV1, normaliseDShareSymbolV1 } from '../src/dinariSymbolBinding.js';
import { assetClassFromSecurityTypeV1, openFigiVerdictV1 } from '../src/openFigi.js';

function stock(over: Partial<DinariStockV1> & { symbol: string }): DinariStockV1 {
  return {
    id: `0196ea6d-0000-7000-8000-${over.symbol.padEnd(12, '0').slice(0, 12)}`,
    name: `${over.symbol} Inc.`,
    is_fractionable: true,
    is_tradable: true,
    tokens: [],
    composite_figi: 'BBG000B9XRY4',
    ...over,
  } as DinariStockV1;
}

describe('a .dw variant is the same security', () => {
  test('the suffix is stripped, and only that suffix', () => {
    assert.equal(normaliseDShareSymbolV1('AAPL.dw'), 'AAPL');
    assert.equal(normaliseDShareSymbolV1('aapl'), 'AAPL');
    assert.equal(normaliseDShareSymbolV1('BRK.A'), 'BRK.A');
    assert.equal(normaliseDShareSymbolV1('  NFLX  '), 'NFLX');
    assert.equal(normaliseDShareSymbolV1(null), null);
    assert.equal(normaliseDShareSymbolV1(''), null);
  });
});

describe('the join binds only what it can bind unambiguously', () => {
  const catalogue = [stock({ symbol: 'AAPL' }), stock({ symbol: 'NFLX' })];

  test('a plain symbol and its .dw twin both bind to the one security', () => {
    const join = joinDinariBySymbolV1({
      onchain: [
        { tokenAddress: '0xaa', symbol: 'AAPL' },
        { tokenAddress: '0xbb', symbol: 'AAPL.dw' },
      ],
      catalogue,
    });
    assert.equal(join.matched.length, 2);
    assert.deepEqual(new Set(join.matched.map((m) => m.stock.id)).size, 1);
    assert.deepEqual(join.refused, []);
  });

  test('the same EXACT symbol on two contracts refuses both', () => {
    // Two different contracts filed under one name is the failure this product
    // exists to prevent; picking the first would be exactly that failure.
    const join = joinDinariBySymbolV1({
      onchain: [
        { tokenAddress: '0xaa', symbol: 'AAPL' },
        { tokenAddress: '0xcc', symbol: 'AAPL' },
      ],
      catalogue,
    });
    assert.deepEqual(join.matched, []);
    assert.deepEqual(
      join.refused.map((r) => r.reason),
      ['duplicate_symbol_onchain', 'duplicate_symbol_onchain'],
    );
  });

  test('a symbol that repeats in the CATALOGUE refuses too', () => {
    const join = joinDinariBySymbolV1({
      onchain: [{ tokenAddress: '0xaa', symbol: 'AAPL' }],
      catalogue: [stock({ symbol: 'AAPL' }), stock({ symbol: 'AAPL', id: 'other' } as never)],
    });
    assert.equal(join.matched.length, 0);
    assert.equal(join.refused[0]?.reason, 'duplicate_symbol_in_catalogue');
  });

  test('a contract whose symbol nobody publishes is refused, not guessed', () => {
    const join = joinDinariBySymbolV1({
      onchain: [
        { tokenAddress: '0xaa', symbol: 'ZZZZ' },
        { tokenAddress: '0xbb', symbol: null },
      ],
      catalogue,
    });
    assert.deepEqual(
      join.refused.map((r) => r.reason),
      ['symbol_not_in_catalogue', 'no_symbol_onchain'],
    );
  });

  test('an address the ISSUER names needs no symbol at all', () => {
    // The real answer, when production access supplies it: `tokens` carries the
    // exact Base address, the symbol is not consulted, and the match says so.
    const named = stock({
      symbol: 'TSLA',
      tokens: ['eip155:8453:0x74ED07D83999bc5DB0FfD850DA0a6Bd782abD39C', 'eip155:1:0xdead'],
    });
    const join = joinDinariBySymbolV1({
      onchain: [{ tokenAddress: '0x74ed07d83999bc5db0ffd850da0a6bd782abd39c', symbol: null }],
      catalogue: [named],
    });
    assert.equal(join.matched.length, 1);
    assert.equal(join.matched[0]?.namedByIssuer, true);
    assert.equal(join.matched[0]?.stock.symbol, 'TSLA');
  });

  test('an address named on ANOTHER chain does not match', () => {
    const named = stock({ symbol: 'TSLA', tokens: ['eip155:1:0x74ed07d83999bc5db0ffd850da0a6bd782abd39c'] });
    const join = joinDinariBySymbolV1({
      onchain: [{ tokenAddress: '0x74ed07d83999bc5db0ffd850da0a6bd782abd39c', symbol: null }],
      catalogue: [named],
    });
    assert.equal(join.matched.length, 0);
    assert.equal(join.refused[0]?.reason, 'no_symbol_onchain');
  });
});

describe('the FIGI is cross-checked, never taken on trust', () => {
  const row = (compositeFigi: string | null, securityType = 'Common Stock') => ({
    ticker: 'AAPL',
    compositeFigi,
    securityType,
    securityType2: securityType,
    marketSector: 'Equity',
  });

  test('the registry returning the same FIGI is agreement', () => {
    const verdict = openFigiVerdictV1('BBG000B9XRY4', [row('BBG000B9XRY4')]);
    assert.equal(verdict.state, 'agrees');
  });

  test('a DIFFERENT FIGI is a refusal, not a correction', () => {
    // Two sources, one ticker, two securities. Binding either is a coin flip.
    const verdict = openFigiVerdictV1('BBG000B9XRY4', [row('BBG000BVPV84')]);
    assert.equal(verdict.state, 'disagrees');
    assert.deepEqual(verdict.state === 'disagrees' ? verdict.found : null, ['BBG000BVPV84']);
  });

  test('no answer is unknown, and unknown is never agreement', () => {
    assert.equal(openFigiVerdictV1('BBG000B9XRY4', []).state, 'unknown');
    assert.equal(openFigiVerdictV1('BBG000B9XRY4', [row(null)]).state, 'unknown');
  });

  test('the asset class comes from the registry, not from a company name', () => {
    // Measured against OpenFIGI on 2026-09-02: AAPL is `Common Stock`, IBIT and
    // SPY are `ETP` / `Mutual Fund`. "Trust" appearing in a name is not a fund.
    assert.equal(assetClassFromSecurityTypeV1('Common Stock', 'Common Stock'), 'equity');
    assert.equal(assetClassFromSecurityTypeV1('ETP', 'Mutual Fund'), 'fund_share');
    assert.equal(assetClassFromSecurityTypeV1('Closed-End Fund', null), 'fund_share');
    assert.equal(assetClassFromSecurityTypeV1('REIT', null), 'fund_share');
    assert.equal(assetClassFromSecurityTypeV1('Warrant', null), 'other');
    assert.equal(assetClassFromSecurityTypeV1(null, null), 'other');
  });
});
