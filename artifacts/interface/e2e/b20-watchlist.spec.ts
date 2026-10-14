import { expect, test } from '@playwright/test';

const WALLET = `0x${'1'.repeat(40)}`;
const TOKENS = Array.from({ length: 25 }, (_, i) => ({
  tokenAddress: `0x${(i + 100).toString(16).padStart(40, '0')}`,
  addedAt: '2026-10-14T08:00:00.000Z', lastSweptAt: null, lastReadAt: null,
  lastOutcome: null, schedule: null, changes: [],
}));
const sla = { distinctAddresses: 1, advertisedIntervalSeconds: 900, achievableIntervalSeconds: 60,
  limitedBy: 'tier_floor', utilisation: 0.01, beyondSlowestTier: false, scheduleActive: true };

for (const fail of [false, true]) {
  test(`official watchlist addition reports ${fail ? 'a failure' : 'the actual additions and remaining quota'}`, async ({ page }) => {
    test.setTimeout(60_000);
    let entries = TOKENS.slice(0, 1);
    let release!: () => void;
    const responseReady = new Promise<void>(resolve => { release = resolve; });
    const writes: string[] = [];
    await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript',
      body: 'export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:"authenticated", sessionAuthenticated:true }; }' }));
    await page.route('**/B20WatchPage.tsx*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const replacement = source.replace(/import\s*\{\s*useAccount\s*\}\s*from\s*["'][^"']+["'];?/u,
        `const useAccount = () => ({ address: "${WALLET}" });`);
      expect(replacement).not.toBe(source);
      await route.fulfill({ response, body: replacement });
    });
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') writes.push(path);
      if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: 'fixture', address: WALLET, chainId: 8453 } } });
      if (path === '/api/status') return route.fulfill({ json: { chainId: 8453,
        productMigration: { b20ControlV1: true, routeIntelligenceV1: true }, rpc: { status: 'connected' } } });
      if (path === '/api/portfolio') return route.fulfill({ json: { tokens: [{ symbol: 'ETH', address: 'native', balanceFormatted: '0.01' }] } });
      if (path === '/api/route-intelligence/b20/watchlist') return route.fulfill({ json: { tokens: entries, remaining: 25 - entries.length, sla } });
      if (path === '/api/route-intelligence/b20/watchlist/preset') {
        expect(request.postDataJSON()).toEqual({ preset: 'official_assets' });
        await responseReady;
        if (fail) return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
        entries = TOKENS;
        return route.fulfill({ json: { tokens: entries, remaining: 0, sla } });
      }
      return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
    });
    await page.goto('/portfolio');
    const add = page.getByRole('button', { name: 'Add official assets to watchlist', exact: true });
    await expect(add).toBeEnabled();
    await expect(page.getByText(/including assets you do not hold, up to 24 available slots/)).toBeVisible();
    await add.click();
    await expect(page.getByRole('button', { name: 'Adding official assets…', exact: true })).toBeDisabled();
    release();
    if (fail) {
      await expect(page.getByText('The watchlist could not be reached. Nothing here is a statement about your tokens.', { exact: true })).toBeVisible();
      await expect(add).toBeEnabled();
      await expect(page.getByText('24 official addresses added. 0 slots remain.', { exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByText('24 official addresses added. 0 slots remain.', { exact: true })).toBeVisible();
      await expect(add).toBeDisabled();
    }
    expect(writes).toEqual(['/api/route-intelligence/b20/watchlist/preset']);
  });
}
