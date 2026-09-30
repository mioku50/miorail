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
  assert.match(html, /Since your last visit/);
  assert.match(html, /What was measured/);
  assert.doesNotMatch(html, /\$1,000|Cash back|nothing changed/i);
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
