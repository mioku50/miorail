import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LendingReviewScreen } from '../src/console/LendingReviewScreen';
import { describeLendingTermsChangesV1, lendingBackLinkV1, parseLendingReviewWireV1, parseLendingExecutionWireV1, lendingExecutionCopyV1, type LendingReadyWireV1 } from '../src/console/lendingReviewView';
import { stepsStoppedV1, stepsUnknownV1, type LendingReviewConsoleModelV1 } from '../src/console/useLendingReviewConsole';
import { RepayEntryScreen, type RepayEntryModelV1 } from '../src/console/RepayEntryScreen';
import { REPAY_COLLATERALS_V1, repayCanReturnV1, repayCapacityViewV1, repayInitialAssetV1, repayIntentAmountsV1, repayTopUpAtomicV1 } from '../src/console/repayEntry';

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
    reading: false, preparing: false, error: null, canReturn: false, onAsset: NOOP, onMode: NOOP, onAmount: NOOP, onMaximum: NOOP, onRead: NOOP, onReview: NOOP, onTakeBack: NOOP, onMax: NOOP, ...patch };
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
  it('accepts only the pinned Morpho BlueBundlesV1 value-bearing call for native ETH borrowing', () => {
    const bundle = '0x4d28d900e381ece4b351302f1abe588496793a2b';
    const morpho = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
    const weth = '0x4200000000000000000000000000000000000006';
    for (const authorizedBefore of [false, true]) {
      const base = ready();
      base.facts = {
        ...base.facts, operation: 'borrow', venue: 'morpho', collateralTokenAddress: weth,
        collateralSymbol: 'WETH', collateralDecimals: 18, collateralSupplyAssets: '10000000000000000', maximumDebitAssets: '0',
        nativeFunding: {
          maximumNativeAssets: '10000000000000000', reserveAssets: '500000000000000',
          balanceBeforeAssets: '25000000000000000', balanceAfterAssets: '15000000000000000',
          authorizedBefore, feeQuoteState: 'wallet_quote_required',
        },
      };
      base.calls = authorizedBefore
        ? [{ to: bundle, value: '10000000000000000', data: '0x04a06d67' }]
        : [
            { to: morpho, value: '0', data: '0xeecea000' },
            { to: bundle, value: '10000000000000000', data: '0x04a06d67' },
            { to: morpho, value: '0', data: '0xeecea000' },
          ];
      base.steps = base.calls.map((c, index) => ({ index, to: c.to, reading: 'Checked native step.' }));
      assert.equal(parseLendingReviewWireV1(base)?.state, 'ready');
      const html = render({ body: base });
      assert.match(html, /Wrap and pledge exactly 0\.01 ETH\./);
      assert.match(html, /0\.015 ETH/);
      assert.match(html, /0\.0005 ETH/);
      assert.match(html, /Wallet-held WETH is not spent/);
      assert.equal(parseLendingReviewWireV1({ ...base, calls: base.calls.map(c => c.to === bundle ? { ...c, to: ADDRESS } : c),
        steps: base.steps.map(s => s.to === bundle ? { ...s, to: ADDRESS } : s) }), null);
    }
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
  it('formats server health ratios exactly without rounding a ratio below one up to one, and explains repayment health ratio N/A', () => {
    const repayBody = ready(); repayBody.facts.healthBeforeWad = null; repayBody.facts.healthAfterWad = null;
    const repayHtml = render({ body: repayBody });
    assert.match(repayHtml, /— Not applicable \(repayment only reduces debt\)/);
    assert.match(repayHtml, /Health ratio is not checked during repayment: repaying USDC only reduces your debt and keeps collateral deposited, so execution does not depend on live oracle prices\./);
    assert.doesNotMatch(repayHtml, /Health ratio<\/th><td class="mono">Not read/);

    const body = ready(); body.facts.operation = 'borrow'; body.facts.healthBeforeWad = '999999999999999999'; body.facts.healthAfterWad = null;
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
  it('a loan stopped in steps reads as stopped with what landed, never as a revert', () => {
    const html = render({ execution: { executionId: 'execution_1', state: 'failed', transactionHash: null, errorCode: 'loan_steps_stopped' } });
    assert.match(html, /Stopped part way: the steps that landed are in place on Base, and the rest was never sent\. You can repay or start a new review now\./);
    assert.doesNotMatch(html, /reverted onchain/);
    assert.match(lendingExecutionCopyV1('failed', 'loan_step_reverted'), /reverted onchain/);
  });
  it('a later step the wallet may have sent is never said to be unsent', () => {
    // Steps 1–2 landed, and the wallet did not answer for step 3.
    const unknown = stepsUnknownV1('borrow', 2, 3);
    assert.equal(unknown, 'The wallet did not say whether it sent step 3 of 3. Steps 1–2 are in place; check the onchain result before pressing again.');
    assert.doesNotMatch(unknown, /not sent|no loan was taken/);
    // The payment of a Spend loan, with the loan in place.
    const paying = stepsUnknownV1('borrow', 3, 4, true);
    assert.match(paying, /^The wallet did not say whether it sent the payment to Bitrefill\. The loan is in place/);
    assert.doesNotMatch(paying, /was not sent/);
    // Declined, it is unsent, and says so.
    assert.match(stepsStoppedV1('borrow', 2, 3, 'You declined step 3 of 3.'), /^You declined step 3 of 3\. Steps 1–2 are in place, and no loan was taken\./);
  });
  // Re-audit R4, 2026-11-04: words about money that the chain contradicted.
  it('a repay-all whose take-back step did not go out says the debt is repaid, and an unknown payment does not place the USDC', () => {
    const declined = stepsStoppedV1('repay', 2, 3, 'You declined step 3 of 3.', false, true);
    assert.equal(declined, 'You declined step 3 of 3. Your debt is repaid, and your collateral was not taken back yet. Open Repay to take it back.');
    assert.doesNotMatch(declined, /nothing was repaid/);
    assert.match(stepsUnknownV1('repay', 2, 3, false, true), /^The wallet did not say whether it sent step 3 of 3, which takes your collateral back\. Your debt is repaid;/);
    // Stopped before the repayment, nothing was repaid, take-back or not.
    assert.match(stepsStoppedV1('repay', 1, 3, null, false, true), /^Step 2 of 3 was not sent\. Step 1 is in place, and nothing was repaid\./);
    assert.match(stepsStoppedV1('repay', 1, 2, null), /nothing was repaid/);
    const paying = stepsUnknownV1('borrow', 3, 4, true);
    assert.match(paying, /either still in your wallet or already with Bitrefill/);
    assert.doesNotMatch(paying, /the USDC is in your wallet/);
  });
  it('a wallet batch id remains a submission handle', () => {
    const html = render({ batchId: 'batch_1' }); assert.match(html, /not a confirmed blockchain result/); assert.doesNotMatch(html, /Open in your wallet|Confirmed onchain:/);
  });
  it('shows No debt (N/A) instead of uint256.max when debt is zero, explains 0.05 -> 0.050001 USDC share rounding, and consolidates warnings into one risk block', () => {
    const body = ready();
    body.measured = { provider: 'base_same_state', blockNumber: 53_298_711, loanDeltaAssets: '50000' };
    body.facts = {
      ...body.facts,
      operation: 'borrow',
      venue: 'aave-v4',
      collateralSymbol: 'NVDAc',
      collateralDecimals: 8,
      requestedAssets: '50000',
      maximumDebitAssets: '0',
      collateralSupplyAssets: '80000',
      debtBeforeAssets: '0',
      debtAfterAssets: '50001',
      collateralBeforeAssets: '0',
      collateralAfterAssets: '80000',
      collateralBeforeShares: '0',
      collateralAfterShares: '80000',
      debtBeforeShares: '0',
      debtAfterShares: '49505',
      healthBeforeWad: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      healthAfterWad: '2264514777517564444',
      warnings: [
        'This also enables your selected stock deposit as collateral in this Spoke.',
        'This creates USDC debt in the reviewed Aave V4 equities Spoke. Its existing collateral and USDC debt are measured together.',
        'Still’s 2026-10-26 allowance was checked at the simulation block. Prices, rates and financial windows can change before your wallet submits.',
        'Aave enforces its own health rules onchain. Your collateral can be liquidated. A server review is not an onchain price or Still-limit guarantee.',
      ],
    };
    assert.equal(parseLendingReviewWireV1(body)?.state, 'ready');
    const html = render({ body });
    assert.match(html, /— No debt \(N\/A\)/);
    assert.doesNotMatch(html, /115792089237316195423570985008687907853269984665640564039457/);
    assert.match(html, /2\.264514777517564444/);
    assert.match(html, /Health ratio is calculated at the simulation block\. It does not guarantee protection against liquidation after prices change\./);
    assert.match(html, /Your wallet receives 0\.05 USDC \(50000 atomic USDC\)\. Onchain debt-share rounding records 0\.050001 USDC \(50001 atomic USDC\) of new debt\./);
    assert.match(html, /borrow request: 50000, wallet USDC delta: 50000, collateral supply: 80000; debt: 0 → 50001 \(shares: 0 → 49505\); collateral: 0 → 80000 \(shares: 0 → 80000\)/);
    assert.equal((html.match(/class="still-warn"/g) ?? []).length, 1);
    for (const warning of body.facts.warnings) assert.equal(html.includes(warning), true);
    assert.match(html, /Transaction preview unavailable/);
    assert.match(html, /Step 1 of 1 · NVDAc token/);

    const subtick = structuredClone(body);
    subtick.facts.healthAfterWad = '2264514776615360449';
    assert.equal(
      describeLendingTermsChangesV1(body, subtick),
      'The terms changed. Read the updated review, then open your wallet again to accept these exact terms.',
    );

    const next = structuredClone(body);
    next.signingTermsHash = `0x${'9'.repeat(64)}`;
    next.facts.healthAfterWad = '2494032094713526717';
    assert.equal(
      describeLendingTermsChangesV1(body, next),
      'The terms changed (health ratio after (2.264514777517564444 → 2.494032094713526717)). Read the updated review, then open your wallet again to accept these exact terms.',
    );

    // Only the calls are new (a loan's deadline moves on every fresh read):
    // that is said as what it is, and the second press is still the person's.
    const recalled = structuredClone(body);
    recalled.callsHash = `0x${'8'.repeat(64)}`;
    assert.equal(
      describeLendingTermsChangesV1(body, recalled),
      'The calls were prepared again for this moment. The amounts, collateral, health ratio and limits above did not change. Open your wallet again to send these exact calls.',
    );
  });
});

describe('repayment entry is exact and does not choose a wallet maximum', () => {
  it('shows sub-cent micro-debt as 0.000002 USDC without rounding to zero', () => {
    const html = renderToStaticMarkup(<RepayEntryScreen model={entry({ read: { ...capacity, debtAtomic: '2' } })} />);
    assert.match(html, /0\.000002 USDC/);
    assert.match(html, /Exact micro-debt of 0\.000002 USDC \(2 atomic USDC\) is shown without rounding to zero/);
  });
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
  it('never autofills an amount or maximum from the position, and Max fills only when pressed', () => {
    const html = renderToStaticMarkup(<RepayEntryScreen model={entry({ mode: 'all', read: capacity })} />);
    assert.match(html, /Enter your own maximum: it is a cap, not the amount\./); assert.match(html, /value=""/); assert.doesNotMatch(html, /value="4\.5"|value="3\.125001"/);
    // 2026-11-07, the operator: the cap read as a second, larger debt (0.95 against 0.78 owed). The
    // note says what is repaid, the debt read and its interest, and that the cap is not it.
    assert.match(html, /This repays the whole debt: 3\.125001 USDC at block [\d,]+, plus the interest until your transaction lands\./);
    // 2026-11-01, the operator: a Max beside the amount, so the wallet need not be opened to look.
    // It is the person's press, never a value the page chose for them.
    assert.match(html, /<button type="button" class="still-borrow-max" title="All the USDC in your wallet, as the most this can spend">Max<\/button>/);
    assert.match(renderToStaticMarkup(<RepayEntryScreen model={entry({ read: { ...capacity, debtAtomic: '0' } })} />), /No debt was recorded in this market/);
    assert.doesNotMatch(renderToStaticMarkup(<RepayEntryScreen model={entry()} />), /No debt was recorded/);
  });

  it('a loan that pays Bitrefill names the payment, its address and its price before the wallet control', () => {
    const body = ready();
    const payment = { merchant: 'bitrefill' as const, orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', payTo: '0x3333333333333333333333333333333333333333', assets: '13250000',
      productName: 'Bitrefill eSIM Germany', packageValue: '10GB, 30 Days', faceCurrency: 'USD', expiresAt: '2026-11-01T12:15:00.000Z' };
    Object.assign(body.facts, { operation: 'borrow', requestedAssets: '13250000', maximumDebitAssets: '0', payment });
    assert.ok(parseLendingReviewWireV1(body));
    const html = render({ body });
    assert.match(html, /Then pay Bitrefill 13\.25 USDC for Bitrefill eSIM Germany · 10GB, 30 Days, in the same transaction\./);
    assert.match(html, /0x3333333333333333333333333333333333333333/);
    // A payment of another amount than the loan, or on a repayment, is not a review.
    assert.equal(parseLendingReviewWireV1({ ...body, facts: { ...body.facts, payment: { ...payment, assets: '13250001' } } }), null);
    assert.equal(parseLendingReviewWireV1({ ...body, facts: { ...body.facts, operation: 'repay', payment } }), null);
  });
});

describe('a review granted in steps, for a wallet that cannot send a batch', () => {
  const stepsBody = (): LendingReadyWireV1 => ({ ...ready(), atomicRequired: false, delivery: 'sequential',
    calls: [{ to: ADDRESS, data: '0x095ea7b3', value: '0' }, { to: ADDRESS, data: '0x12345678', value: '0' }],
    steps: [{ index: 0, to: ADDRESS, reading: 'Allows only the registered Aave Spoke to move up to 3000000 atomic units; the next step uses exactly this allowance.' },
      { index: 1, to: ADDRESS, reading: 'Repays up to the exact confirmed USDC maximum.' }],
    facts: { ...ready().facts, venue: 'aave-v4' } });

  it('is read only for Aave V4, without native ETH, and never as a half-batch', () => {
    assert.equal(parseLendingReviewWireV1(stepsBody())?.state, 'ready');
    for (const changed of [
      { facts: { ...stepsBody().facts, venue: 'morpho' as const } },
      { atomicRequired: true },
      { delivery: undefined },
      { facts: { ...stepsBody().facts, payment: { merchant: 'bitrefill' as const, orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', payTo: ADDRESS, assets: '3000000',
        productName: 'x', packageValue: '1', faceCurrency: null, expiresAt: NOW } } },
    ]) assert.equal(parseLendingReviewWireV1({ ...stepsBody(), ...changed }), null, JSON.stringify(Object.keys(changed)));
    assert.equal(parseLendingReviewWireV1({ ...ready(), delivery: 'sequential' }), null);
  });

  it('a Spend loan goes in steps with the payment last, to Base USDC, and says so', () => {
    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const payment = { merchant: 'bitrefill' as const, orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', payTo: '0x3333333333333333333333333333333333333333', assets: '3000000',
      productName: 'Bitrefill eSIM Germany', packageValue: '1GB, 7 Days', faceCurrency: 'USD', expiresAt: '2026-11-01T12:15:00.000Z' };
    const base = stepsBody();
    const paying: LendingReadyWireV1 = { ...base, calls: [...base.calls, { to: USDC, data: '0xa9059cbb', value: '0' }],
      steps: [...base.steps, { index: 2, to: USDC, reading: 'Pay Bitrefill: send 3.00 USDC to the invoice address 0x3333…3333' }],
      facts: { ...base.facts, operation: 'borrow', requestedAssets: '3000000', maximumDebitAssets: '0', payment } };
    assert.equal(parseLendingReviewWireV1(paying)?.state, 'ready');
    const html = render({ body: paying });
    assert.match(html, /Then pay Bitrefill 3 USDC for Bitrefill eSIM Germany · 1GB, 7 Days, as the last step\./);
    assert.match(html, /Still reads the invoice again before your wallet is asked for that step; if Bitrefill no longer waits for it, nothing is paid\./);
    assert.match(html, />Open step 1 of 3 in your wallet</);
    // A payment whose last step is anything but the Base USDC transfer is not a review.
    assert.equal(parseLendingReviewWireV1({ ...paying, calls: [...base.calls, { to: ADDRESS, data: '0xa9059cbb', value: '0' }],
      steps: [...base.steps, { index: 2, to: ADDRESS, reading: 'Pay Bitrefill' }] }), null);
    // The batch review still says "in the same transaction".
    assert.match(render({ body: { ...paying, atomicRequired: true, delivery: undefined } as LendingReadyWireV1 }), /, in the same transaction\./);
  });

  it('says it goes in steps, opens step one, and shows where the steps stand', () => {
    const html = render({ body: stepsBody() });
    assert.match(html, /Steps in your wallet \(2 transactions\)/);
    assert.match(html, /reviews each next step again, from the chain as it is then, before your wallet asks for it/);
    assert.doesNotMatch(html, /Verified atomic batch|Transaction preview unavailable/);
    assert.match(html, />Open step 1 of 2 in your wallet</);
    assert.match(render({ body: stepsBody(), walletBusy: true, step: { index: 2, total: 2, phase: 'wallet' } }), /Step 2 of 2: confirm it in your wallet\./);
    assert.match(render({ body: stepsBody(), walletBusy: true, step: { index: 1, total: 2, phase: 'checking' } }), /Step 1 of 2 landed\. Still checks the next step against the chain…/);
    // A batch review reads as before.
    assert.match(render(), />Open in your wallet</);
  });

  it('binds a far health ratio as one bucket on the client too', () => {
    const far = (wad: string) => ({ ...ready(), facts: { ...ready().facts, operation: 'borrow' as const, requestedAssets: '180000', maximumDebitAssets: '0', debtBeforeAssets: '3', healthBeforeWad: wad } });
    assert.equal(describeLendingTermsChangesV1(far('2152681126303693684440118'), far('2152681088235212709150883')).includes('health ratio'), false);
  });

  // Re-audit R3, 2026-11-04: a step whose answer was lost left the loan holding its market.
  it('offers to stop a loan left part way, saying what is in place and what Still checks first', () => {
    const borrow = { ...stepsBody(), facts: { ...stepsBody().facts, operation: 'borrow' as const, requestedAssets: '180000', maximumDebitAssets: '0' } };
    const execution = { executionId: 'execution_1', state: 'unknown' as const, transactionHash: null, errorCode: 'loan_steps_incomplete', steps: { landed: 2, total: 3, stoppable: true } };
    const html = render({ body: borrow, execution, onStop: NOOP });
    assert.match(html, /Steps 1–2 of 3 are in place on Base, and Still has not seen step 3 land\./);
    assert.match(html, /If you will not send step 3, stop here\. Still first checks on Base that your wallet sent nothing after step 2 and has nothing waiting; only then is this loan recorded as stopped after step 2, and Repay works again\. Do not stop while your wallet still asks you to approve step 3\./);
    assert.match(html, />Stop here</);
    assert.match(render({ body: borrow, execution: { ...execution, steps: { landed: 1, total: 3, stoppable: true } }, onStop: NOOP }), /Step 1 of 3 is in place on Base, and Still has not seen step 2 land\./);
    // A repayment says so; without the server's offer nothing is shown.
    assert.match(render({ body: stepsBody(), execution, onStop: NOOP }), /only then is this repayment recorded as stopped after step 2/);
    assert.doesNotMatch(render({ body: borrow, execution }), /Stop here|has not seen step/);
  });

  it('a stopped loan in steps takes a step the wallet sent after all, by its hash', () => {
    const execution = { executionId: 'execution_1', state: 'failed' as const, transactionHash: null, errorCode: 'loan_steps_stopped', steps: { landed: 2, total: 3, stoppable: false } };
    const html = render({ body: { ...stepsBody(), facts: { ...stepsBody().facts, operation: 'borrow' as const } }, execution, onFindTransaction: NOOP });
    assert.match(html, /Stopped part way:/);
    assert.match(html, /Your wallet sent step 3 after all\?/);
    assert.match(html, /Still adds it to this loan only if it is exactly step 3, landed on Base; it will not send anything\./);
    assert.doesNotMatch(html, />Stop here</);
    assert.match(render({ execution: { ...execution, state: 'unknown', errorCode: null, steps: null }, onFindTransaction: NOOP }), /Wallet sent it, but the result is still unknown\?/);
  });

  it('reads where a loan in steps stands only as the server put it', () => {
    const base = { executionId: 'execution_1', state: 'unknown', transactionHash: null, errorCode: 'loan_steps_incomplete' };
    assert.deepEqual(parseLendingExecutionWireV1({ ...base, steps: { landed: 2, total: 3, stoppable: true } }, 'execution_1')?.steps, { landed: 2, total: 3, stoppable: true });
    assert.equal(parseLendingExecutionWireV1({ ...base, steps: null }, 'execution_1')?.steps, null);
    for (const steps of [{ landed: 4, total: 3, stoppable: true }, { landed: 1, total: 0, stoppable: false }, { landed: 1.5, total: 3, stoppable: true },
      { landed: 1, total: 3, stoppable: 'yes' }, { landed: -1, total: 3, stoppable: false }, 'steps']) {
      assert.equal(parseLendingExecutionWireV1({ ...base, steps }, 'execution_1'), null, JSON.stringify(steps));
    }
  });
});

describe('repay all and take the stock back', () => {
  const NVDAC = REPAY_COLLATERALS_V1.find(row => row.id === 'NVDAc')!;
  const stock = { venue: 'aave-v4' as const, marketId: `0x${'b'.repeat(40)}`, collateralTokenAddress: NVDAC.token, collateralSymbol: 'NVDAc', collateralDecimals: 8,
    debtAtomic: '180030', walletUsdcAtomic: '200000', blockNumber: 53_447_233, collateralAtomic: '3014121' };
  function returned(onlyBack = false): LendingReadyWireV1 {
    const body = ready();
    Object.assign(body.facts, { venue: 'aave-v4', collateralTokenAddress: NVDAC.token, collateralSymbol: 'NVDAc', marketId: stock.marketId, amountMode: 'all', requestedAssets: null,
      maximumDebitAssets: onlyBack ? '0' : '190000', debtBeforeAssets: onlyBack ? '0' : '180030', debtAfterAssets: '0', collateralBeforeAssets: '3014121', collateralAfterAssets: '0',
      collateralReturnAssets: '3014121' });
    return body;
  }
  it('reads the deposit of a loan and offers it back, on Aave V4 and on Morpho', () => {
    const read = repayCapacityViewV1({ state: 'read', read: stock }, NVDAC.token).read;
    assert.equal(read?.collateralAtomic, '3014121'); assert.equal(repayCanReturnV1(read), true);
    assert.equal(repayCanReturnV1({ ...stock, collateralAtomic: '0' }), false);
    assert.equal(repayCapacityViewV1({ state: 'read', read: { ...capacity, collateralAtomic: '5' } }, capacity.collateralTokenAddress).read?.collateralAtomic, '5');
    assert.equal(repayCapacityViewV1({ state: 'read', read: { ...capacity, collateralAtomic: '5.0' } }, capacity.collateralTokenAddress).read, null);
    const morpho = renderToStaticMarkup(<RepayEntryScreen model={entry({ read: { ...capacity, collateralAtomic: '100000000' }, canReturn: true })} />);
    assert.match(morpho, /Deposited in Morpho/); assert.match(morpho, /Repay all, take back cbBTC/);
    const html = renderToStaticMarkup(<RepayEntryScreen model={entry({ asset: 'NVDAc', read: stock, canReturn: true, mode: 'return' })} />);
    assert.match(html, /Deposited in Aave/); assert.match(html, /0\.03014121 NVDAc/);
    assert.match(html, /Repay all, take back NVDAc/); assert.match(html, /Then your 0\.03014121 NVDAc comes back to this wallet in the same review/);
    assert.doesNotMatch(renderToStaticMarkup(<RepayEntryScreen model={entry({ read: capacity })} />), /take back/i);
    assert.match(html, /Deposited in Aave V4/);
  });
  it('says plainly when the wallet holds less USDC than the debt, by the button it disables', () => {
    const html = renderToStaticMarkup(<RepayEntryScreen model={entry({ asset: 'NVDAc', read: { ...stock, walletUsdcAtomic: '0' }, canReturn: true, mode: 'return' })} />);
    assert.match(html, /This wallet holds 0 USDC and the debt is 0\.18003 USDC now, 0\.18003 USDC short\..*for example 0\.2 USDC, then read the position again\.<\/p><button type="submit" class="still-btn" disabled="">Review repayment/);
    // 2026-11-03: a wallet holding the 2 USDC it borrowed owed 2.000003 eleven minutes later.
    const dust = renderToStaticMarkup(<RepayEntryScreen model={entry({ asset: 'NVDAc', read: { ...stock, walletUsdcAtomic: '2000000', debtAtomic: '2000003' }, canReturn: true, mode: 'return', maximum: '2' })} />);
    assert.match(dust, /This wallet holds 2 USDC and the debt is 2\.000003 USDC now, 0\.000003 USDC short\..*for example 0\.02 USDC/);
    assert.equal(repayTopUpAtomicV1({ debtAtomic: '2000003', walletUsdcAtomic: '2000000' }), BigInt(20_000));
    assert.equal(repayTopUpAtomicV1({ debtAtomic: '2000003', walletUsdcAtomic: '2000003' }), null);
    // A maximum below the debt is refused before any review, with both numbers.
    assert.match(repayIntentAmountsV1({ mode: 'return', amount: '', maximum: '2', walletUsdcAtomic: '2500000', debtAtomic: '2000003' }).error!,
      /^The debt is 2\.000003 USDC now, more than this maximum of 2 USDC: interest adds to it every second\./);
    assert.match(repayIntentAmountsV1({ mode: 'all', amount: '', maximum: '2', walletUsdcAtomic: '2000000', debtAtomic: '2000003' }).error!, /0\.000003 USDC short/);
    // An exact repayment can be smaller than the debt: said at the top, and not blocked.
    const exact = renderToStaticMarkup(<RepayEntryScreen model={entry({ asset: 'NVDAc', read: { ...stock, walletUsdcAtomic: '0' }, canReturn: true, mode: 'assets', amount: '0.1' })} />);
    assert.match(exact, /This wallet holds 0 USDC on Base, and the debt is 0\.18003 USDC\..*An exact repayment can be smaller than the debt\./);
    assert.doesNotMatch(exact, /disabled="">Review repayment/);
    // A review that could not be prepared is said by the button, not above the fold.
    const refused = renderToStaticMarkup(<RepayEntryScreen model={entry({ asset: 'NVDAc', read: stock, canReturn: true, mode: 'return', maximum: '0.1', error: 'The debt is 0.18003 USDC now.' })} />);
    assert.match(refused, /<p class="still-warn" role="alert">The debt is 0\.18003 USDC now\.<\/p><button type="submit"/);
    assert.doesNotMatch(renderToStaticMarkup(<RepayEntryScreen model={entry({ asset: 'NVDAc', read: stock, canReturn: true, mode: 'return' })} />), /This wallet holds/);
    assert.doesNotMatch(renderToStaticMarkup(<RepayEntryScreen model={entry({ asset: 'NVDAc', read: { ...stock, debtAtomic: '0', walletUsdcAtomic: '0' }, canReturn: true })} />), /This wallet holds/);
  });
  it('a refused review says why and offers the page that asked it', () => {
    const link = (claims: unknown) => `miorail-lending-v1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${'s'.repeat(43)}`;
    assert.deepEqual(lendingBackLinkV1(link({ question: { operation: 'repay', collateralTokenAddress: NVDAC.token.toLowerCase() } })), { href: `/repay?token=${NVDAC.token.toLowerCase()}`, label: 'Back to Repay' });
    assert.deepEqual(lendingBackLinkV1(link({ question: { operation: 'borrow' } })), { href: '/borrow', label: 'Back to Get money' });
    assert.equal(lendingBackLinkV1('not a review link'), null);
    assert.equal(lendingBackLinkV1(null), null);
    const detail = 'The debt is 2.000003 USDC now, more than your maximum of 2 USDC: interest adds to it every second.';
    const html = render({ body: { state: 'refused', refusal: 'repay_maximum_exceeded', detail }, back: { href: '/repay?token=0xabc', label: 'Back to Repay' } });
    assert.match(html, /The debt is 2\.000003 USDC now[^<]*<\/p><a class="still-btn sec" href="\/repay\?token=0xabc">Back to Repay<\/a>/);
    assert.match(render({ error: 'This review link expired.', back: { href: '/borrow', label: 'Back to Get money' } }), /This review link expired\.<\/p><a class="still-btn sec" href="\/borrow">Back to Get money<\/a>/);
  });
  it('with no debt left offers the stock back alone, asking for no USDC', () => {
    const html = renderToStaticMarkup(<RepayEntryScreen model={entry({ asset: 'NVDAc', read: { ...stock, debtAtomic: '0' }, canReturn: true })} />);
    assert.match(html, /No debt is open in this market/); assert.match(html, /Take back NVDAc/); assert.doesNotMatch(html, /Maximum USDC funding/);
    assert.deepEqual(repayIntentAmountsV1({ mode: 'return', amount: '', maximum: '', walletUsdcAtomic: '0', debtAtomic: '0' }).intent,
      { amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '0', returnCollateral: true });
    assert.deepEqual(repayIntentAmountsV1({ mode: 'return', amount: '', maximum: '0.19', walletUsdcAtomic: '200000', debtAtomic: '180030' }).intent,
      { amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '190000', returnCollateral: true });
    assert.equal(repayIntentAmountsV1({ mode: 'return', amount: '', maximum: '', walletUsdcAtomic: '200000', debtAtomic: '180030' }).intent, null);
  });
  it('the review names the stock coming back, and with no debt says no USDC moves', () => {
    assert.equal(parseLendingReviewWireV1(returned())?.state, 'ready');
    const html = render({ body: returned() });
    assert.match(html, /Repay all and take back NVDAc/); assert.match(html, /Then take back <strong>0\.03014121 NVDAc<\/strong> to this wallet, in the same transaction/);
    assert.doesNotMatch(html, /Your collateral stays deposited/);
    const alone = render({ body: returned(true) });
    assert.match(alone, /Take back NVDAc/); assert.match(alone, /No USDC debt is open/); assert.doesNotMatch(alone, /Maximum USDC funding/);
  });
  it('refuses a return on a borrow or an exact repayment, and accepts one on Morpho', () => {
    const morpho = returned(); Object.assign(morpho.facts, { venue: 'morpho' });
    assert.equal(parseLendingReviewWireV1(morpho)?.state, 'ready');
    assert.match(render({ body: morpho }), /Morpho checks the account before the collateral leaves/);
    for (const patch of [{ operation: 'borrow' }, { amountMode: 'assets', requestedAssets: '1' }, { collateralReturnAssets: '0' }]) {
      const body = returned(); Object.assign(body.facts, patch);
      assert.equal(parseLendingReviewWireV1(body), null, JSON.stringify(patch));
    }
  });
});
