import { expect, test, type Page } from '@playwright/test';

// Watch: Investigate, B20 controls and Radar on one page. Every API request is
// intercepted; nothing signs and nothing is sent anywhere.

const WALLET = `0x${'1'.repeat(40)}`;
const TOKEN = `0x${'b2'.repeat(20)}`;

async function install(page: Page) {
  const reads: string[] = [];
  const writes: string[] = [];
  await page.route('**/AuthProvider.tsx*', (route) => route.fulfill({ contentType: 'application/javascript',
    body: 'export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:"authenticated", sessionAuthenticated:true }; }' }));
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    (request.method() === 'GET' ? reads : writes).push(path);
    if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: 'fixture', address: WALLET, chainId: 8453 } } });
    if (path === '/api/status') return route.fulfill({ json: { chainId: 8453, productMigration: { b20ControlV1: true, routeIntelligenceV1: true }, rpc: { status: 'connected' } } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { reads, writes };
}

for (const width of [390, 1280]) {
  test(`one page reads any address, your tokens and your markets (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { writes } = await install(page);
    await page.goto('/watch');
    for (const name of ['Any address', 'Your tokens', 'Your markets']) await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Market Reality Radar', exact: true })).toBeVisible();
    for (const name of ['Any address', 'Your tokens', 'Your markets']) {
      await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name, exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`watch-${width}.png`), fullPage: true });
    expect(writes).toEqual([]);
  });
}

test('the old addresses land on their section, and a token reaches the section it was meant for', async ({ page }) => {
  const { reads, writes } = await install(page);
  await page.goto(`/investigate?token=${TOKEN}`);
  await expect(page).toHaveURL(new RegExp(`/watch\\?token=${TOKEN}#investigate$`));
  await expect.poll(() => reads.includes(`/api/route-intelligence/rwa/investigate/${TOKEN}`)).toBe(true);

  // A Discover handover to "Your tokens" is not an address for Investigate to read.
  const before = reads.length;
  await page.goto(`/portfolio?token=${TOKEN}`);
  await expect(page).toHaveURL(new RegExp(`/watch\\?token=${TOKEN}#tokens$`));
  await expect(page.getByRole('heading', { name: 'Your tokens', exact: true })).toBeVisible();
  expect(reads.slice(before)).not.toContain(`/api/route-intelligence/rwa/investigate/${TOKEN}`);

  await page.goto('/radar');
  await expect(page).toHaveURL(/\/watch#radar$/);
  await page.goto('/b20');
  await expect(page).toHaveURL(/\/watch#tokens$/);
  expect(writes).toEqual([]);
});
