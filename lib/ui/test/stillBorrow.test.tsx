import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { StillBorrow, type StillBorrowModelV1 } from '../src/still/StillBorrow';
import { skyStateV1 } from '../src/still/skyState';

void React;

const noop = () => {};
function model(overrides: Partial<StillBorrowModelV1> = {}): StillBorrowModelV1 {
  return {
    sky: skyStateV1({ now: new Date('2026-10-28T15:00:00Z') }),
    signedIn: true, signInHref: '/signin?returnTo=%2Fborrow%2Fnew',
    asset: 'cbBTC', onAsset: noop, collateralAmount: '0', onCollateralAmount: noop,
    borrowAmount: '', onBorrowAmount: noop,
    reading: false, preparing: false, needsRead: true, onReadLimit: noop, onReview: noop,
    capacity: null, error: null, ...overrides,
  };
}
const capacity = { walletBalance: '0.01234567', pledged: '0.003', maximumUsdc: '125.34', blockNumber: 53_100_000 };
const render = (overrides: Partial<StillBorrowModelV1> = {}) => renderToStaticMarkup(<StillBorrow model={model(overrides)} />);
function button(html: string, label: string): string {
  const found = html.match(new RegExp(`<button\\b[^>]*>${label}<\\/button>`));
  assert(found, `expected button ${label}`);
  return found[0];
}

describe('Still borrowing starts with a selected pledge and a server read', () => {
  it('requires sign-in without leaking a supplied private balance or review action', () => {
    const html = render({ signedIn: false, needsRead: false, capacity });
    assert.match(html, /<h1>Get money<\/h1>/);
    assert.match(html, /href="\/signin\?returnTo=%2Fborrow%2Fnew"[^>]*>Sign in<\/a>/);
    assert.match(html, /href="\/assets"[^>]*>Back to Assets<\/a>/);
    assert.doesNotMatch(html, /<input|125\.34|0\.01234567|Review loan/);
  });

  it('names the protocol each loan is made on, before anything is chosen, signed in or not', () => {
    // 2026-10-31, the operator: the product must say which protocols the loans use.
    for (const html of [render({ asset: null, collateralAmount: '' }), render({ signedIn: false })]) {
      assert.match(html, />Where your loan lives<\/h2>/);
      assert.match(html, /Still is not a lender and never holds your collateral or your USDC\./);
      assert.match(html, /<dt>Tokenized stocks<\/dt><dd>Aave V4<\/dd>/);
      assert.match(html, /<dt>cbBTC, WETH or explicitly selected ETH<\/dt><dd>Morpho<\/dd>/);
    }
  });

  it('offers the registered stocks, cbBTC, WETH and explicit native ETH without automatic-Max choices', () => {
    const html = render({ asset: null, collateralAmount: '' });
    assert.match(html, /aria-label="Collateral token"/);
    assert.match(html, /<strong>cbBTC<\/strong>/);
    assert.match(html, /<strong>WETH<\/strong>/);
    assert.match(html, /<strong>ETH<\/strong>/);
    assert.match(html, /Wrapped ETH/);
    assert.match(html, /Wrap native ETH/);
    assert.match(html, /<dt>cbBTC, WETH or explicitly selected ETH<\/dt><dd>Morpho<\/dd>/);
    assert.match(html, /Stock collateral · Aave V4/);
    assert.match(html, /<option value="NVDAc">NVDAc · NVIDIA<\/option>/);
    assert.match(button(html, 'Read borrowing limit'), /disabled=""/);
    assert.doesNotMatch(html, /<button[^>]*>Max|Review loan/);
    assert.match(html, /Choose your collateral and read the borrowing limit first/);
  });

  it('distinguishes native ETH in the wallet from already-pledged WETH and states the fee reserve', () => {
    const html = render({ asset: 'ETH', collateralAmount: '0.01', needsRead: false,
      capacity: { ...capacity, walletBalance: '0.025', pledged: '0.003', nativeReserve: '0.0005' } });
    assert.match(html, /Enter the exact ETH to wrap and pledge\. Wallet-held WETH is not spent\./);
    assert.match(html, /0\.025 ETH/);
    assert.match(html, /0\.003 WETH/);
    assert.match(html, /At least 0\.0005 ETH is kept out of the collateral for wallet\/network fees\./);
  });

  it('allows the explicit zero-addition choice and does not create a loan amount', () => {
    const html = render();
    assert.doesNotMatch(button(html, 'Read borrowing limit'), /disabled/);
    assert.match(html, /Enter 0 to use only collateral already deposited/);
    assert.match(html, /value="0"/);
    assert.doesNotMatch(html, />USDC to borrow<\/label>|Review loan/);
  });

  it('shows the server values and their block without rounding or filling the loan input', () => {
    const html = render({ needsRead: false, capacity });
    assert.match(html, /125\.34<span> USDC<\/span>/);
    assert.match(html, /0\.01234567 cbBTC/);
    assert.match(html, /0\.003 cbBTC/);
    assert.match(html, /53,100,000/);
    assert.match(button(html, 'Review loan'), /disabled=""/);
    assert.doesNotMatch(html, /value="125\.34"/);
  });

  it('hands a chosen amount to review instead of reimplementing the server limit in the screen', () => {
    const html = render({ needsRead: false, capacity: { ...capacity, maximumUsdc: '2.00' }, borrowAmount: '3.000001' });
    assert.match(html, /value="3\.000001"/);
    assert.doesNotMatch(button(html, 'Review loan'), /disabled/);
    assert.match(html, /The next page checks this exact amount/);
    assert.match(html, /not a recommendation to borrow/);
    assert.match(html, /collateral can be liquidated/);
  });

  it('hides stale numbers and the review action after the collateral choice changes', () => {
    const html = render({ capacity, needsRead: true, borrowAmount: '3' });
    assert.match(html, /Your collateral choice changed/);
    assert.doesNotMatch(html, /125\.34|0\.01234567|53,100,000|Review loan/);
  });

  for (const [state, label] of [['reading', 'Reading limit…'], ['preparing', 'Preparing review…']] as const) {
    it(`keeps controls inactive while ${state}`, () => {
      const html = render({ capacity, needsRead: false, borrowAmount: '3', [state]: true });
      assert.match(button(html, state === 'reading' ? label : 'Read borrowing limit'), /disabled=""/);
      assert.match(button(html, state === 'preparing' ? label : 'Review loan'), /disabled=""/);
      assert.match(html, /aria-busy="true"/);
      assert.equal([...html.matchAll(/<input\b[^>]*disabled=""/g)].length, 2);
    });
  }

  it('keeps an unread limit distinct from measured zero and does not enable review', () => {
    const html = render({ capacity: { walletBalance: null, pledged: null, maximumUsdc: null, blockNumber: null }, needsRead: false, borrowAmount: '3' });
    assert.equal([...html.matchAll(/Not read/g)].length, 3);
    assert.match(html, /Reading block not available/);
    assert.match(html, /The limit could not be read/);
    assert.match(button(html, 'Review loan'), /disabled=""/);
    assert.doesNotMatch(html, /0 USDC/);
    const zero = render({ capacity: { walletBalance: '0', pledged: '0', maximumUsdc: '0', blockNumber: 53_100_000 }, needsRead: false });
    assert.match(zero, />0<span> USDC<\/span>/);
    assert.match(zero, />0 cbBTC<\/dd>/);
    assert.doesNotMatch(zero, /Not read/);
  });

  it('preserves a server refusal in readable escaped text without presenting it as empty funds', () => {
    const html = render({ error: 'The balance could not be read <again>.' });
    assert.match(html, /role="alert">The balance could not be read &lt;again&gt;\.<\/p>/);
    assert.doesNotMatch(html, /No collateral|No funds|Review loan/);
  });
});

describe('what Still’s limit is worth, in numbers', () => {
  const aave = { protocol: 'Aave V4', protocolLimitAtomic: '1234567890', stillLimitAtomic: '617283945', shareBps: 5_000, marginAtStillLimitBps: 5_000, lowered: null };

  it('reads the server’s two limits, rounded down to the cent, with the margin at Still’s', async () => {
    const { stillBorrowComparisonViewV1 } = await import('../src/still/borrowIntent');
    assert.deepEqual(stillBorrowComparisonViewV1(aave, 'NVDAc'), {
      protocol: 'Aave V4', protocolLimitUsdc: '1,234.56', stillLimitUsdc: '617.28', sharePercent: '50%', marginPercent: '50%', lowered: null,
    });
    // A crypto loan is Morpho's, and a figure from the other protocol is not this one's.
    assert.equal(stillBorrowComparisonViewV1(aave, 'cbBTC'), null);
    assert.equal(stillBorrowComparisonViewV1({ ...aave, protocol: 'Morpho' }, 'cbBTC')?.protocol, 'Morpho');
    // Anything not exact leaves the comparison out, never a guess.
    for (const odd of [{ ...aave, stillLimitAtomic: '1234567891' }, { ...aave, protocolLimitAtomic: '0', stillLimitAtomic: '0' },
      { ...aave, shareBps: 0 }, { ...aave, marginAtStillLimitBps: 10_001 }, { ...aave, lowered: { reason: 'tea_time' } }, { ...aave, lowered: undefined }]) {
      assert.equal(stillBorrowComparisonViewV1(odd, 'NVDAc'), null, JSON.stringify(odd));
    }
  });

  it('says why a stock counts lower: the closed market, the company’s report, or a calendar we could not read', async () => {
    const { stillBorrowComparisonViewV1 } = await import('../src/still/borrowIntent');
    const lowered = (value: unknown) => stillBorrowComparisonViewV1({ ...aave, shareBps: 4_000, marginAtStillLimitBps: 6_000, lowered: value }, 'NVDAc')!.lowered;
    assert.equal(lowered({ reason: 'market_closed', until: '2026-11-02T01:00:00.000Z' }),
      'Stocks count at 40%, not 50%, until Sun 8 PM New York time: Wall Street is closed, and a stock can open far from the price its token trades at on Base.');
    assert.equal(lowered({ reason: 'earnings', reportDate: '2026-11-19', until: '2026-11-21T01:00:00.000Z' }),
      'NVDAc counts at 40%, not 50%, until Fri 8 PM New York time: NVIDIA reports earnings on Nov 19, and the price can jump either way.');
    assert.match(lowered({ reason: 'earnings_unread' })!, /^NVDAc counts at 40%, not 50%: Still could not read the earnings calendar just now/);
  });

  it('prints both limits and both margins where the amount is chosen', () => {
    const html = render({ asset: 'NVDAc', needsRead: false, capacity: { ...capacity, comparison: {
      protocol: 'Aave V4', protocolLimitUsdc: '1,234.56', stillLimitUsdc: '617.28', sharePercent: '40%', marginPercent: '60%',
      lowered: 'Stocks count at 40%, not 50%, until Sun 8 PM New York time: Wall Street is closed.',
    } } });
    assert.match(html, /<dt>Aave V4 would lend up to<\/dt><dd class="mono">1,234\.56 USDC<\/dd>/);
    assert.match(html, /<dt>Still lends up to<\/dt><dd class="mono">617\.28 USDC · 40% of it<\/dd>/);
    assert.match(html, /Borrowing Aave V4’s full amount, the smallest fall in price could start liquidation\. Borrowing Still’s, your collateral could fall 60% first\./);
    assert.match(html, /until Sun 8 PM New York time: Wall Street is closed\./);
    assert.doesNotMatch(render({ asset: 'NVDAc', needsRead: false, capacity }), /would lend up to/);
  });
});

describe('Max beside the amount', () => {
  it('sits in the collateral field, says what it fills, and waits for the asset', () => {
    const html = render({ asset: 'NVDAc', onMax: noop });
    assert.match(html, /<div class="still-borrow-amount has-max"><input id="[^"]+-collateral"/);
    assert.match(html, /<button type="button" class="still-borrow-max" title="All of it in your wallet">Max<\/button>/);
    assert.match(render({ asset: 'ETH', onMax: noop }), /title="All the ETH in your wallet, less 0\.0005 ETH kept for network fees"/);
    assert.match(render({ asset: null, onMax: noop }), /<button type="button" class="still-borrow-max" disabled=""/);
    assert.match(render({ asset: 'NVDAc', onMax: noop, maxReading: true }), />Reading…<\/button>/);
    assert.doesNotMatch(render({ asset: 'NVDAc' }), /still-borrow-max/);
  });

  it('paying an invoice, the loan is its price, native ETH is not offered and the review says loan and payment', () => {
    const spend = { state: 'ready' as const, productName: 'Bitrefill eSIM Germany', packageValue: '10GB, 30 Days', priceUsdc: '13.25', expiresAt: '2026-11-01T12:15:00.000Z' };
    const html = render({ spend, needsRead: false, capacity, borrowAmount: '13.25' });
    assert.match(html, /Paying Bitrefill · Bitrefill eSIM Germany · 10GB, 30 Days: 13\.25 USDC\./);
    assert.match(html, /USDC to borrow · the invoice’s price/);
    assert.match(html, /<input[^>]*value="13\.25"[^>]*readOnly=""|<input[^>]*readOnly=""[^>]*value="13\.25"/);
    assert.match(button(html, 'Review loan and payment'), /<button/);
    assert.doesNotMatch(html, /Wrap native ETH/);
    assert.match(render({ spend: { state: 'gone' } }), /Still no longer holds this Bitrefill invoice/);
    assert.doesNotMatch(render({ spend: { state: 'gone' }, signedIn: false }), /no longer holds/);
    // An invoice still being read cannot be reviewed yet.
    assert.match(render({ spend: { state: 'reading' }, needsRead: false, capacity, borrowAmount: '' }), /<button type="submit" class="still-btn" disabled="">Review loan and payment<\/button>/);
  });
});
