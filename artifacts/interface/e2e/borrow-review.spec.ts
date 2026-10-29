import { expect, test } from '@playwright/test';
import { install, ready, type FixtureWindow } from './fixtures/lending-review.js';

// Legacy assistant URLs now use the same owned review, persistent arm and
// receipt reconciliation as /lending. The shared controller's full negative
// matrix is exercised in lending-review.spec.ts rather than a retired host.
for (const width of [390, 1366]) {
  test(`an existing assistant borrow link opens the common lending review (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page);
    state.response = { ...ready(), measured: { ...ready().measured, loanDeltaAssets: '3000000' }, facts: { ...ready().facts, operation: 'borrow', debtAfterAssets: '6125001', requestedAssets: '3000000', maximumDebitAssets: '0', collateralSupplyAssets: '0' } };
    await page.goto('/borrow/miorail-borrow-v1.legacy.fixture');
    await expect(page.getByRole('heading', { name: 'Review loan', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open in your wallet', exact: true })).toBeVisible();
    expect(state.order).toEqual(['review']);
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).lendingWalletAttempts)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
test('an old assistant link with an existing attempt cannot bypass the shared submission lock', async ({ page }) => {
  const state = await install(page);
  state.executionState = 'unknown';
  await page.goto('/borrow/miorail-borrow-v1.legacy.fixture');
  await expect(page.getByText(/This review has an existing wallet attempt/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open in your wallet', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check onchain result', exact: true }).click();
  expect(state.order).toEqual(['review', 'result']);
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).lendingWalletAttempts)).toBe(0);
});
