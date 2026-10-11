import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { giftShareLinksV1 } from '../src/console/giftView';
import {
  ShareHostProviderV1,
  ShareLinkV1,
  castFromComposeHrefV1,
  shareClickV1,
  type ShareCastV1,
  type ShareHostV1,
} from '../src/console/shareHost';

void React;

const URL_V1 = 'https://miorail.xyz/stocks?weekend=20261010T2140Z';
const TEXT_V1 = 'The weekend on Base: NVDA +0.4% against Friday’s close & more';

function hostV1(over: Partial<ShareHostV1> = {}) {
  const casts: ShareCastV1[] = [];
  const opened: string[] = [];
  const host: ShareHostV1 = {
    composeCast: async (cast) => {
      casts.push(cast);
    },
    openUrl: async (url) => {
      opened.push(url);
    },
    ...over,
  };
  return { host, casts, opened };
}

const settledV1 = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a composer link gives back exactly the text and link it was made from', () => {
  const links = giftShareLinksV1({ url: URL_V1, text: TEXT_V1 });
  assert.deepEqual(castFromComposeHrefV1(links.farcaster), { text: TEXT_V1, embeds: [URL_V1] });
  // The old host redirects to the new one with the query intact.
  assert.deepEqual(castFromComposeHrefV1('https://warpcast.com/~/compose?text=gm'), { text: 'gm', embeds: [] });
  for (const other of [links.x, 'https://farcaster.xyz/~/channel/base', 'http://farcaster.xyz/~/compose?text=gm', 'not a url']) {
    assert.equal(castFromComposeHrefV1(other), null, other);
  }
  assert.equal(
    castFromComposeHrefV1('https://farcaster.xyz/~/compose?embeds[]=a&embeds[]=b&embeds[]=c')?.embeds.length,
    2,
    'Farcaster takes two embeds at most',
  );
});

test('inside a host the Farcaster button asks the host to compose the cast', async () => {
  const { host, casts, opened } = hostV1();
  const links = giftShareLinksV1({ url: URL_V1, text: TEXT_V1 });
  let prevented = false;
  shareClickV1(host, links.farcaster)({ preventDefault: () => (prevented = true) });
  await settledV1();
  assert.equal(prevented, true, 'the web composer never opens inside the app');
  assert.deepEqual(casts, [{ text: TEXT_V1, embeds: [URL_V1] }]);
  assert.deepEqual(opened, []);
});

test('inside a host any other share link is opened by the host, not in its webview', async () => {
  const { host, casts, opened } = hostV1();
  const links = giftShareLinksV1({ url: URL_V1, text: TEXT_V1 });
  shareClickV1(host, links.x)({ preventDefault: () => undefined });
  await settledV1();
  assert.deepEqual(casts, []);
  assert.deepEqual(opened, [links.x]);
});

test('a host that will not compose still opens the composer link', async () => {
  const { host, opened } = hostV1({
    composeCast: async () => {
      throw new Error('composeCast not supported');
    },
  });
  const links = giftShareLinksV1({ url: URL_V1, text: TEXT_V1 });
  shareClickV1(host, links.farcaster)({ preventDefault: () => undefined });
  await settledV1();
  assert.deepEqual(opened, [links.farcaster]);
});

test('the button is the same link with a host or without one', () => {
  const links = giftShareLinksV1({ url: URL_V1, text: TEXT_V1 });
  const plain = renderToStaticMarkup(<ShareLinkV1 className="btn sec" href={links.farcaster}>Cast on Farcaster</ShareLinkV1>);
  const hosted = renderToStaticMarkup(
    <ShareHostProviderV1 value={hostV1().host}>
      <ShareLinkV1 className="btn sec" href={links.farcaster}>Cast on Farcaster</ShareLinkV1>
    </ShareHostProviderV1>,
  );
  assert.match(plain, /^<a class="btn sec" href="https:\/\/farcaster\.xyz\/~\/compose\?text=[^"]+" target="_blank" rel="noopener noreferrer">Cast on Farcaster<\/a>$/);
  assert.equal(hosted, plain);
});
