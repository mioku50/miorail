import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const WALLET = '0x1111111111111111111111111111111111111111';

for (const width of [1280, 390]) {
  test(`GMGN price stays read-only, including a provider refusal (${width}px)`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 900 });
    const posts: string[] = [];
    let refused = false;
    await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript',
      body: 'export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:"authenticated", sessionAuthenticated:true }; }' }));
    // A fixture wallet identity, with no signer or wallet transport installed.
    await page.route('**/RouteIntelligenceConsole.tsx*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const replacement = source.replace(/import\s*\{\s*useAccount\s*\}\s*from\s*["'][^"']+["'];?/u,
        `const useAccount = () => ({ address: "${WALLET}", isConnected: true, chainId: 8453 });`);
      expect(replacement).not.toBe(source);
      return route.fulfill({ response, body: replacement });
    });
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'POST') posts.push(path);
      if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: 'fixture-user', address: WALLET, chainId: 8453 } } });
      if (path === '/api/status') return route.fulfill({ json: { productMigration: { routeIntelligenceV1: true }, baseMcp: { enabled: true, configured: true } } });
      if (path === '/api/routes/swap/evaluate' || path.endsWith('/swap/evaluate')) {
        // Generate fresh canonical hashes and timestamps through the real
        // adapter, engine and projector, with a fixture HTTP transport only.
        const fixtures = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx',
          fileURLToPath(new URL('./fixtures/gmgn-quotes.mjs', import.meta.url))], { encoding: 'utf8' }));
        const response = fixtures[refused ? 1 : 0];
        return route.fulfill({ json: response });
      }
      return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
    });
    await page.goto('/routes');
    await page.getByPlaceholder('Swap 100 USDC to ETH with the best net result').fill('Get a GMGN quote to swap 100 USDC for WETH');
    await page.getByRole('button', { name: 'Compare routes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Quote only', exact: true })).toBeDisabled();
    await expect(page.getByText('GMGN quote only. GMGN swaps cannot be prepared or approved here.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review transaction', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`gmgn-quote-${width}.png`), fullPage: true });
    refused = true;
    await page.getByRole('button', { name: 'Change goal', exact: true }).click();
    await page.getByRole('button', { name: 'Compare routes', exact: true }).click();
    await expect(page.getByText('GMGN refused the request. This is on the provider\'s side, not your goal.', { exact: true }).first()).toBeVisible();
    expect(posts.every(path => path.endsWith('/swap/evaluate'))).toBe(true);
    expect(posts).toHaveLength(2);
  });
}
