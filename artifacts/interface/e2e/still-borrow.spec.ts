import { expect, test, type Page } from '@playwright/test';
import { CRYPTO, STOCKS, ADDRESSES } from '../../../lib/still-engine/src/registry.js';
import { stillTerms } from '../../../lib/still-engine/src/terms.js';
import { calendar } from '../../../lib/still-engine/test/fixtures.js';

const NOW = new Date('2026-10-28T15:00:00Z');
const WALLET = '0x1111111111111111111111111111111111111111';
const REVIEW_URL = '/lending/miorail-lending-v1.fixturepayload.fixturesignature';

async function install(page: Page, signedIn = true) {
  await page.clock.setFixedTime(NOW);
  await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript', body:
    `export function AuthProvider({children}) { return children; } export function useAuthGate() { return {showPrivateSurfaces:${signedIn},phase:'${signedIn ? 'authenticated' : 'disconnected'}',sessionAuthenticated:${signedIn}}; }` }));
  await page.addInitScript(() => {
    const methods: string[] = [];
    Object.assign(window, { __stillBorrowWalletMethods: methods, ethereum: {
      on() {}, removeListener() {},
      request: async ({ method }: { method: string }) => {
        methods.push(method);
        if (/sign|send|transaction/i.test(method)) throw new Error('Fixture forbids wallet actions');
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'eth_accounts') return [];
        return null;
      },
    } });
  });
  const state = {
    mode: 'read' as 'read' | 'unavailable' | 'refused' | 'unknown-balance',
    limitReads: [] as URL[], writes: [] as string[], intents: [] as unknown[],
    intentGate: null as Promise<void> | null,
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() !== 'GET') {
      state.writes.push(path);
      if (request.method() === 'POST' && path === '/api/route-intelligence/rwa/borrow/intent') {
        state.intents.push(request.postDataJSON());
        if (state.intentGate) await state.intentGate;
        await route.fulfill({ json: { borrowDraftId: 'fixture-draft', reviewUrl: REVIEW_URL, expiresAt: '2026-10-28T15:05:00.000Z' } });
        return;
      }
      await route.fulfill({ status: 503, json: { error: 'fixture_write_forbidden' } });
      return;
    }
    if (path === '/api/auth/session') return route.fulfill({ json: { user: signedIn ? { id: 'fixture', address: WALLET, chainId: 8453 } : null } });
    if (path === '/api/public/still/terms') return route.fulfill({ json: JSON.parse(JSON.stringify(stillTerms(calendar(), NOW))) });
    if (path === '/api/route-intelligence/rwa/borrow/capacity') {
      state.limitReads.push(url);
      if (state.mode === 'unavailable') return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
      if (state.mode === 'refused') return route.fulfill({ json: { state: 'refused', detail: 'The selected pledge exceeds this wallet’s measured balance.' } });
      const asset = CRYPTO.find(row => row.token.toLowerCase() === url.searchParams.get('token')?.toLowerCase());
      const stock = STOCKS.find(row => row.token.toLowerCase() === url.searchParams.get('token')?.toLowerCase());
      if (!asset && !stock) return route.fulfill({ status: 400, json: { error: 'fixture_wrong_asset' } });
      const supply = url.searchParams.get('collateralSupplyAtomic');
      const native = url.searchParams.get('funding') === 'native';
      return route.fulfill({ json: {
        state: 'read', marketScope: stock ? 'still_aave_spoke' : 'still_registered_market', markets: [{
          marketId: stock ? ADDRESSES.aaveSpoke.toLowerCase() : asset!.morphoMarket, collateralTokenAddress: stock?.token.toLowerCase(), collateralDecimals: stock?.decimals ?? asset!.decimals, loanDecimals: 6,
          collateralSupplyAtomic: supply, walletCollateralAtomic: state.mode === 'unknown-balance' ? null : stock ? '100000000' : asset!.id === 'cbBTC' ? '25000000' : '500000000000000000',
          collateralAtomic: stock ? '0' : asset!.id === 'cbBTC' ? '1000000' : '100000000000000000', blockNumber: 53_177_777,
          ...(native ? { funding: 'native', nativeReserveAtomic: '500000000000000', feeQuoteState: 'wallet_quote_required' } : {}),
          still: { availableAtomic: '5000000', scope: supply === '0' ? 'existing_collateral' : 'selected_collateral' },
        }],
      } });
    }
    if (path.startsWith('/api/route-intelligence/rwa/lending/review/')) {
      return route.fulfill({ json: { state: 'refused', detail: 'Fixture review stops before any wallet action.' } });
    }
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return state;
}

async function noWalletAction(page: Page) {
  const methods = await page.evaluate(() => (window as unknown as { __stillBorrowWalletMethods: string[] }).__stillBorrowWalletMethods);
  expect(methods.filter(method => /sign|send|transaction/i.test(method))).toEqual([]);
}

for (const width of [390, 1366]) {
  test(`stock collateral uses its own exact decimals and Aave review (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); const state = await install(page);
    await page.goto('/borrow');
    await page.getByLabel('Stock collateral · Aave V4', { exact: true }).selectOption('NVDAc');
    await page.getByLabel('Amount to add', { exact: true }).fill('0.05000001');
    expect(state.limitReads).toHaveLength(0);
    await page.getByRole('button', { name: 'Read borrowing limit', exact: true }).click();
    await expect(page.locator('.still-borrow-maximum')).toContainText('5 USDC');
    expect(state.limitReads[0]!.searchParams.get('collateralSupplyAtomic')).toBe('5000001');
    expect(state.limitReads[0]!.searchParams.get('token')).toBe(STOCKS.find(row => row.id === 'NVDAc')!.token);
    await page.getByLabel('USDC to borrow', { exact: true }).fill('3');
    await page.getByRole('button', { name: 'Review loan', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${REVIEW_URL.replaceAll('.', '\\.')}$`));
    expect(state.intents).toEqual([{ collateralTokenAddress: STOCKS.find(row => row.id === 'NVDAc')!.token, collateralSupplyAtomic: '5000001', borrowAmountAtomic: '3000000' }]);
    expect(state.writes).toEqual(['/api/route-intelligence/rwa/borrow/intent']);
    await noWalletAction(page);
  });

  test(`a selected pledge is read on demand and becomes only a review question (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page);
    await page.goto('/borrow', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Get money', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assets', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(state.limitReads).toHaveLength(0);
    await page.getByRole('button', { name: /cbBTC/ }).click();
    await page.getByLabel('Amount to add', { exact: true }).fill('0.01');
    expect(state.limitReads).toHaveLength(0);
    await page.getByRole('button', { name: 'Read borrowing limit', exact: true }).click();
    await expect(page.locator('.still-borrow-maximum')).toContainText('5 USDC');
    expect(state.limitReads).toHaveLength(1);
    expect(state.limitReads[0]!.searchParams.get('collateralSupplyAtomic')).toBe('1000000');
    await page.getByLabel('USDC to borrow', { exact: true }).fill('3.000001');
    expect(state.limitReads).toHaveLength(1);
    await page.getByLabel('Amount to add', { exact: true }).fill('0.02');
    await expect(page.getByRole('button', { name: 'Review loan', exact: true })).toHaveCount(0);
    await expect(page.getByText(/Your collateral choice changed/)).toBeVisible();
    expect(state.limitReads).toHaveLength(1);
    await page.getByRole('button', { name: 'Read borrowing limit', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review loan', exact: true })).toBeEnabled();
    expect(state.limitReads).toHaveLength(2);
    expect(state.limitReads[1]!.searchParams.get('collateralSupplyAtomic')).toBe('2000000');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Filling fields can scroll on a phone. Full-page captures must start at
    // the top so sticky wallet/nav bars are not painted mid-document.
    await page.evaluate(() => window.scrollTo(0, 0));
    const heading = await page.getByRole('heading', { name: 'Get money', exact: true }).boundingBox();
    const walletBar = await page.locator('.still-walletbar').boundingBox();
    expect(heading && walletBar && heading.y >= walletBar.y + walletBar.height).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`selected-collateral-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Review loan', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${REVIEW_URL.replaceAll('.', '\\.')}$`));
    await expect(page.getByText('Sign in and connect the same wallet to read this private review.', { exact: true })).toBeVisible();
    expect(state.intents).toEqual([{ collateralTokenAddress: CRYPTO[0]!.token, collateralSupplyAtomic: '2000000', borrowAmountAtomic: '3000001' }]);
    expect(state.writes).toEqual(['/api/route-intelligence/rwa/borrow/intent']);
    await noWalletAction(page);
  });

  test(`unavailable, refused and unread balances stay different (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page);
    state.mode = 'unavailable';
    await page.goto('/borrow?asset=WETH', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: /WETH/ })).toHaveAttribute('aria-pressed', 'true');
    expect(state.limitReads).toHaveLength(0);
    await page.getByRole('button', { name: 'Read borrowing limit', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Your borrowing limit could not be read');
    await expect(page.getByRole('button', { name: 'Review loan', exact: true })).toHaveCount(0);
    state.mode = 'refused';
    await page.getByRole('button', { name: 'Read borrowing limit', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('The selected pledge exceeds this wallet’s measured balance.');
    state.mode = 'unknown-balance';
    await page.getByRole('button', { name: 'Read borrowing limit', exact: true }).click();
    await expect(page.locator('.still-borrow-facts')).toContainText('Not read');
    await expect(page.locator('.still-borrow-maximum')).toContainText('5 USDC');
    expect(state.limitReads).toHaveLength(3);
    expect(state.writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await noWalletAction(page);
  });
}

test('a visitor sees a sign-in link and never starts a private balance read', async ({ page }) => {
  const state = await install(page, false);
  await page.goto('/borrow?asset=cbBTC', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Sign in to read your balances and borrowing limit.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/signin?next=%2Fborrow%3Fasset%3DcbBTC');
  expect(state.limitReads).toEqual([]);
  expect(state.writes).toEqual([]);
});

test('an explicit native-ETH query requires a positive amount, keeps the fee reserve and submits nativeFundingAtomic', async ({ page }) => {
  const state = await install(page);
  await page.goto('/borrow?asset=ETH', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: /cbBTC/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: /WETH/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: /ETH\s*Wrap native ETH/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Read borrowing limit', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter an amount greater than zero.');
  expect(state.limitReads).toEqual([]);
  await page.getByLabel('Amount to add', { exact: true }).fill('0.01');
  await page.getByRole('button', { name: 'Read borrowing limit', exact: true }).click();
  await expect(page.locator('.still-borrow-maximum')).toContainText('5 USDC');
  await expect(page.getByText(/At least 0\.0005 ETH is kept out of the collateral/)).toBeVisible();
  await expect(page.locator('.still-borrow-facts')).toContainText('0.1 WETH');
  expect(state.limitReads[0]!.searchParams.get('funding')).toBe('native');
  expect(state.limitReads[0]!.searchParams.get('collateralSupplyAtomic')).toBe('10000000000000000');
  await page.getByLabel('USDC to borrow', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Review loan', exact: true }).click();
  expect(state.intents).toEqual([{
    collateralTokenAddress: CRYPTO[1]!.token,
    collateralSupplyAtomic: '10000000000000000',
    borrowAmountAtomic: '3000000',
    nativeFundingAtomic: '10000000000000000',
  }]);
  await noWalletAction(page);
});

test('a late prepared link cannot pull the person back after leaving the form', async ({ page }) => {
  const state = await install(page);
  let release!: () => void;
  state.intentGate = new Promise<void>(resolve => { release = resolve; });
  await page.goto('/borrow?asset=cbBTC', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Read borrowing limit', exact: true }).click();
  await page.getByLabel('USDC to borrow', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Review loan', exact: true }).click();
  await expect.poll(() => state.intents.length).toBe(1);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assets', exact: true }).click();
  await expect(page).toHaveURL(/\/assets$/);
  release();
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(/\/assets$/);
  expect(state.intents).toHaveLength(1);
  await noWalletAction(page);
});
