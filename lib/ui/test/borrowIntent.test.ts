import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADDRESSES, CRYPTO, STOCKS } from '@mioagent/still-engine/registry';
import { borrowAssetFromQueryV1, borrowCollateralDecimalsV1, borrowCollateralTokenV1, parseBorrowDecimalV1, stillBorrowBalanceViewV1, stillBorrowCapacityViewV1 } from '../src/still/borrowIntent.js';
import { repayAllBoundAtomicV1, repayIntentAmountsV1, repayMaxV1, repayShortTextV1, repayTopUpAtomicV1 } from '../src/console/repayEntry.js';
import { LENDING_MOVED_OUTSIDE_COPY_V1, lendingExecutionCopyV1, parseLendingExecutionWireV1 } from '../src/console/lendingReviewView.js';

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
  it('on Repay, the wallet’s USDC short of the debt; a wallet that covers it moves to Repay all, with the debt and a margin for interest as the bound', () => {
    // 2026-11-07: Max put the whole Morpho debt, 0.840001 USDC, into Exact USDC, and the review was refused.
    assert.deepEqual(repayMaxV1({ debtAtomic: '840001', walletUsdcAtomic: '909427' }, 'assets'), { mode: 'all', atomic: '860000' });
    // The wallet holds the debt but not its margin: the wallet's USDC is the bound.
    assert.deepEqual(repayMaxV1({ debtAtomic: '10000000', walletUsdcAtomic: '10000000' }, 'assets'), { mode: 'all', atomic: '10000000' });
    assert.deepEqual(repayMaxV1({ debtAtomic: '10000000', walletUsdcAtomic: '4000000' }, 'assets'), { mode: 'assets', atomic: '4000000' });
    assert.deepEqual(repayMaxV1({ debtAtomic: '10000000', walletUsdcAtomic: '25000000' }, 'all'), { mode: 'all', atomic: '10010000' });
    assert.deepEqual(repayMaxV1({ debtAtomic: '10000000', walletUsdcAtomic: '25000000' }, 'return'), { mode: 'return', atomic: '10010000' });
    // Short of the debt, Repay all keeps the wallet's USDC, and the page says how much to send.
    assert.deepEqual(repayMaxV1({ debtAtomic: '10000000', walletUsdcAtomic: '4000000' }, 'all'), { mode: 'all', atomic: '4000000' });
  });
  // Audit LEND-2 (2026-11-10): Aave takes the smaller of the debt and the bound when a repayment lands, so a
  // bound at the debt itself leaves the interest since the read owing, and the whole spoke was then held.
  it('Repay all is asked with room above the debt: on Aave V4 a part would be left owing, on Morpho the repayment would revert (audits LEND-2, LM-4)', () => {
    const ask = (venue: 'aave-v4' | 'morpho', maximum: string, wallet = '5000000') =>
      repayIntentAmountsV1({ mode: 'all', amount: '', maximum, walletUsdcAtomic: wallet, debtAtomic: '2000003', blockNumber: 53_000_000, venue });
    assert.equal(ask('aave-v4', '2.000003').intent, null);
    assert.equal(ask('aave-v4', '2.000003').error,
      'The debt is 2.000003 USDC now and this maximum is 2.000003 USDC: interest adds to the debt every second, and with so little room a part of it would be left owing. Set the maximum to at least 2.02 USDC; what is not needed stays in your wallet.');
    assert.match(ask('aave-v4', '1.5').error ?? '', /more than this maximum of 1\.5 USDC: interest adds to it every second\. Set the maximum to at least 2\.02 USDC;/);
    assert.deepEqual(ask('aave-v4', '2.02').intent, { amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '2020000' });
    // Morpho repays the debt's shares: a bound at the debt itself reverts once interest passes it (audit LM-4).
    assert.equal(ask('morpho', '2.000003').intent, null);
    assert.equal(ask('morpho', '2.000003').error,
      'The debt is 2.000003 USDC now and this maximum is 2.000003 USDC: interest adds to the debt every second, and with so little room the repayment would revert onchain if the debt passed this maximum before it landed. Set the maximum to at least 2.02 USDC; what is not needed stays in your wallet.');
    assert.match(ask('morpho', '1.5').error ?? '', /more than this maximum of 1\.5 USDC: interest adds to it every second\. Set the maximum to at least 2\.02 USDC;/);
    assert.deepEqual(ask('morpho', '2.02').intent, { amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '2020000' });
    for (const venue of ['aave-v4', 'morpho'] as const) assert.doesNotMatch(ask(venue, '1.5').error ?? '', /at least the debt|a little above the debt/);
    // A wallet that covers the debt and not that room is told how much more to send, on either venue.
    for (const venue of ['aave-v4', 'morpho'] as const) {
      assert.equal(repayTopUpAtomicV1({ debtAtomic: '2000003', walletUsdcAtomic: '2000060', venue }), BigInt(20_000), venue);
      assert.equal(repayTopUpAtomicV1({ debtAtomic: '2000003', walletUsdcAtomic: '2020000', venue }), null, venue);
    }
    assert.match(repayShortTextV1({ debtAtomic: '2000003', walletUsdcAtomic: '2000060', venue: 'morpho' }) ?? '', /^This wallet holds 2\.00006 USDC and the debt is 2\.000003 USDC now\. Repay all on Morpho is asked with room/);
    assert.equal(repayShortTextV1({ debtAtomic: '2000003', walletUsdcAtomic: '2000060', venue: 'aave-v4' }),
      'This wallet holds 2.00006 USDC and the debt is 2.000003 USDC now. Repay all on Aave V4 is asked with room for the interest that adds to the debt until it lands: at least 2.02 USDC, 0.01994 USDC more than the wallet holds. '
      + 'Send this wallet a little more USDC, for example 0.02 USDC, then read the position again. What is not needed stays in your wallet.');
    assert.equal(ask('aave-v4', '2.00006', '2000060').error, repayShortTextV1({ debtAtomic: '2000003', walletUsdcAtomic: '2000060', venue: 'aave-v4' }));
    // Short of the debt itself, the words are the ones already known, and the example reaches the bound.
    assert.match(repayShortTextV1({ debtAtomic: '2000003', walletUsdcAtomic: '2000000', venue: 'aave-v4' }) ?? '', /0\.000003 USDC short\..*for example 0\.02 USDC, then read the position again\.$/);
    assert.match(repayShortTextV1({ debtAtomic: '2000003', walletUsdcAtomic: '2000000', venue: 'morpho' }) ?? '', /for example 0\.02 USDC, then read the position again\.$/);
  });
  it('a Repay all that landed and left interest owing says how much, and is not called closed', () => {
    assert.equal(lendingExecutionCopyV1('confirmed', null, '23'),
      'Confirmed onchain: the repayment landed. Interest that added to the debt until it landed left 0.000023 USDC owing: repay it to close the loan.');
    assert.equal(lendingExecutionCopyV1('confirmed', null, null), 'Confirmed onchain: the approved calls and the resulting position were verified.');
    assert.equal(lendingExecutionCopyV1('confirmed', null, '0'), 'Confirmed onchain: the approved calls and the resulting position were verified.');
    const row = { executionId: 'execution_1', state: 'confirmed', transactionHash: `0x${'9'.repeat(64)}`, errorCode: null };
    assert.equal(parseLendingExecutionWireV1({ ...row, remainingDebtAtomic: '23' }, 'execution_1')?.remainingDebtAtomic, '23');
    assert.equal(parseLendingExecutionWireV1({ ...row, remainingDebtAtomic: null }, 'execution_1')?.remainingDebtAtomic, null);
    for (const bad of ['0', '-1', '1.5', 23]) assert.equal(parseLendingExecutionWireV1({ ...row, remainingDebtAtomic: bad }, 'execution_1'), null);
  });
  it('a result whose position another hand moved too is confirmed, and says the position differs from the review (audit LM-1)', () => {
    assert.equal(lendingExecutionCopyV1('confirmed', null, null, true), `Confirmed onchain: the approved calls landed exactly as reviewed. ${LENDING_MOVED_OUTSIDE_COPY_V1}`);
    // What is left is not only interest then.
    const tail = lendingExecutionCopyV1('confirmed', null, '23', true);
    assert.equal(tail, `Confirmed onchain: the repayment landed, and 0.000023 USDC is still owing: repay it to close the loan. ${LENDING_MOVED_OUTSIDE_COPY_V1}`);
    assert.doesNotMatch(tail, /Interest/);
    assert.match(LENDING_MOVED_OUTSIDE_COPY_V1, /liquidation/);
    const row = { executionId: 'execution_1', state: 'confirmed', transactionHash: `0x${'9'.repeat(64)}`, errorCode: null };
    assert.equal(parseLendingExecutionWireV1({ ...row, positionMovedOutside: true }, 'execution_1')?.positionMovedOutside, true);
    assert.equal(parseLendingExecutionWireV1({ ...row, positionMovedOutside: 'yes' }, 'execution_1')?.positionMovedOutside, false);
    // Said only of a confirmed result.
    assert.equal(parseLendingExecutionWireV1({ ...row, state: 'unknown', positionMovedOutside: true }, 'execution_1')?.positionMovedOutside, false);
  });
  it('Max for Repay all is the debt read, rounded up to the cent, plus one cent or 0.1% of it, whichever is more', () => {
    // 2026-11-10, the operator: Max put all 171.8 USDC of the wallet in for a debt of 0.850328 USDC.
    assert.deepEqual(repayMaxV1({ debtAtomic: '850328', walletUsdcAtomic: '171800000' }, 'return'), { mode: 'return', atomic: '870000' });
    assert.equal(repayAllBoundAtomicV1('850328'), BigInt(870_000));
    assert.equal(repayAllBoundAtomicV1('2000000'), BigInt(2_010_000));
    assert.equal(repayAllBoundAtomicV1('3125001'), BigInt(3_140_000));
    assert.equal(repayAllBoundAtomicV1('1'), BigInt(20_000));
    // Above ten USDC the margin is 0.1%, rounded up to the cent: 10,000.123456 owed, 10,010.14 bound.
    assert.equal(repayAllBoundAtomicV1('10000123456'), BigInt(10_010_140_000));
    assert.equal(repayAllBoundAtomicV1('20000000'), BigInt(20_020_000));
    // A wallet between the debt and the bound gives all it holds, still at least the debt.
    assert.deepEqual(repayMaxV1({ debtAtomic: '850328', walletUsdcAtomic: '860000' }, 'all'), { mode: 'all', atomic: '860000' });
  });
});

