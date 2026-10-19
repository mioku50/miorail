import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StockShareLinks, stockShareLinksV1 } from '../src/console/StockShareLinks';
import { castFromComposeHrefV1 } from '../src/console/shareHost';
import { MyStocksTodayCard } from '../src/console/MyStocksTodayCard';
import { briefFixture } from '../../rwa-market-reality/test/fixtures/stockBrief.js';

void React;

test('X and Farcaster share the same public stock, without a wallet or quote', () => {
  const links = stockShareLinksV1(' nvda ')!;
  const x = new URL(links.x);
  assert.equal(x.origin + x.pathname, 'https://x.com/intent/tweet');
  assert.equal(x.searchParams.get('url'), 'https://miorail.xyz/stocks/nvda');
  assert.deepEqual(castFromComposeHrefV1(links.farcaster), {
    text: x.searchParams.get('text'), embeds: ['https://miorail.xyz/stocks/nvda'],
  });
  assert.doesNotMatch(x.searchParams.get('text')!, /\$|0x|held|my wallet|buy now/i);
  assert.equal(new URL(stockShareLinksV1('BRK.B')!.x).searchParams.get('url'), 'https://miorail.xyz/stocks/brk.b');
});

test('an unselected or invalid symbol has no share links', () => {
  for (const symbol of [null, '', '../today', 'NVDA?wallet=private', 'https://example.com', 'ABCDEFGHIJKLMNOPQ']) {
    assert.equal(stockShareLinksV1(symbol), null);
    assert.equal(renderToStaticMarkup(<StockShareLinks symbol={symbol} />), '');
  }
});

test('both composer buttons are ordinary safe links, available without a session', () => {
  const html = renderToStaticMarkup(<StockShareLinks symbol="NVDA" />);
  assert.match(html, /aria-label="Share NVDA stock card"/);
  assert.match(html, />Post on X<\/a>/);
  assert.match(html, />Cast on Farcaster<\/a>/);
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) ?? []).length, 2);
});

test('folded, both places to post sit behind one Share; open is the default', () => {
  const folded = renderToStaticMarkup(<StockShareLinks symbol="NVDA" folded />);
  assert.match(folded, /^<details class="share-fold"><summary class="btn sec">Share<\/summary><div [^>]*aria-label="Share NVDA stock card"/);
  assert.match(folded, />Post on X<\/a>/);
  assert.match(folded, />Cast on Farcaster<\/a>/);
  assert.doesNotMatch(renderToStaticMarkup(<StockShareLinks symbol="NVDA" />), /<details|<summary/);
});

test('the My stocks holding exposes the public card, not its position', () => {
  const data = briefFixture();
  const html = renderToStaticMarkup(<MyStocksTodayCard model={{ data, loading: false, failed: false,
    refreshing: false, returning: true, onRefresh() {} }} />);
  assert.match(html, /aria-label="Share NVDA stock card"/);
  const links = [...html.matchAll(/href="(https:\/\/(?:x.com|farcaster.xyz)[^"]+)"/g)];
  assert.equal(links.length, 2);
  for (const [, href] of links) {
    const decoded = decodeURIComponent(href!.replaceAll('&amp;', '&'));
    assert.doesNotMatch(decoded, new RegExp(data.holdings[0]!.tokenAddress, 'i'));
    assert.ok(!decoded.includes(data.holdings[0]!.tokens));
  }
});
