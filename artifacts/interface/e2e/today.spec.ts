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

test('the share action keeps readable text in the Sky night palette', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(new Date('2026-10-31T20:00:00Z')); // Berlin21:00 visual night
  const { writes } = await install(page, true);
  await page.goto('/today');
  await expect(page.locator('.still-frame')).toHaveAttribute('data-sky', 'night');
  const stock = page.getByRole('article', { name: 'Your NVDAc' });
  await stock.locator('summary.today-stock-id').click();
  await stock.locator('summary', { hasText: 'Share' }).click();
  const share = stock.getByRole('link', { name: 'Cast on Farcaster', exact: true });
  await expect(share).toBeVisible();
  const colour = await share.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, ink: style.color };
  });
  const luminance = (value: string) => {
    const channels = value.match(/[\d.]+/g)!.slice(0, 3).map(channel => {
      const s = Number(channel) / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const ink = luminance(colour.ink), background = luminance(colour.background);
  expect((Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
  expect(writes).toEqual([]);
});

for (const width of [1280, 390]) {
  test(`Today leads with findings and hands questions over without executing (${width}px)`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 844 });
    const { reads, writes } = await install(page, true);
    await page.goto('/today');
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
    // Investigate is a section of Watch now; the old address redirects there.
    await expect(page).toHaveURL(new RegExp(`/watch\\?token=${LOOKALIKE}#investigate`));
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
    // The signed-in wallet's Mirror, the one source for its loan: 3.4 NVDAc pledged, $240.17 owed.
    const report = (address: string, debtCents = '24017') => ({
      kind: 'still.mirror', version: 1,
      subject: { address, name: null, input: address },
      reading: { block: '53118515', blockTime: '2026-10-26T14:52:57.000Z', assembledAt: '2026-10-26T14:52:58.000Z', provider: 'infura' },
      terms: {
        version: '2026-10-25', stockShareBps: 5000, cryptoShareBps: 5000,
        weekend: { active: false, startsAt: '2026-10-31T00:00:00.000Z', endsAt: '2026-11-02T01:00:00.000Z', stockShareBps: 4000 },
        earnings: { stockShareBps: 4000, calendarReadAt: '2026-10-26T14:00:00.000Z' },
      },
      headline: { state: 'funded', availableCents: '37028', complete: true, reason: null, weekdayAvailableCents: null },
      assets: [{
        asset: 'NVDAc', kind: 'stock', name: 'NVIDIA', symbol: 'NVDAc', token: '0xb2000000000000000000001ba3d2eb3a2f32f1b6',
        isin: 'US67066G1040', venue: 'aave-v4', wallet: { raw: '80000000', decimals: 8 }, pledged: { raw: '340000000', decimals: 8 },
        shares: null, priceCents: '21190', priceUpdatedAt: '2026-10-21T14:00:00.000Z', valueCents: '89000', protocolFactorBps: 7000,
        stillFactorBps: 3500, capacityCents: '31150', earnings: null, limits: [], failed: [],
      }],
      venues: [{
        venue: 'aave-v4', market: '0x17905db0e4a3514467539956c084180616ae7b8d', label: 'Aave V4 · Coinbase Stocks',
        debtCents, capacityCents: '61045', availableCents: '37028', borrowRateBps: 366, liquidityCents: '109645815',
        deductions: { loansCents: '24017', venueLimitCents: '0' },
        safety: { marginBps: 5237, state: 'calm', healthFactor: '2099920000000000000', source: 'computed' },
        liquidationPrices: [{ asset: 'NVDAc', priceCents: '10092', unreachable: false }], failed: [],
      }],
      coverage: { measured: [], notCounted: [], failed: [] }, evidence: [],
    });
    await page.route('**/api/still/mine', route => {
      calls++;
      expect(route.request().method()).toBe('GET');
      expect(new URL(route.request().url()).search).toBe('');
      if (calls === 2) return route.fulfill({ status: 503, json: { outcome: 'chain_unavailable', attempts: [] } });
      const answer = calls === 3 ? report(LOOKALIKE, '999900') : report(WALLET);
      return route.fulfill({ json: { outcome: 'report', report: answer, cached: false } });
    });
    await page.goto('/today');
    const section = page.locator('.today-details').filter({ has: page.locator('summary', { hasText: 'Your Aave v4 stock position' }) });
    await section.locator('summary').click();
    await expect(section.getByRole('button', { name: 'Read my Aave position', exact: true })).toBeVisible();
    expect(calls).toBe(0);
    await section.getByRole('button', { name: 'Read my Aave position', exact: true }).click();
    await expect(section.getByText('$240.17', { exact: true })).toBeVisible();
    await expect(section.getByText(/health factor falls to 1/)).toBeVisible();
    await expect(section.getByText('3.66% a year, variable', { exact: true })).toBeVisible();
    expect(calls).toBe(1);
    await section.getByRole('button', { name: 'Read again', exact: true }).click();
    await expect(section.getByRole('status')).toContainText('does not mean you have no position');
    await expect(section.getByText('$240.17', { exact: true })).toBeVisible();
    expect(calls).toBe(2);
    await section.getByRole('button', { name: 'Read again', exact: true }).click();
    await expect.poll(() => calls).toBe(3);
    await expect(section.getByRole('status')).toContainText('previous result');
    await expect(section.getByText('$9,999.00', { exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
