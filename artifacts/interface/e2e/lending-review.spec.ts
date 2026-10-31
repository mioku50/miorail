import { expect, test } from '@playwright/test';
import { install, ready, attempts, OTHER, type FixtureWindow } from './fixtures/lending-review.js';

for (const width of [390, 1366]) {
  test(`fresh lending refusal never arms or opens a wallet (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 }); const state = await install(page);
    await page.goto('/lending/fixture-lending');
    const open = page.getByRole('button', { name: 'Open in your wallet', exact: true }); await expect(open).toBeVisible();
    expect(state.order).toEqual(['review']); expect(await attempts(page)).toBe(0);
    state.response = { state: 'refused', refusal: 'funding_unread', detail: 'USDC funding could not be read.' };
    await open.click(); await expect(open).toHaveCount(0); await expect(page.locator('body')).toContainText('USDC funding could not be read.');
    expect(state.order).toEqual(['review', 'review']); expect(await attempts(page)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`lending-refused-${width}.png`), fullPage: true });
  });
}
test('changed lending terms require another explicit click; arm precedes wallet and a batch is not confirmation', async ({ page }) => {
  const state = await install(page); await page.goto('/lending/fixture-lending');
  const open = page.getByRole('button', { name: 'Open in your wallet', exact: true }); await expect(open).toBeVisible();
  state.response = { ...ready(), callsHash: `0x${'3'.repeat(64)}`, signingTermsHash: `0x${'4'.repeat(64)}` };
  // Only the calls are new, as a loan's deadline makes them on every read: said as that.
  await open.click(); await expect(page.getByText(/The calls were prepared again for this moment/)).toBeVisible(); expect(await attempts(page)).toBe(0);
  const reads = state.reviewReads; await open.click();
  await expect.poll(() => attempts(page)).toBe(1); await expect(open).toHaveCount(0);
  expect(state.reviewReads).toBe(reads); expect(state.order).toEqual(['review', 'review', 'arm', 'submission:submitted']);
  await expect(page.locator('body')).toContainText('not a confirmed blockchain result');
  await expect(page.locator('body')).not.toContainText('Confirmed onchain:');
  state.executionState = 'confirmed'; await page.getByRole('button', { name: 'Check onchain result', exact: true }).click();
  await expect(page.locator('body')).toContainText('Confirmed onchain:'); expect(await attempts(page)).toBe(1);
});
test('a failed refresh cannot fall back to cached executable calls', async ({ page }) => {
  const state = await install(page); await page.goto('/lending/fixture-lending');
  const open = page.getByRole('button', { name: 'Open in your wallet', exact: true }); await expect(open).toBeVisible();
  state.failRefresh = true; await open.click(); await expect(page.getByRole('alert')).toContainText('review could not be read');
  await expect(open).toHaveCount(0);
  expect(state.order).toEqual(['review', 'review']); expect(await attempts(page)).toBe(0);
});
test('an unknown lending submission stays locked after reload and is not called a failure', async ({ page }) => {
  const state = await install(page, 'timeout'); await page.goto('/lending/fixture-lending');
  const open = page.getByRole('button', { name: 'Open in your wallet', exact: true }); await open.click();
  await expect.poll(() => attempts(page)).toBe(1); await expect(open).toHaveCount(0); expect(state.executionState).toBe('unknown');
  await page.reload(); await expect(page.locator('body')).toContainText('existing wallet attempt'); await expect(open).toHaveCount(0);
  await page.getByRole('button', { name: 'Check onchain result', exact: true }).click(); await expect(page.locator('body')).toContainText('submission result is unknown');
  expect(await attempts(page)).toBe(0); await expect(page.locator('body')).not.toContainText('Confirmed onchain:');
});
test('only an explicit wallet rejection permits a repeat lending attempt', async ({ page }) => {
  const state = await install(page, 'rejected'); await page.goto('/lending/fixture-lending');
  const open = page.getByRole('button', { name: 'Open in your wallet', exact: true }); await open.click();
  await expect(page.getByText('You declined in your wallet. Nothing was sent.', { exact: true })).toBeVisible();
  await expect(open).toBeEnabled(); await open.click(); await expect.poll(() => attempts(page)).toBe(2);
  expect(state.order.filter(row => row === 'submission:rejected')).toHaveLength(2);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('miorail:borrow-attempt:v1:')))).toEqual([]);
});
test('a wallet that answers it does not support the batch sent nothing: the review is freed, not locked', async ({ page }) => {
  // Coinbase Wallet with an imported key, 2026-10-31: -32603 with "...is not
  // supported" in its details. The page locked that review as "maybe sent".
  const state = await install(page, 'unsupported'); await page.goto('/lending/fixture-lending');
  const open = page.getByRole('button', { name: 'Open in your wallet', exact: true }); await open.click();
  await expect(page.getByText(/^This wallet cannot send these calls as one transaction\./)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('result is unknown');
  expect(state.order).toEqual(['review', 'review', 'arm', 'submission:rejected']);
  expect(await page.evaluate(() => (window as unknown as { lendingWalletRefusals?: number }).lendingWalletRefusals)).toBe(1);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('miorail:borrow-attempt:v1:')))).toEqual([]);
});
test('owner/connector mismatch masks private review before paint and does not read another wallet', async ({ page }) => {
  const state = await install(page); await page.goto('/lending/fixture-lending');
  await expect(page.locator('body')).toContainText('3.125001 USDC'); const reads = state.reviewReads;
  await page.evaluate(other => (window as FixtureWindow).setLendingFixtureIdentity({ session: other, connected: '0x1111111111111111111111111111111111111111' }), OTHER);
  await expect(page.locator('body')).toContainText('Sign in and connect the same wallet');
  await expect(page.locator('body')).not.toContainText('3.125001 USDC'); expect(state.reviewReads).toBe(reads);
  expect(await attempts(page)).toBe(0);
});
test('late SDK result never posts an old execution under a changed session', async ({ page }) => {
  const state = await install(page, 'pending'); await page.goto('/lending/fixture-lending');
  await page.getByRole('button', { name: 'Open in your wallet', exact: true }).click(); await expect.poll(() => attempts(page)).toBe(1);
  await page.evaluate(other => (window as FixtureWindow).setLendingFixtureIdentity({ session: other, connected: '0x1111111111111111111111111111111111111111' }), OTHER);
  await page.evaluate(() => (window as FixtureWindow).finishLendingWallet('old-owner-batch'));
  await expect(page.locator('body')).not.toContainText('old-owner-batch');
  expect(state.order).toEqual(['review', 'review', 'arm']);
});

test('an expired preparation retains only status access to an existing wallet attempt', async ({ page }) => {
  const state = await install(page); state.response = { state: 'refused', refusal: 'lending_preparation_expired',
    detail: 'The preparation expired. Your existing submission can still be checked; nothing can be sent from this link.',
    executionId: 'execution_1', executionState: 'awaiting_wallet', facts: ready().facts };
  state.executionState = 'ready';
  await page.goto('/lending/expired-owned-question');
  await expect(page.getByRole('alert')).toContainText('preparation expired');
  await expect(page.getByRole('button', { name: 'Open in your wallet', exact: true })).toHaveCount(0);
  state.executionState = 'unknown';
  await page.getByRole('button', { name: 'Check onchain result', exact: true }).click();
  await expect(page.locator('body')).toContainText('submission result is unknown');
  expect(state.order).toEqual(['review', 'result']); expect(await attempts(page)).toBe(0);
});

test('a pasted transaction hash never confirms or repeats a wallet action', async ({ page }) => {
  const state = await install(page, 'timeout'); await page.goto('/lending/fixture-lending');
  await page.getByRole('button', { name: 'Open in your wallet', exact: true }).click();
  await expect.poll(() => attempts(page)).toBe(1);
  await page.getByText('Wallet sent it, but the result is still unknown?', { exact: true }).click();
  await page.getByLabel('Transaction hash', { exact: true }).fill(`0x${'5'.repeat(64)}`);
  await page.getByRole('button', { name: 'Find this transaction', exact: true }).click();
  await expect.poll(() => state.order.at(-1)).toBe('result');
  await expect(page.locator('body')).toContainText('submission result is unknown');
  await expect(page.locator('body')).not.toContainText('Confirmed onchain:');
  expect(state.transactionHints).toEqual([`0x${'5'.repeat(64)}`]); expect(await attempts(page)).toBe(1);
  await expect(page.getByRole('button', { name: 'Open in your wallet', exact: true })).toHaveCount(0);
});
