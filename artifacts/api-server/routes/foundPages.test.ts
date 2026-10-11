import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';
import type { FoundShareV1 } from '@mioagent/route-storage';

import { foundPagesRouter, foundPagesRuntime, publicFoundRouter } from './foundPages.js';
import { resetStockPagesTemplateV1, stockPagesRuntime } from './stockPages.js';

const original = { ...foundPagesRuntime };
const originalStock = { ...stockPagesRuntime };
afterEach(() => {
  Object.assign(foundPagesRuntime, original);
  Object.assign(stockPagesRuntime, originalStock);
  resetStockPagesTemplateV1();
});

const CARD: FoundShareV1 = { code: 'AbCdEfGhIjKl', receiptId: 'base-mcp-action:x', protocol: 'uniswap', usdCents: 1_153,
  tokens: [{ symbol: 'WETH', amount: '0.0042' }, { symbol: 'USDC', amount: '1.53' }], blockNumber: '37123456',
  createdAt: '2026-10-11T22:00:00.000Z' };

function app() {
  stockPagesRuntime.indexHtmlPath = () => '/virtual/index.html';
  stockPagesRuntime.stat = (async () => ({ mtimeMs: 1 })) as never;
  stockPagesRuntime.readFile = (async () => '<html><head><title>Miorail</title><meta name="description" content="x"></head><body></body></html>') as never;
  stockPagesRuntime.origin = () => 'https://miorail.xyz';
  foundPagesRuntime.card = async (code) => (code === CARD.code ? CARD : null);
  const server = express();
  server.use(foundPagesRouter);
  server.use('/api/public', publicFoundRouter);
  return server;
}

test('a card’s page carries its own head: the amount, its picture and a Farcaster embed', async () => {
  const page = await request(app()).get(`/found/${CARD.code}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>\$11\.53 in Uniswap fees, found with Miorail<\/title>/);
  assert.match(page.text, /property="og:image" content="https:\/\/miorail\.xyz\/found\/AbCdEfGhIjKl\.png"/);
  assert.match(page.text, /name="robots" content="noindex"/);
  assert.match(page.text, /name="fc:miniapp" content="[^"]*found\/AbCdEfGhIjKl-3x2\.png[^"]*Check yours/);
  assert.doesNotMatch(page.text, /0x[0-9a-f]{40}/i);
});

test('an unknown or malformed code is a real 404 with the app and a noindex head', async () => {
  for (const path of ['/found/ZZZZZZZZZZZZ', '/found/not-a-code', '/found/ZZZZZZZZZZZZ.png']) {
    const res = await request(app()).get(path);
    assert.equal(res.status, 404, path);
  }
  assert.match((await request(app()).get('/found/ZZZZZZZZZZZZ')).text, /<title>Card not found · Miorail<\/title>/);
});

test('the picture is a PNG in both shapes, held a day', async () => {
  const server = app();
  const drawn: string[] = [];
  foundPagesRuntime.renderPng = async (svg: string) => { drawn.push(svg); return new Uint8Array([137, 80, 78, 71]); };
  for (const [path, height] of [[`/found/${CARD.code}.png`, '630'], [`/found/${CARD.code}-3x2.png`, '800']] as const) {
    const res = await request(server).get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['cache-control'], 'public, max-age=86400');
    assert.match(drawn.at(-1)!, new RegExp(`height="${height}"`));
  }
  foundPagesRuntime.renderPng = async () => { throw new Error('wasm'); };
  const fallback = await request(server).get(`/found/${CARD.code}.png`);
  assert.equal(fallback.status, 302);
  assert.equal(fallback.headers.location, 'https://miorail.xyz/og-stocks.png');
});

test('the public figures are what the picture shows, nothing more', async () => {
  const res = await request(app()).get(`/api/public/found/${CARD.code}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['blockNumber', 'code', 'createdAt', 'protocol', 'text', 'tokens', 'usdCents']);
  assert.equal(res.body.text, 'Collected $11.53 in Uniswap fees that were sitting in my wallet. Found with Miorail.');
  assert.equal((await request(app()).get('/api/public/found/ZZZZZZZZZZZZ')).status, 404);
});
