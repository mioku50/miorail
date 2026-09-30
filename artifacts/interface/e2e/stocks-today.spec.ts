import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { briefFixture, NOW } from '../../../lib/rwa-market-reality/test/fixtures/stockBrief.js';
import type { StockPositionQuoteV1 } from '@mioagent/rwa-market-reality/stock-position-quote';

const WALLET = '0x1111111111111111111111111111111111111111';
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

for (const width of [1440, 390]) {
  test(`a returning holder sees a personal overview, can refresh and open its stock (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const asked: string[] = [];
    const writes: string[] = [];
    let fail = false;
    await page.route('**/AuthProvider.tsx*', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `
      export function AuthProvider({children}) { return children; }
      export function useAuthGate() { return { showPrivateSurfaces:true, phase:'authenticated', sessionAuthenticated:true, continueWithWallet:async()=>{}, signing:false, error:null }; }
    `,
      }),
    );
    await page.route('**/api/**', (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() !== 'GET') writes.push(url.pathname);
      if (url.pathname === '/api/auth/session')
        return route.fulfill({
          json: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } },
        });
      if (url.pathname === '/api/status')
        return route.fulfill({
          json: {
            chainId: 8453,
            productMigration: { routeIntelligenceV1: true },
            rpc: { status: 'connected' },
          },
        });
      if (url.pathname === '/api/stocks/today') {
        asked.push(url.search);
        const brief = briefFixture();
        if (url.searchParams.get('since')) brief.since = url.searchParams.get('since')!;
        return route.fulfill(
          fail ? { status: 503, json: { code: 'stock_brief_unread' } } : { json: brief },
        );
      }
      if (url.pathname.endsWith('/rwa/underlyings'))
        return route.fulfill({ json: fixture('underlyings') });
      if (
        url.pathname.includes('/rwa/market-reality/') &&
        !/\/(measure|history|ask)$/.test(url.pathname)
      )
        return route.fulfill({ json: fixture('nvda-market') });
      return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
    });
    await page.goto('/stocks');
    const card = page.getByRole('region', { name: 'My stocks today', exact: true });
    await expect(card.getByText('0.000882 held')).toBeVisible();
    await expect(card.getByRole('heading', { name: 'In the last 24 hours' })).toBeVisible();
    expect(asked[0]).toBe('');
    await page.reload();
    await expect(card.getByRole('heading', { name: 'Since your last visit' })).toBeVisible();
    await expect
      .poll(() =>
        asked.some((query) => new URLSearchParams(query).get('since') === NOW.toISOString()),
      )
      .toBe(true);
    await card.getByText('What was measured', { exact: true }).click();
    await expect(card.getByText(/They are not sale proceeds/)).toBeVisible();
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/miorail-stocks-today-${width}.png`, fullPage: false });
    fail = true;
    await card.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(card.getByText(/Your overview could not be refreshed/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(card.getByText('0.000882 held')).toBeVisible();
    await card.getByRole('link', { name: 'NVDAc', exact: true }).click();
    await expect(page).toHaveURL(/\/stocks\/nvda/);
    // The only permitted incidental write is the existing automatic Measure.
    expect(writes.every((path) => path.endsWith('/measure'))).toBe(true);
  });
}

for (const width of [1440, 390]) {
  test(`cash out is explicit, expires honestly and never invokes an action (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.install({ time: width === 390 ? new Date('2000-01-01T00:00:00Z') : NOW });
    let quoteCalls = 0;
    let fail = false;
    const writes: string[] = [];
    await page.route('**/AuthProvider.tsx*', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:'authenticated', sessionAuthenticated:true }; }`,
      }),
    );
    await page.route('**/api/**', (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (req.method() !== 'GET') writes.push(url.pathname);
      if (url.pathname === '/api/auth/session')
        return route.fulfill({
          json: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } },
        });
      if (url.pathname === '/api/status')
        return route.fulfill({
          json: {
            chainId: 8453,
            productMigration: { routeIntelligenceV1: true },
            rpc: { status: 'connected' },
          },
        });
      if (url.pathname === '/api/stocks/today') return route.fulfill({ json: briefFixture() });
      if (url.pathname === '/api/stocks/cash-out') {
        quoteCalls++;
        expect(req.postDataJSON()).toEqual({
          tokenAddress: briefFixture().holdings[0]!.tokenAddress,
        });
        const quote: StockPositionQuoteV1 = {
          schemaVersion: 'my-stock-cash-out/v1',
          chainId: 8453,
          tokenAddress: briefFixture().holdings[0]!.tokenAddress,
          tokenSymbol: 'NVDAc',
          generatedAt: NOW.toISOString(),
          holding: {
            balanceAtomic: '88158',
            tokens: '0.00088158',
            decimals: 8,
            blockTag: '0x3197501',
          },
          status: 'quoted',
          destination: 'USDC',
          destinationDecimals: 6,
          returnedAtomic: '201555',
          observedAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
          selectedSource: 'kyberswap',
          approvedSources: ['kyberswap'],
          sources: [{ source: 'kyberswap', status: 'full', errorCode: null }],
          executionProven: false,
          createsApproval: false,
          createsCalldata: false,
          createsTransaction: false,
          caveats: ['No wallet-specific transfer check or simulation was performed.'],
        };
        return route.fulfill(
          fail
            ? { status: 503, json: { error: 'stock_cash_out_measurement_unread' } }
            : { json: quote },
        );
      }
      if (url.pathname.endsWith('/rwa/underlyings'))
        return route.fulfill({ json: fixture('underlyings') });
      if (
        url.pathname.includes('/rwa/market-reality/') &&
        !/\/(measure|history|ask)$/.test(url.pathname)
      )
        return route.fulfill({ json: fixture('nvda-market') });
      return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
    });
    await page.goto('/stocks');
    const card = page.getByRole('region', { name: 'My stocks today', exact: true });
    await expect(card.getByRole('button', { name: 'Check cash out', exact: true })).toBeVisible();
    expect(quoteCalls).toBe(0);
    await card.getByRole('button', { name: 'Check cash out', exact: true }).click();
    await expect(card.getByText('Router quote: 0.201555 USDC', { exact: true })).toBeVisible();
    await expect(card.getByText(/for.*0.00088158 NVDAc/)).toBeVisible();
    await expect(card.getByText(/balance just read differs/)).toBeVisible();
    await card.getByText('Cash out measurement details', { exact: true }).click();
    await expect(card.getByText(/No wallet-specific transfer check/)).toBeVisible();
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/miorail-cash-out-${width}.png`, fullPage: false });
    await page.clock.fastForward(21_000);
    await expect(card.getByText('Last quoted: 0.201555 USDC', { exact: true })).toBeVisible();
    await expect(card.getByText(/Price expired/)).toBeVisible();
    expect(quoteCalls).toBe(1, 'expiry must not poll or measure again');
    fail = true;
    await card.getByRole('button', { name: 'Check cash out again', exact: true }).click();
    await expect(card.getByText(/Cash out could not be checked/)).toBeVisible();
    await expect(card.getByText('Last quoted: 0.201555 USDC', { exact: true })).toBeVisible();
    expect(quoteCalls).toBe(2);
    expect(writes.filter((path) => !path.endsWith('/measure'))).toEqual([
      '/api/stocks/cash-out',
      '/api/stocks/cash-out',
    ]);
  });
}
