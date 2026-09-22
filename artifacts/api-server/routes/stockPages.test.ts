import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';

import {
  renderStockPageHtmlV1,
  resetStockPagesPreviewCacheV1,
  resetStockPagesTemplateV1,
  stockPageMetaV1,
  stockPagesRouter,
  stockPagesRuntime,
  type StockPageEntryV1,
} from './stockPages.js';

const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Miorail</title>
    <meta name="description" content="Miorail shows the reality behind tokenized assets." />
  </head>
  <body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body>
</html>
`;

const NOW = new Date('2026-09-23T12:00:00.000Z');

const NVDA: StockPageEntryV1 = {
  symbol: 'NVDA',
  companyName: 'NVIDIA',
  underlyingKey: 'security:isin:US67066G1040',
  coinbaseIssued: true,
};

function appV1() {
  const app = express();
  // The API app's own security middleware, so the test sees the headers the
  // page would actually leave with.
  app.use(helmet());
  app.use(stockPagesRouter);
  return app;
}

function stubV1(t: test.TestContext, over: Partial<typeof stockPagesRuntime> = {}) {
  const saved = { ...stockPagesRuntime };
  const asked: string[] = [];
  Object.assign(stockPagesRuntime, {
    enabled: () => true,
    indexHtmlPath: () => '/srv/index.html',
    origin: () => 'https://miorail.xyz',
    stat: async () => ({ mtimeMs: 1 }) as never,
    readFile: async () => TEMPLATE,
    stocks: async () => [
      NVDA,
      { symbol: 'AAPL', companyName: 'Apple Inc.', underlyingKey: 'security:isin:US0378331005', coinbaseIssued: true },
      { symbol: 'GME', companyName: 'GameStop', underlyingKey: 'security:isin:US36467W1099', coinbaseIssued: false },
    ],
    roundTrip: async (key: string) => {
      asked.push(key);
      return { roundTripCostBps: '11', observedAt: '2026-09-23T10:00:00.000Z' };
    },
    now: () => NOW,
    ...over,
  });
  resetStockPagesTemplateV1();
  resetStockPagesPreviewCacheV1();
  t.after(() => {
    Object.assign(stockPagesRuntime, saved);
    resetStockPagesTemplateV1();
    resetStockPagesPreviewCacheV1();
  });
  return asked;
}

test('a stock page is the app, with a head that names the stock and dates its number', async (t) => {
  const asked = stubV1(t);
  const response = await request(appV1()).get('/stocks/nvda').expect(200);
  const html = response.text;
  assert.deepEqual(asked, ['security:isin:US67066G1040']);
  assert.match(html, /<title>NVIDIA \(NVDA\) on Base · Miorail<\/title>/);
  assert.match(html, /Round trip at \$1,000: 0\.11%, measured 2 h ago\./);
  assert.match(html, /<link rel="canonical" href="https:\/\/miorail\.xyz\/stocks\/nvda" \/>/);
  assert.match(html, /property="og:image" content="https:\/\/miorail\.xyz\/og-stocks\.png"/);
  // The app still boots: the body is the static document's, untouched.
  assert.match(html, /<script type="module" src="\/assets\/index-abc\.js"><\/script>/);
  // Exactly one title and one description — an unfurler meeting two picks one.
  assert.equal(html.match(/<title>/g)?.length, 1);
  assert.equal(html.match(/name="description"/g)?.length, 1);
});

test('the document leaves with the static server’s rules, not the API’s', async (t) => {
  stubV1(t);
  const response = await request(appV1()).get('/stocks/nvda').expect(200);
  // Helmet's CSP would block the wallet connectors and fonts the page loads;
  // nginx has never sent one with this file.
  assert.equal(response.headers['content-security-policy'], undefined);
  assert.equal(response.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.match(String(response.headers['cache-control']), /no-cache/);
  assert.match(String(response.headers['content-type']), /text\/html/);
});

test('a number without a recent clock does not go out at all', async (t) => {
  stubV1(t, {
    roundTrip: async () => ({ roundTripCostBps: '11', observedAt: '2026-09-10T10:00:00.000Z' }),
  });
  const html = (await request(appV1()).get('/stocks/nvda').expect(200)).text;
  assert.doesNotMatch(html, /Round trip at/);
  assert.match(html, /No wallet needed to look\./);
});

test('a round trip that cannot be read is a preview without a number, not a failed page', async (t) => {
  stubV1(t, {
    roundTrip: async () => {
      throw new Error('database said no');
    },
  });
  const html = (await request(appV1()).get('/stocks/nvda').expect(200)).text;
  assert.match(html, /<title>NVIDIA \(NVDA\) on Base · Miorail<\/title>/);
  assert.doesNotMatch(html, /Round trip at/);
});

test('an unknown ticker is a real answer: the app, a 404 and a noindex head', async (t) => {
  const asked = stubV1(t);
  const response = await request(appV1()).get('/stocks/zzzz').expect(404);
  assert.match(response.text, /<meta name="robots" content="noindex" \/>/);
  assert.match(response.text, /statement about Miorail’s corpus/);
  assert.doesNotMatch(response.text, /rel="canonical"/);
  assert.deepEqual(asked, []);
});

test('whatever the corpus says is escaped, never executed', async () => {
  const html = renderStockPageHtmlV1(
    TEMPLATE,
    stockPageMetaV1({
      origin: 'https://miorail.xyz',
      entry: { ...NVDA, companyName: '</title><script>alert(1)</script>' },
      roundTrip: null,
      now: NOW,
    }),
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a ticker-only row is titled by its ticker alone, never "NVDA (NVDA)"', () => {
  const meta = stockPageMetaV1({
    origin: 'https://miorail.xyz',
    entry: { ...NVDA, symbol: 'MSTR', companyName: null },
    roundTrip: null,
    now: NOW,
  });
  assert.equal(meta.title, 'MSTR on Base · Miorail');
});

test('without the template this answers 503, so nginx serves the static file', async (t) => {
  stubV1(t, {
    stat: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  });
  await request(appV1()).get('/stocks/nvda').expect(503);
  await request(appV1()).get('/stocks').expect(503);
});

test('the list page has its own head', async (t) => {
  stubV1(t);
  const html = (await request(appV1()).get('/stocks').expect(200)).text;
  assert.match(html, /<title>Tokenized stocks on Base, measured · Miorail<\/title>/);
  assert.match(html, /href="https:\/\/miorail\.xyz\/stocks"/);
});

test('the sitemap lists the Coinbase-issued stock pages and the fixed pages', async (t) => {
  stubV1(t);
  const response = await request(appV1()).get('/sitemap.xml').expect(200);
  assert.match(String(response.headers['content-type']), /application\/xml/);
  const locs = [...response.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locs, [
    'https://miorail.xyz/stocks',
    'https://miorail.xyz/stocks/aapl',
    'https://miorail.xyz/stocks/nvda',
    'https://miorail.xyz/is-it-real',
  ]);
});

test('a sitemap whose corpus will not answer still lists the fixed pages', async (t) => {
  stubV1(t, {
    stocks: async () => {
      throw new Error('no database');
    },
  });
  const response = await request(appV1()).get('/sitemap.xml').expect(200);
  assert.equal([...response.text.matchAll(/<loc>/g)].length, 2);
});

test('a burst of unfurls reads the ladder once', async (t) => {
  const asked = stubV1(t);
  const app = appV1();
  await Promise.all([
    request(app).get('/stocks/nvda').expect(200),
    request(app).get('/stocks/nvda').expect(200),
    request(app).get('/stocks/NVDA').expect(200),
  ]);
  assert.deepEqual(asked, ['security:isin:US67066G1040']);
});
