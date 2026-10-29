import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LendingReviewScreen } from '../src/console/LendingReviewScreen';
import { parseLendingReviewWireV1, parseLendingExecutionWireV1, lendingExecutionCopyV1, type LendingReadyWireV1 } from '../src/console/lendingReviewView';
import type { LendingReviewConsoleModelV1 } from '../src/console/useLendingReviewConsole';
import { RepayEntryScreen, type RepayEntryModelV1 } from '../src/console/RepayEntryScreen';
import { REPAY_COLLATERALS_V1, repayCapacityViewV1, repayInitialAssetV1, repayIntentAmountsV1 } from '../src/console/repayEntry';

void React;
const NOOP = () => {};
const ADDRESS = '0x1111111111111111111111111111111111111111';
const NOW = '2026-10-29T03:45:00Z';
function ready(): LendingReadyWireV1 {
  return { state: 'ready', executionId: 'execution_1', callsHash: `0x${'1'.repeat(64)}`, signingTermsHash: `0x${'2'.repeat(64)}`, expiresAt: NOW,
    atomicRequired: true, calls: [{ to: ADDRESS, data: '0x12345678', value: '0' }], steps: [{ index: 0, to: ADDRESS, reading: 'Repays debt without withdrawing collateral.' }],
    measured: { provider: 'fixture', blockNumber: 53_200_001, loanDeltaAssets: '-3000000' },
    facts: { operation: 'repay', venue: 'morpho', collateralTokenAddress: ADDRESS, collateralSymbol: 'cbBTC', collateralDecimals: 8, marketId: `0x${'a'.repeat(64)}`,
      amountMode: 'assets', requestedAssets: '3000000', maximumDebitAssets: '3000000', collateralSupplyAssets: '0',
      debtBeforeAssets: '3125001', debtAfterAssets: '125001', collateralBeforeAssets: '1234567', collateralAfterAssets: '1234567', debtBeforeShares: '3125001000000', debtAfterShares: '125001000000', blockNumber: 53_200_000, warnings: [] } };
}
function model(patch: Partial<LendingReviewConsoleModelV1> = {}): LendingReviewConsoleModelV1 {
  return { loading: false, error: null, body: ready(), walletBusy: false, walletError: null, submissionLock: null, batchId: null,
    execution: null, checking: false, onOpen: NOOP, onCheck: NOOP, ...patch };
}
const render = (patch: Partial<LendingReviewConsoleModelV1> = {}) => renderToStaticMarkup(<LendingReviewScreen model={model(patch)} />);
function entry(patch: Partial<RepayEntryModelV1> = {}): RepayEntryModelV1 {
  return { signedIn: true, signInHref: '/signin', asset: 'cbBTC', mode: 'assets', amount: '', maximum: '', read: null,
    reading: false, preparing: false, error: null, onAsset: NOOP, onMode: NOOP, onAmount: NOOP, onMaximum: NOOP, onRead: NOOP, onReview: NOOP, ...patch };
}
const capacity = { venue: 'morpho' as const, marketId: `0x${'a'.repeat(64)}`, collateralTokenAddress: REPAY_COLLATERALS_V1[0]!.token,
  collateralSymbol: 'cbBTC', collateralDecimals: 8, debtAtomic: '3125001', walletUsdcAtomic: '4500000', blockNumber: 53_200_000 };

describe('lending ready/refused wire boundaries', () => {
  it('accepts only a complete atomic server review with exact aligned calls and readings', () => {
    assert.equal(parseLendingReviewWireV1(ready())?.state, 'ready');
    for (const changed of [
      { atomicRequired: false }, { executionId: undefined }, { callsHash: 'invalid' }, { signingTermsHash: undefined },
      { steps: [] }, { steps: [{ index: 1, to: ADDRESS, reading: 'Wrong order' }] },
      { calls: [{ to: ADDRESS, value: '1', data: '0x12345678' }] }, { measured: null }, { facts: { ...ready().facts, debtBeforeAssets: null } },
    ]) assert.equal(parseLendingReviewWireV1({ ...ready(), ...changed }), null);
  });
  it('supports up to eight protocol calls while retaining mandatory signing terms', () => {
    const body = ready();
    body.calls = Array.from({ length: 8 }, () => ({ ...body.calls[0]! }));
    body.steps = body.calls.map((call, index) => ({ index, to: call.to, reading: 'A checked call.' }));
    assert.equal(parseLendingReviewWireV1(body)?.state, 'ready');
    body.calls.push(body.calls[0]!); body.steps.push({ ...body.steps[0]!, index: 8 });
    assert.equal(parseLendingReviewWireV1(body), null);
  });
  it('strips executable fields from a refusal while keeping its owned execution result link', () => {
    const parsed = parseLendingReviewWireV1({ ...ready(), state: 'refused', refusal: 'lending_submission_pending', detail: 'Check the existing result.', executionState: 'unknown' });
    assert.equal(parsed?.state, 'refused'); assert.equal('calls' in parsed!, false);
    assert.equal(parsed?.executionId, 'execution_1');
  });
  it('does not accept an execution belonging to a different id or an invalid transaction hash', () => {
    const row = { executionId: 'execution_1', state: 'submitted', transactionHash: null, errorCode: null };
    assert.equal(parseLendingExecutionWireV1(row, 'execution_1')?.state, 'submitted');
    assert.equal(parseLendingExecutionWireV1(row, 'other'), null);
    assert.equal(parseLendingExecutionWireV1({ ...row, state: 'complete' }, 'execution_1'), null);
    assert.equal(parseLendingExecutionWireV1({ ...row, transactionHash: 'batch_1' }, 'execution_1'), null);
  });
});

describe('lending review presentation does not call a submission a repayment', () => {
  it('shows exact before/after debt, retained collateral and maximum funding before the wallet control', () => {
    const html = render();
    assert.match(html, /Review repayment/); assert.match(html, /3\.125001 USDC/); assert.match(html, /0\.125001 USDC/);
    assert.match(html, /0\.01234567 cbBTC/); assert.match(html, /Maximum USDC funding/); assert.match(html, /collateral stays deposited/);
    assert.match(html, /53,200,000/); assert.match(html, /53,200,001/); assert.match(html, /Open in your wallet/);
    assert.doesNotMatch(html, /Confirmed onchain|Repayment completed/);
  });
  it('all has an explicit maximum and never uses the rounded debt as its amount', () => {
    const body = ready(); body.facts.amountMode = 'all'; body.facts.requestedAssets = null; body.facts.maximumDebitAssets = '4000000';
    const html = render({ body }); assert.match(html, /entire debt position at execution/); assert.match(html, /4 USDC/); assert.doesNotMatch(html, /Repay exactly/);
  });
  it('formats server health ratios exactly without rounding a ratio below one up to one', () => {
    const body = ready(); body.facts.healthBeforeWad = '999999999999999999'; body.facts.healthAfterWad = null;
    const html = render({ body }); assert.match(html, /0\.999999999999999999/); assert.match(html, /Not read/);
    assert.doesNotMatch(html, /1\.00|safe|healthy/);
    assert.equal(parseLendingReviewWireV1({ ...body, facts: { ...body.facts, healthAfterWad: -1 } }), null);
  });
  it('names server Still and protocol total-debt limits and the terms version for borrowing', () => {
    const body = ready(); body.facts = { ...body.facts, operation: 'borrow', policyLimitAssets: '12500000', protocolLimitAssets: '25000000', termsVersion: '2026-10-26' };
    const html = render({ body }); assert.match(html, /Still total debt limit: 12\.5 USDC/); assert.match(html, /Protocol total debt limit: 25 USDC/);
    assert.match(html, /Terms version: 2026-10-26/);
  });
  it('never renders a wallet action for a refusal even with a stale onOpen callback', () => {
    const html = render({ body: { state: 'refused', refusal: 'not_established', detail: 'Debt was not read.' } });
    assert.match(html, /Debt was not read/); assert.doesNotMatch(html, /Open in your wallet|After these calls|Maximum USDC/);
    assert.doesNotMatch(html, /Morpho|Aave V4|Review loan/);
  });
  it('masks a private review entirely behind its identity/read error', () => {
    const html = render({ error: 'Connect the correct wallet.' }); assert.doesNotMatch(html, /3\.125001|0\.01234567|Open in your wallet/);
  });
  for (const state of ['awaiting_wallet', 'submitted', 'unknown', 'confirmed', 'failed'] as const) it(`keeps ${state} actions locked and uses only the server status`, () => {
    const html = render({ execution: { executionId: 'execution_1', state, transactionHash: null, errorCode: null } });
    assert.doesNotMatch(html, /Open in your wallet/);
    assert.match(html, /Check onchain result/);
    assert.equal(html.includes('Confirmed onchain:'), state === 'confirmed');
    assert.equal(lendingExecutionCopyV1(state).length > 0, true);
  });
  it('a wallet batch id remains a submission handle', () => {
    const html = render({ batchId: 'batch_1' }); assert.match(html, /not a confirmed blockchain result/); assert.doesNotMatch(html, /Open in your wallet|Confirmed onchain:/);
  });
});

describe('repayment entry is exact and does not choose a wallet maximum', () => {
  it('accepts query selections only from the code-owned collateral set', () => {
    assert.equal(repayInitialAssetV1('?asset=NVDAc'), 'NVDAc'); assert.equal(repayInitialAssetV1('?asset=ETH'), 'WETH');
    assert.equal(repayInitialAssetV1('?token='+REPAY_COLLATERALS_V1[0]!.token), 'cbBTC');
    assert.equal(repayInitialAssetV1('?token='+ADDRESS), null);
  });
  it('binds the read to the exact registered token and preserves unread versus zero', () => {
    assert.equal(repayCapacityViewV1({ state: 'read', read: capacity }, capacity.collateralTokenAddress).read?.debtAtomic, '3125001');
    assert.equal(repayCapacityViewV1({ state: 'read', read: { ...capacity, debtAtomic: '0' } }, capacity.collateralTokenAddress).read?.debtAtomic, '0');
    assert.equal(repayCapacityViewV1({ state: 'read', read: { ...capacity, debtAtomic: null } }, capacity.collateralTokenAddress).read, null);
    assert.equal(repayCapacityViewV1({ state: 'read', read: { ...capacity, collateralTokenAddress: ADDRESS } }, capacity.collateralTokenAddress).read, null);
    assert.match(repayCapacityViewV1({ state: 'refused', detail: 'USDC not read.' }, capacity.collateralTokenAddress).error!, /USDC not read/);
  });
  it('requires typed full-repay budget and parses six decimals without rounding', () => {
    assert.deepEqual(repayIntentAmountsV1({ mode: 'assets', amount: '3.000001', maximum: '', walletUsdcAtomic: '4500000' }).intent,
      { amountMode: 'assets', repayAmountAtomic: '3000001', maximumUsdcAtomic: '3000001' });
    assert.deepEqual(repayIntentAmountsV1({ mode: 'all', amount: '3', maximum: '4', walletUsdcAtomic: '4500000' }).intent,
      { amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '4000000' });
    for (const text of ['', '3.0000001', '3e0', '0', '-1', '4.500001']) assert.equal(repayIntentAmountsV1({ mode: 'all', amount: '3', maximum: text, walletUsdcAtomic: '4500000' }).intent, null);
  });
  it('hides a supplied private balance when signed out', () => {
    const html = renderToStaticMarkup(<RepayEntryScreen model={entry({ signedIn: false, read: capacity })} />);
    assert.match(html, /Sign in/); assert.doesNotMatch(html, /3\.125001|4\.5|Read repayment position|Review repayment|<input/);
  });
  it('never autofills an amount or maximum from the position and names zero only from a read', () => {
    const html = renderToStaticMarkup(<RepayEntryScreen model={entry({ mode: 'all', read: capacity })} />);
    assert.match(html, /Enter your own maximum/); assert.match(html, /value=""/); assert.doesNotMatch(html, /value="4\.5"|>Max<|value="3\.125001"/);
    assert.match(renderToStaticMarkup(<RepayEntryScreen model={entry({ read: { ...capacity, debtAtomic: '0' } })} />), /No debt was recorded in this market/);
    assert.doesNotMatch(renderToStaticMarkup(<RepayEntryScreen model={entry()} />), /No debt was recorded/);
  });
});
