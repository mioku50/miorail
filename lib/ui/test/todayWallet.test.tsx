import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TodayWallet, searchWalletBalancesV1 } from '../src/console/TodayWallet';
import { walletBalanceRowsV1, type WalletBalanceEntryV1 } from '../src/console/WalletBalancesCard';
import { todayModelV1, todayWalletCheckV1 } from '../src/console/todayView';
import { TodayScreen } from '../src/console/TodayScreen';

void React;
const official = `0x${'1'.repeat(40)}`;
const mismatch = `0x${'2'.repeat(40)}`;
const rows: WalletBalanceEntryV1[] = [
  { symbol: 'ETH', address: 'native', balanceFormatted: '0.0003' },
  { symbol: 'NVDAc', address: official, balanceFormatted: '0.0009', usdValue: '0.20', registry: { standing: 'official', ticker: 'NVDAc' } },
  { symbol: 'NVDAc', address: mismatch, balanceFormatted: '15', possibleSpam: true, registry: { standing: 'lookalike', ticker: 'NVDAc', officialAddress: official } },
  { symbol: 'UNKNOWN', address: `0x${'3'.repeat(40)}`, balanceFormatted: null },
  { symbol: 'DUST', address: `0x${'4'.repeat(40)}`, balanceFormatted: '1', usdValue: '0.0002', verified: true },
  { symbol: 'SPAM', address: `0x${'5'.repeat(40)}`, balanceFormatted: '10', possibleSpam: true },
  { symbol: 'ZERO', address: `0x${'6'.repeat(40)}`, balanceFormatted: '0.0000' },
];
const noop = () => {};

test('one portfolio preserves ETH, unknown balances and issuer findings, while hiding zero and spam', () => {
  const list = walletBalanceRowsV1(rows);
  assert.deepEqual(list.shown.map(row => row.symbol), ['ETH', 'DUST', 'NVDAc', 'NVDAc', 'UNKNOWN']);
  assert.equal(list.hiddenZero, 1);
  assert.equal(list.hiddenSpam, 1);
  const check = todayWalletCheckV1(list.shown);
  assert.deepEqual([check.official.length, check.lookalikes.length, check.unchecked.length], [1, 1, 1]);
  const html = renderToStaticMarkup(<TodayWallet model={{ rows, loading: false, unavailableReason: null }} onInvestigate={noop} />);
  assert.match(html, /View all · 5 balances/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /≈ \$0.20/);
  assert.match(html, /≈ less than \$0.01/);
  assert.match(html, />UNKNOWN<\/strong>/);
  assert.match(html, /not the official NVDAc/);
  assert.match(html, /Outside coverage is not a risk finding/);
  const missing = [{ symbol: 'EMPTY', address: mismatch, balanceFormatted: '' }];
  assert.equal(walletBalanceRowsV1(missing).shown.length, 1);
  assert.equal(todayWalletCheckV1(missing).unchecked.length, 1);
});

test('search distinguishes same-symbol contracts by address and accepts case and whitespace', () => {
  const shown = walletBalanceRowsV1(rows).shown;
  assert.deepEqual(searchWalletBalancesV1(shown, ' nvdaC ').map(row => row.address), [official, mismatch]);
  assert.deepEqual(searchWalletBalancesV1(shown, mismatch.toUpperCase()).map(row => row.address), [mismatch]);
  assert.equal(searchWalletBalancesV1(shown, 'no such token').length, 0);
  assert.equal(searchWalletBalancesV1(shown, ' ').length, 5);
});

test('a failed or pending reading never becomes a count of zero stocks or an empty wallet', () => {
  for (const model of [
    { rows, loading: false, unavailableReason: 'Balances unavailable' },
    { rows: [], loading: true, unavailableReason: null },
  ]) {
    const html = renderToStaticMarkup(<TodayWallet model={model} onInvestigate={noop} />);
    assert.doesNotMatch(html, /Official stock|Outside reviewed coverage|No balances to display|NVDAc/);
    assert.match(html, /role="status"/);
  }
});

test('Today carries the supplied portfolio and keeps old controls separate from a recent market measurement', () => {
  const model = todayModelV1({ signedIn: true, stocks: [], question: '', reply: null,
    now: new Date('2026-10-14T15:00:00.000Z'),
    wallet: { rows, check: todayWalletCheckV1(rows), loading: false, failed: false, radar: null,
      trackedB20: 1, controlWatches: [{ tokenAddress: official,
        lastSweptAt: '2026-08-16T15:00:00.000Z', lastReadAt: '2026-08-16T15:00:00.000Z', lastOutcome: 'read',
        schedule: { intervalSeconds: 900, nextDueAt: '2026-10-14T15:03:00.000Z',
          lastCheckedAt: '2026-10-14T14:48:00.000Z', lastCompletedAt: '2026-10-14T14:48:00.000Z',
          lastOutcome: 'measured', checks: 1, completedChecks: 1 } }] },
    actions: { onQuestionChange: noop, onRoute: noop, onInvestigate: noop, onOpenRadar: noop,
      onOpenB20: noop, onAskWallet: noop, onOpenStock: noop, onSignIn: noop },
  });
  assert.equal(model.wallet!.balances!.rows, rows);
  const clocks = model.wallet!.items.find(item => item.key === `b20:${official}`)!.clocks!;
  assert.equal(clocks.find(clock => clock.id === 'controls')!.state, 'Read 59d ago');
  assert.match(clocks.find(clock => clock.id === 'market')!.state, /Measured 12m ago/);
  const html = renderToStaticMarkup(<TodayScreen model={{ ...model, stocksToday: null }} />);
  assert.ok(html.indexOf('id="today-ask-input"') < html.indexOf('aria-label="My wallet"'));
  assert.match(html, /Controls<\/dt>/);
  assert.match(html, /Market watch<\/dt>/);
  assert.doesNotMatch(html, /Their controls are read in the background/);
});

test('the official stocks are named by face, not only counted', () => {
  // 2026-10-19: «Official stocks 2» said how many and not which.
  const quotes = new Map([[official, { iconPath: `/api/public/stocks/icons/${official}.png`, price: '$228.78', change: '+0.10%' }]]);
  const html = renderToStaticMarkup(<TodayWallet model={{ rows, loading: false, unavailableReason: null }}
    onInvestigate={noop} quotes={quotes} />);
  const held = html.slice(html.indexOf('class="today-wallet-held"'));
  assert.match(held, new RegExp(`^class="today-wallet-held"><span class="today-wallet-chip"><img class="mr-choice-icon" src="/api/public/stocks/icons/${official}.png"[^>]*>NVDAc</span>`));
  // The same face beside the row in the full list; a token the board does not
  // know keeps its name alone.
  assert.equal((html.match(new RegExp(`src="/api/public/stocks/icons/${official}.png"`, 'g')) ?? []).length, 2);
  assert.match(html, /<div><strong>UNKNOWN<\/strong>/);
});
