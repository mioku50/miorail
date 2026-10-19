import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { briefFixture } from '../../../lib/rwa-market-reality/test/fixtures/stockBrief.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const LOOKALIKE = '0x2222222222222222222222222222222222222222';
const OFFICIAL = '0xb20000000000000000000078ee7ce2fe4908108c';
const index = JSON.parse(readFileSync(new URL('./fixtures/underlyings.json', import.meta.url), 'utf8'));
// The Stocks board's reading of the official NVDAc: its icon and its price on Base.
const QUOTES = { schemaVersion: 'stock-quotes/v1', asOf: '2026-10-14T08:00:00.000Z', rows: [{
  underlyingKey: 'security:isin:US67066G1040', tokenAddress: OFFICIAL, tokenSymbol: 'NVDAc', companyName: 'NVIDIA Corporation',
  iconPath: `/api/public/stocks/icons/${OFFICIAL}.png`, priceUsd: 217.882337005, priceAt: '2026-10-14T07:15:26.994Z',
  change24h: 0.02123820995496839, changeFromAt: '2026-10-13T07:27:00.402Z' }] };
const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

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
    if (path === '/api/public/stocks/quotes') return route.fulfill({ json: QUOTES });
    if (path.startsWith('/api/public/stocks/icons/')) return route.fulfill({ contentType: 'image/png', body: ICON });
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
    const finding = page.getByText('Not the official AAPLc', { exact: true });
    await expect(finding).toBeVisible();
    // The holding leads by its face: Coinbase's icon, ticker and company, and the price on Base.
    const stockCard = page.getByRole('article', { name: 'Your NVDAc' });
    await expect(stockCard).toBeVisible();
    await expect(stockCard.locator('.today-stock-name', { hasText: 'NVDAc' })).toBeVisible();
    await expect(stockCard.getByText('$217.88 on Base · +2.12% 24h', { exact: true })).toBeVisible();
    await expect.poll(() => stockCard.locator('img.mr-stock-icon').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    // The first screen, as it loads: the finding and the holding, then the question.
    const order = await page.evaluate(() => {
      const [finding, holding, ask] = ['.today .cardrow[data-tone="attention"]', '.today-stock', '#today-ask-input']
        .map(selector => document.querySelector(selector));
      const follows = (first: Element | null, next: Element | null) =>
        Boolean(first && next && (first.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING));
      return follows(finding, holding) && follows(holding, ask);
    });
    expect(order).toBe(true);
    const question = await page.locator('#today-ask-input').boundingBox();
    expect(question).not.toBeNull();
    expect(question!.y + question!.height).toBeLessThan(844);
    // The row opens to its actions; both places to post sit behind one "Share" among them.
    await stockCard.locator('summary.today-stock-id').click();
    await expect(stockCard.getByRole('button', { name: 'View market', exact: true })).toBeVisible();
    await stockCard.locator('summary', { hasText: 'Share' }).click();
    const share = stockCard.getByRole('group', { name: 'Share NVDA stock card' });
    await expect(share.getByRole('link', { name: 'Post on X', exact: true })).toBeVisible();
    await expect(share.getByRole('link', { name: 'Cast on Farcaster', exact: true })).toBeVisible();
    for (const href of await share.locator('a').evaluateAll(links => links.map(link => link.href))) {
      expect(decodeURIComponent(href)).toContain('https://miorail.xyz/stocks/nvda');
      expect(decodeURIComponent(href)).not.toContain(WALLET);
      expect(decodeURIComponent(href)).not.toContain('0.00088158');
    }
    await expect(page.getByRole('heading', { name: 'My stocks today', exact: true })).toBeHidden();
    await expect(page.getByText('Wallet overview updated Oct 14, 08:00 AM UTC · cached data', { exact: true })).toBeVisible();
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
  await expect(page.getByText('Not the official AAPLc', { exact: true })).toHaveCount(0);
});

for (const width of [1280, 390]) {
  test(`Aave position is requested explicitly; errors and another wallet cannot replace it (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { writes } = await install(page, true);
    let calls = 0;
    const position = {
      schemaVersion: 'aave-v4-position/v1', chainId: 8453, walletAddress: WALLET,
      spokeAddress: '0x17905db0e4a3514467539956c084180616ae7b8d', observedAt: '2026-10-14T12:00:00Z',
      source: 'aave_api', state: 'read', collateralUsd: '2000', debtUsd: '500',
      netAccruedInterestUsd: '-0.125', netBorrowApyBps: 333, healthFactor: '0.99', remainingBorrowingPowerUsd: '0',
    };
    await page.route('**/api/aave/position', route => {
      calls++;
      expect(route.request().method()).toBe('GET');
      expect(new URL(route.request().url()).search).toBe('');
      if (calls === 2) return route.fulfill({ status: 503, json: { code: 'aave_v4_position_unread' } });
      return route.fulfill({ json: calls === 3 ? { ...position, walletAddress: LOOKALIKE, debtUsd: '9999' } : position });
    });
    await page.goto('/today');
    const section = page.locator('.today-details').filter({ has: page.locator('summary', { hasText: 'Your Aave v4 stock position' }) });
    await section.locator('summary').click();
    await expect(section.getByRole('button', { name: 'Read my Aave position', exact: true })).toBeVisible();
    expect(calls).toBe(0);
    await section.getByRole('button', { name: 'Read my Aave position', exact: true }).click();
    await expect(section.getByText('$500.00', { exact: true })).toBeVisible();
    await expect(section.getByText(/Liquidation threshold: health factor 1/)).toBeVisible();
    await expect(section.getByText('3.33%', { exact: true })).toBeVisible();
    expect(calls).toBe(1);
    await section.getByRole('button', { name: 'Read again', exact: true }).click();
    await expect(section.getByRole('status')).toContainText('does not mean you have no position');
    await expect(section.getByText('$500.00', { exact: true })).toBeVisible();
    expect(calls).toBe(2);
    await section.getByRole('button', { name: 'Read again', exact: true }).click();
    await expect.poll(() => calls).toBe(3);
    await expect(section.getByRole('status')).toContainText('previous result');
    await expect(section.getByText('$9,999.00', { exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
