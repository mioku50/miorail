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

  it('offers the registered stocks, cbBTC and WETH without native-ETH or automatic-Max choices', () => {
    const html = render({ asset: null, collateralAmount: '' });
    assert.match(html, /aria-label="Collateral token"/);
    assert.match(html, /<strong>cbBTC<\/strong>/);
    assert.match(html, /<strong>WETH<\/strong>/);
    assert.match(html, /Wrapped ETH/);
    assert.match(html, /Native ETH is not added here/);
    assert.match(html, /Stock collateral · Aave V4/);
    assert.match(html, /<option value="NVDAc">NVDAc · NVIDIA<\/option>/);
    assert.match(button(html, 'Read borrowing limit'), /disabled=""/);
    assert.doesNotMatch(html, /<button[^>]*>Max|Review loan/);
    assert.match(html, /Choose your collateral and read the borrowing limit first/);
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
