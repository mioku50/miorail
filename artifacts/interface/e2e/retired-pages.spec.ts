import { expect, test, type Page } from '@playwright/test';

// Discover and Watch left Still (operator, 2026-11-17). Every address either
// page had leads to More, signed in or not, and More offers neither. Every API
// request is intercepted; nothing signs and nothing is sent anywhere.

const WALLET = `0x${'1'.repeat(40)}`;
const TOKEN = `0x${'b2'.repeat(20)}`;

async function install(page: Page, signedIn: boolean) {
  const writes: string[] = [];
  await page.route('**/AuthProvider.tsx*', (route) => route.fulfill({ contentType: 'application/javascript',
    body: `export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:${signedIn}, phase:'${signedIn ? 'authenticated' : 'anonymous'}', sessionAuthenticated:${signedIn} }; }` }));
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(path);
    if (path === '/api/auth/session') return route.fulfill({ json: { user: signedIn ? { id: 'fixture', address: WALLET, chainId: 8453 } : null } });
    if (path === '/api/status') return route.fulfill({ json: { chainId: 8453, productMigration: { b20ControlV1: true, routeIntelligenceV1: true }, rpc: { status: 'connected' } } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { writes };
}

const OLD_ADDRESSES_V1 = [
  '/opportunities',
  '/opportunities?tab=signals',
  '/opportunities/launches',
  '/watch',
  `/watch?token=${TOKEN}#investigate`,
  `/investigate?token=${TOKEN}`,
  `/portfolio?token=${TOKEN}`,
  `/portfolio/${TOKEN}`,
  '/radar',
  '/b20',
] as const;

for (const signedIn of [true, false]) {
  test(`every Discover and Watch address leads to More (${signedIn ? 'signed in' : 'signed out'})`, async ({ page }) => {
    const { writes } = await install(page, signedIn);
    for (const address of OLD_ADDRESSES_V1) {
      await page.goto(address);
      await expect(page, address).toHaveURL(/\/more$/);
      await expect(page.getByRole('heading', { level: 1, name: 'More', exact: true }), address).toBeVisible();
    }
    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: /^Discover/ })).toHaveCount(0);
    await expect(main.getByRole('link', { name: /^Watch/ })).toHaveCount(0);
    for (const href of ['/opportunities', '/watch', '/investigate', '/radar', '/portfolio']) {
      await expect(main.locator(`a[href="${href}"]`), href).toHaveCount(0);
    }
    await expect(main.getByRole('link', { name: /^Today/ })).toHaveAttribute('href', '/today');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(writes).toEqual([]);
  });
}
