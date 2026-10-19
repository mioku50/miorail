import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TodayScreen } from '../src/console/TodayScreen';
import { todayModelV1, todayWalletCheckV1 } from '../src/console/todayView';
import { briefFixture, TOKEN } from '../../rwa-market-reality/test/fixtures/stockBrief.js';

const nothing = () => {};
void React;
function modelV1(signedIn = true) {
  return { ...todayModelV1({ signedIn, question: '', reply: null,
    stocks: [{ symbol: 'NVDA', name: 'NVIDIA' }],
    wallet: { loading: false, failed: false, overviewUpdatedAt: '2026-10-14T08:00:00.000Z', dataFreshness: 'cached',
      radar: null, trackedB20: null,
      check: todayWalletCheckV1([
        { symbol: 'NVDAc', address: TOKEN, balanceFormatted: '0.000882', registry: { standing: 'official', ticker: 'NVDAc' } },
        { symbol: 'AAPLc', address: `0x${'2'.repeat(40)}`, balanceFormatted: '15', registry: { standing: 'lookalike', ticker: 'AAPLc' } },
        ...Array.from({ length: 32 }, (_, i) => ({ symbol: `TOKEN${i}`, address: `0x${(i + 100).toString(16).padStart(40, '0')}`, balanceFormatted: '1' })),
      ]) },
    actions: { onQuestionChange: nothing, onRoute: nothing, onInvestigate: nothing, onOpenRadar: nothing,
      onOpenB20: nothing, onAskWallet: nothing, onOpenStock: nothing, onOpenDividends: nothing, onSignIn: nothing },
  }), stocksToday: { data: briefFixture(), loading: false, failed: false, refreshing: false, returning: true,
    onRefresh: nothing, onMeasureCashOut: async () => { throw new Error('must not run on render'); } } };
}

test('one finding and one holding lead; the question precedes the full feed and coverage', () => {
  const html = renderToStaticMarkup(<TodayScreen model={modelV1()} />);
  assert.match(html, /Your Base Today/);
  assert.match(html, /Not the official AAPLc/);
  assert.match(html, /Your NVDAc/);
  assert.ok(html.indexOf('Your NVDAc') < html.indexOf('id="today-ask-input"'));
  assert.ok(html.indexOf('id="today-ask-input"') < html.indexOf('id="my-stocks-today"'));
  assert.ok(html.indexOf('id="today-ask-input"') < html.indexOf('32 tokens outside'));
  assert.doesNotMatch(html, /<details[^>]* open|tokens nobody checked|no list vouches/);
  assert.match(html, />Dividends<\/button>/);
  assert.match(html, />View market<\/button>/);
  const lead = html.slice(html.indexOf('class="today-stock"'), html.indexOf('id="today-ask-input"'));
  assert.match(lead, /aria-label="Share NVDA stock card"/);
  // One "Share" among the card's actions, not two more buttons on their own row.
  assert.equal((lead.match(/<summary class="btn sec">Share<\/summary>/g) ?? []).length, 1);
  assert.ok(lead.indexOf('>View market</button>') < lead.indexOf('<details class="share-fold">'));
  assert.match(lead, />Post on X<\/a>/);
  assert.match(lead, />Cast on Farcaster<\/a>/);
  assert.match(lead, /miorail.xyz%2Fstocks%2Fnvda/);
  assert.match(html, /Oct 14, 08:00 AM UTC · cached data/);
});

test('outside coverage is neutral and never becomes a suspicious-token finding', () => {
  const model = modelV1();
  const coverage = model.wallet!.items.find(item => item.key === 'unchecked')!;
  assert.equal(coverage.attention, false);
  assert.match(coverage.body, /coverage gap, not a risk finding/);
  const html = renderToStaticMarkup(<TodayScreen model={model} />);
  assert.equal((html.match(/class="cardrow" data-tone="attention"/g) ?? []).length, 1);
  assert.doesNotMatch(coverage.title, /suspicious|unsafe|danger/i);
});

test('unknown dates and unavailable changes are not fabricated as fresh data or zero updates', () => {
  const model = modelV1();
  model.wallet!.overviewUpdatedAt = 'unread';
  model.stocksToday.data.changesUnavailable = true;
  const html = renderToStaticMarkup(<TodayScreen model={model} />);
  assert.match(html, /Wallet overview time unavailable/);
  const hero = html.slice(0, html.indexOf('</header>'));
  assert.doesNotMatch(hero, /\d+<\/strong> updates|Invalid Date/);
});

test('a guest never sees wallet findings or stock data, even if a stale model is supplied', () => {
  const html = renderToStaticMarkup(<TodayScreen model={modelV1(false)} />);
  assert.match(html, /id="today-ask-input"/);
  assert.doesNotMatch(html, /AAPLc|NVDAc|My stocks today|cached data/);
});
