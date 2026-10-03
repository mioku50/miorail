import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { briefFixture } from '../../rwa-market-reality/test/fixtures/stockBrief.js';
import { briefInput, FEED, TOKEN } from '../../rwa-market-reality/test/fixtures/stockBrief.js';
import { stockBriefV1 } from '../../rwa-market-reality/src/stockBrief.js';
import { MyStocksTodayCard } from '../src/console/MyStocksTodayCard';
import { giftRecipientFollowupV1 } from '../src/console/giftView';

test('the personal feed presents one issuer update and keeps compatibility logs inside evidence', () => {
  const transactionHash = `0x${'a'.repeat(64)}`;
  const cards = ['ui_multiplier_updated', 'multiplier_updated', 'announcement'].map((event, i) => ({
    signalId: String(3 - i),
    chainId: 8453 as const,
    kind:
      event === 'announcement'
        ? ('official_asset_corporate_action_announced' as const)
        : ('official_asset_multiplier_changed' as const),
    subjectAddress: TOKEN,
    officialAddress: null,
    subjectTicker: 'NVDAc',
    officialTicker: null,
    occurredAt: '2026-09-30T16:47:47.000Z',
    recordedAt: '2026-09-30T16:59:27.058Z',
    facts: { transactionHash, event, multiplierWad: '1000537939576369481' },
  }));
  const html = renderToStaticMarkup(
    <MyStocksTodayCard
      model={{
        data: stockBriefV1({ ...briefInput(), changes: { ...FEED, cards } }),
        loading: false,
        failed: false,
        refreshing: false,
        returning: true,
        onRefresh() {},
      }}
    />,
  );
  assert.equal((html.match(/NVDAc: Shares per token changed/g) ?? []).length, 1);
  assert.match(html, /1 about stocks you hold\./);
  assert.match(html, /Source records · 3/);
  assert.match(html, /about 1\.00053794/);
  assert.match(html, /The issuer announced a corporate action/);
  assert.match(html, new RegExp(`https://basescan.org/tx/${transactionHash}`));
});

test('a personal holding, estimated dividend and dated reference appear without turning a benchmark into sale proceeds', () => {
  const html = renderToStaticMarkup(
    <MyStocksTodayCard
      model={{
        data: briefFixture(),
        loading: false,
        failed: false,
        refreshing: false,
        returning: true,
        onRefresh() {},
      }}
    />,
  );
  assert.match(html, /My stocks today/);
  assert.match(html, /0\.000882 held/);
  assert.match(html, /Reference value/);
  assert.match(html, /\(estimate\)/);
  assert.match(html, /Unread updates/);
  assert.match(html, /What was measured/);
  assert.doesNotMatch(html, /\$1,000|Cash back|nothing changed/i);
});

test('a delayed personal change links to exact evidence and cannot imply ownership at occurrence', () => {
  const data = briefFixture();
  const token = data.holdings[0]!.tokenAddress;
  data.changes!.cards = [
    {
      signalId: 'late',
      chainId: 8453,
      kind: 'official_asset_multiplier_changed',
      subjectAddress: token,
      subjectTicker: 'NVDAc',
      officialAddress: null,
      officialTicker: null,
      occurredAt: '2026-09-20T10:00:00.000Z',
      recordedAt: '2026-09-30T20:00:00.000Z',
      facts: { multiplierWad: '1050000000000000000' },
    },
  ];
  data.inbox = {
    ...data.inbox,
    reviewToken: 'opaque-review-proof',
    windowBasis: 'recorded_at',
    heldCount: 1,
    watchedCount: 0,
    items: [
      {
        signalId: 'late',
        relation: 'held',
        relatedTokenAddress: token,
        inspectionHref: `/investigate?token=${token}`,
        relatedInspectionHref: null,
      },
    ],
  };
  const model = {
    data,
    loading: false,
    failed: false,
    refreshing: false,
    returning: true,
    onRefresh() {},
    onMarkRead() {},
  };
  const html = renderToStaticMarkup(<MyStocksTodayCard model={model} />);
  assert.match(html, /Your stock/);
  assert.match(html, new RegExp(`href="/investigate\\?token=${token}"`));
  // Ten days late: the reader is told why an old event is new here.
  assert.match(html, /Sep 20, 10:00 AM UTC · seen by Miorail Sep 30/);
  assert.match(html, /does not establish that you held the token/);
  assert.match(html, />Mark as read<\/button>/);
  for (const state of [
    { ...data, changesUnavailable: true },
    { ...data, changesTruncated: true },
  ]) {
    const failed = renderToStaticMarkup(<MyStocksTodayCard model={{ ...model, data: state }} />);
    assert.match(failed, /disabled="">Mark as read<\/button>/);
  }
});

test('an unavailable overview reports a gap, never an empty wallet', () => {
  const html = renderToStaticMarkup(
    <MyStocksTodayCard
      model={{
        data: null,
        loading: false,
        failed: true,
        refreshing: false,
        returning: false,
        onRefresh() {},
      }}
    />,
  );
  assert.match(html, /says nothing about your holdings/);
  assert.doesNotMatch(html, /You hold none/);
});

test('only a verified delivered gift offers recipient continuation, and another wallet cannot enroll from the link', () => {
  const recipient = '0x1111111111111111111111111111111111111111';
  const input = {
    verified: true,
    delivered: true,
    recipient,
    sessionWallet: null,
    stockHref: '/stocks/nvda',
  };
  assert.equal(giftRecipientFollowupV1({ ...input, verified: false }), null);
  assert.equal(giftRecipientFollowupV1({ ...input, delivered: false }), null);
  assert.match(giftRecipientFollowupV1(input)!.href, /^\/signin\?next=/);
  assert.equal(
    giftRecipientFollowupV1({ ...input, sessionWallet: recipient })!.href,
    '/stocks/nvda#my-stocks-today',
  );
  assert.match(giftRecipientFollowupV1(input)!.note, /no claim transaction/);
});
