import { expect, test } from '@playwright/test';
import { install, stepsReady, type FixtureWindow } from './fixtures/lending-review.js';

// A wallet without batches (Rabby) gets a stock loan in steps: the review is
// asked for steps, each landed step goes to the server before the next is
// asked, and a decline after a step says what is in place. The batch path is
// covered, unchanged, in lending-review.spec.ts.
const sends = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as FixtureWindow).lendingStepSends ?? []);

for (const width of [390, 1366]) {
  test(`a stock loan goes in steps, each reported before the next (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page, 'steps');
    await page.goto('/lending/miorail-lending-v2.steps.fixture');
    await expect(page.getByText('Steps in your wallet (3 transactions)', { exact: false })).toBeVisible();
    await expect(page.getByText(/reviews each next step again, from the chain as it is then/)).toBeVisible();
    await page.getByRole('button', { name: 'Open step 1 of 3 in your wallet', exact: true }).click();
    await expect(page.getByText(/^Submitted from your wallet\./)).toBeVisible();
    expect(state.reviewQueries.every(query => query === '?delivery=sequential')).toBe(true);
    expect(state.order.filter(entry => entry !== 'review')).toEqual(['arm', 'step:0', 'step:1', 'step:2']);
    expect(await sends(page)).toHaveLength(3);
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).lendingWalletAttempts)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('declining a later step keeps what landed, says so, and asks nothing more', async ({ page }) => {
  const state = await install(page, 'steps-declined');
  await page.goto('/lending/miorail-lending-v2.steps.fixture');
  await page.getByRole('button', { name: 'Open step 1 of 3 in your wallet', exact: true }).click();
  await expect(page.getByText('You declined step 2 of 3. Step 1 is in place, and no loan was taken. Open Get money again to go on from here.')).toBeVisible();
  // Declined in the wallet, so the rest was never sent: the stop is told to the server as such.
  expect(state.order.filter(entry => entry !== 'review')).toEqual(['arm', 'step:0', 'submission:stopped']);
  expect(await sends(page)).toHaveLength(2);
  await expect(page.getByText(/reverted onchain/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Open step/ })).toHaveCount(0);
});

test('a refused review between steps stops them, and the refusal is what the page says', async ({ page }) => {
  const state = await install(page, 'steps');
  state.stepAnswers[0] = { state: 'stopped', refusal: 'aave_over_still_limit', detail: 'The requested loan exceeds the measured Still allowance.', batchId: 'fixture-steps-1' };
  await page.goto('/lending/miorail-lending-v2.steps.fixture');
  await page.getByRole('button', { name: 'Open step 1 of 3 in your wallet', exact: true }).click();
  await expect(page.getByText('The requested loan exceeds the measured Still allowance. Step 1 is in place, and no loan was taken.', { exact: false })).toBeVisible();
  expect(await sends(page)).toHaveLength(1);
  expect(state.order.filter(entry => entry !== 'review')).toEqual(['arm', 'step:0']);
});

// A Spend purchase from the same wallet: the loan's steps, then the exact USDC
// transfer to Bitrefill's invoice, last. Every value is synthetic.
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
function payingSteps() {
  const base = stepsReady();
  return { ...base, calls: [...base.calls, { to: USDC, data: '0xa9059cbb', value: '0' }],
    steps: [...base.steps, { index: 3, to: USDC, reading: 'Pay Bitrefill: send 0.18 USDC to the invoice address 0x3333…3333' }],
    facts: { ...base.facts, payment: { merchant: 'bitrefill', orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', payTo: '0x3333333333333333333333333333333333333333',
      assets: '180000', productName: 'Bitrefill eSIM Germany', packageValue: '1GB, 7 Days', faceCurrency: 'USD', expiresAt: '2026-10-29T04:00:00.000Z' } } };
}

test('a Spend purchase goes in steps too, the payment last', async ({ page }) => {
  const state = await install(page, 'steps');
  state.stepsResponse = payingSteps();
  state.stepAnswers[2] = { state: 'next', index: 3, batchId: 'fixture-steps-3' };
  state.stepAnswers[3] = { state: 'submitted', batchId: 'fixture-steps-4' };
  await page.goto('/lending/miorail-lending-v2.steps.fixture');
  await expect(page.getByText(/Then pay Bitrefill 0\.18 USDC for Bitrefill eSIM Germany · 1GB, 7 Days, as the last step\./)).toBeVisible();
  await page.getByRole('button', { name: 'Open step 1 of 4 in your wallet', exact: true }).click();
  await expect(page.getByText(/^Submitted from your wallet\./)).toBeVisible();
  expect(state.order.filter(entry => entry !== 'review')).toEqual(['arm', 'step:0', 'step:1', 'step:2', 'step:3']);
  expect((await sends(page)).at(-1)).toBe(USDC);
});

test('an invoice that stopped waiting before the payment leaves the loan in place, and says Bitrefill was not paid', async ({ page }) => {
  const state = await install(page, 'steps');
  state.stepsResponse = payingSteps();
  state.stepAnswers[2] = { state: 'stopped', refusal: 'spend_invoice_not_unpaid', detail: 'Bitrefill reports this invoice as denied, so the payment was not sent.', batchId: 'fixture-steps-3' };
  await page.goto('/lending/miorail-lending-v2.steps.fixture');
  await page.getByRole('button', { name: 'Open step 1 of 4 in your wallet', exact: true }).click();
  await expect(page.getByText('Bitrefill reports this invoice as denied, so the payment was not sent. The loan is in place and the USDC is in your wallet. Repay it, or open Spend for a new invoice.')).toBeVisible();
  expect(await sends(page)).toHaveLength(3);
  await expect(page.getByRole('button', { name: /Open step/ })).toHaveCount(0);
});

// Re-audit R3, 2026-11-04: step 2 landed, its answer never reached Still, and the loan held its market.
test('a loan left part way is stopped there after a reload, only on the server’s word', async ({ page }) => {
  const state = await install(page, 'steps');
  Object.assign(state, { executionState: 'unknown', errorCode: 'loan_steps_incomplete', stepsStanding: { landed: 2, total: 3, stoppable: true }, refusedFacts: stepsReady().facts });
  state.stopAnswers.push({ status: 409, json: { error: 'loan_steps_later_transaction',
    detail: 'Your wallet sent another transaction after step 2. Still cannot tell from Base whether it was step 3 of 3, so this loan was not stopped. If it was, paste its hash below.' } });
  state.stopAnswers.push({ status: 200, json: { executionId: 'execution_1', state: 'failed', transactionHash: `0x${'2'.padStart(64, '0')}`, errorCode: 'loan_steps_stopped',
    steps: { landed: 2, total: 3, stoppable: false } } });
  await page.goto('/lending/miorail-lending-v2.steps.fixture');
  await page.getByRole('button', { name: 'Check onchain result', exact: true }).click();
  await expect(page.getByText('Steps 1–2 of 3 are in place on Base, and Still has not seen step 3 land.')).toBeVisible();
  await expect(page.getByText(/only then is this loan recorded as stopped after step 2, and Repay works again\./)).toBeVisible();
  // Refused, the server's own reason is what the page says, and the offer stays.
  await page.getByRole('button', { name: 'Stop here', exact: true }).click();
  await expect(page.getByText(/^Your wallet sent another transaction after step 2\. Still cannot tell from Base whether it was step 3 of 3/)).toBeVisible();
  await page.getByRole('button', { name: 'Stop here', exact: true }).click();
  await expect(page.getByText(/^Stopped part way: the steps that landed are in place on Base/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop here' })).toHaveCount(0);
  await expect(page.getByText('Your wallet sent step 3 after all?')).toBeVisible();
  expect(state.order.filter(entry => entry !== 'review')).toEqual(['result', 'stop', 'stop']);
  expect(await sends(page)).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
