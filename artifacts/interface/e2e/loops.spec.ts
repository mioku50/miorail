import { expect, test, type Page } from '@playwright/test';

// /loops and its row in More. Every API request is intercepted; nothing signs and nothing is sent anywhere.

const ANSWER = {
  outcome: 'loops', weekStartsAt: '2026-11-16T00:00:00.000Z',
  counts: { total: 3, week: 2, viaAssistant: 2, byBrand: { apple: 2, amazon: 1, google: 0, meta: 0, microsoft: 0 } },
  wall: [{ loopNo: 2, brand: 'apple', brandName: 'Apple', card: 'Apple gift card', productName: 'iTunes Germany', packageLabel: '25 EUR',
    priceUsdc: '27', venueName: 'Aave', via: 'claude', day: '2026-11-17', label: 'alice.base.eth' }],
};

async function install(page: Page, open: boolean) {
  const writes: string[] = [];
  await page.route('**/AuthProvider.tsx*', (route) => route.fulfill({ contentType: 'application/javascript',
    body: 'export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:false, phase:"anonymous", sessionAuthenticated:false }; }' }));
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(path);
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null } });
    if (path === '/api/public/still/loops') return open ? route.fulfill({ json: ANSWER }) : route.fulfill({ status: 404, json: { outcome: 'loops_off' } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { writes };
}

for (const width of [390, 1280]) {
  test(`Loops show the week, how one is made and the wall, and More offers them once open (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { writes } = await install(page, true);
    await page.goto('/loops');
    await expect(page.getByRole('heading', { level: 1, name: 'Loops', exact: true })).toBeVisible();
    await expect(page.getByText('this week', { exact: true })).toBeVisible();
    await expect(page.getByText('An Xbox card, paid by a loan against MSFTc')).toBeVisible();
    await expect(page.getByText('Loop #2 · alice.base.eth')).toBeVisible();
    await expect(page.getByText(/can be liquidated if prices fall/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`loops-${width}.png`), fullPage: true });
    await page.goto('/more');
    await expect(page.getByRole('main').getByRole('link', { name: /^Loops/ })).toHaveAttribute('href', '/loops');
    expect(writes).toEqual([]);
  });
}

test('while Loops are closed the page says so and More does not offer it', async ({ page }) => {
  const { writes } = await install(page, false);
  await page.goto('/loops');
  await expect(page.getByText('Loops are not open yet.')).toBeVisible();
  await page.goto('/more');
  await expect(page.getByRole('heading', { level: 1, name: 'More', exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: /^Loops/ })).toHaveCount(0);
  expect(writes).toEqual([]);
});
