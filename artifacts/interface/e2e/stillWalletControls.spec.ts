import { expect, test, type Page } from '@playwright/test';
import { stillTerms } from '../../../lib/still-engine/src/terms.js';
import { calendar } from '../../../lib/still-engine/test/fixtures.js';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const MONDAY = new Date('2026-10-26T18:05:00Z');

async function install(page: Page, account: string | null = null) {
  let user = account ? { id: 'wallet-fixture', address: account, chainId: 8453 } : null;
  const writes: string[] = [];
  await page.clock.setFixedTime(MONDAY);
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(path);
    if (path === '/api/auth/session') return route.fulfill({ json: { user } });
    if (path === '/api/auth/logout') {
      user = null;
      return route.fulfill({ json: { success: true } });
    }
    if (path === '/api/public/still/terms') return route.fulfill({ json: JSON.parse(JSON.stringify(stillTerms(calendar(), MONDAY))) });
    if (path === '/api/status') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { writes };
}

/** Only an injected connection: no signature or transaction method succeeds. */
async function injectedWallet(page: Page, address: string) {
  await page.addInitScript((wallet) => {
    const calls: string[] = [];
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let allowed = false;
    const provider = {
      isMetaMask: true,
      on(event: string, callback: (...args: unknown[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(callback);
      },
      removeListener(event: string, callback: (...args: unknown[]) => void) { listeners.get(event)?.delete(callback); },
      async request({ method }: { method: string }) {
        calls.push(method);
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'net_version') return '8453';
        if (method === 'eth_accounts') return allowed ? [wallet] : [];
        if (method === 'eth_requestAccounts') { allowed = true; return [wallet]; }
        if (method === 'wallet_requestPermissions') { allowed = true; return [{ parentCapability: 'eth_accounts' }]; }
        if (method === 'wallet_getPermissions') return allowed ? [{ parentCapability: 'eth_accounts' }] : [];
        if (method === 'wallet_revokePermissions') { allowed = false; return null; }
        throw Object.assign(new Error(`Fixture forbids ${method}`), { code: -32601 });
      },
    };
    const target = window as unknown as { ethereum: typeof provider; __fixtureWalletRequests: string[] };
    target.ethereum = provider;
    target.__fixtureWalletRequests = calls;
  }, address);
}

async function noSigning(page: Page, writes: string[]) {
  expect(writes.every(path => path === '/api/auth/logout')).toBe(true);
  const calls = await page.evaluate(() => (window as unknown as { __fixtureWalletRequests?: string[] }).__fixtureWalletRequests ?? []);
  expect(calls.some(method => /sign|sendTransaction|sendCalls/i.test(method))).toBe(false);
}

for (const width of [390, 1920]) {
  test(`every Still page keeps a visible connect action (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1080 });
    const { writes } = await install(page);
    for (const path of ['/', '/assets', '/agent', '/more', '/stocks']) {
      await page.goto(path);
      const bar = page.getByRole('banner', { name: 'Wallet and account' });
      await expect(bar.getByRole('link', { name: 'Connect wallet', exact: true })).toBeVisible();
      const box = await bar.boundingBox();
      expect(box?.y).toBeLessThan(150);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(writes).toEqual([]);
  });
}

test('a session without a browser wallet is labelled correctly and can sign out', async ({ page }) => {
  const { writes } = await install(page, A);
  await page.goto('/more');
  const bar = page.getByRole('banner', { name: 'Wallet and account' });
  await bar.locator('summary').click();
  await expect(bar.getByText('Signed in · Wallet disconnected', { exact: true }).last()).toBeVisible();
  await expect(bar.getByText('Your account is still signed in, but no wallet is connected in this browser.', { exact: true })).toBeVisible();
  await expect(bar.getByRole('link', { name: 'Connect wallet', exact: true })).toHaveAttribute('href', '/signin?next=%2Fmore');
  await bar.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(bar.getByRole('link', { name: 'Connect wallet', exact: true })).toBeVisible();
  expect(writes).toEqual(['/api/auth/logout']);
});

test('sign out keeps the browser connection, then Switch wallet opens the existing picker without signing', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await injectedWallet(page, A);
  const { writes } = await install(page, A);
  await page.goto('/more');
  const bar = page.getByRole('banner', { name: 'Wallet and account' });
  await bar.locator('summary').click();
  await bar.getByRole('link', { name: 'Connect wallet', exact: true }).click();
  await expect(page).toHaveURL(/\/signin\?next=%2Fmore$/);
  await page.getByRole('button', { name: 'Browser wallet', exact: false }).click();
  await expect(page).toHaveURL(/\/more$/);
  await expect(bar.getByText('Connected · Signed in', { exact: true }).first()).toBeVisible();
  await bar.locator('summary').click();
  await bar.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(bar.getByText('Connected · Not signed in', { exact: true }).first()).toBeVisible();
  await bar.locator('summary').click();
  await expect(bar.getByRole('button', { name: 'Sign in with this wallet', exact: true })).toBeVisible();
  await expect(bar.getByText(A, { exact: true })).toBeVisible();
  await bar.getByRole('button', { name: 'Switch wallet', exact: true }).click();
  await expect(page).toHaveURL(/\/signin\?next=%2Fmore$/);
  await expect(page.getByRole('heading', { name: 'Choose a wallet', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Browser wallet', exact: false })).toBeVisible();
  await noSigning(page, writes);
});

test('a different connected wallet shows both identities and can disconnect after tenant logout', async ({ page }) => {
  await injectedWallet(page, B);
  const { writes } = await install(page, A);
  await page.goto('/signin?next=%2Fmore%3Ffrom%3Dwallet');
  await page.getByRole('button', { name: 'Browser wallet', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Continue with your wallet', exact: true })).toBeVisible();
  // An initial A/B mismatch intentionally stays signed out until a person
  // signs in with B. Navigate without reloading the fixture's provider.
  await page.evaluate(() => { history.pushState(null, '', '/more?from=wallet'); dispatchEvent(new PopStateEvent('popstate')); });
  const bar = page.getByRole('banner', { name: 'Wallet and account' });
  await expect(bar.locator('summary')).toHaveText(/0x2222…2222/);
  await bar.locator('summary').click();
  await expect(bar.getByText(A, { exact: true })).toBeVisible();
  await expect(bar.getByText(B, { exact: true })).toBeVisible();
  await expect(bar.getByText(/The connected wallet differs/)).toBeVisible();
  await bar.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(bar.getByRole('link', { name: 'Connect wallet', exact: true })).toBeVisible();
  await expect(bar.getByRole('link', { name: 'Connect wallet', exact: true })).toHaveAttribute('href', '/signin?next=%2Fmore%3Ffrom%3Dwallet');
  await noSigning(page, writes);
});

test('the wallet menu keeps its last action above phone navigation in landscape', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await injectedWallet(page, A);
  const { writes } = await install(page, A);
  await page.goto('/signin?next=%2Fmore');
  await page.getByRole('button', { name: 'Browser wallet', exact: false }).click();
  await expect(page).toHaveURL(/\/more$/);
  const bar = page.getByRole('banner', { name: 'Wallet and account' });
  await bar.locator('summary').click();
  const menu = bar.locator('.still-wallet-menu');
  const last = bar.getByRole('button', { name: 'Sign out', exact: true });
  await last.scrollIntoViewIfNeeded();
  const navigation = await page.getByRole('navigation', { name: 'Main' }).boundingBox();
  expect((await menu.boundingBox())!.y + (await menu.boundingBox())!.height).toBeLessThan(navigation!.y);
  expect((await last.boundingBox())!.y + (await last.boundingBox())!.height).toBeLessThan(navigation!.y);
  await expect(last).toBeInViewport();
  await noSigning(page, writes);
});
