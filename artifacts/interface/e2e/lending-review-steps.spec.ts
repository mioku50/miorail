import { expect, test } from '@playwright/test';
import { install, type FixtureWindow } from './fixtures/lending-review.js';

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
  expect(state.order.filter(entry => entry !== 'review')).toEqual(['arm', 'step:0', 'submission:submitted']);
  expect(await sends(page)).toHaveLength(2);
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
