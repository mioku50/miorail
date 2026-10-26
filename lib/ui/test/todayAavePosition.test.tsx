import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MirrorReport } from '@mioagent/still-engine/report';
import { TodayAavePosition, type TodayAavePositionModelV1 } from '../src/console/TodayAavePosition';

void React;

type Venue = MirrorReport['venues'][number];
type Line = MirrorReport['assets'][number];

// The example portfolio Still's engine tests compute: 3.4 NVDAc pledged at $211.90, $240.17 owed.
const NVDA: Line = {
  asset: 'NVDAc', kind: 'stock', name: 'NVIDIA', symbol: 'NVDAc', token: '0xb2000000000000000000001ba3d2eb3a2f32f1b6',
  isin: 'US67066G1040', venue: 'aave-v4', wallet: { raw: '80000000', decimals: 8 }, pledged: { raw: '340000000', decimals: 8 },
  shares: null, priceCents: '21190', priceUpdatedAt: '2026-10-21T14:00:00.000Z', valueCents: '89000', protocolFactorBps: 7000,
  stillFactorBps: 3500, capacityCents: '31150', earnings: null, limits: [], failed: [],
};
const AAVE: Venue = {
  venue: 'aave-v4', market: '0x17905db0e4a3514467539956c084180616ae7b8d', label: 'Aave V4 · Coinbase Stocks',
  debtCents: '24017', capacityCents: '61045', availableCents: '37028', borrowRateBps: 366, liquidityCents: '109645815',
  deductions: { loansCents: '24017', venueLimitCents: '0' },
  safety: { marginBps: 5237, state: 'calm', healthFactor: '2099920000000000000', source: 'computed' },
  liquidationPrices: [{ asset: 'NVDAc', priceCents: '10092', unreachable: false }], failed: [],
};
function report(over: { venues?: Venue[]; assets?: Line[] } = {}): MirrorReport {
  return {
    kind: 'still.mirror', version: 1,
    subject: { address: `0x${'1'.repeat(40)}`, name: null, input: `0x${'1'.repeat(40)}` },
    reading: { block: '53118515', blockTime: '2026-10-26T14:52:57.000Z', assembledAt: '2026-10-26T14:52:58.000Z', provider: 'infura' },
    terms: {
      version: '2026-10-25', stockShareBps: 5000, cryptoShareBps: 5000,
      weekend: { active: false, startsAt: '2026-10-31T00:00:00.000Z', endsAt: '2026-11-02T01:00:00.000Z', stockShareBps: 4000 },
      earnings: { stockShareBps: 4000, calendarReadAt: '2026-10-26T14:00:00.000Z' },
    },
    headline: { state: 'funded', availableCents: '37028', complete: true, reason: null, weekdayAvailableCents: null },
    assets: over.assets ?? [NVDA], venues: over.venues ?? [AAVE],
    coverage: { measured: [], notCounted: [], failed: [] }, evidence: [],
  };
}
const model = (over: Partial<TodayAavePositionModelV1> = {}) => ({
  data: null, loading: false, failed: false, onRead: () => { throw new Error('must not read on render'); }, ...over,
});

test('Aave section is collapsed and never reads on render; a failed read is not an empty position', () => {
  const html = renderToStaticMarkup(<TodayAavePosition model={model()} />);
  assert.doesNotMatch(html, /<details[^>]*open|No pledged stocks/);
  assert.match(html, /Read my Aave position/);
  const failed = renderToStaticMarkup(<TodayAavePosition model={model({ failed: true })} />);
  assert.match(failed, /does not mean you have no position/); assert.doesNotMatch(failed, /No pledged stocks/);
});

test('the position comes from the chain, with its block, threshold and scope', () => {
  const html = renderToStaticMarkup(<TodayAavePosition model={model({ data: report() })} />);
  assert.match(html, /block 53,118,515/); assert.match(html, /Aave v4 Coinbase Stocks market only/);
  // 3.4 × $211.90, rounded down to the cent.
  assert.match(html, /\$720.46/); assert.match(html, /\$240.17/); assert.match(html, /3.66% a year, variable/);
  assert.match(html, /2.0999/); assert.match(html, /52% together before liquidation/);
  assert.match(html, /Below \$100.92 if only it moved/); assert.match(html, /\$370.28/);
  assert.match(html, /health factor falls to 1/); assert.match(html, /class="lnote">Liquidation/);
  assert.doesNotMatch(html, /You can borrow|Safe|guaranteed|Aave API/i);
});

test('a position near liquidation is said in the warning colour, and only then', () => {
  const near = { ...AAVE, safety: { ...AAVE.safety!, marginBps: 300, state: 'act' as const, healthFactor: '1031000000000000000' } };
  const html = renderToStaticMarkup(<TodayAavePosition model={model({ data: report({ venues: [near] }) })} />);
  assert.match(html, /class="note warn">Liquidation/); assert.match(html, /1.031/);
});

test('nothing pledged and no debt is one sentence, an unread debt is never a zero, and a failed refresh keeps the date', () => {
  const empty = renderToStaticMarkup(<TodayAavePosition model={model({ data: report({ venues: [], assets: [] }) })} />);
  assert.match(empty, /No pledged stocks and no debt/); assert.match(empty, /Other Aave markets were not checked/);
  assert.doesNotMatch(empty, /\$240.17/);
  const unread = { ...AAVE, debtCents: null, availableCents: null, safety: null, liquidationPrices: [], failed: ['Aave USDC debt'] };
  const html = renderToStaticMarkup(<TodayAavePosition model={model({ data: report({ venues: [unread] }), failed: true })} />);
  assert.match(html, /Debt<\/dt><dd>Not read/); assert.match(html, /Not read this time: Aave USDC debt/);
  assert.match(html, /previous result/); assert.doesNotMatch(html, /No pledged stocks/);
});
