import assert from 'node:assert/strict';
import test from 'node:test';
import {
  stockPositionDecimalV1,
  stockPositionQuoteOpenV1,
  type StockPositionQuoteV1,
} from '../src/stockPositionQuote.js';

test('raw token atoms are formatted without floating point loss, including dust and zero decimals', () => {
  assert.equal(stockPositionDecimalV1('88158', 8), '0.00088158');
  assert.equal(
    stockPositionDecimalV1('9007199254740993123456789', 18),
    '9007199.254740993123456789',
  );
  assert.equal(stockPositionDecimalV1('1', 36), '0.000000000000000000000000000000000001');
  assert.equal(stockPositionDecimalV1('17', 0), '17');
});
test('a quote closes at its expiry, and an expired measurement never opens again', () => {
  const quote = { status: 'quoted', expiresAt: '2026-10-01T12:00:20Z' } as StockPositionQuoteV1;
  assert.equal(stockPositionQuoteOpenV1(quote, new Date('2026-10-01T12:00:19Z')), true);
  assert.equal(stockPositionQuoteOpenV1(quote, new Date('2026-10-01T12:00:20Z')), false);
  assert.equal(
    stockPositionQuoteOpenV1({ ...quote, status: 'expired' }, new Date('2026-10-01T12:00:19Z')),
    false,
  );
});
