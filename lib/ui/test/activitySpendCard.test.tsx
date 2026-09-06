import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

void React;

import {
  ActivitySpendCard,
  type ActivitySpendEntryV1,
  type ActivitySpendModelV1,
} from '../src/console/ActivityPanels';

// ---------------------------------------------------------------------------
// The ledger opened Activity with six of our own $0.001 test transactions,
// five of them failed, above the result of a real one. The rows fold; the
// numbers do not.
// ---------------------------------------------------------------------------

const receipt = (over: Partial<ActivitySpendEntryV1> = {}): ActivitySpendEntryV1 => ({
  id: 'r1',
  actionType: 'x402_buyer_smoke',
  category: 'dev_smoke',
  direction: 'outgoing',
  cost: '0.001',
  txHash: `0x${'ab'.repeat(32)}`,
  status: 'settled',
  createdAt: '2026-07-09T19:39:26.000Z',
  ...over,
});

const model = (over: Partial<ActivitySpendModelV1> = {}): ActivitySpendModelV1 => ({
  loading: false,
  unavailableReason: null,
  entries: [],
  summary: {
    totalSpentUsdc: '0.001',
    devSmokeSpentUsdc: '0.001',
    devSmokeCallsCount: 6,
    failedBuyerAttemptsCount: 5,
    summaryScope: 'latest_100_tenant_receipts',
    recordsConsidered: 6,
    truncated: false,
  },
  ...over,
});

const render = (over: Partial<ActivitySpendModelV1> = {}) =>
  renderToStaticMarkup(<ActivitySpendCard {...model(over)} />);

describe('paid intelligence keeps its numbers and folds its rows', () => {
  test('the total and the summary sentence need no press', () => {
    const markup = render({
      entries: [receipt(), receipt({ id: 'r2', status: 'failed' })],
    });
    assert.match(markup, /\$0\.001/);
    // Every measurement the card has: the share that is ours, and the failures
    // that are not in the total.
    assert.match(markup, /6 development smoke payments/);
    assert.match(markup, /5 attempt\(s\) failed and are not counted/);
  });

  test('development smoke is its own group, and its count is reconciled with the total', () => {
    // Shipped for four minutes reading "6 development smoke payments" under a
    // sentence reading "1 development smoke payment". Both true: the sentence
    // totals what SETTLED, the group lists every receipt. One word, two
    // numbers, one card.
    const markup = render({
      entries: [receipt(), receipt({ id: 'r2', status: 'failed' })],
    });
    assert.match(markup, /<summary>2 development smoke receipts · 1 settled/);
    assert.match(markup, /Real settled transactions from our own tests/);
    // And it is not passed off as a purchase.
    assert.doesNotMatch(markup, /<summary>\d+ purchase/);
  });

  test('a group where everything settled does not print a redundant second count', () => {
    const markup = render({ entries: [receipt(), receipt({ id: 'r2' })] });
    assert.match(markup, /<summary>2 development smoke receipts ·/);
    assert.doesNotMatch(markup, /2 settled/);
  });

  test('a real purchase is its own group and does not inherit the smoke wording', () => {
    const markup = render({
      entries: [receipt({ id: 'p1', category: 'premium_data', actionType: 'x402_call' })],
    });
    assert.match(markup, /<summary>1 purchase</);
    assert.doesNotMatch(markup, /development smoke payments? ·/);
  });

  test('seller-side diagnostics are still not money this account spent', () => {
    const markup = render({
      entries: [receipt({ id: 's1', direction: 'incoming_seller_smoke' })],
    });
    assert.match(markup, /Nothing has been paid for from this account/);
  });
});
