import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';
import { InMemoryRateLimiter } from '@mioagent/utils';
import { computeMirror, type MirrorOutcome, type MirrorService } from '@mioagent/still-engine';

import { EXAMPLE, calendar, snapshot, universe } from '../../../lib/still-engine/test/fixtures.js';
import { renderCardPngV1 } from '../lib/cardImage.js';
import { stillBrandCardSvgV1 } from '../lib/stillCard.js';
import { issueStillSpendShareV1 } from '../lib/stillSpendShare.js';
import { stillPagesRouter, stillPagesRuntimeV1 } from './stillPages.js';
import { publicStillRouter, publicStillRuntimeV1, resetStillCardCachesV1 } from './stillPublic.js';
import { resetStockPagesTemplateV1, stockPagesRuntime } from './stockPages.js';

// The static document already carries Still's default preview: a page with a
// head of its own must replace it, not sit beside it.
const TEMPLATE = `<!doctype html><html><head>
    <title>Still · Spend without selling</title>
    <meta name="description" content="default" />
    <meta property="og:image" content="https://stills.lat/og-still.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="fc:miniapp" content='{"version":"1"}' />
  </head><body><div id="root"></div></body></html>`;

const NAME = 'example.base.eth';
const ADDRESS = `0x${'1'.repeat(40)}`;
const report = () =>
  computeMirror({
    universe: universe(),
    snapshot: snapshot(EXAMPLE),
    calendar: calendar(),
    subject: { address: ADDRESS as `0x${string}`, name: NAME, input: NAME },
    assembledAt: new Date('2026-10-21T15:00:01Z'),
  });

const saved = { stock: { ...stockPagesRuntime }, still: { ...publicStillRuntimeV1 }, pages: { ...stillPagesRuntimeV1 } };
afterEach(() => {
  Object.assign(stockPagesRuntime, saved.stock);
  Object.assign(publicStillRuntimeV1, saved.still);
  Object.assign(stillPagesRuntimeV1, saved.pages);
  resetStockPagesTemplateV1();
  resetStillCardCachesV1();
});

function app(answer: (input: string) => Promise<MirrorOutcome>) {
  const drawn: string[] = [];
  const service: MirrorService = {
    check: answer,
    reading: async () => assert.fail('a public link reads by check'),
    earnings: async () => ({ ok: false }),
  };
  Object.assign(stockPagesRuntime, {
    origin: () => 'https://miorail.xyz',
    indexHtmlPath: () => '/srv/index.html',
    stat: async () => ({ mtimeMs: 1 }) as never,
    readFile: async () => TEMPLATE,
  });
  Object.assign(publicStillRuntimeV1, {
    service: () => service,
    limiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 30 }),
    now: () => new Date('2026-10-21T15:00:01Z'),
    // The picture's words, not its pixels: what it says is what is tested.
    renderPng: async (svg: string) => {
      drawn.push(svg);
      return new TextEncoder().encode(svg);
    },
  });
  resetStockPagesTemplateV1();
  resetStillCardCachesV1();
  const server = express();
  server.use('/api/public/still', publicStillRouter);
  server.use(stillPagesRouter);
  return { server, drawn };
}

const metaContent = (html: string, key: string) =>
  [...html.matchAll(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`, 'g'))].map((m) => m[1]!.replace(/&amp;/g, '&').replace(/&quot;/g, '"'));

test('a wallet link on stills.lat previews with its modelled room and its own card', async () => {
  const { server } = app(async () => ({ outcome: 'report', report: report(), cached: false }));
  const res = await request(server).get(`/w/${NAME}`).set('Host', 'stills.lat');
  assert.equal(res.status, 200);
  assert.match(res.text, /<title>example\.base\.eth: \$784\.62 modelled borrowing room · Still<\/title>/);
  assert.deepEqual(metaContent(res.text, 'og:image'), ['https://stills.lat/api/public/still/card.png?subject=example.base.eth']);
  assert.deepEqual(metaContent(res.text, 'twitter:card'), ['summary_large_image']);
  assert.deepEqual(metaContent(res.text, 'og:site_name'), ['Still']);
  assert.deepEqual(metaContent(res.text, 'og:url'), ['https://stills.lat/w/example.base.eth']);
  assert.match(metaContent(res.text, 'description')[0]!, /^Read from Base at block 53,000,000\./);
  // A cast opens the page inside Farcaster on the domain the mini app is registered for.
  const embed = JSON.parse(metaContent(res.text, 'fc:miniapp')[0]!);
  assert.equal(embed.imageUrl, 'https://stills.lat/api/public/still/card.png?subject=example.base.eth&shape=tall');
  assert.equal(embed.button.title, 'Check on Still');
  assert.equal(embed.button.action.url, 'https://miorail.xyz/w/example.base.eth');
  // The same link on miorail.xyz names miorail.xyz.
  const there = await request(server).get(`/w/${NAME}`).set('Host', 'miorail.xyz');
  assert.deepEqual(metaContent(there.text, 'og:url'), ['https://miorail.xyz/w/example.base.eth']);
});

test('a name nobody uses keeps its 404, with Still’s own picture', async () => {
  const { server } = app(async (input) => ({ outcome: 'name_not_found', input, name: input }));
  const res = await request(server).get('/w/nobody.base.eth').set('Host', 'stills.lat');
  assert.equal(res.status, 404);
  assert.deepEqual(metaContent(res.text, 'og:image'), ['https://stills.lat/og-still.png']);
  assert.deepEqual(metaContent(res.text, 'robots'), ['noindex']);
});

test('a chain slower than the head goes without the number, never with a guess', async () => {
  stillPagesRuntimeV1.headBudgetMs = 20;
  const { server } = app(() => new Promise(() => {}));
  const res = await request(server).get(`/w/${ADDRESS}`).set('Host', 'stills.lat');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`<title>${ADDRESS} · Still</title>`));
  assert.doesNotMatch(res.text, /\$\d/);
  assert.deepEqual(metaContent(res.text, 'og:image'), [`https://stills.lat/api/public/still/card.png?subject=${ADDRESS}`]);
});

test('the card is the wallet’s check, kept ten minutes, and Still’s own picture when it cannot be read', async () => {
  let calls = 0;
  const { server, drawn } = app(async () => {
    calls += 1;
    return { outcome: 'report', report: report(), cached: false };
  });
  const wide = await request(server).get('/api/public/still/card.png').query({ subject: NAME });
  assert.equal(wide.status, 200);
  assert.match(wide.headers['content-type'], /^image\/png/);
  assert.equal(wide.headers['cache-control'], 'public, max-age=600');
  assert.match(drawn[0]!, /width="1200" height="630"/);
  assert.match(drawn[0]!, /EXAMPLE\.BASE\.ETH · MODELLED ROOM/);
  assert.match(drawn[0]!, /\$784/);
  await request(server).get('/api/public/still/card.png').query({ subject: NAME });
  assert.equal(calls, 1);
  const tall = await request(server).get('/api/public/still/card.png').query({ subject: NAME, shape: 'tall' });
  assert.equal(tall.status, 200);
  assert.match(drawn.at(-1)!, /width="1200" height="800"/);

  const unread = app(async () => ({ outcome: 'chain_unavailable', attempts: [] }));
  const fallback = await request(unread.server).get('/api/public/still/card.png').query({ subject: NAME });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers['cache-control'], 'public, max-age=60');
  assert.match(unread.drawn[0]!, /Spend without/);
  assert.doesNotMatch(unread.drawn[0]!, /\$\d/);
});

test('the brand card renders with Still’s own font files', async () => {
  const png = await renderCardPngV1(stillBrandCardSvgV1('wide'));
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Jost is in the font list: a missing face would fall back silently to Inter.
  assert.match(stillBrandCardSvgV1('wide'), /font-family="Jost\*, Inter, sans-serif"/);
});

const SHARE_SECRET = 'spend-share-fixture-secret-never-production';
const PUBG = { productName: 'PUBG Mobile UC International', packageLabel: '10 UC', priceAtomic: '180000', collateral: 'NVDAc', venue: 'aave-v4' } as const;

test('a shared purchase previews with its own card, and reads and names no wallet', async () => {
  const { server, drawn } = app(async () => assert.fail('a purchase link reads no wallet'));
  publicStillRuntimeV1.secret = () => SHARE_SECRET;
  const token = issueStillSpendShareV1(PUBG, SHARE_SECRET);
  const res = await request(server).get(`/spend/p/${token}`).set('Host', 'stills.lat');
  assert.equal(res.status, 200);
  assert.match(res.text, /<title>Paid with a loan: PUBG Mobile UC International · Still<\/title>/);
  assert.deepEqual(metaContent(res.text, 'og:image'), [`https://stills.lat/api/public/still/spend-card.png?t=${token}`]);
  assert.deepEqual(metaContent(res.text, 'og:url'), [`https://stills.lat/spend/p/${token}`]);
  assert.deepEqual(metaContent(res.text, 'robots'), ['noindex']);
  assert.match(metaContent(res.text, 'description')[0]!, /^10 UC for 0\.18 USDC, borrowed against NVDA through Aave and paid to Bitrefill/);
  const embed = JSON.parse(metaContent(res.text, 'fc:miniapp')[0]!);
  assert.equal(embed.imageUrl, `https://stills.lat/api/public/still/spend-card.png?t=${token}&shape=tall`);
  assert.equal(embed.button.action.url, `https://miorail.xyz/spend/p/${token}`);

  const wide = await request(server).get('/api/public/still/spend-card.png').query({ t: token });
  assert.equal(wide.status, 200);
  assert.match(wide.headers['content-type'], /^image\/png/);
  assert.equal(wide.headers['cache-control'], 'public, max-age=86400');
  const svg = drawn.at(-1)!;
  assert.match(svg, /width="1200" height="630"/);
  assert.match(svg, /PAID WITH A LOAN · NOTHING SOLD/);
  assert.match(svg, /PUBG Mobile UC/);
  assert.match(svg, /0\.18 USDC/);
  assert.match(svg, /Borrowed against NVDA through Aave/);
  assert.doesNotMatch(svg, /0x[0-9a-fA-F]{6}/);
  const tall = await request(server).get('/api/public/still/spend-card.png').query({ t: token, shape: 'tall' });
  assert.equal(tall.status, 200);
  assert.match(drawn.at(-1)!, /width="1200" height="800"/);

  const words = await request(server).get('/api/public/still/spend-share').query({ t: token });
  assert.equal(words.status, 200);
  assert.deepEqual(words.body, { outcome: 'share', share: { productName: 'PUBG Mobile UC International', packageLabel: '10 UC', priceUsdc: '0.18',
    collateralLabel: 'NVDA', collateralName: 'NVIDIA stock', venueName: 'Aave' } });
});

test('a purchase link Still did not sign keeps its 404, and its card says nothing about it', async () => {
  const { server, drawn } = app(async () => assert.fail('a purchase link reads no wallet'));
  publicStillRuntimeV1.secret = () => SHARE_SECRET;
  const forged = issueStillSpendShareV1({ ...PUBG, productName: 'A yacht' }, `${SHARE_SECRET}-someone-else`);
  const res = await request(server).get(`/spend/p/${forged}`).set('Host', 'stills.lat');
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.text, /yacht/);
  assert.deepEqual(metaContent(res.text, 'og:image'), ['https://stills.lat/og-still.png']);
  const card = await request(server).get('/api/public/still/spend-card.png').query({ t: forged });
  assert.equal(card.status, 200);
  assert.equal(card.headers['cache-control'], 'public, max-age=60');
  assert.match(drawn.at(-1)!, /Spend without/);
  assert.doesNotMatch(drawn.at(-1)!, /yacht/);
  const words = await request(server).get('/api/public/still/spend-share').query({ t: forged });
  assert.equal(words.status, 404);
  assert.deepEqual(words.body, { outcome: 'share_invalid' });
});
