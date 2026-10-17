import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TodayAavePosition, type TodayAavePositionModelV1 } from '../src/console/TodayAavePosition';
import { AAVE_V4_BASE_SPOKE_V1 } from '@mioagent/rwa-issuer/aaveV4';

void React;
const data: NonNullable<TodayAavePositionModelV1['data']> = {
  schemaVersion: 'aave-v4-position/v1', chainId: 8453, walletAddress: '0x'+'1'.repeat(40),
  spokeAddress: AAVE_V4_BASE_SPOKE_V1, observedAt: '2026-10-14T12:00:00Z', source: 'aave_api',
  state: 'read', collateralUsd: '2000', debtUsd: '500', netAccruedInterestUsd: '-0.005',
  netBorrowApyBps: 333, healthFactor: '0.99', remainingBorrowingPowerUsd: '0',
};
const model = (over: Partial<TodayAavePositionModelV1> = {}) => ({
  data: null, loading: false, failed: false, onRead: () => { throw new Error('must not read on render'); }, ...over,
});
test('Aave section is collapsed and never reads on render; a failed read is not an empty position', () => {
  const html = renderToStaticMarkup(<TodayAavePosition model={model()} />);
  assert.doesNotMatch(html, /<details[^>]*open|No position was returned/);
  assert.match(html, /Read my Aave position/);
  const failed = renderToStaticMarkup(<TodayAavePosition model={model({ failed: true })} />);
  assert.match(failed, /does not mean you have no position/); assert.doesNotMatch(failed, /No position was returned/);
});
test('Aave debt, health and net interest are shown with their source, threshold and scope', () => {
  const html = renderToStaticMarkup(<TodayAavePosition model={model({ data })} />);
  assert.match(html, /\$500.00/); assert.match(html, /3.33%/); assert.match(html, /0.99/);
  assert.match(html, /−less than \$0.01/); assert.match(html, /Liquidation threshold: health factor 1/);
  assert.match(html, /class="note warn"/); assert.match(html, /Aave API read/); assert.match(html, /Base MAG7 market only/);
  assert.doesNotMatch(html, /You can borrow|Safe|guaranteed/i);
  const charged = renderToStaticMarkup(<TodayAavePosition model={model({ data: { ...data, netAccruedInterestUsd: '-1234.5' } })} />);
  assert.match(charged, /−\$1,234.50/); assert.doesNotMatch(charged, /\$-/);
});
test('empty and no-debt positions remain distinct, and refresh failure retains the date', () => {
  const empty = renderToStaticMarkup(<TodayAavePosition model={model({ data: { ...data, state: 'empty',
    collateralUsd: null, debtUsd: null, netAccruedInterestUsd: null, netBorrowApyBps: null, healthFactor: null,
    remainingBorrowingPowerUsd: null } })} />);
  assert.match(empty, /Other Aave markets were not checked/); assert.doesNotMatch(empty, /\$500/);
  const noDebt = renderToStaticMarkup(<TodayAavePosition model={model({ data: { ...data, debtUsd: '0', healthFactor: null }, failed: true })} />);
  assert.match(noDebt, /No debt health factor returned/); assert.match(noDebt, /previous result/);
});
