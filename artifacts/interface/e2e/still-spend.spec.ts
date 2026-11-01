import { expect, test, type Page } from '@playwright/test';
import { computeMirror } from '../../../lib/still-engine/src/mirror.js';
import { EXAMPLE, calendar, snapshot, universe } from '../../../lib/still-engine/test/fixtures.js';

// Still Spend, stage 1: Bitrefill's catalogue in USDC beside the reader's own
// Still room. It reads; nothing is bought and no wallet is asked anything.

const NOW = new Date('2026-10-28T15:00:00Z');
const WALLET = '0x1111111111111111111111111111111111111111';

function report() {
  return JSON.parse(JSON.stringify(computeMirror({
    universe: universe(), snapshot: snapshot(EXAMPLE), calendar: calendar(),
    subject: { address: WALLET as `0x${string}`, name: null, input: WALLET }, assembledAt: new Date('2026-10-21T15:00:01Z'),
  })));
}

async function install(page: Page, signedIn: boolean) {
  const reads: string[] = [], writes: string[] = [], walletMethods: string[] = [];
  await page.clock.setFixedTime(NOW);
  await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript',
    body: `export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:${signedIn}, phase:'${signedIn ? 'authenticated' : 'disconnected'}', sessionAuthenticated:${signedIn} }; }` }));
  await page.exposeFunction('__spendWalletMethod', (method: string) => { walletMethods.push(method); });
  await page.addInitScript(() => {
    Object.assign(window, { ethereum: { on() {}, removeListener() {}, request: async ({ method }: { method: string }) => {
      (window as unknown as { __spendWalletMethod: (m: string) => void }).__spendWalletMethod(method);
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_accounts') return [];
      return null;
    } } });
  });
  await page.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    (request.method() === 'GET' ? reads : writes).push(`${path}${url.search}`);
    if (path === '/api/auth/session') return route.fulfill({ json: { user: signedIn ? { id: 'fixture', address: WALLET, chainId: 8453 } : null } });
    if (path === '/api/still/mine' && signedIn) return route.fulfill({ json: { outcome: 'report', report: report(), cached: false } });
    if (path === '/api/public/still/spend/search') {
      if (url.searchParams.get('type') === 'giftcard') {
        return route.fulfill({ json: { outcome: 'products', type: 'giftcard', country: 'DE', query: url.searchParams.get('q') ?? '', readAt: NOW.toISOString(),
          products: url.searchParams.get('q') === 'Amazon' ? [{ id: 'amazon_de-germany', name: 'Amazon.de', countries: ['DE'], inStock: true }] : [] } });
      }
      return route.fulfill({ json: { outcome: 'products', type: 'esim', country: url.searchParams.get('country'), query: '', readAt: NOW.toISOString(), products: [
        { id: 'bitrefill-esim-germany', name: 'Bitrefill eSIM Germany', countries: ['DE'], inStock: true },
        { id: 'bitrefill-esim-europe', name: 'Bitrefill eSIM Europe', countries: ['AT', 'DE', 'FR'], inStock: true },
      ] } });
    }
    if (path === '/api/public/still/spend/product') {
      const id = url.searchParams.get('id');
      if (id === 'amazon_de-germany') {
        return route.fulfill({ json: { outcome: 'product', readAt: NOW.toISOString(), product: { id, name: 'Amazon.de', country: 'DE', inStock: true, recipientType: null, url: null,
          packages: [{ value: '50', faceCurrency: 'EUR', priceUsdc: '58.80' }, { value: '100000', faceCurrency: 'EUR', priceUsdc: '114230.00' }] } } });
      }
      return route.fulfill({ json: { outcome: 'product', readAt: NOW.toISOString(), product: { id, name: 'Bitrefill eSIM Germany', country: 'DE', inStock: true, recipientType: 'mixed', url: null,
        packages: [{ value: '1GB, 7 Days', faceCurrency: 'USD', priceUsdc: '2.53' }, { value: '10GB, 30 Days', faceCurrency: 'USD', priceUsdc: '13.25' }] } } });
    }
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { reads, writes, walletMethods };
}

for (const width of [390, 1366]) {
  test(`Spend lists Bitrefill's catalogue in USDC beside the reader's Still room, and buys nothing (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page, true);
    await page.goto('/spend');
    await expect(page.getByText('Nothing can be bought here yet.', { exact: false })).toBeVisible();
    await page.getByLabel('Country', { exact: true }).selectOption('DE');
    await page.getByRole('button', { name: /Bitrefill eSIM Europe\s*3 countries/ }).waitFor();
    await page.getByRole('button', { name: /^Bitrefill eSIM Germany/ }).click();
    await expect(page.getByRole('heading', { name: 'Bitrefill eSIM Germany' })).toBeVisible();
    const row = (label: string) => page.locator('.still-borrow-facts > div', { hasText: label });
    await expect(row('10GB, 30 Days')).toContainText('13.25 USDCwithin your room');
    await expect(page.getByText(/^Your Still room now: \$/)).toBeVisible();
    await page.getByRole('button', { name: /^Gift cards/ }).click();
    await page.getByLabel('Brand', { exact: true }).fill('Amazon');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: /^Amazon\.de/ }).click();
    await expect(row('50 EUR')).toContainText('58.80 USDCwithin your room');
    await expect(row('100000 EUR')).toContainText('114230.00 USDCmore than your room');
    expect(state.writes).toEqual([]);
    expect(state.walletMethods.filter(method => /sign|send|transaction/i.test(method))).toEqual([]);
    expect(state.reads.some(path => path.startsWith('/api/public/still/spend/search?type=giftcard&country=DE&q=Amazon'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('signed out, Spend shows the prices and offers sign-in instead of a comparison', async ({ page }) => {
  const state = await install(page, false);
  await page.goto('/spend');
  await page.getByRole('button', { name: /^Bitrefill eSIM Germany/ }).click();
  await expect(page.locator('.still-borrow-facts > div', { hasText: '1GB, 7 Days' })).toContainText('2.53 USDC');
  await expect(page.getByText(/to see which of these your Still room covers\./)).toBeVisible();
  await expect(page.getByText(/within your room|more than your room/)).toHaveCount(0);
  expect(state.reads.filter(path => path.startsWith('/api/still/mine'))).toEqual([]);
});
