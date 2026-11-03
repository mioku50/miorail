import { expect, test, type Page } from '@playwright/test';

// A page opened again after MetaMask paired by WalletConnect (Safari on an
// iPhone, 2026-11-03): wagmi restores the stored connection, and while it
// reconnects it hands out the connector it stored, an id, a name and a type
// with no methods yet. Every load of the page failed on it. The page must
// draw instead, on every load. Nothing here is a real wallet.

const WALLET = '0x1111111111111111111111111111111111111111';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
// wagmi's own stored shape: a Map of connections, the current one, store version 3.
const STORED = JSON.stringify({
  state: {
    connections: { __type: 'Map', value: [['wc-1', { accounts: [WALLET], chainId: 8453, connector: { id: 'walletConnect', name: 'WalletConnect', type: 'walletConnect', uid: 'wc-1' } }]] },
    chainId: 8453,
    current: 'wc-1',
  },
  version: 3,
});

test.use({ userAgent: IPHONE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function install(page: Page) {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  await page.addInitScript((stored) => { localStorage.setItem('wagmi.store', stored); }, STORED);
}

// The stored connection is gone once wagmi has finished reconnecting (none of this page's wallets answers for it).
const storedConnections = (page: Page) => page.evaluate(() => {
  const stored = JSON.parse(localStorage.getItem('wagmi.store') ?? 'null') as { state?: { connections?: { value?: unknown[] } } } | null;
  return stored?.state?.connections?.value?.length ?? -1;
});

test('a page opened again with a stored WalletConnect pairing draws, on every load', async ({ page }) => {
  await install(page);
  for (const open of [() => page.goto('/'), () => page.reload()]) {
    await open();
    await expect.poll(() => storedConnections(page)).toBe(0);
    await expect(page.getByRole('heading', { name: 'Spend without selling.', exact: true })).toBeVisible();
    await expect(page.getByText('Miorail hit an unexpected error', { exact: true })).toHaveCount(0);
  }
});
