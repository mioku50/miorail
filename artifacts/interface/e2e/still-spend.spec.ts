import { expect, test, type Page } from '@playwright/test';
import { computeMirror } from '../../../lib/still-engine/src/mirror.js';
import { CRYPTO } from '../../../lib/still-engine/src/registry.js';
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

const ORDER_ID = '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34';
const ORDER = { orderId: ORDER_ID, productId: 'bitrefill-esim-germany', productName: 'Bitrefill eSIM Germany', packageValue: '1GB, 7 Days', faceCurrency: 'USD',
  priceAtomic: '2530000', payTo: '0x3333333333333333333333333333333333333333', createdAt: NOW.toISOString(), expiresAt: '2026-10-28T15:15:00.000Z', paymentLink: null };

async function install(page: Page, signedIn: boolean, options: { pay?: boolean } = {}) {
  const reads: string[] = [], writes: string[] = [], walletMethods: string[] = [], bodies: Record<string, unknown> = {};
  const checkout = options.pay ? { checkout: { enabled: true, available: true, capAtomic: '100000000' } } : {};
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
    if (request.method() === 'POST' && options.pay) bodies[path] = request.postDataJSON();
    if (options.pay && request.method() === 'POST' && path === '/api/still/spend/orders') return route.fulfill({ json: { order: ORDER } });
    if (options.pay && path === `/api/still/spend/orders/${ORDER_ID}`) return route.fulfill({ json: { order: ORDER, status: { status: 'unpaid', accessLink: null, esimInstallLink: null }, statusError: null } });
    if (options.pay && path === '/api/route-intelligence/rwa/borrow/capacity') {
      const asset = CRYPTO.find(row => row.token.toLowerCase() === url.searchParams.get('token')?.toLowerCase())!;
      return route.fulfill({ json: { state: 'read', marketScope: 'still_registered_market', markets: [{ marketId: asset.morphoMarket, collateralDecimals: asset.decimals, loanDecimals: 6,
        collateralSupplyAtomic: url.searchParams.get('collateralSupplyAtomic'), walletCollateralAtomic: '25000000', collateralAtomic: '1000000', blockNumber: 53_177_777,
        still: { availableAtomic: '5000000', scope: 'existing_collateral' }, comparison: null }] } });
    }
    if (options.pay && request.method() === 'POST' && path === '/api/route-intelligence/rwa/borrow/intent') {
      return route.fulfill({ json: { borrowDraftId: 'fixture-draft', reviewUrl: '/lending/miorail-lending-v3.fixturepayload.fixturesignature', expiresAt: '2026-10-28T15:05:00.000Z' } });
    }
    if (options.pay && path.startsWith('/api/route-intelligence/rwa/lending/review/')) return route.fulfill({ json: { state: 'refused', refusal: 'fixture', detail: 'Fixture review stops before any wallet action.' } });
    if (path === '/api/auth/session') return route.fulfill({ json: { user: signedIn ? { id: 'fixture', address: WALLET, chainId: 8453 } : null } });
    if (path === '/api/still/mine' && signedIn) return route.fulfill({ json: { outcome: 'report', report: report(), cached: false } });
    if (path === '/api/public/still/spend/search') {
      if (url.searchParams.get('type') === 'giftcard') {
        return route.fulfill({ json: { ...checkout, outcome: 'products', type: 'giftcard', country: 'DE', query: url.searchParams.get('q') ?? '', readAt: NOW.toISOString(),
          products: url.searchParams.get('q') === 'Amazon' ? [{ id: 'amazon_de-germany', name: 'Amazon.de', countries: ['DE'], inStock: true }] : [] } });
      }
      return route.fulfill({ json: { ...checkout, outcome: 'products', type: 'esim', country: url.searchParams.get('country'), query: '', readAt: NOW.toISOString(), products: [
        { id: 'bitrefill-esim-germany', name: 'Bitrefill eSIM Germany', countries: ['DE'], inStock: true },
        { id: 'bitrefill-esim-europe', name: 'Bitrefill eSIM Europe', countries: ['AT', 'DE', 'FR'], inStock: true },
      ] } });
    }
    if (path === '/api/public/still/spend/product') {
      const id = url.searchParams.get('id');
      if (id === 'amazon_de-germany') {
        return route.fulfill({ json: { ...checkout, outcome: 'product', readAt: NOW.toISOString(), product: { id, name: 'Amazon.de', country: 'DE', inStock: true, recipientType: null, url: null,
          packages: [{ value: '50', faceCurrency: 'EUR', priceUsdc: '58.80' }, { value: '100000', faceCurrency: 'EUR', priceUsdc: '114230.00' }] } } });
      }
      return route.fulfill({ json: { ...checkout, outcome: 'product', readAt: NOW.toISOString(), product: { id, name: 'Bitrefill eSIM Germany', country: 'DE', inStock: true, recipientType: 'mixed', url: null,
        packages: [{ value: '1GB, 7 Days', faceCurrency: 'USD', priceUsdc: '2.53' }, { value: '10GB, 30 Days', faceCurrency: 'USD', priceUsdc: '13.25' }] } } });
    }
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { reads, writes, walletMethods, bodies };
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
    const row = (label: string) => page.locator('.still-spend-price', { hasText: label });
    await expect(row('10GB, 30 Days')).toContainText('13.25 USDC');
    await expect(row('10GB, 30 Days')).toContainText('Within your room');
    await expect(page.locator('.still-spend-room')).toContainText('Your Still room now');
    await expect(page.locator('.still-spend-room-amount')).toHaveText(/^(at least )?\$[\d,]+\.\d\d$/);
    await page.getByRole('button', { name: /^Gift cards/ }).click();
    await page.getByLabel('Brand', { exact: true }).fill('Amazon');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: /^Amazon\.de/ }).click();
    await expect(row('50 EUR')).toContainText('58.80 USDC');
    await expect(row('50 EUR')).toContainText('Within your room');
    await expect(row('100000 EUR')).toContainText('114230.00 USDC');
    await expect(row('100000 EUR')).toContainText('More than your room');
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
  await expect(page.locator('.still-spend-price', { hasText: '1GB, 7 Days' })).toContainText('2.53 USDC');
  await expect(page.getByText(/to see which of these your Still room covers\./)).toBeVisible();
  await expect(page.getByText(/within your room|more than your room/i)).toHaveCount(0);
  expect(state.reads.filter(path => path.startsWith('/api/still/mine'))).toEqual([]);
});

for (const width of [390, 1366]) {
  test(`paying from Still opens one invoice, then Get money borrows exactly its price, and nothing is signed (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page, true, { pay: true });
    await page.goto('/spend');
    await expect(page.getByText(/^Pay with Still: a loan for the exact price pays Bitrefill/)).toBeVisible();
    await page.getByRole('button', { name: /^Bitrefill eSIM Germany/ }).click();
    const row = page.locator('.still-spend-price', { hasText: '1GB, 7 Days' });
    await row.getByRole('button', { name: 'Pay with Still', exact: true }).click();
    await expect(page.getByRole('heading', { name: '2.53 USDC for Bitrefill eSIM Germany · 1GB, 7 Days' })).toBeVisible();
    await page.getByLabel('Email for Bitrefill’s receipt', { exact: true }).fill('buyer@example.com');
    await page.getByRole('button', { name: 'Open invoice and choose collateral', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/borrow\\?spend=${ORDER_ID}$`));
    await expect(page.getByText(/^Paying Bitrefill · Bitrefill eSIM Germany · 1GB, 7 Days: 2\.53 USDC\./)).toBeVisible();
    // Native ETH cannot carry a payment, so it is not offered here.
    await expect(page.getByRole('button', { name: /Wrap native ETH/ })).toHaveCount(0);
    await page.getByRole('button', { name: /^cbBTC/ }).click();
    await page.getByRole('button', { name: 'Read borrowing limit', exact: true }).click();
    await expect(page.getByLabel(/USDC to borrow/)).toHaveValue('2.53');
    await page.getByRole('button', { name: 'Review loan and payment', exact: true }).click();
    await expect(page).toHaveURL(/\/lending\/miorail-lending-v3\.fixturepayload\.fixturesignature$/);
    expect(state.bodies['/api/still/spend/orders']).toEqual({ productId: 'bitrefill-esim-germany', packageValue: '1GB, 7 Days', email: 'buyer@example.com' });
    expect(state.bodies['/api/route-intelligence/rwa/borrow/intent']).toEqual({ collateralTokenAddress: CRYPTO[0]!.token, collateralSupplyAtomic: '0', borrowAmountAtomic: '2530000', spendOrderId: ORDER_ID });
    expect(state.walletMethods.filter(method => /sign|send|transaction/i.test(method))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

