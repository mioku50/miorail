import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeMirror } from '@mioagent/still-engine';
import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';

import { EXAMPLE, calendar, snapshot, universe } from '../../still-engine/test/fixtures';
import { assetsViewV1, lenderPriceTimeLineV1 } from '../src/still/assetsView';
import { StillAssets } from '../src/still/StillPages';
import { skyStateV1 } from '../src/still/skyState';

void React;

const NOW = new Date('2026-10-21T15:00:00Z');

function portfolio(): MirrorReport {
  return JSON.parse(JSON.stringify(computeMirror({
    universe: universe(),
    snapshot: snapshot(EXAMPLE),
    calendar: calendar(),
    subject: { address: '0x00000000000000000000000000000000000b0b0b', name: null, input: 'example' },
    assembledAt: NOW,
  })));
}

function dividendRead(receivedUsd: string, upcomingUsd: string | null = receivedUsd): DividendWalletResponseV1 {
  return {
    schemaVersion: 'dividend-wallet/v1',
    generatedAt: NOW.toISOString(),
    blockNumber: 53_000_000,
    receivedUsd,
    passThroughPercent: '49.5',
    holdings: [{
      underlyingKey: 'security:isin:US0378331005',
      symbol: 'AAPL',
      company: 'Apple',
      tokenAddress: '0xb200000000000000000000c2e324d24d7eecd1fb',
      tokenSymbol: 'AAPLc',
      tokens: '1.5',
      received: [{
        state: 'effective', reason: null, amountPerShare: '0.27', payDate: '2026-08-13',
        payDateApproximate: false, kind: 'measured', tokens: '1.5', shares: '0.000001', usd: receivedUsd,
        at: '2026-08-13T15:00:00.000Z',
      }],
      upcoming: [{
        state: 'estimated', reason: null, amountPerShare: '0.27', payDate: '2026-11-12',
        payDateApproximate: true, kind: 'estimate', tokens: '1.5', shares: '0.000001', usd: upcomingUsd, at: null,
      }],
    }],
  };
}

function renderAssets(view: ReturnType<typeof assetsViewV1>): string {
  return renderToStaticMarkup(<StillAssets model={{
    sky: skyStateV1({ now: NOW }), view, loading: false, failed: null,
    onRetry: () => {}, signedIn: true, signInHref: '/signin',
  }} />);
}

describe('Still Assets presentation', () => {
  it('keeps positive source amounts below a cent visible, including the received total', () => {
    for (const sourceUsd of ['0.0001', '0.0099']) {
      const view = assetsViewV1({ report: portfolio(), dividends: dividendRead(sourceUsd) });
      const lines = view.rows.find((row) => row.id === 'AAPLc')!.lines;
      assert.deepEqual(lines.find((line) => line.text.startsWith('Dividends reinvested')), {
        text: 'Dividends reinvested so far: <$0.01',
      });
      assert.equal(lines.at(-1)!.text, 'Dividend ahead: <$0.01, if you hold AAPLc when it converts (an estimate)');
      assert.equal(view.receivedDividends, '<$0.01');
      assert.match(renderAssets(view), /Dividends reinvested so far: &lt;\$0\.01/);
    }
  });

  it('does not turn an exact source zero or an unread value into a positive fraction of a cent', () => {
    const zero = assetsViewV1({ report: portfolio(), dividends: dividendRead('0.0000') });
    const lines = zero.rows.find((row) => row.id === 'AAPLc')!.lines;
    assert.equal(zero.receivedDividends, null);
    assert.equal(lines.some((line) => line.text.startsWith('Dividends reinvested')), false);
    assert.equal(lines.at(-1)!.text, 'Dividend ahead: ≈ $0.00, if you hold AAPLc when it converts (an estimate)');
    assert.doesNotMatch(renderAssets(zero), /&lt;\$0\.01/);

    const unread = assetsViewV1({ report: portfolio(), dividends: dividendRead('0.0000', null) });
    assert.equal(unread.rows.find((row) => row.id === 'AAPLc')!.lines.some((line) => line.text.startsWith('Dividend ahead')), false);
  });

  it('uses the ordinary money label at a cent and above', () => {
    for (const [sourceUsd, label] of [['0.0100', '$0.01'], ['0.5200', '$0.52']]) {
      const view = assetsViewV1({ report: portfolio(), dividends: dividendRead(sourceUsd!) });
      assert.equal(view.receivedDividends, label);
      assert.equal(view.rows.find((row) => row.id === 'AAPLc')!.lines.at(-2)!.text, `Dividends reinvested so far: ${label}`);
    }
  });

  it('renders the dividend label before its amount while keeping the pledged-loan emphasis', () => {
    const view = assetsViewV1({ report: portfolio(), dividends: dividendRead('0.5200') });
    const html = renderAssets(view);
    assert.match(html, /Dividends reinvested so far: \$0\.52/);
    assert.doesNotMatch(html, /\$0\.52(?:<\/strong>)?Dividends/);
    assert.match(html, /<strong>3\.4 hold up your Aave loan<\/strong> · 0\.8 free/);
    assert.equal(view.loans[0]!.owed, '$240.17');
  });

  it('keeps the mobile reading order and gives the dividend chevron a bounded decorative size', () => {
    const html = renderAssets(assetsViewV1({ report: portfolio(), dividends: dividendRead('0.5200') }));
    assert.match(html, /^<div class="still-assets">/);
    assert.match(html, /<a href="\/stocks\/dividends" class="still-card still-feature-link">/);
    assert.match(html, /<svg class="still-chevron" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">/);
    const summary = html.indexOf('reviewed for loans');
    const tabs = html.indexOf('role="tablist"');
    const holdings = html.indexOf('class="still-assets-primary"');
    const dividends = html.indexOf('<aside class="still-assets-aside still-section">');
    assert.ok(summary >= 0 && summary < tabs && tabs < holdings && holdings < dividends);
  });
});

describe('selling a holding on Swap, from Assets', () => {
  const report = (holdings: Parameters<typeof snapshot>[0]): MirrorReport => JSON.parse(JSON.stringify(computeMirror({
    universe: universe(),
    snapshot: snapshot(holdings),
    calendar: calendar(),
    subject: { address: '0x00000000000000000000000000000000000b0b0b', name: null, input: 'example' },
    assembledAt: NOW,
  })));
  const goalOf = (view: ReturnType<typeof assetsViewV1>, id: string) => view.rows.find((row) => row.id === id)?.sell?.goal ?? null;
  const NVDA = '0xb20000000000000000000078ee7ce2fE4908108C';

  it('hands over the whole free balance, exactly, by its contract', () => {
    const view = assetsViewV1({ report: portfolio(), usdc: { raw: '1000000', decimals: 6 } });
    // 0.8 NVDAc free beside 3.4 pledged: only the free part can be sold.
    assert.equal(goalOf(view, 'NVDAc'), `swap my 0.8 ${NVDA} to USDC`);
    assert.equal(view.rows.find((row) => row.id === 'NVDAc')!.sell!.href, `/routes?goal=${encodeURIComponent(`swap my 0.8 ${NVDA} to USDC`)}`);
    assert.equal(goalOf(view, 'cbBTC'), 'swap my 0.012 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf to USDC');
    // USDC, exactly, buys ETH on Swap (operator, 2026-11-09).
    assert.equal(goalOf(view, 'USDC'), 'Swap 1 USDC to ETH');
    const html = renderAssets(view);
    assert.match(html, /Sell for USDC on Swap/);
    assert.match(html, /Swap for ETH on Swap →/);
    assert.equal(goalOf(assetsViewV1({ report: portfolio(), usdc: { raw: '1355000', decimals: 6 } }), 'USDC'), 'Swap 1.355 USDC to ETH');
    assert.equal(goalOf(assetsViewV1({ report: portfolio(), usdc: { raw: '0', decimals: 6 } }), 'USDC'), null);
  });

  it('shows the ETH a wallet keeps for fees, which the report does not count, read beside USDC', () => {
    // 2026-11-09: 0.0001 ETH is below the 0.0005 ETH reserve, so the report has no ETH line, and
    // Assets said 0 ETH.
    const gasOnly = report({ wallet: { ETH: 100_000_000_000_000n } });
    assert.equal(gasOnly.assets.find((line) => line.asset === 'ETH'), undefined);
    const eth = (usdc: Parameters<typeof assetsViewV1>[0]['usdc']) => assetsViewV1({ report: gasOnly, usdc }).rows.find((row) => row.id === 'ETH')!;
    const held = eth({ raw: '0', decimals: 6, block: '1', nativeEthRaw: '100000000000000' });
    assert.equal(held.amount, '0.0001 ETH');
    assert.equal(held.value, '—');
    assert.match(held.lines[0]!.text, /^Network-fee money: Still keeps 0\.0005 ETH for fees and does not count it$/);
    assert.equal(held.sell, undefined);
    // A measured zero is a zero; an ETH read that did not answer is not one.
    assert.equal(eth({ raw: '0', decimals: 6, nativeEthRaw: '0' }).amount, '0 ETH');
    assert.equal(eth({ raw: '0', decimals: 6, nativeEthRaw: null }).amount, '— ETH');
    assert.equal(eth({ raw: '0', decimals: 6, nativeEthRaw: null }).value, null);
    assert.equal(eth('loading').amount, '… ETH');
    assert.equal(eth('unread').amount, '— ETH');
    // Without the read beside it, the page says what it always said.
    assert.equal(eth(undefined).amount, '0 ETH');
    assert.equal(eth({ raw: '0', decimals: 6 }).amount, '0 ETH');
  });

  it('counts the wallet’s USDC in the total at the top, and says what the total is made of', () => {
    // 2026-11-09, the operator: a wallet holding only USDC read $0.00 at the top of Assets.
    const empty = report({ wallet: {} });
    const view = assetsViewV1({ report: empty, usdc: { raw: '1355000', decimals: 6 } });
    assert.equal(view.total, '$1.35');
    assert.equal(view.reviewedTotal, '$0.00');
    assert.equal(view.usdcTotal, '$1.35');
    assert.equal(view.totalNote, '$0.00 reviewed for loans · $1.35 USDC');
    const html = renderAssets(view);
    assert.match(html, /<div class="still-balance-label">Holdings<\/div><div class="still-big"><span class="d">\$1<\/span><span class="c">\.(?:<!-- -->)?35<\/span>/);
    assert.match(html, /\$0\.00 reviewed for loans · \$1\.35 USDC/);
    assert.match(html, /What a loan pays out and Repay takes; Still does not lend against it/);
    // While USDC is read, or when it did not answer, the total is the reviewed holdings' and says why.
    assert.equal(assetsViewV1({ report: empty, usdc: 'loading' }).totalNote, '$0.00 reviewed for loans · USDC is being read');
    const unread = assetsViewV1({ report: empty, usdc: 'unread' });
    assert.equal(unread.total, '$0.00');
    assert.equal(unread.usdcTotal, 'unread');
    assert.equal(unread.totalNote, '$0.00 reviewed for loans · USDC not read just now, so not in the total');
    // Without a USDC read the note names the reviewed holdings alone.
    assert.equal(assetsViewV1({ report: empty }).totalNote, '$0.00 reviewed for loans');
  });

  it('offers nothing for what is all pledged, and asks how much ETH', () => {
    const view = assetsViewV1({ report: report({ pledged: { NVDAc: 340_000_000n }, aaveDebt: 100_000_000n, wallet: { ETH: 10n ** 16n } }) });
    assert.equal(goalOf(view, 'NVDAc'), null);
    assert.equal(goalOf(view, 'ETH'), 'swap my ETH to USDC');
  });
});

// Audit DATA-3: "Gold $4,042" and a limit drawn from it stood with no time, while the gold feed
// behind Morpho's oracle stands for hours on a weekday and from Friday to Sunday evening.
describe('when the lender read the price a gold, bitcoin or ether row is counted at', () => {
  const SATURDAY = '2026-10-24T22:00:00.000Z';
  const gold = (priceUpdatedAt: string | null) => ({ kind: 'crypto' as const, asset: 'PAXG', priceUpdatedAt });

  it('gold on a Saturday says it is Friday’s price, and that the feed stands', () => {
    assert.equal(
      lenderPriceTimeLineV1(gold('2026-10-23T21:00:00.000Z'), SATURDAY),
      "Counted at the gold price of Fri 21:00 UTC, the latest Morpho's oracle has: its gold feed can stand for hours, and stands all weekend",
    );
  });

  it('bitcoin and ether say it only when their feed fell behind, and do not speak of gold', () => {
    const btc = (priceUpdatedAt: string | null) => ({ kind: 'crypto' as const, asset: 'cbBTC', priceUpdatedAt });
    assert.equal(lenderPriceTimeLineV1(btc('2026-10-24T21:56:00.000Z'), SATURDAY), null, 'four minutes old');
    assert.equal(lenderPriceTimeLineV1(btc('2026-10-24T21:00:01.000Z'), SATURDAY), null, 'a second under an hour');
    assert.equal(lenderPriceTimeLineV1(btc('2026-10-24T21:00:00.000Z'), SATURDAY), "Counted at the price Morpho's oracle last read, Sat 21:00 UTC");
  });

  it('a price older than six days carries its date, and one with no time says nothing', () => {
    assert.match(lenderPriceTimeLineV1(gold('2026-10-16T21:00:00.000Z'), SATURDAY)!, /of 2026-10-16 21:00 UTC, the latest/);
    assert.equal(lenderPriceTimeLineV1(gold(null), SATURDAY), null);
    assert.equal(lenderPriceTimeLineV1(gold('not a time'), SATURDAY), null);
    // A stock's row has its own rule (the stale-price line), and never this one.
    assert.equal(lenderPriceTimeLineV1({ kind: 'stock', asset: 'NVDAc', priceUpdatedAt: '2026-10-23T21:00:00.000Z' }, SATURDAY), null);
  });

  it('the row of a gold holder shows the line, under what the row already says', () => {
    const at = BigInt(Date.parse(SATURDAY) / 1000);
    const read = JSON.parse(JSON.stringify(computeMirror({
      universe: universe(),
      snapshot: snapshot({ wallet: { PAXG: 10n ** 18n }, morphoPriceAt: { PAXG: at - 25n * 3_600n } }, at),
      calendar: calendar(),
      subject: { address: '0x00000000000000000000000000000000000b0b0b', name: null, input: 'example' },
      assembledAt: new Date(SATURDAY),
    }))) as MirrorReport;
    const row = assetsViewV1({ report: read }).rows.find((entry) => entry.id === 'PAXG')!;
    assert.deepEqual(row.lines.map((entry) => entry.text), [
      'Modelled room · up to $1,564.46 on Morpho',
      "Counted at the gold price of Fri 21:00 UTC, the latest Morpho's oracle has: its gold feed can stand for hours, and stands all weekend",
    ]);
    // Without the feed's time the row is what it was.
    const untimed = JSON.parse(JSON.stringify(computeMirror({
      universe: universe(),
      snapshot: snapshot({ wallet: { PAXG: 10n ** 18n } }, at),
      calendar: calendar(),
      subject: { address: '0x00000000000000000000000000000000000b0b0b', name: null, input: 'example' },
      assembledAt: new Date(SATURDAY),
    }))) as MirrorReport;
    assert.deepEqual(
      assetsViewV1({ report: untimed }).rows.find((entry) => entry.id === 'PAXG')!.lines.map((entry) => entry.text),
      ['Modelled room · up to $1,564.46 on Morpho'],
    );
  });
});
