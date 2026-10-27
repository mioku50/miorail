import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeMirror } from '@mioagent/still-engine';
import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';

import { EXAMPLE, calendar, snapshot, universe } from '../../still-engine/test/fixtures';
import { assetsViewV1 } from '../src/still/assetsView';
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
    const summary = html.indexOf('holdings Still can lend against');
    const tabs = html.indexOf('role="tablist"');
    const holdings = html.indexOf('class="still-assets-primary"');
    const dividends = html.indexOf('<aside class="still-assets-aside still-section">');
    assert.ok(summary >= 0 && summary < tabs && tabs < holdings && holdings < dividends);
  });
});
