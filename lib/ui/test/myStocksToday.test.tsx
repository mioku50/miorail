import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { briefFixture } from '../../rwa-market-reality/test/fixtures/stockBrief.js';
import { MyStocksTodayCard } from '../src/console/MyStocksTodayCard';
import { giftRecipientFollowupV1 } from '../src/console/giftView';

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
  assert.match(html, /Since you last marked as read/);
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
  assert.match(html, /Related to your holdings/);
  assert.match(html, new RegExp(`href="/investigate\\?token=${token}"`));
  assert.match(html, /Occurred Sep 20/);
  assert.match(html, /recorded Sep 30/);
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
