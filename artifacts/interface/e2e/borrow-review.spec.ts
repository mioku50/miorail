import { expect, test, type Page } from '@playwright/test';
import { NOW, WALLET, borrowReviewFixture as body } from './fixtures/borrow-review.js';
import { stillTerms } from '../../../lib/still-engine/src/terms.js';
import { calendar } from '../../../lib/still-engine/test/fixtures.js';

async function install(page: Page) {
  await page.clock.setFixedTime(NOW);
  await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript', body:
    'export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:"authenticated", sessionAuthenticated:true }; }' }));
  const state = { response: body(), fail: false, reviewReads: 0, writes: [] as string[] };
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') { state.writes.push(path); return route.fulfill({ status: 503, json: { error: 'fixture_write_forbidden' } }); }
    if (path.includes('/rwa/borrow/review/')) {
      state.reviewReads++;
      return route.fulfill({ status: state.fail ? 503 : 200, json: state.fail ? { error: 'unavailable' } : state.response });
    }
    if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } } });
    if (path === '/api/public/still/terms') return route.fulfill({ json: JSON.parse(JSON.stringify(stillTerms(calendar(), NOW))) });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return state;
}
for (const width of [390, 1366]) {
  test(`a fresh refusal removes the wallet action (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page);
    await page.goto('/borrow/test-draft');
    const open = page.getByRole('button', { name: 'Open in your wallet', exact: true });
    await expect(open).toBeVisible();
    const reads = state.reviewReads;
    state.response = body(true);
    await open.click();
    await expect(page.getByText(/This amount exceeds Still’s limit/)).toBeVisible();
    await expect(open).toHaveCount(0);
    expect(state.reviewReads).toBeGreaterThan(reads);
    expect(state.writes).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`borrow-refused-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`changed calls need another explicit review and do not prepare forever (${width}px)`, async ({ page }) => {
    const state = await install(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/borrow/test-draft');
    const open = page.getByRole('button', { name: 'Open in your wallet', exact: true });
    await expect(open).toBeVisible();
    state.response = body(false, true);
    await open.click();
    await expect(page.getByText(/The terms changed. Read the updated review/)).toBeVisible();
    const reads = state.reviewReads;
    await open.click();
    // This isolated browser has no connected signing wallet. Reaching that
    // ordinary refusal proves the explicit second click passed the fresh gate;
    // no extension, real signature or transaction is present.
    await expect(page.getByText(/Your wallet is not connected|Your wallet did not return a submission result/)).toBeVisible();
    expect(state.reviewReads).toBe(reads);
    expect(state.writes).toEqual([]);
  });
  test(`failed refresh does not fall back to cached calls (${width}px)`, async ({ page }) => {
    const state = await install(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/borrow/test-draft');
    const open = page.getByRole('button', { name: 'Open in your wallet', exact: true });
    await expect(open).toBeVisible();
    state.fail = true;
    await open.click();
    await expect(page.getByText(/This review could not be read/)).toBeVisible();
    await expect(open).toHaveCount(0);
    expect(state.writes).toEqual([]);
  });
}

async function controllableWallet(page: Page, outcome: 'timeout' | 'no-id' | 'submitted' | 'rejected' | 'pending') {
  const uiRoot = '/@fs' + new URL('../../../lib/ui/src/console/', import.meta.url).pathname;
  // Use the same optimizer identity as the real shared hook. Importing an
  // unversioned React URL here would create a second hooks dispatcher.
  const hookSource = await (await page.request.get(`${uiRoot}borrowReviewConsole.ts`)).text();
  const reactPath = hookSource.match(/from ["']([^"']*\/react\.js\?v=[^"']+)["']/)?.[1];
  expect(reactPath).toBeTruthy();
  await page.route('**/BorrowReviewPage.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: `
    import React from '${reactPath}';
    import {useBorrowReviewConsoleV1} from '${uiRoot}borrowReviewConsole.ts';
    import {BorrowReviewScreen} from '${uiRoot}BorrowReviewScreen.tsx';
    window.borrowWalletAttempts = 0;
    export function BorrowReviewPage() {
      const [wallet,setWallet] = React.useState('${WALLET}');
      window.setBorrowFixtureWallet = setWallet;
      const {model} = useBorrowReviewConsoleV1({draft:'test-draft',walletAddress:wallet,
        sendCalls: async () => {
          window.borrowWalletAttempts++;
          ${outcome === 'timeout' ? "throw new Error('response lost after wallet accepted');" :
            outcome === 'rejected' ? "throw Object.assign(new Error('declined'),{code:4001});" :
              outcome === 'no-id' ? 'return null;' : outcome === 'pending' ? 'return await new Promise(resolve => { window.finishBorrowFixture = resolve; });' : "return 'fixture-batch';"}
        }});
      return React.createElement(BorrowReviewScreen,{model});
    }` }));
}

for (const outcome of ['timeout', 'no-id', 'submitted'] as const) {
  test(`a ${outcome} wallet request is blocked after reload and returning to the wallet`, async ({ page }) => {
    const state = await install(page);
    await controllableWallet(page, outcome);
    await page.goto('/borrow/test-draft');
    const open = page.getByRole('button', { name: 'Open in your wallet', exact: true });
    await open.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { borrowWalletAttempts: number }).borrowWalletAttempts)).toBe(1);
    await expect(open).toHaveCount(0);
    if (outcome === 'submitted') await expect(page.getByText('Submitted from your wallet.', { exact: true })).toBeVisible();
    else await expect(page.getByText(/Miorail will not send it again/)).toBeVisible();
    if (outcome === 'no-id') await expect(page.locator('body')).not.toContainText('Your wallet accepted the batch');
    await page.reload();
    await expect(page.getByText(/Miorail will not send it again/)).toBeVisible();
    await expect(open).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { setBorrowFixtureWallet: (wallet: string) => void }).setBorrowFixtureWallet(`0x${'2'.repeat(40)}`));
    await expect(open).toBeVisible();
    await page.evaluate(wallet => (window as unknown as { setBorrowFixtureWallet: (wallet: string) => void }).setBorrowFixtureWallet(wallet), WALLET);
    await expect(page.getByText(/Miorail will not send it again/)).toBeVisible();
    await expect(open).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { borrowWalletAttempts: number }).borrowWalletAttempts)).toBe(0);
    expect(state.writes).toEqual([]);
  });
}

test('a definitive wallet rejection permits retry without retaining an attempted-submission marker', async ({ page }) => {
  await install(page);
  await controllableWallet(page, 'rejected');
  await page.goto('/borrow/test-draft');
  const open = page.getByRole('button', { name: 'Open in your wallet', exact: true });
  await open.click();
  await expect(page.getByText('You declined in your wallet. Nothing was sent.', { exact: true })).toBeVisible();
  await expect(open).toBeEnabled();
  await open.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { borrowWalletAttempts: number }).borrowWalletAttempts)).toBe(2);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('miorail:borrow-attempt:v1:')))).toEqual([]);
});

test('a late wallet result belongs to its original identity, which remains locked on return', async ({ page }) => {
  await install(page);
  await controllableWallet(page, 'pending');
  await page.goto('/borrow/test-draft');
  const open = page.getByRole('button', { name: 'Open in your wallet', exact: true });
  await open.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { borrowWalletAttempts: number }).borrowWalletAttempts)).toBe(1);
  await page.evaluate(() => (window as unknown as { setBorrowFixtureWallet: (wallet: string) => void }).setBorrowFixtureWallet(`0x${'2'.repeat(40)}`));
  await page.evaluate(() => (window as unknown as { finishBorrowFixture: (batch: string) => void }).finishBorrowFixture('original-wallet-batch'));
  await expect(open).toBeVisible();
  await expect(page.getByText('original-wallet-batch', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Submitted from your wallet.', { exact: true })).toHaveCount(0);
  await page.evaluate(wallet => (window as unknown as { setBorrowFixtureWallet: (wallet: string) => void }).setBorrowFixtureWallet(wallet), WALLET);
  await expect(page.getByText(/This review was already submitted from your wallet/)).toBeVisible();
  await expect(open).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { borrowWalletAttempts: number }).borrowWalletAttempts)).toBe(1);
});
