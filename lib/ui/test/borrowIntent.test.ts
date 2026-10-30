import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CRYPTO } from '@mioagent/still-engine/registry';
import { borrowAssetFromQueryV1, borrowCollateralTokenV1, parseBorrowDecimalV1, stillBorrowCapacityViewV1 } from '../src/still/borrowIntent.js';

describe('a chosen collateral amount is interpreted exactly', () => {
  for (const [text, decimals, atomic] of [['.00000001', 8, '1'], ['0001.20', 6, '1200000'], ['.000000000000000001', 18, '1'], ['0', 18, '0']] as const) {
    it(`keeps ${text} without floating point or rounding`, () => assert.equal(parseBorrowDecimalV1(text, decimals, true).atomic, atomic));
  }
  for (const text of ['1e3', '1,000', '-1', 'Infinity', '', '.', '0.000000001']) {
    it(`refuses unsupported or overprecise input ${JSON.stringify(text)}`, () => assert.equal(parseBorrowDecimalV1(text, 8).atomic, null));
  }
  it('zero collateral is a choice while a zero loan is not', () => {
    assert.equal(parseBorrowDecimalV1('0', 6).atomic, null);
    assert.equal(parseBorrowDecimalV1('0', 18, true).atomic, '0');
  });
});

function response(supply = '0') {
  return { state: 'read', marketScope: 'still_registered_market', markets: [{
    marketId: CRYPTO[0]!.morphoMarket, collateralDecimals: 8, loanDecimals: 6,
    collateralSupplyAtomic: supply, walletCollateralAtomic: '123456789', collateralAtomic: '100000000', blockNumber: 53100000,
    still: { scope: supply === '0' ? 'existing_collateral' : 'selected_collateral', availableAtomic: '12340000' },
  }] };
}

describe('Get money shows a server allowance for one selected pledge', () => {
  it('uses the registry and formats exact quantities without recomputing risk', () => {
    assert.equal(borrowCollateralTokenV1('cbBTC'), CRYPTO[0]!.token);
    assert.equal(borrowCollateralTokenV1('WETH'), CRYPTO[1]!.token);
    assert.deepEqual(stillBorrowCapacityViewV1(response(), 'cbBTC', '0'), { error: null, capacity: {
      walletBalance: '1.23456789', pledged: '1', maximumUsdc: '12.34', blockNumber: 53100000,
    } });
  });
  it('does not carry an old or different asset amount into the next selection', () => {
    assert.equal(stillBorrowCapacityViewV1(response(), 'WETH', '0').capacity, null);
    assert.equal(stillBorrowCapacityViewV1(response(), 'cbBTC', '1').capacity, null);
    assert(stillBorrowCapacityViewV1(response('1'), 'cbBTC', '1').capacity);
  });
  it('keeps an unread wallet balance distinct from a measured zero', () => {
    const read = response(); read.markets[0]!.walletCollateralAtomic = null as unknown as string;
    assert.equal(stillBorrowCapacityViewV1(read, 'cbBTC', '0').capacity!.walletBalance, null);
    read.markets[0]!.walletCollateralAtomic = '0';
    assert.equal(stillBorrowCapacityViewV1(read, 'cbBTC', '0').capacity!.walletBalance, '0');
  });
  it('does not invent a maximum from an absent allowance or another response shape', () => {
    const read = response(); read.markets[0]!.still.availableAtomic = null as unknown as string;
    assert.equal(stillBorrowCapacityViewV1(read, 'cbBTC', '0').capacity, null);
    assert.equal(stillBorrowCapacityViewV1({}, 'cbBTC', '0').capacity, null);
    assert.equal(stillBorrowCapacityViewV1({ state: 'refused', detail: 'The selected balance could not be read.' }, 'cbBTC', '0').error,
      'The selected balance could not be read.');
  });
  it('binds explicit ETH capacity to positive native funding and the 0.0005 ETH fee reserve', () => {
    assert.equal(borrowAssetFromQueryV1('ETH'), 'ETH');
    assert.equal(borrowCollateralTokenV1('ETH'), CRYPTO[1]!.token);
    const wethRow = {
      marketId: CRYPTO[1]!.morphoMarket, collateralDecimals: 18, loanDecimals: 6,
      collateralSupplyAtomic: '10000000000000000', walletCollateralAtomic: '25000000000000000',
      collateralAtomic: '3000000000000000', blockNumber: 53100000,
      funding: 'native', nativeReserveAtomic: '500000000000000', feeQuoteState: 'wallet_quote_required',
      still: { scope: 'selected_collateral', availableAtomic: '12340000' },
    };
    const read = { state: 'read', marketScope: 'still_registered_market', markets: [wethRow] };
    assert.deepEqual(stillBorrowCapacityViewV1(read, 'ETH', '10000000000000000'), {
      error: null,
      capacity: { nativeReserve: '0.0005', walletBalance: '0.025', pledged: '0.003', maximumUsdc: '12.34', blockNumber: 53100000 },
    });
    assert.equal(stillBorrowCapacityViewV1(read, 'WETH', '10000000000000000').capacity, null);
    assert.equal(stillBorrowCapacityViewV1({ ...read, markets: [{ ...wethRow, funding: undefined }] }, 'ETH', '10000000000000000').capacity, null);
  });
});
