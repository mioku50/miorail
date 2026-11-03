import { expect, test, type Page } from '@playwright/test';

// A wallet that never shows the sign-in request (MetaMask's app, 2026-11-03:
// the challenge was issued, no signature came back, and the button waited for
// good). After a while the page offers to ask again; the second request is
// signed, and only its challenge is sent back. Nothing here is a real wallet.

const WALLET = '0x1111111111111111111111111111111111111111';
const NOW = new Date('2026-11-03T19:30:00Z');

async function install(page: Page) {
  const state = { user: null as null | { id: string; address: string; chainId: number }, challenges: 0, verified: [] as string[] };
  await page.route('**/api/**', (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: state.user } });
    if (path === '/api/auth/challenge' && request.method() === 'POST') {
      state.challenges++;
      return route.fulfill({ json: { nonce: `nonce-${state.challenges}`, message: `fixture challenge ${state.challenges}`, expiresAt: new Date(NOW.getTime() + 300_000).toISOString(), chainId: 8453 } });
    }
    if (path === '/api/auth/verify' && request.method() === 'POST') {
      state.verified.push((request.postDataJSON() as { message: string }).message);
      state.user = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 };
      return route.fulfill({ json: { user: state.user } });
    }
    if (path === '/api/status') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  // The first personal_sign never answers; the second one does.
  await page.addInitScript((wallet) => {
    const signs: string[] = [];
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let allowed = false;
    const provider = {
      on(event: string, callback: (...args: unknown[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(callback);
      },
      removeListener(event: string, callback: (...args: unknown[]) => void) { listeners.get(event)?.delete(callback); },
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'net_version') return '8453';
        if (method === 'eth_accounts') return allowed ? [wallet] : [];
        if (method === 'eth_requestAccounts') { allowed = true; return [wallet]; }
        if (method === 'wallet_requestPermissions') { allowed = true; return [{ parentCapability: 'eth_accounts' }]; }
        if (method === 'wallet_getPermissions') return allowed ? [{ parentCapability: 'eth_accounts' }] : [];
        if (method === 'personal_sign') {
          signs.push(String(params?.[0]));
          if (signs.length === 1) return new Promise(() => {});
          return `0x${'ab'.repeat(65)}`;
        }
        throw Object.assign(new Error(`Fixture forbids ${method}`), { code: -32601 });
      },
    };
    const target = window as unknown as { ethereum: typeof provider; __fixtureSigns: string[] };
    target.ethereum = provider;
    target.__fixtureSigns = signs;
  }, WALLET);
  return state;
}

test('a sign-in the wallet never shows can be asked again, and only the new request signs in', async ({ page }) => {
  await page.clock.install({ time: NOW });
  const state = await install(page);
  await page.goto('/signin?next=%2Fmore');
  await page.getByRole('button', { name: 'Browser wallet', exact: false }).click();
  const signIn = page.getByRole('button', { name: 'Sign in with Browser wallet', exact: true });
  await signIn.click();
  await expect(page.getByRole('button', { name: 'Waiting for wallet…', exact: true })).toBeDisabled();
  expect(state.challenges).toBe(1);
  // The wallet stays silent: after a while the press is free again.
  await page.clock.fastForward(21_000);
  await expect(page.getByText('Browser wallet has not shown the sign-in request. Open it to sign, or ask again; the first request is let go.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ask Browser wallet again', exact: true }).click();
  await expect.poll(() => state.verified).toEqual(['fixture challenge 2']);
  expect(state.challenges).toBe(2);
  expect(await page.evaluate(() => (window as unknown as { __fixtureSigns: string[] }).__fixtureSigns.length)).toBe(2);
  await expect(page.getByRole('button', { name: /Ask .* again|Waiting for wallet…/ })).toHaveCount(0);
});
