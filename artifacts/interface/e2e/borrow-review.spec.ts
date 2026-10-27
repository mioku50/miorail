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
