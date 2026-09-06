import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import {
  stockSellConfirmAllowedV1,
  stockSellTermsStateV1,
} from '../src/console/stockSellAmount';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

// ---------------------------------------------------------------------------
// Phase 17.9 — the review must measure what it is about to confirm.
//
// The defect: the page assembled the board at the draft's CASH size and then
// took a TOKEN amount from the holder. Nothing reconciled the two, so a draft
// prepared at $0.09 rendered the market for $0.09 while one press of "Use
// available balance" confirmed a whole position against that picture.
// ---------------------------------------------------------------------------

describe('the confirm button waits for terms about THIS amount', () => {
  const state = (over: Partial<Parameters<typeof stockSellTermsStateV1>[0]> = {}) =>
    stockSellTermsStateV1({
      amountAtomic: '85690',
      askedFor: '85690',
      pending: false,
      status: 'established',
      ...over,
    });

  test('terms for the amount in the box open the button', () => {
    assert.equal(state(), 'established');
    assert.equal(stockSellConfirmAllowedV1(state(), '85690'), true);
  });

  test('editing the amount takes the button away again', () => {
    // Nothing invalidates anything: the terms are simply for a different size,
    // and the match stops holding. That is the truth, stated structurally.
    const edited = state({ amountAtomic: '85691' });
    assert.equal(edited, 'unasked');
    assert.equal(stockSellConfirmAllowedV1(edited, '85691'), false);
  });

  test('no amount is unasked, never established', () => {
    assert.equal(state({ amountAtomic: null, askedFor: null }), 'unasked');
    assert.equal(stockSellConfirmAllowedV1('unasked', null), false);
  });

  test('a size the routers refused does not open the button', () => {
    const refused = state({ status: 'no_route' });
    assert.equal(refused, 'no_route');
    assert.equal(stockSellConfirmAllowedV1(refused, '85690'), false);
  });

  test('terms we could not establish do not open the button either', () => {
    const ours = state({ status: 'not_established' });
    assert.equal(stockSellConfirmAllowedV1(ours, '85690'), false);
    // Absent is treated as ours, never as a market answer.
    assert.equal(state({ status: null }), 'not_established');
  });

  test('a measurement in flight is pending, not established', () => {
    assert.equal(state({ pending: true }), 'pending');
    assert.equal(stockSellConfirmAllowedV1('pending', '85690'), false);
  });
});

describe('the screen says which size the board is about', () => {
  const screen = read('lib/ui/src/console/StockActionReviewScreen.tsx');
  const console_ = read('lib/ui/src/console/stockActionReviewConsole.ts');

  test('the sell panel renders the terms state rather than the board alone', () => {
    assert.match(screen, /sellTerms/);
    assert.match(screen, /Check this amount/);
    // "Nobody has asked yet" is the state this screen most needed to be able
    // to show: without it the board's figures sit above a confirm button and
    // are read as the terms of the sale.
    assert.match(screen, /have not been asked about this amount yet/);
  });

  test('our failure and the market’s refusal are two different sentences', () => {
    assert.match(console_, /stockSellTermsFailureCopyV1/);
    const copy = console_.slice(console_.indexOf('export function stockSellTermsFailureCopyV1'));
    const ours = copy.slice(copy.indexOf('stock_sell_terms_measurement_failed'));
    assert.match(ours, /statement about Miorail/);
    const market = copy.slice(copy.indexOf('stock_action_sell_size_unroutable'));
    assert.match(market, /this size/);
  });
});
