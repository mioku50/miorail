import { expect, test, type Page } from '@playwright/test';

// A Still Spend purchase someone shared: the public page asks the server what
// the signed link claims, shows the card, and asks no wallet anything. The
// links and every answer here are made up.

const NOW = new Date('2026-11-01T16:00:00Z');
const TOKEN = `ss1.${'e'.repeat(120)}.${'s'.repeat(43)}`;
const FORGED = `ss1.${'f'.repeat(120)}.${'x'.repeat(43)}`;
// A plain loan's card shares the address (2026-11-03).
const LOAN = `sl1.${'l'.repeat(60)}.${'s'.repeat(43)}`;
// One transparent pixel stands in for the card.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function install(page: Page) {
  const reads: string[] = [], walletMethods: string[] = [];
  await page.clock.setFixedTime(NOW);
  await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript',
    body: "export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:false, phase:'disconnected', sessionAuthenticated:false }; }" }));
  await page.exposeFunction('__shareWalletMethod', (method: string) => { walletMethods.push(method); });
  await page.addInitScript(() => {
    Object.assign(window, { ethereum: { on() {}, removeListener() {}, request: async ({ method }: { method: string }) => {
      (window as unknown as { __shareWalletMethod: (m: string) => void }).__shareWalletMethod(method);
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_accounts') return [];
      return null;
    } } });
  });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url()), path = url.pathname;
    reads.push(`${path}${url.search}`);
    if (path === '/api/public/still/spend-share') {
      if (url.searchParams.get('t') === LOAN) {
        return route.fulfill({ json: { outcome: 'share', share: { kind: 'loan', borrowedUsdc: '2.00', collateralLabel: 'NVDA', collateralName: 'NVIDIA stock', venueName: 'Aave' } } });
      }
      return url.searchParams.get('t') === TOKEN
        ? route.fulfill({ json: { outcome: 'share', share: { productName: 'PUBG Mobile UC International', packageLabel: '10 UC', priceUsdc: '0.18',
          collateralLabel: 'NVDA', collateralName: 'NVIDIA stock', venueName: 'Aave' } } })
        : route.fulfill({ status: 404, json: { outcome: 'share_invalid' } });
    }
    if (path === '/api/public/still/spend-card.png') return route.fulfill({ contentType: 'image/png', body: PNG });
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { reads, walletMethods };
}

for (const width of [390, 1366]) {
  test(`a shared purchase shows its card and what it claims, and asks no wallet anything (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page);
    await page.goto(`/spend/p/${TOKEN}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Paid with a loan', exact: true })).toBeVisible();
    await expect(page.getByText('PUBG Mobile UC International, 10 UC, for 0.18 USDC. Borrowed against NVDA through Aave and paid to Bitrefill with that loan on Base, without selling.')).toBeVisible();
    const card = page.locator('img.still-spend-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('src', `/api/public/still/spend-card.png?t=${TOKEN}`);
    await expect(page.getByRole('link', { name: 'See what a loan could pay for', exact: true })).toHaveAttribute('href', '/spend');
    expect(state.reads.filter(read => read.startsWith('/api/public/still/spend-share'))).toEqual([`/api/public/still/spend-share?t=${TOKEN}`]);
    expect(state.walletMethods.filter(method => /sign|send|transaction/i.test(method))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`spend-share-${width}.png`), fullPage: true });
  });
}

test('a purchase link Still did not sign shows nothing it claims', async ({ page }) => {
  const state = await install(page);
  await page.goto(`/spend/p/${FORGED}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('This purchase card could not be verified, so nothing about it is shown.')).toBeVisible();
  await expect(page.locator('img.still-spend-card')).toHaveCount(0);
  await expect(page.getByText(/PUBG/)).toHaveCount(0);
  expect(state.reads.some(read => read.startsWith('/api/public/still/spend-card.png'))).toBe(false);
});

for (const width of [390, 1366]) {
  test(`a shared loan shows its card and what it claims, and asks no wallet anything (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page);
    await page.goto(`/spend/p/${LOAN}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Spent without selling', exact: true })).toBeVisible();
    await expect(page.getByText('2.00 USDC borrowed against NVDA through Aave on Base. Nothing was sold: it is the loan’s collateral.')).toBeVisible();
    await expect(page.locator('img.still-spend-card')).toHaveAttribute('src', `/api/public/still/spend-card.png?t=${LOAN}`);
    await expect(page.getByRole('link', { name: 'See what a wallet could borrow without selling', exact: true })).toHaveAttribute('href', '/');
    expect(state.walletMethods.filter(method => /sign|send|transaction/i.test(method))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`loan-share-${width}.png`), fullPage: true });
  });
}
