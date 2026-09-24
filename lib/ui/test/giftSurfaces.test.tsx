import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  GIFT_SHARE_WARNING_V1,
  giftBannerV1,
  giftFromHistoryStateV1,
  giftProofLineV1,
  giftShareForProofV1,
  giftShareLinksV1,
  giftUrlV1,
  publicGiftPageViewV1,
  reviewCallRowsV1,
  type PublicGiftLikeV1,
} from '../src/console/giftView';
import { GiftProofPanel, PublicGiftCard, type ProofGiftModelV1 } from '../src/console/GiftPanels';
import { ProofScreen } from '../src/console/ConsoleScreens';
import { GiftForm } from '../src/console/MarketRealityScreen';
import { swapPrepareNoticeV1 } from '../src/console/consoleFlow';

// ---------------------------------------------------------------------------
// Growth plan step 4: what a gift looks like, from the stock card to the page
// it is shared as — with X and Farcaster as the two buttons that matter.
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
const ID = 'c'.repeat(48);
const NVDA_ASSET = { symbol: 'NVDAc', decimals: 8 };

describe('the recipient comes from history state, never the address bar', () => {
  test('the shape the stock card writes, and nothing else', () => {
    assert.deepEqual(giftFromHistoryStateV1({ gift: { recipient: FRIEND.toUpperCase().replace('0X', '0x'), recipientName: 'friend.base.eth' } }), {
      recipient: FRIEND,
      recipientName: 'friend.base.eth',
    });
    // A name that is not a Basename is dropped; the address still stands.
    assert.deepEqual(giftFromHistoryStateV1({ gift: { recipient: FRIEND, recipientName: 'friend.eth' } }), {
      recipient: FRIEND,
      recipientName: null,
    });
    for (const state of [null, undefined, {}, { gift: {} }, { gift: { recipient: '0x1234' } }, { gift: { recipient: 'friend.base.eth' } }]) {
      assert.equal(giftFromHistoryStateV1(state), null);
    }
  });

  test('the banner names the recipient, or says a link cannot carry one', () => {
    const named = giftBannerV1({ gift: { recipient: FRIEND, recipientName: 'friend.base.eth' }, missing: false });
    assert.equal(named?.tone, 'gift');
    assert.equal(named?.title, 'Gift to friend.base.eth');
    assert.match(named?.detail ?? '', /exactly the swap's guaranteed minimum/);
    const missing = giftBannerV1({ gift: null, missing: true });
    assert.equal(missing?.tone, 'warn');
    assert.match(missing?.detail ?? '', /nothing here will be prepared as a gift/);
    assert.equal(giftBannerV1({ gift: null, missing: false }), null);
  });
});

describe('the review names every call for what it does', () => {
  const rows = reviewCallRowsV1({
    calls: [
      { callType: 'approval', to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', spender: '0x000000000022d473030f116ddee9f6b43ac78ba3', recipient: null, amountAtomic: '100000' },
      { callType: 'swap', to: '0x6ff5693b99212da76ad316178a184ab56d299b43', spender: null, recipient: null, amountAtomic: null },
      { callType: 'transfer', to: NVDA, spender: null, recipient: FRIEND, amountAtomic: '44006', asset: NVDA_ASSET },
      { callType: 'other', to: NVDA, spender: null, recipient: null, amountAtomic: null },
    ],
    quoteExpiry: '12:00:00',
    recipientName: 'friend.base.eth',
  });

  test('the swap pays the giver; the transfer is the only call paying anyone else', () => {
    assert.deepEqual(rows.map((row) => row.index), [1, 2, 3, 4]);
    assert.equal(rows[0]!.title, 'Allow 0x000000000022d473030f116ddee9f6b43ac78ba3 to spend exactly 100000');
    assert.match(rows[1]!.detail, /Recipient is your own wallet/);
    assert.equal(rows[2]!.title, 'Send exactly 0.00044006 NVDAc to friend.base.eth');
    assert.match(rows[2]!.detail, /this is the only call that sends anything to anyone else/);
    assert.doesNotMatch(rows[2]!.detail, /Recipient is your own wallet/);
    assert.match(rows[3]!.title, /An unrecognised call/);
  });
});

describe('the proof says delivered only from the receipt', () => {
  test('completed is delivered; anything else is not', () => {
    const gift = { recipient: FRIEND, amountAtomic: '44006' };
    const done = giftProofLineV1({ gift, asset: NVDA_ASSET, finalStatus: 'completed', recipientName: 'friend.base.eth' });
    assert.equal(done?.title, 'Gift delivered to friend.base.eth');
    assert.equal(done?.delivered, true);
    assert.match(done?.detail ?? '', /0\.00044006 NVDAc went to 0x8e52/);
    const pending = giftProofLineV1({ gift, asset: NVDA_ASSET, finalStatus: 'pending' });
    assert.equal(pending?.delivered, false);
    assert.match(pending?.detail ?? '', /not confirmed until the receipt shows the transfer/);
    assert.equal(giftProofLineV1({ gift: null, asset: NVDA_ASSET, finalStatus: 'completed' }), null);
  });
});

describe('sharing on X and Farcaster', () => {
  const url = giftUrlV1('https://miorail.xyz/', ID);

  test('the link is the gift page for the public proof id', () => {
    assert.equal(url, `https://miorail.xyz/gift/${ID}`);
  });

  test('X takes the link as url, Farcaster as an embed, and the text never carries it', () => {
    const links = giftShareLinksV1({ url, text: 'I gave friend.base.eth 0.00044006 NVDAc & more' });
    const x = new URL(links.x);
    assert.equal(x.origin + x.pathname, 'https://x.com/intent/tweet');
    assert.equal(x.searchParams.get('url'), url);
    assert.equal(x.searchParams.get('text'), 'I gave friend.base.eth 0.00044006 NVDAc & more');
    const farcaster = new URL(links.farcaster);
    assert.equal(farcaster.origin + farcaster.pathname, 'https://farcaster.xyz/~/compose');
    assert.equal(farcaster.searchParams.get('embeds[]'), url);
    assert.doesNotMatch(farcaster.searchParams.get('text') ?? '', /miorail\.xyz/);
  });

  test('the post states the proof’s own figures', () => {
    const share = giftShareForProofV1({
      gift: { recipient: FRIEND, amountAtomic: '44006' },
      asset: NVDA_ASSET,
      recipientName: null,
      url,
    });
    assert.equal(share.text, 'I gave 0x8e52…beef 0.00044006 NVDAc: a tokenized stock, delivered on Base in one transaction.');
  });

  test('before the link exists: the warning, and one button that creates it', () => {
    const model: ProofGiftModelV1 = {
      title: 'Gift delivered to friend.base.eth',
      detail: '0.00044006 NVDAc went to 0x8e52…',
      delivered: true,
      share: {
        url: null,
        pending: false,
        error: null,
        onCreate: () => undefined,
        xHref: null,
        farcasterHref: null,
        onCopy: () => undefined,
        copied: false,
      },
    };
    const html = renderToStaticMarkup(<GiftProofPanel gift={model} />);
    assert.ok(html.includes(GIFT_SHARE_WARNING_V1), 'the warning sits above the button that publishes');
    assert.match(html, /Share this gift on X or Farcaster/);
    assert.doesNotMatch(html, /x\.com\/intent/);
    assert.deepEqual(undefinedClasses(html), []);
  });

  test('after: X and Farcaster are the large buttons, opening their own composers', () => {
    const links = giftShareLinksV1({ url, text: 'I gave friend.base.eth 0.00044006 NVDAc' });
    const model: ProofGiftModelV1 = {
      title: 'Gift delivered to friend.base.eth',
      detail: 'delivered',
      delivered: true,
      share: {
        url,
        pending: false,
        error: null,
        onCreate: () => undefined,
        xHref: links.x,
        farcasterHref: links.farcaster,
        onCopy: () => undefined,
        copied: false,
      },
    };
    const html = renderToStaticMarkup(<GiftProofPanel gift={model} />);
    assert.match(html, /class="btn lg share-x" href="https:\/\/x\.com\/intent\/tweet\?text=/);
    assert.match(html, /class="btn lg share-fc" href="https:\/\/farcaster\.xyz\/~\/compose\?text=/);
    assert.equal(html.match(/rel="noopener noreferrer"/g)?.length, 2);
    assert.match(html, /Post on X/);
    assert.match(html, /Cast on Farcaster/);
    assert.match(html, /class="btn sec"[^>]*>Copy link/);
    assert.deepEqual(undefinedClasses(html), []);
  });

  test('an undelivered gift offers nothing to share', () => {
    const html = renderToStaticMarkup(
      <GiftProofPanel gift={{ title: 'Gift to friend.base.eth', detail: 'not confirmed', delivered: false, share: null }} />,
    );
    assert.doesNotMatch(html, /Share this gift|Post on X|Cast on Farcaster/);
    assert.match(html, /data-delivered="false"/);
  });

  test('the proof screen carries the gift above its timeline, and only when there is one', () => {
    const base = {
      steps: [],
      eyebrow: 'Route proof',
      amount: '0.00044227',
      unit: 'NVDAc',
      usd: 'received',
      headlinePill: { label: 'completed', tone: 'g' as const },
      why: 'why',
      kpis: [],
      timeline: [],
      planVsActual: [],
      record: [],
      onExport: () => undefined,
      onNewGoal: () => undefined,
    };
    const plain = renderToStaticMarkup(<ProofScreen {...base} />);
    assert.doesNotMatch(plain, /gift-proof/);
    const withGift = renderToStaticMarkup(
      <ProofScreen {...base} gift={{ title: 'Gift delivered to friend.base.eth', detail: 'd', delivered: true, share: null }} />,
    );
    assert.ok(withGift.indexOf('gift-proof') > 0 && withGift.indexOf('gift-proof') < withGift.indexOf('Execution timeline'));
  });
});

describe('the public gift page', () => {
  const gift: PublicGiftLikeV1 = {
    giver: GIVER,
    recipient: FRIEND,
    amountAtomic: '44006',
    token: { address: NVDA, symbol: 'NVDAc', decimals: 8 },
    finalStatus: 'completed',
    delivered: true,
    transactionHash: `0x${'1'.repeat(64)}`,
    paid: { amountAtomic: '100000', symbol: 'USDC', decimals: 6 },
    issuedAt: '2026-09-24T10:00:00.000Z',
  };
  const labels = {
    names: { giver: 'mioku.base.eth', recipient: 'friend.base.eth' },
    stock: { ticker: 'NVDA', companyName: 'NVIDIA' },
  };

  test('who gave whom what, with every figure from the bundle', () => {
    const view = publicGiftPageViewV1({ publicId: ID, origin: 'https://miorail.xyz', gift, labels, verified: true });
    assert.equal(view.headline, 'mioku.base.eth gave friend.base.eth NVIDIA stock');
    assert.equal(view.amount, '0.00044006');
    assert.equal(view.unit, 'NVDAc');
    assert.equal(view.status.tone, 'g');
    assert.equal(view.stockHref, '/stocks/nvda');
    assert.equal(view.identityHref, `/is-it-real/${NVDA}`);
    assert.equal(view.proofHref, `/proof/${ID}`);
    const byLabel = Object.fromEntries(view.rows.map((row) => [row.label, row]));
    assert.equal(byLabel.From?.href, `https://basescan.org/address/${GIVER}`);
    assert.equal(byLabel.Transaction?.href, `https://basescan.org/tx/0x${'1'.repeat(64)}`);
    assert.equal(byLabel['Paid for the purchase']?.value, '0.1 USDC');
    assert.equal(byLabel['This record']?.value, 'Checked in your browser: every hash matches');
    assert.match(view.giveBack, /enter mioku\.base\.eth/);
    assert.equal(view.share?.url, `https://miorail.xyz/gift/${ID}`);
  });

  test('with no labels, the page names people by address and still reads', () => {
    const view = publicGiftPageViewV1({ publicId: ID, origin: 'https://miorail.xyz', gift, labels: null, verified: null });
    assert.equal(view.headline, '0x4de2…0d70 gave 0x8e52…beef NVDAc stock');
    assert.equal(view.stockHref, null);
    assert.equal(view.rows.find((row) => row.label === 'This record')?.value, 'Not checked');
  });

  test('a gift that did not arrive is never headed as given, and is not offered for sharing', () => {
    const view = publicGiftPageViewV1({
      publicId: ID,
      origin: 'https://miorail.xyz',
      gift: { ...gift, finalStatus: 'failed', delivered: false },
      labels,
      verified: false,
    });
    assert.equal(view.headline, 'A gift from mioku.base.eth to friend.base.eth did not arrive');
    assert.doesNotMatch(view.headline, / gave /);
    assert.equal(view.status.tone, 'a');
    assert.equal(view.share, null);
    assert.equal(view.rows.find((row) => row.label === 'This record')?.value, 'Did NOT check out in your browser');
  });

  test('renders with console classes only, and outbound links that cannot reach back', () => {
    const view = publicGiftPageViewV1({ publicId: ID, origin: 'https://miorail.xyz', gift, labels, verified: true });
    const html = renderToStaticMarkup(<PublicGiftCard view={view} />);
    assert.match(html, /mioku\.base\.eth gave friend\.base\.eth NVIDIA stock/);
    assert.match(html, /Post on X/);
    assert.match(html, /Cast on Farcaster/);
    assert.match(html, /href="\/stocks\/nvda"/);
    for (const match of html.matchAll(/<a [^>]*target="_blank"[^>]*>/g)) {
      assert.match(match[0], /rel="noopener noreferrer"/);
    }
    assert.deepEqual(undefinedClasses(html), []);
  });
});

describe('the stock card and the refusal', () => {
  test('the gift form states its range and asks for a person', () => {
    const html = renderToStaticMarkup(<GiftForm onSubmit={async () => null} onCancel={() => undefined} />);
    assert.match(html, /Who receives it/);
    assert.match(html, /alice\.base\.eth or 0x…/);
    assert.match(html, /From 0\.1 to 100 USDC/);
  });

  test('a refused gift says it is the gift that was refused', () => {
    assert.equal(
      swapPrepareNoticeV1({ outcome: 'unsupported', reason: 'gift_refused', detail: 'A gift is from 0.1 to 100 USDC.' })?.title,
      'Miorail cannot send this gift',
    );
    assert.equal(
      swapPrepareNoticeV1({ outcome: 'unsupported', reason: 'unsupported_pair', detail: 'x' })?.title,
      'Miorail cannot prepare this route',
    );
  });
});
