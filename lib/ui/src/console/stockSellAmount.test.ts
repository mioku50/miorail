import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stockSellAmountV1, tokenDecimalV1 } from './stockSellAmount';

const holding = { state: 'read' as const, decimals: 8, balanceAtomic: '43417' };

test('SELL input preserves the exact balance and the smallest token unit', () => {
  assert.equal(stockSellAmountV1('0.00043417', holding).atomic, '43417');
  assert.equal(stockSellAmountV1('.00000001', holding).atomic, '1');
  assert.equal(stockSellAmountV1(' 000.00043417 ', holding).atomic, '43417');
  assert.equal(stockSellAmountV1('', holding).balance, '0.00043417');
});

test('SELL never rounds, accepts scientific notation or exceeds the read balance', () => {
  for (const input of ['', '0', '-1', '+1', '1e-8', '0,00043417', '0.000434171', '0.00043418', 'NaN', '.']) {
    assert.equal(stockSellAmountV1(input, holding).atomic, null, input);
  }
});

test('SELL decimal conversion is exact beyond Number precision and for zero decimals', () => {
  const large = { state: 'read' as const, decimals: 18, balanceAtomic: '9007199254740993000000000000000001' };
  const decimal = '9007199254740993.000000000000000001';
  assert.equal(tokenDecimalV1(large.balanceAtomic, 18), decimal);
  assert.equal(stockSellAmountV1(decimal, large).atomic, large.balanceAtomic);
  assert.equal(stockSellAmountV1('2', { ...holding, decimals: 0, balanceAtomic: '2' }).atomic, '2');
  assert.equal(stockSellAmountV1('2.1', { ...holding, decimals: 0, balanceAtomic: '3' }).atomic, null);
});

test('SELL refuses missing, malformed, empty or changed holdings', () => {
  for (const value of [null, { state: 'unread' as const }, { ...holding, balanceAtomic: '0' },
    { ...holding, balanceAtomic: 'bad' }, { ...holding, decimals: -1 }, { ...holding, decimals: 256 }]) {
    assert.equal(stockSellAmountV1('0.00043417', value).atomic, null);
  }
  assert.equal(stockSellAmountV1('0.00043417', { ...holding, balanceAtomic: '43416' }).atomic, null);
});
