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
    // The previous auto-visit cursor is not a user acknowledgment.
    await page.addInitScript(
      (wallet) => localStorage.setItem(`miorail:stocks-seen:${wallet}`, '2026-09-30T20:55:00.000Z'),
      WALLET,
    );
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
    await expect(
      card.getByRole('heading', { name: 'Recorded in the last 24 hours' }),
    ).toBeVisible();
    expect(asked[0]).toBe('');
    await page.reload();
    await expect(
      card.getByRole('heading', { name: 'Recorded in the last 24 hours' }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        (wallet) => localStorage.getItem(`miorail:stocks-reviewed:v1:${wallet}`),
        WALLET,
      ),
    ).toBeNull();
    await card.getByRole('button', { name: 'Mark as read', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Marked as read', exact: true })).toBeDisabled();
    await page.reload();
    await expect(
      card.getByRole('heading', { name: 'Since you last marked as read' }),
    ).toBeVisible();
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

test('unread findings survive reloads; gaps cannot advance the receipt; another wallet starts separately', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  let wallet = WALLET;
  let state: 'complete' | 'unavailable' | 'full' = 'complete';
  const writes: string[] = [];
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith('miorail:stocks-reviewed:') &&
        sessionStorage.getItem('block-reviewed-storage') === 'yes'
      )
        throw new Error('storage_blocked');
      return original.call(this, key, value);
    };
  });
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
        json: { user: { id: `eip155:8453:${wallet}`, address: wallet, chainId: 8453 } },
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
      const data = briefFixture(),
        token = data.holdings[0]!.tokenAddress;
      data.changes!.cards = [
        {
          signalId: 'late',
          chainId: 8453,
          kind: 'official_asset_multiplier_changed',
          subjectAddress: token,
          subjectTicker: 'NVDAc',
          officialAddress: null,
          officialTicker: null,
          occurredAt: '2026-09-20T10:00:00.000Z',
          recordedAt: '2026-09-30T20:00:00.000Z',
          facts: { multiplierWad: '1050000000000000000' },
        },
      ];
      data.inbox = {
        windowBasis: 'recorded_at',
        heldCount: 1,
        watchedCount: 0,
        items: [
          {
            signalId: 'late',
            relation: 'held',
            relatedTokenAddress: token,
            inspectionHref: `/investigate?token=${token}`,
            relatedInspectionHref: null,
          },
        ],
      };
      data.changesUnavailable = state === 'unavailable';
      data.changesTruncated = state === 'full';
      return route.fulfill({ json: data });
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
  await expect(card.getByText('Related to your holdings', { exact: true })).toBeVisible();
  await expect(
    card.getByRole('link', { name: 'Inspect this contract', exact: true }),
  ).toHaveAttribute('href', `/investigate?token=${briefFixture().holdings[0]!.tokenAddress}`);
  await expect(card.getByText(/Occurred Sep 20.*recorded Sep 30/)).toBeVisible();
  await page.reload();
  await expect(card.getByText('Related to your holdings', { exact: true })).toBeVisible();
  expect(
    await page.evaluate((w) => localStorage.getItem(`miorail:stocks-reviewed:v1:${w}`), WALLET),
  ).toBeNull();
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await card.screenshot({ path: '/tmp/miorail-update-inbox-390.png' });
  for (const next of ['unavailable', 'full'] as const) {
    state = next;
    await card.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Mark as read', exact: true })).toBeDisabled();
    expect(
      await page.evaluate((w) => localStorage.getItem(`miorail:stocks-reviewed:v1:${w}`), WALLET),
    ).toBeNull();
  }
  state = 'complete';
  await card.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Mark as read', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate((w) => localStorage.getItem(`miorail:stocks-reviewed:v1:${w}`), WALLET),
    )
    .toBe(NOW.toISOString());
  wallet = '0x2222222222222222222222222222222222222222';
  await page.reload();
  await expect(card.getByRole('heading', { name: 'Recorded in the last 24 hours' })).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('block-reviewed-storage', 'yes'));
  await card.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await expect(card.getByText(/Your browser could not save the date/)).toBeVisible();
  expect(
    await page.evaluate((w) => localStorage.getItem(`miorail:stocks-reviewed:v1:${w}`), wallet),
  ).toBeNull();
  expect(writes.filter((path) => !path.endsWith('/measure'))).toEqual([]);
});

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
