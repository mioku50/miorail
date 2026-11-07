import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADDRESSES, CRYPTO, STOCKS } from '@mioagent/still-engine/registry';
import { borrowAssetFromQueryV1, borrowCollateralDecimalsV1, borrowCollateralTokenV1, parseBorrowDecimalV1, stillBorrowBalanceViewV1, stillBorrowCapacityViewV1 } from '../src/still/borrowIntent.js';
import { repayMaxV1 } from '../src/console/repayEntry.js';

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
    // A server that sends no comparison gets none shown, never one worked out here.
    assert.deepEqual(stillBorrowCapacityViewV1(response(), 'cbBTC', '0'), { error: null, capacity: {
      walletBalance: '1.23456789', pledged: '1', maximumUsdc: '12.34', blockNumber: 53100000, comparison: null,
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
      capacity: { nativeReserve: '0.0005', walletBalance: '0.025', pledged: '0.003', maximumUsdc: '12.34', blockNumber: 53100000, comparison: null },
    });
    assert.equal(stillBorrowCapacityViewV1(read, 'WETH', '10000000000000000').capacity, null);
    assert.equal(stillBorrowCapacityViewV1({ ...read, markets: [{ ...wethRow, funding: undefined }] }, 'ETH', '10000000000000000').capacity, null);
  });
  it('offers the ETH the server says can be added, and nothing it did not say', () => {
    // 2026-10-31: 0.0033 ETH asked of a wallet holding 0.0033, with 0.0005 kept for fees.
    const refused = {
      state: 'refused', refusal: 'native_fee_reserve_insufficient', markets: [],
      detail: 'This wallet holds 0.0033 ETH. Still leaves 0.0005 ETH in it for network fees, so you can add up to 0.0028 ETH.',
      walletNativeAtomic: '3300000000000000', maximumNativeAtomic: '2800000000000000',
    };
    assert.deepEqual(stillBorrowCapacityViewV1(refused, 'ETH', '3300000000000000'),
      { capacity: null, error: refused.detail, suggestedAmount: '0.0028' });
    // Nothing to add, a balance nobody read, another asset, or an amount that is
    // not below the ask: the sentence alone.
    for (const [payload, asset] of [
      [{ ...refused, maximumNativeAtomic: '0' }, 'ETH'],
      [{ state: 'refused', refusal: 'native_balance_unread', detail: 'unread', markets: [] }, 'ETH'],
      [refused, 'WETH'],
      [{ ...refused, maximumNativeAtomic: '3300000000000000' }, 'ETH'],
      [{ ...refused, maximumNativeAtomic: '28e14' }, 'ETH'],
    ] as const) {
      assert.equal('suggestedAmount' in stillBorrowCapacityViewV1(payload, asset, '3300000000000000'), false);
    }
  });
});

describe('a phone’s decimal comma is the decimal point (2026-11-07)', () => {
  // An iPhone set to Russian has no dot on its decimal keypad: "0,8" was refused.
  it('reads a lone comma as the point, exactly', () => {
    assert.deepEqual(parseBorrowDecimalV1('0,8', 6), { atomic: '800000', error: null });
    assert.deepEqual(parseBorrowDecimalV1(' 1,5 ', 6), { atomic: '1500000', error: null });
    assert.deepEqual(parseBorrowDecimalV1('0,000543068208472116', 18), { atomic: '543068208472116', error: null });
    assert.deepEqual(parseBorrowDecimalV1('12,5', 6), { atomic: '12500000', error: null });
    assert.deepEqual(parseBorrowDecimalV1('0,500', 6), { atomic: '500000', error: null });
    assert.equal(parseBorrowDecimalV1('1,0000001', 6).error, 'Use at most 6 decimal places. Amounts are never rounded.');
  });
  it('never guesses at a comma that could be a thousands separator, and says why', () => {
    for (const text of ['1,000', '12,500', '999,999']) {
      const parsed = parseBorrowDecimalV1(text, 6);
      assert.equal(parsed.atomic, null, text);
      assert.match(parsed.error!, /without the comma, or with a dot: it could be \d+ or \d+\.\d+\./, text);
    }
    for (const text of ['1,5,0', '1,5.0', '1.000,5', ',']) assert.equal(parseBorrowDecimalV1(text, 6).atomic, null, text);
  });
});

describe('gold is chosen like bitcoin, with its own decimals and market (2026-11-07)', () => {
  const PAXG = CRYPTO.find(row => row.id === 'PAXG')!;
  it('takes PAXG from a link, pledges its token and counts 18 decimals, as the registry says', () => {
    assert.equal(borrowAssetFromQueryV1('PAXG'), 'PAXG');
    assert.equal(borrowCollateralTokenV1('PAXG'), PAXG.token);
    // Read from the registry: before gold, every coin that was not WETH or ETH was taken for 8.
    assert.equal(borrowCollateralDecimalsV1('PAXG'), 18);
    assert.equal(borrowCollateralDecimalsV1('cbBTC'), 8);
    assert.equal(borrowCollateralDecimalsV1('WETH'), 18);
    assert.equal(borrowCollateralDecimalsV1('NVDAc'), 8);
    assert.equal(parseBorrowDecimalV1('0.5', borrowCollateralDecimalsV1('PAXG'), true).atomic, '500000000000000000');
  });
  it('reads PAXG’s own market row, never the bitcoin or ether one', () => {
    const row = { marketId: PAXG.morphoMarket, walletCollateralAtomic: '1000000000000000000' };
    assert.deepEqual(stillBorrowBalanceViewV1({ state: 'read', marketScope: 'still_registered_market', markets: [row] }, 'PAXG'), { maxAtomic: '1000000000000000000', error: null });
    assert.equal(stillBorrowBalanceViewV1(response(), 'PAXG').maxAtomic, null);
  });
});

describe('Max fills the amount from the server’s own read', () => {
  const NVDAC = STOCKS.find(stock => stock.id === 'NVDAc')!;
  const stockRow = { marketId: ADDRESSES.aaveSpoke.toLowerCase(), collateralTokenAddress: NVDAC.token.toLowerCase(), walletCollateralAtomic: '2028750' };
  it('a token is all of it in the wallet; native ETH keeps the fee reserve; WETH is the token', () => {
    assert.deepEqual(stillBorrowBalanceViewV1({ state: 'read', marketScope: 'still_aave_spoke', markets: [stockRow] }, 'NVDAc'), { maxAtomic: '2028750', error: null });
    assert.deepEqual(stillBorrowBalanceViewV1(response(), 'cbBTC'), { maxAtomic: '123456789', error: null });
    const weth = CRYPTO.find(row => row.id === 'ETH')!;
    const native = { state: 'read', marketScope: 'still_registered_market', markets: [{ marketId: weth.morphoMarket, walletCollateralAtomic: '3300000000000000',
      funding: 'native', nativeReserveAtomic: '500000000000000' }] };
    assert.deepEqual(stillBorrowBalanceViewV1(native, 'ETH'), { maxAtomic: '2800000000000000', error: null });
    // The server's own figure when it refused even one wei: zero ETH to add is an answer.
    assert.deepEqual(stillBorrowBalanceViewV1({ state: 'refused', refusal: 'native_fee_reserve_insufficient', maximumNativeAtomic: '0', detail: 'x' }, 'ETH'),
      { maxAtomic: '0', error: null });
  });
  it('an unread balance is said, never filled in as zero; a row for another market is not this one', () => {
    const unread = stillBorrowBalanceViewV1({ state: 'read', marketScope: 'still_aave_spoke', markets: [{ ...stockRow, walletCollateralAtomic: null }] }, 'NVDAc');
    assert.equal(unread.maxAtomic, null);
    assert.match(unread.error!, /could not be read just now/);
    assert.equal(stillBorrowBalanceViewV1({ state: 'read', marketScope: 'still_aave_spoke', markets: [stockRow] }, 'AAPLc').maxAtomic, null);
    assert.equal(stillBorrowBalanceViewV1(response(), 'NVDAc').maxAtomic, null);
    assert.deepEqual(stillBorrowBalanceViewV1({ state: 'refused', detail: 'Still could not establish this Aave account at one Base block.' }, 'NVDAc'),
      { maxAtomic: null, error: 'Still could not establish this Aave account at one Base block.' });
  });
  it('on Repay, the wallet’s USDC short of the debt; a wallet that covers it moves to Repay all, with the wallet’s USDC as the bound', () => {
    // 2026-11-07: Max put the whole Morpho debt, 0.840001 USDC, into Exact USDC, and the review was refused.
    assert.deepEqual(repayMaxV1({ debtAtomic: '840001', walletUsdcAtomic: '909427' }, 'assets'), { mode: 'all', atomic: '909427' });
    assert.deepEqual(repayMaxV1({ debtAtomic: '10000000', walletUsdcAtomic: '10000000' }, 'assets'), { mode: 'all', atomic: '10000000' });
    assert.deepEqual(repayMaxV1({ debtAtomic: '10000000', walletUsdcAtomic: '4000000' }, 'assets'), { mode: 'assets', atomic: '4000000' });
    assert.deepEqual(repayMaxV1({ debtAtomic: '10000000', walletUsdcAtomic: '25000000' }, 'all'), { mode: 'all', atomic: '25000000' });
    assert.deepEqual(repayMaxV1({ debtAtomic: '10000000', walletUsdcAtomic: '25000000' }, 'return'), { mode: 'return', atomic: '25000000' });
  });
});

