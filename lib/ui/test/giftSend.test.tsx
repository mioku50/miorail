import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  GIFT_SEND_NOT_VERIFIED_V1,
  giftBannerV1,
  giftDefaultModeV1,
  giftFromHistoryStateV1,
  giftSendAmountV1,
  giftSendHonestyViewV1,
  giftSendNoticeV1,
  giftSendValueV1,
  publicGiftPageViewV1,
  reviewCallRowsV1,
  usdcCentsLabelV1,
  type GiftHoldingV1,
  type PublicGiftLikeV1,
} from '../src/console/giftView';
import { ReviewScreen } from '../src/console/ConsoleScreens';
import { GiftForm } from '../src/console/MarketRealityScreen';

// ---------------------------------------------------------------------------
// A gift from what the wallet already holds: the form reads the holding first,
// gives from it in the stock's own units, and every screen after says that
// nothing was bought.
// ---------------------------------------------------------------------------

const definedConsoleClasses = new Set(
  readFileSync(new URL('../src/console/console.css', import.meta.url), 'utf8')
    .match(/\.[A-Za-z][A-Za-z0-9_-]*/g)
    ?.map((selector) => selector.slice(1)) ?? [],
);

function undefinedClasses(html: string): string[] {
  const used = [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) => match[1]!.split(/\s+/).filter(Boolean));
  return [...new Set(used)].filter((name) => !definedConsoleClasses.has(name));
}

const GIVER = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const FRIEND = '0x8e525bfce1c0ffee00000000000000000000beef';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const HELD: Extract<GiftHoldingV1, { status: 'held' }> = {
  status: 'held',
  symbol: 'NVDAc',
  decimals: 8,
  balanceAtomic: '44227',
  // What all of it fetches: a little under the 0.1 USDC it cost.
  valueUsdcAtomic: '98765',
};

describe('the handoff to the Routes console', () => {
  test('a send travels in history state, whole, or not at all', () => {
    const state = {
      gift: {
        recipient: FRIEND,
        recipientName: 'friend.base.eth',
        send: { tokenAddress: NVDA, amountAtomic: '44227', symbol: 'NVDAc', decimals: 8 },
      },
    };
    assert.deepEqual(giftFromHistoryStateV1(state), {
      recipient: FRIEND,
      recipientName: 'friend.base.eth',
      send: { tokenAddress: NVDA, amountAtomic: '44227', symbol: 'NVDAc', decimals: 8 },
    });
    // A bought gift is unchanged.
    assert.deepEqual(giftFromHistoryStateV1({ gift: { recipient: FRIEND, recipientName: null } }), {
      recipient: FRIEND,
      recipientName: null,
    });
    // A malformed send is no gift — never a purchase in its place.
    for (const send of [
      { tokenAddress: 'nvda', amountAtomic: '44227', symbol: 'NVDAc', decimals: 8 },
      { tokenAddress: NVDA, amountAtomic: '0', symbol: 'NVDAc', decimals: 8 },
      { tokenAddress: NVDA, amountAtomic: '1.5', symbol: 'NVDAc', decimals: 8 },
      { tokenAddress: NVDA, amountAtomic: '44227', symbol: '', decimals: 8 },
      { tokenAddress: NVDA, amountAtomic: '44227', symbol: 'NVDAc', decimals: 99 },
      'send',
    ]) {
      assert.equal(giftFromHistoryStateV1({ gift: { recipient: FRIEND, recipientName: null, send } }), null, JSON.stringify(send));
    }
  });

  test('the banner says it comes from what the wallet holds, and that nothing is bought', () => {
    const banner = giftBannerV1({
      gift: { recipient: FRIEND, recipientName: 'friend.base.eth', send: { tokenAddress: NVDA, amountAtomic: '44227', symbol: 'NVDAc', decimals: 8 } },
      missing: false,
    });
    assert.equal(banner?.title, 'Gift to friend.base.eth');
    assert.match(banner?.detail ?? '', /receives exactly 0\.00044227 NVDAc from what your wallet already holds/);
    assert.match(banner?.detail ?? '', /Nothing is bought or swapped/);
    assert.doesNotMatch(banner?.detail ?? '', /guaranteed minimum/);
  });
});

describe('the form', () => {
  test('an amount is read in the stock’s own units, exactly, and valued pro rata', () => {
    const all = giftSendAmountV1({ text: '0.00044227', holding: HELD });
    assert.deepEqual(all, { status: 'ready', atomic: '44227', label: '0.00044227', valueLabel: '$0.09' });
    const comma = giftSendAmountV1({ text: '0,0004', holding: { ...HELD, valueUsdcAtomic: '1000000' } });
    assert.equal(comma.status, 'ready');
    const tooPrecise = giftSendAmountV1({ text: '0.000442271', holding: HELD });
    assert.equal(tooPrecise.status, 'too_precise');
    const more = giftSendAmountV1({ text: '0.00044228', holding: HELD });
    assert.equal(more.status, 'over_balance');
    if (more.status === 'over_balance') assert.match(more.message, /holds 0\.00044227 NVDAc\. Give less, or buy the gift with USDC/);
    assert.equal(giftSendAmountV1({ text: '', holding: HELD }).status, 'empty');
    assert.equal(giftSendAmountV1({ text: '0', holding: HELD }).status, 'zero');
  });

  test('the range is by what it fetches: $0.05 to $100, and an unpriced holding is left to the server', () => {
    const small = giftSendAmountV1({ text: '0.0002', holding: HELD });
    assert.equal(small.status, 'below_minimum');
    if (small.status === 'below_minimum') assert.match(small.message, /at least \$0\.05; 0\.0002 NVDAc fetches about \$0\.04/);
    const large = giftSendAmountV1({ text: '1', holding: { ...HELD, balanceAtomic: '100000000', valueUsdcAtomic: '226000000' } });
    assert.equal(large.status, 'above_maximum');
    const unpriced = giftSendAmountV1({ text: '0.0002', holding: { ...HELD, valueUsdcAtomic: null } });
    assert.deepEqual(unpriced, { status: 'ready', atomic: '20000', label: '0.0002', valueLabel: null });
    assert.equal(giftSendValueV1({ amountAtomic: '22113', balanceAtomic: '44227', valueUsdcAtomic: '98765' }), '49381');
    assert.equal(usdcCentsLabelV1('98765'), '$0.09');
    assert.equal(usdcCentsLabelV1('100000000'), '$100.00');
  });

  test('it gives from the holding by default, unless the whole holding is too small to give', () => {
    assert.equal(giftDefaultModeV1(HELD), 'send');
    assert.equal(giftDefaultModeV1({ ...HELD, valueUsdcAtomic: null }), 'send');
    assert.equal(giftDefaultModeV1({ ...HELD, valueUsdcAtomic: '49999' }), 'buy');
    assert.equal(giftDefaultModeV1({ status: 'none', symbol: 'NVDAc', decimals: 8 }), 'buy');
    assert.equal(giftDefaultModeV1({ status: 'unavailable', message: 'x' }), 'buy');
    assert.equal(giftDefaultModeV1(null), 'buy');
  });

  test('before the holding is read it says so, with console classes only', () => {
    const html = renderToStaticMarkup(
      <GiftForm onSubmit={async () => null} onCancel={() => undefined} loadHolding={() => new Promise(() => undefined)} />,
    );
    assert.match(html, /Reading what your wallet holds of this stock/);
    assert.deepEqual(undefinedClasses(html), []);
  });
});

describe('the review of one transfer', () => {
  const CALL = {
    callType: 'transfer',
    to: NVDA,
    spender: null,
    recipient: FRIEND,
    amountAtomic: '44227',
    asset: { symbol: 'NVDAc', decimals: 8 },
  };

  test('the one call is named as the gift from holdings, with no swap to refer to', () => {
    const rows = reviewCallRowsV1({ calls: [CALL], quoteExpiry: '2026-09-24T12:05:00.000Z', recipientName: 'friend.base.eth' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.title, 'Send exactly 0.00044227 NVDAc to friend.base.eth');
    assert.match(rows[0]!.detail, /from what your wallet already holds\. It is the only call: nothing is bought or swapped/);
    assert.doesNotMatch(rows[0]!.detail, /swap above/);
  });

  test('what was checked is the send’s own list, not a purchase’s', () => {
    const view = giftSendHonestyViewV1({
      token: { address: NVDA, symbol: 'NVDAc', decimals: 8 },
      recipient: FRIEND,
      recipientName: 'friend.base.eth',
      safetyChecks: [
        { id: 'send_reviewed_stock', description: 'reviewed', status: 'passed', detail: null },
        { id: 'send_calldata_exact', description: 'calldata', status: 'passed', detail: null },
        { id: 'send_balance', description: 'balance', status: 'passed', detail: null },
      ],
      simulation: { state: 'passed' },
    });
    assert.deepEqual(
      view.verified.map((fact) => fact.label),
      ['You give', 'They receive', 'Calldata', 'Balance', 'Token security', 'Simulation'],
    );
    assert.match(view.verified[1]!.detail, /friend\.base\.eth, resolved again just before this review/);
    assert.match(view.verified[4]!.detail, /nothing is bought, so no token-risk provider was queried/);
    assert.deepEqual(view.notVerified, [...GIFT_SEND_NOT_VERIFIED_V1]);
    assert.ok(view.notVerified.every((line) => !/pool|liquidity/i.test(line)), 'a purchase’s unknowns are not a transfer’s');
  });

  test('an expired or refused send is worded as a transfer, and the buttons say what they do', () => {
    assert.deepEqual(giftSendNoticeV1({ outcome: 'refresh_required', detail: 'Start it again.' }), {
      title: 'This gift’s review expired',
      detail: 'Start it again.',
      canCompareAgain: true,
    });
    assert.equal(giftSendNoticeV1({ outcome: 'unsupported', reason: 'gift_refused', detail: 'x' })?.title, 'Miorail cannot send this gift');
    const html = renderToStaticMarkup(
      <ReviewScreen
        steps={[]}
        calls={[]}
        simulation={{ available: false, passed: false, canSign: false, headline: 'x', detail: null, subLabel: 'not run' } as never}
        balanceChanges={[]}
        balanceUnavailableReason={null}
        checks={[]}
        limits={[]}
        onLimitChange={() => undefined}
        onApprove={() => undefined}
        onBack={() => undefined}
        approvePending={false}
        notice={{ title: 'This gift’s review expired', detail: 'Start it again.', canCompareAgain: true }}
        onCompareAgain={() => undefined}
        compareAgainLabel="Prepare it again"
        backLabel="Back to the stock"
      />,
    );
    assert.match(html, /Prepare it again/);
    assert.match(html, /Back to the stock/);
    assert.doesNotMatch(html, /Compare again|Back to routes/);
  });
});

describe('the public gift page', () => {
  test('a gift from holdings says nothing was bought, and shows no purchase', () => {
    const gift: PublicGiftLikeV1 = {
      giver: GIVER,
      recipient: FRIEND,
      amountAtomic: '44227',
      token: { address: NVDA, symbol: 'NVDAc', decimals: 8 },
      finalStatus: 'completed',
      delivered: true,
      transactionHash: `0x${'1'.repeat(64)}`,
      source: 'held',
      paid: null,
      issuedAt: '2026-09-24T12:00:00.000Z',
    };
    const view = publicGiftPageViewV1({ publicId: 'b'.repeat(48), origin: 'https://miorail.xyz', gift, labels: null, verified: true });
    assert.match(view.note, /received exactly 0\.00044227 NVDAc, sent from 0x4de2…0d70’s own holdings in one transfer\. Nothing was bought for it\./);
    assert.ok(!view.rows.some((row) => row.label === 'Paid for the purchase'));
    assert.doesNotMatch(view.note, /guaranteed minimum/);
  });
});
