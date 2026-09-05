import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const NVDA = 'security:isin:US67066G1040';
const COIN = 'security:isin:US19260Q1076';
const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';

/** Exercise real routing, hooks, components and CSS. Authentication alone is
 * bypassed in this local browser module; every API call is intercepted. No
 * wallet provider, production cookie, live network or signature is needed. */
async function stubApi(page: Page, holding: unknown = { state: 'read', balanceAtomic: '43417', decimals: 8, blockTag: '0x308c458' }) {
  const confirmations: unknown[] = [];
  const forbiddenWrites: string[] = [];
  await page.route('**/RequireSession.tsx*', route => route.fulfill({
    contentType: 'application/javascript',
    body: 'export function RequireSession({children}) { return children; }',
  }));
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json: unknown;
    if (path === '/api/status') json = { chainId: 8453, productMigration: { routeIntelligenceV1: true }, rpc: { status: 'connected' } };
    else if (path === '/api/auth/session') json = { user: null };
    else if (path.endsWith('/rwa/underlyings')) json = fixture('underlyings');
    else if (path.endsWith('/stock-action/test-sell/confirm')) {
      confirmations.push(request.postDataJSON());
      json = { clearance: 'fixture-clearance', expiresAt: '2026-09-05T22:00:00Z' };
    } else if (path.endsWith('/stock-action/test-sell')) {
      json = {
        outcome: 'review', evidenceState: 'expired_quote', holding,
        representation: { tokenAddress: TOKEN, caip10: `eip155:8453:${TOKEN}`, issuerId: 'coinbase' },
        question: { direction: 'sell', requestedCashAtomic: '1000000000', destination: 'USDC' },
        reality: fixture('nvda-market'),
      };
    } else if (path.includes('/rwa/market-reality/') && !/\/(measure|history|ask)$/.test(path)) {
      json = fixture(path.includes('US19260') ? 'coin-market' : 'nvda-market');
    } else if (/\/(release|submission|approve)$/.test(path)) forbiddenWrites.push(path);
    return json ? route.fulfill({ json }) : route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { confirmations, forbiddenWrites };
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`selected stock survives navigation, reload and theme changes (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await stubApi(page);
    await page.goto(`/market?key=${encodeURIComponent(NVDA)}`);
    const nvda = page.getByRole('option', { name: /^NVDA / });
    const coin = page.getByRole('option', { name: /^COIN / });
    await expect(nvda).toHaveAttribute('aria-selected', 'true');
    expect(await nvda.evaluate(e => getComputedStyle(e).boxShadow)).toContain('2px inset');
    await coin.click();
    await expect(coin).toHaveAttribute('aria-selected', 'true');
    await expect(nvda).toHaveAttribute('aria-selected', 'false');
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(COIN)));
    expect(await coin.evaluate(e => getComputedStyle(e).boxShadow)).toContain('2px inset');
    await page.reload();
    await expect(coin).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Base', exact: true }).click();
    expect(await coin.evaluate(e => getComputedStyle(e).boxShadow)).toContain('2px inset');
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    expect(await coin.evaluate(e => getComputedStyle(e).boxShadow)).toContain('2px inset');
  });

  test(`Use & access gives visible feedback and removes market-only controls (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await stubApi(page);
    await page.goto(`/market?key=${encodeURIComponent(COIN)}`);
    const utility = page.getByRole('tab', { name: 'Use & access', exact: true });
    await utility.click();
    await expect(utility).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tablist', { name: 'Direction', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tablist', { name: 'Size', exact: true })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Use & access' })).toBeInViewport();
    await page.getByRole('tab', { name: 'Market Reality', exact: true }).click();
    await expect(page.getByRole('tablist', { name: 'Direction', exact: true })).toBeVisible();
  });
}

test('SELL confirms exact token atoms without opening a wallet', async ({ page }) => {
  const { confirmations, forbiddenWrites } = await stubApi(page);
  await page.goto('/action/test-sell');
  const amount = page.getByLabel('Token amount to sell');
  const confirm = page.getByRole('button', { name: 'Confirm token amount', exact: true });
  await expect(confirm).toBeDisabled();
  await amount.fill('0.000434171');
  await expect(confirm).toBeDisabled();
  await amount.fill('1e-8');
  await expect(confirm).toBeDisabled();
  await amount.fill('0.00043418');
  await expect(confirm).toBeDisabled();
  await page.getByRole('button', { name: 'Use available balance' }).click();
  await expect(amount).toHaveValue('0.00043417');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect.poll(() => confirmations).toEqual([{ tokenAmountAtomic: '43417' }]);
  await expect(page.getByText('Confirmed sell: 0.00043417 tokens (43417 base units).', { exact: true })).toBeVisible();
  expect(forbiddenWrites).toEqual([]);
});

test('one wallet attempt stays pending until the wallet resolves', async ({ page }) => {
  await stubApi(page);
  // Replace the wallet-owning host with a controllable wallet double. The
  // shared review hook, API client and review screen remain the real modules.
  const uiRoot = '/@fs' + new URL('../../../lib/ui/src/console/', import.meta.url).pathname;
  await page.route('**/StockActionReviewPage.tsx*', route => route.fulfill({
    contentType: 'application/javascript', body: `
      import React from '/node_modules/.vite/deps/react.js';
      import {useStockActionReviewConsoleV1} from '${uiRoot}stockActionReviewConsole.ts';
      import {StockActionReviewScreen} from '${uiRoot}StockActionReviewScreen.tsx';
      window.walletAttempts = 0;
      export function StockActionReviewPage() {
        const {model} = useStockActionReviewConsoleV1({draft:'test-sell',
          sendCalls: async () => { window.walletAttempts++; await new Promise(resolve => { window.finishWallet = resolve; }); return 'test-batch'; },
          recordSubmission: async () => {}});
        return React.createElement(StockActionReviewScreen, {model});
      }`,
  }));
  let releases = 0;
  await page.route('**/api/route-intelligence/rwa/stock-action/release', route => {
    releases++;
    return route.fulfill({ json: { action: { calls: [{ to: TOKEN, value: '0x0', data: '0x' }], atomicRequired: true } } });
  });
  await page.goto('/action/test-sell');
  await page.getByRole('button', { name: 'Use available balance' }).click();
  await page.getByRole('button', { name: 'Confirm token amount', exact: true }).click();
  await page.getByRole('button', { name: 'Open in your Base Account', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { walletAttempts: number }).walletAttempts)).toBe(1);
  await expect(page.getByRole('button', { name: 'Waiting for your wallet…', exact: true })).toBeDisabled();
  expect(releases).toBe(1);
  await page.evaluate(() => (window as unknown as { finishWallet: () => void }).finishWallet());
  await expect(page.getByText('Submitted from your Base Account.', { exact: true })).toBeVisible();
});

for (const holding of [null, { state: 'unread' }, { state: 'read', decimals: 8, balanceAtomic: '0' }]) {
  test(`SELL refuses an unavailable amount: ${JSON.stringify(holding)}`, async ({ page }) => {
    const { confirmations } = await stubApi(page, holding);
    await page.goto('/action/test-sell');
    await expect(page.getByRole('button', { name: 'Confirm token amount', exact: true })).toBeDisabled();
    await page.getByLabel('Token amount to sell').fill('0.00000001');
    await expect(page.getByRole('button', { name: 'Confirm token amount', exact: true })).toBeDisabled();
    expect(confirmations).toEqual([]);
  });
}
