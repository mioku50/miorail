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
test('calls prepared again under the same terms go to the wallet at the first press; arm precedes wallet and a batch is not confirmation', async ({ page }) => {
  const state = await install(page); await page.goto('/lending/fixture-lending');
  const open = page.getByRole('button', { name: 'Open in your wallet', exact: true }); await expect(open).toBeVisible();
  // Only the calls are new, as a loan's deadline makes them on every read (2026-11-07: the first press always asked again).
  state.response = { ...ready(), callsHash: `0x${'3'.repeat(64)}`, signingTermsHash: `0x${'4'.repeat(64)}`, calls: [{ to: ready().calls[0]!.to, data: '0x12345679', value: '0' }] };
  await open.click();
  await expect.poll(() => attempts(page)).toBe(1); await expect(open).toHaveCount(0);
  await expect(page.getByText(/prepared again for this moment|The terms changed/)).toHaveCount(0);
  expect(state.order).toEqual(['review', 'review', 'arm', 'submission:submitted']);
  await expect(page.locator('body')).toContainText('not a confirmed blockchain result');
  await expect(page.locator('body')).not.toContainText('Confirmed onchain:');
  state.executionState = 'confirmed'; await page.getByRole('button', { name: 'Check onchain result', exact: true }).click();
  await expect(page.locator('body')).toContainText('Confirmed onchain:'); expect(await attempts(page)).toBe(1);
});
// 2026-11-08: Still pays a batch's network fee. The wallet is handed the arm's offer exactly, and nothing for anything else.
const FEE_OFFER = { paymasterUrl: 'https://miorail.xyz/api/paymaster/sponsorship/fixture.token', context: { sponsorship: 'fixture.token' } };
for (const [name, made, handed] of [
  ['the arm’s offer, exactly', FEE_OFFER, FEE_OFFER],
  ['nothing for an offer that names another paymaster', { ...FEE_OFFER, paymasterUrl: 'https://api.developer.coinbase.com/rpc/v1/base/KEY' }, null],
  ['nothing when the arm makes no offer', undefined, null],
] as const) {
  test(`a batch hands the wallet ${name}`, async ({ page }) => {
    const state = await install(page); state.armSponsorship = made; await page.goto('/lending/fixture-lending');
    const open = page.getByRole('button', { name: 'Open in your wallet', exact: true }); await expect(open).toBeVisible();
    await open.click(); await expect.poll(() => attempts(page)).toBe(1);
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).lendingSponsorships)).toEqual([handed]);
    expect(state.order).toEqual(['review', 'review', 'arm', 'submission:submitted']);
  });
}
test('changed lending terms require another explicit click, which sends that exact review', async ({ page }) => {
  const state = await install(page); await page.goto('/lending/fixture-lending');
  const open = page.getByRole('button', { name: 'Open in your wallet', exact: true }); await expect(open).toBeVisible();
  const fresh = ready();
  state.response = { ...fresh, facts: { ...fresh.facts, debtBeforeAssets: '3125002' }, callsHash: `0x${'3'.repeat(64)}`, signingTermsHash: `0x${'4'.repeat(64)}` };
  await open.click(); await expect(page.getByText(/^The terms changed \(debt before \(3\.125001 USDC → 3\.125002 USDC\)/)).toBeVisible(); expect(await attempts(page)).toBe(0);
  const reads = state.reviewReads; await open.click();
  await expect.poll(() => attempts(page)).toBe(1); await expect(open).toHaveCount(0);
  expect(state.reviewReads).toBe(reads); expect(state.order).toEqual(['review', 'review', 'arm', 'submission:submitted']);
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
  // The marker is cleared once the rejection is recorded, a moment after the server saw it.
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('miorail:borrow-attempt:v1:')))).toEqual([]);
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
test('a wallet that could not reach Base sent nothing: the review says so and is offered again, still as one batch', async ({ page }) => {
  // MetaMask whose Base endpoint kept failing, 2026-11-08: it failed reading eth_getCode, before sending anything.
  const state = await install(page, 'rpc-failing'); await page.goto('/lending/fixture-lending');
  const open = page.getByRole('button', { name: 'Open in your wallet', exact: true }); await open.click();
  // It said to retry in 0,12 minutes: the page waits that and a second more, saying why, then asks once more.
  await expect(page.getByText(/^Your wallet could not reach Base, so nothing was sent\. Still asks it again in 9 seconds…$/)).toBeVisible();
  await expect(page.getByText(/^This wallet could not reach Base: its own connection to the network \(its RPC\) kept failing, so nothing was sent\./)).toBeVisible({ timeout: 15_000 });
  expect(await attempts(page)).toBe(2);
  await expect(page.locator('body')).not.toContainText('result is unknown');
  expect(state.order).toEqual(['review', 'review', 'arm', 'submission:rejected']);
  // Not a refusal of batches: the wallet is not stopped from being asked for one again.
  expect(await page.evaluate(() => (window as unknown as { lendingWalletRefusals?: number }).lendingWalletRefusals)).toBeUndefined();
  await expect(open).toBeEnabled();
});
test('a wallet whose connection to Base failed before sending is asked once more after the wait it named, and the loan goes', async ({ page }) => {
  const state = await install(page, 'rpc-failing-once'); await page.goto('/lending/fixture-lending');
  const open = page.getByRole('button', { name: 'Open in your wallet', exact: true }); await open.click();
  await expect(page.getByText(/^Your wallet could not reach Base, so nothing was sent\. Still asks it again in 2 seconds…$/)).toBeVisible();
  await expect.poll(() => attempts(page)).toBe(2);
  await expect(page.locator('body')).toContainText('not a confirmed blockchain result');
  await expect(page.getByText(/could not reach Base/)).toHaveCount(0);
  expect(state.order).toEqual(['review', 'review', 'arm', 'submission:submitted']);
});
test('an arm refused while another loan holds the market says so, and the wallet is never asked', async ({ page }) => {
  // 2026-11-09: a repayment said only "could not be armed" while the loan before it, landed, was still being read.
  const state = await install(page); await page.goto('/lending/fixture-lending');
  const detail = 'Another loan or repayment in this market is still being read from Base, so this one was not sent and your wallet was not asked. Open that review and check its onchain result; once Still has read it, this one can be sent.';
  state.armRefusal = { status: 409, json: { error: 'execution_active', detail } };
  await page.getByRole('button', { name: 'Open in your wallet', exact: true }).click();
  await expect(page.getByText(detail, { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('could not be armed');
  expect(await attempts(page)).toBe(0);
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

// Final audit FA2, 2026-11-04: a review left while its arm was answered still asked the wallet for the batch,
// and nothing was left on the page to record what the wallet did.
test('a review left while its arm is answered never asks the wallet, and the arm goes back as not sent', async ({ page }) => {
  const state = await install(page); await page.goto('/lending/fixture-lending');
  let answerArm!: () => void; state.armHeld = new Promise<void>((resolve) => { answerArm = resolve; });
  await page.getByRole('button', { name: 'Open in your wallet', exact: true }).click();
  await expect.poll(() => state.order.includes('arm')).toBe(true);
  await page.evaluate(() => (window as FixtureWindow).closeLendingReview()); await expect(page.locator('body')).toContainText('Left the review');
  answerArm();
  await expect.poll(() => state.order.at(-1)).toBe('submission:rejected');
  expect(await attempts(page)).toBe(0); expect(state.executionState).toBe('ready');
  expect(state.order).toEqual(['review', 'review', 'arm', 'submission:rejected']);
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
