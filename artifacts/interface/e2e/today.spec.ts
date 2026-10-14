import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { briefFixture } from '../../../lib/rwa-market-reality/test/fixtures/stockBrief.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const LOOKALIKE = '0x2222222222222222222222222222222222222222';
const OFFICIAL = '0xb20000000000000000000078ee7ce2fe4908108c';
const index = JSON.parse(readFileSync(new URL('./fixtures/underlyings.json', import.meta.url), 'utf8'));

// Fixtures exercise the real page, hooks and routing without an operator
// session or a wallet capable of signing. Every API request is intercepted.
async function install(page: Page, signedIn: boolean, failPortfolio = false) {
  const reads: string[] = [], writes: string[] = [];
  await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript',
    body: `export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:${signedIn}, phase:'${signedIn ? 'authenticated' : 'anonymous'}', sessionAuthenticated:${signedIn} }; }` }));
  await page.route('**/TodayPage.tsx*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const replacement = source.replace(/import\s*\{\s*useAccount\s*\}\s*from\s*["'][^"']+["'];?/u,
      `const useAccount = () => ({ address: ${signedIn ? JSON.stringify(WALLET) : 'undefined'} });`);
    expect(replacement).not.toBe(source);
    await route.fulfill({ response, body: replacement });
  });
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    (request.method() === 'GET' ? reads : writes).push(path);
    if (path === '/api/auth/session') return route.fulfill({ json: { user: signedIn ? { id: 'fixture', address: WALLET, chainId: 8453 } : null } });
    if (path === '/api/status') return route.fulfill({ json: { chainId: 8453,
      productMigration: { routeIntelligenceV1: true, b20ControlV1: false }, rpc: { status: 'connected' },
      baseMcp: { enabled: true, configured: true, auth: { connected: signedIn } } } });
    if (path.endsWith('/rwa/underlyings') || path === '/api/public/stocks/underlyings') return route.fulfill({ json: index });
    if (path === '/api/portfolio' && !failPortfolio) return route.fulfill({ json: {
      updatedAt: '2026-10-14T08:00:00.000Z', dataFreshness: 'cached', tokens: [
      { symbol: 'ETH', address: 'native', balanceFormatted: '0.0003' },
      { symbol: 'NVDAc', address: OFFICIAL, balanceFormatted: '1', usdValue: '0.20', registry: { standing: 'official', ticker: 'NVDAc' } },
      { symbol: 'AAPLc', address: LOOKALIKE, balanceFormatted: '15', registry: { standing: 'lookalike', ticker: 'AAPLc', officialAddress: OFFICIAL } },
      ...Array.from({ length: 32 }, (_, i) => ({ symbol: `UNCHECKED${i}`, address: `0x${(i + 100).toString(16).padStart(40, '0')}`, balanceFormatted: '1' })),
    ] } });
    if (path === '/api/stocks/today') return route.fulfill({ json: briefFixture() });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { reads, writes };
}

for (const width of [1280, 390]) {
  test(`Today leads with findings and hands questions over without executing (${width}px)`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 844 });
    const { reads, writes } = await install(page, true);
    await page.goto('/');
    await expect(page).toHaveURL(/\/today$/);
    const finding = page.getByText("AAPLc — issuer address doesn't match", { exact: true });
    await expect(finding).toBeVisible();
    await expect(page.getByText('Your NVDAc', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My stocks today', exact: true })).toBeHidden();
    await expect(page.getByText('Wallet overview updated Oct 14, 08:00 AM UTC · cached data', { exact: true })).toBeVisible();
    const order = await page.evaluate(() => {
      const cards = document.querySelector('.today .cardrow[data-tone="attention"]');
      const ask = document.querySelector('#today-ask-input');
      return Boolean(cards && ask && (cards.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(order).toBe(true);
    const question = await page.locator('#today-ask-input').boundingBox();
    expect(question).not.toBeNull();
    expect(question!.y + question!.height).toBeLessThan(844);
    const wallet = page.getByRole('region', { name: 'My wallet', exact: true });
    await expect(wallet).toBeVisible();
    await expect(wallet.getByLabel('Search by symbol or address')).toBeHidden();
    const portfolioReads = reads.filter(path => path === '/api/portfolio').length;
    await wallet.getByText('View all · 35 balances', { exact: true }).click();
    const search = wallet.getByLabel('Search by symbol or address');
    await search.fill(' nvdac ');
    await expect(wallet.getByText('1 of 35 balances', { exact: true })).toBeVisible();
    await expect(wallet.getByText('≈ $0.20', { exact: true })).toBeVisible();
    await search.fill(LOOKALIKE.toUpperCase());
    await expect(wallet.locator('li')).toHaveCount(1);
    await expect(wallet.getByText('AAPLc', { exact: true })).toBeVisible();
    await search.fill('nothing like this');
    await expect(wallet.getByText('No balance matches this search.', { exact: true })).toBeVisible();
    await search.fill('ETH');
    await expect(wallet.locator('li')).toHaveCount(1);
    await expect(wallet.getByRole('button', { name: /^Check / })).toHaveCount(0);
    await wallet.getByText('View all · 35 balances', { exact: true }).click();
    expect(reads.filter(path => path === '/api/portfolio').length).toBe(portfolioReads);
    await page.getByText('Stocks and recent updates · 0', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'My stocks today', exact: true })).toBeVisible();
    await page.getByText('Stocks and recent updates · 0', { exact: true }).click();
    const coverage = page.locator('.today-details').filter({ has: page.locator('summary', { hasText: "32 tokens outside Miorail's reviewed coverage" }) });
    await coverage.locator('summary').click();
    await expect(coverage.getByText(/coverage gap, not a risk finding/)).toBeVisible();
    await coverage.locator('summary').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`today-holder-${width}.png`), fullPage: true });

    await page.getByRole('button', { name: 'See the evidence', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/investigate\\?token=${LOOKALIKE}`));
    await expect.poll(() => reads.includes(`/api/route-intelligence/rwa/investigate/${LOOKALIKE}`)).toBe(true);
    await page.goto('/today');
    await page.locator('.today-details > summary').filter({ hasText: /^Rewards$/ }).click();
    await page.getByRole('button', { name: 'What can I claim?', exact: true }).first().click();
    await expect(page.locator('#base-mcp-console-input')).toHaveValue('What can I claim?', { timeout: 20_000 });
    expect(writes).toEqual([]);

    await page.goto('/today');
    await page.locator('#today-ask-input').fill('Swap 100 USDC to ETH');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect(page.getByPlaceholder('Swap 100 USDC to ETH with the best net result')).toHaveValue('Swap 100 USDC to ETH', { timeout: 20_000 });
    expect(writes).toEqual([]);

    await page.goto('/today');
    await page.locator('#today-ask-input').fill('Что происходит с NVDA?');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect(page).toHaveURL(/\/stocks\/nvda$/);
    expect(writes).toEqual([]);
  });
}

test('Today guest reads no private wallet data; an address opens the public dossier', async ({ page }) => {
  const { reads, writes } = await install(page, false);
  await page.goto('/today');
  await expect(page.getByRole('heading', { name: 'Is it the real one, and can you sell it?' })).toBeVisible();
  await page.locator('#today-ask-input').fill(LOOKALIKE);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/is-it-real/${LOOKALIKE}`));
  expect(reads).not.toContain('/api/portfolio');
  expect(reads).not.toContain('/api/stocks/today');
  expect(writes).toEqual([]);
});

test('Today failed balances show an unavailable read instead of zero holdings', async ({ page }) => {
  await install(page, true, true);
  await page.goto('/today');
  await expect(page.getByText('Your balances could not be read. This is not a statement about what you hold.', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByLabel('Today in numbers')).toHaveCount(0);
  await expect(page.getByText("AAPLc — issuer address doesn't match", { exact: true })).toHaveCount(0);
});
