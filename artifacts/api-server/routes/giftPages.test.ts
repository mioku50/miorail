import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';

import {
  giftPagesRouter,
  giftPagesRuntime,
  publicGiftRouter,
  resetGiftPageCachesV1,
} from './giftPages.js';
import { resetStockPagesTemplateV1, stockPagesRuntime } from './stockPages.js';

// ---------------------------------------------------------------------------
// `/gift/<publicId>`: the app, with a head a link preview on X or Farcaster can
// read — every claim in it taken from the bundle's own transfer calldata.
// ---------------------------------------------------------------------------

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

const ID = 'c'.repeat(48);
const GIVER = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const FRIEND = '0x8e525bfce1c0ffee00000000000000000000beef';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';

function word(value: string | bigint): string {
  return (typeof value === 'string' ? value.replace(/^0x/, '') : value.toString(16)).padStart(64, '0');
}

function bundle(over: { finalStatus?: string; calls?: unknown[] } = {}) {
  const asset = { kind: 'erc20', address: NVDA, symbol: 'NVDAc', decimals: 8 };
  return {
    proofFamily: 'route',
    issuedAt: '2026-09-24T10:00:00.000Z',
    proof: {
      walletAddress: GIVER,
      finalStatus: over.finalStatus ?? 'completed',
      transactionHashes: [`0x${'1'.repeat(64)}`],
      approvedCalls: over.calls ?? [
        { callType: 'swap', to: '0x6ff5693b99212da76ad316178a184ab56d299b43', valueWei: '0', data: '0x3593564c' },
        {
          callType: 'transfer',
          to: NVDA,
          valueWei: '0',
          data: `0xa9059cbb${word(FRIEND)}${word(44006n)}`,
          asset,
          amountAtomic: '44006',
          recipient: FRIEND,
        },
      ],
      actualResult: {
        assetChanges: [
          { direction: 'debit', amountAtomic: '100000', asset: { kind: 'erc20', symbol: 'USDC', decimals: 6 } },
          { direction: 'credit', amountAtomic: '44227', asset },
        ],
      },
    },
  };
}

function stubV1(t: test.TestContext, over: Partial<typeof giftPagesRuntime> = {}) {
  const savedGift = { ...giftPagesRuntime };
  const savedStock = { ...stockPagesRuntime };
  const loaded: string[] = [];
  Object.assign(stockPagesRuntime, {
    indexHtmlPath: () => '/srv/index.html',
    origin: () => 'https://miorail.xyz',
    stat: async () => ({ mtimeMs: 1 }) as never,
    readFile: async () => TEMPLATE,
  });
  Object.assign(giftPagesRuntime, {
    enabled: () => true,
    migrationAvailable: async () => true,
    loadBundle: async (publicId: string) => {
      loaded.push(publicId);
      return publicId === ID ? bundle() : null;
    },
    reverseName: async (address: string) =>
      address === GIVER ? 'mioku.base.eth' : address === FRIEND ? 'friend.base.eth' : null,
    stock: async () => ({ ticker: 'NVDA', companyName: 'NVIDIA' }),
    ...over,
  });
  resetStockPagesTemplateV1();
  resetGiftPageCachesV1();
  t.after(() => {
    Object.assign(giftPagesRuntime, savedGift);
    Object.assign(stockPagesRuntime, savedStock);
    resetStockPagesTemplateV1();
    resetGiftPageCachesV1();
  });
  return loaded;
}

function appV1() {
  const app = express();
  app.use(helmet());
  app.use('/api/public', publicGiftRouter);
  app.use(giftPagesRouter);
  return app;
}

test('a gift previews as who gave whom which stock, for X and Farcaster alike', async (t) => {
  stubV1(t);
  const response = await request(appV1()).get(`/gift/${ID}`).expect(200);
  const html = response.text;
  assert.match(html, /<title>mioku\.base\.eth gave friend\.base\.eth NVIDIA stock · Miorail<\/title>/);
  assert.match(html, /0\.00044006 NVDAc: tokenized NVIDIA stock, delivered on Base in one transaction\./);
  // X reads twitter:*, Farcaster renders a plain link from og:*.
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(html, /property="og:image" content="https:\/\/miorail\.xyz\/og-gift\.png"/);
  assert.match(html, /name="twitter:image" content="https:\/\/miorail\.xyz\/og-gift\.png"/);
  // Unguessable is not secret: never indexed, never canonical.
  assert.match(html, /<meta name="robots" content="noindex" \/>/);
  assert.doesNotMatch(html, /rel="canonical"/);
  assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(String(response.headers['cache-control']), /no-store/);
  // Still the app underneath.
  assert.match(html, /<script type="module" src="\/assets\/index-abc\.js"><\/script>/);
  assert.equal(html.match(/<title>/g)?.length, 1);
});

test('a gift that did not complete is never described as given', async (t) => {
  stubV1(t, { loadBundle: async () => bundle({ finalStatus: 'failed' }) });
  const html = (await request(appV1()).get(`/gift/${ID}`).expect(200)).text;
  assert.doesNotMatch(html, / gave /);
  assert.match(html, /<title>A gift of NVIDIA stock that did not arrive · Miorail<\/title>/);
  assert.match(html, /so nothing was delivered/);
});

test('a name that cannot be read is an address, and a stock that cannot be named is its symbol', async (t) => {
  stubV1(t, {
    reverseName: async () => {
      throw new Error('resolver down');
    },
    stock: async () => null,
  });
  const html = (await request(appV1()).get(`/gift/${ID}`).expect(200)).text;
  assert.match(html, /<title>0x4de2…0d70 gave 0x8e52…beef NVDAc stock · Miorail<\/title>/);
});

test('an unknown id, a revoked one and a plain swap are the same 404', async (t) => {
  const loaded: string[] = [];
  stubV1(t, {
    loadBundle: async (publicId: string) => {
      loaded.push(publicId);
      return publicId === ID ? bundle({ calls: [{ callType: 'swap', to: NVDA, valueWei: '0', data: '0x3593564c' }] }) : null;
    },
  });
  for (const id of [ID, 'd'.repeat(48)]) {
    const response = await request(appV1()).get(`/gift/${id}`).expect(404);
    assert.match(response.text, /<title>Gift not found · Miorail<\/title>/);
    assert.match(response.text, /<meta name="robots" content="noindex" \/>/);
  }
  // A malformed id never reaches the store.
  await request(appV1()).get('/gift/not-an-id').expect(404);
  assert.deepEqual(loaded, [ID, 'd'.repeat(48)]);
});

test('with public proofs off, the gift page does not exist', async (t) => {
  const loaded = stubV1(t, { enabled: () => false });
  await request(appV1()).get(`/gift/${ID}`).expect(404);
  await request(appV1()).get(`/api/public/gifts/${ID}`).expect(404);
  assert.deepEqual(loaded, []);
});

test('a store that fails still serves the app, under a generic head', async (t) => {
  stubV1(t, {
    loadBundle: async () => {
      throw new Error('database said no');
    },
  });
  const html = (await request(appV1()).get(`/gift/${ID}`).expect(200)).text;
  assert.match(html, /<title>A gift of stock on Base · Miorail<\/title>/);
});

test('the labels endpoint answers names and a company, never cached', async (t) => {
  stubV1(t);
  const response = await request(appV1()).get(`/api/public/gifts/${ID}`).expect(200);
  assert.deepEqual(response.body, {
    names: { giver: 'mioku.base.eth', recipient: 'friend.base.eth' },
    stock: { ticker: 'NVDA', companyName: 'NVIDIA' },
  });
  assert.equal(response.headers['cache-control'], 'no-store');
  await request(appV1()).get(`/api/public/gifts/${'d'.repeat(48)}`).expect(404);
});

test('a name is looked up once per address, not once per unfurl', async (t) => {
  let lookups = 0;
  stubV1(t, {
    reverseName: async () => {
      lookups += 1;
      return null;
    },
  });
  await request(appV1()).get(`/gift/${ID}`).expect(200);
  await request(appV1()).get(`/gift/${ID}`).expect(200);
  await request(appV1()).get(`/api/public/gifts/${ID}`).expect(200);
  assert.equal(lookups, 2);
});
