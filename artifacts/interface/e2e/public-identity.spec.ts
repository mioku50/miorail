import { expect, test, type Page } from '@playwright/test';
import type { PublicIdentityReadingV1 } from '../../../lib/ui/src/console/publicIdentityView.js';

const UNKNOWN = '0x3333333333333333333333333333333333333333';
const LOOKALIKE = '0x1111111111111111111111111111111111111111';
const OFFICIAL = '0xb200000000000000000000c2e324d24d7eecd1fb';

// The same two evidence states as publicIdentityView.test.ts: no record is
// neutral, while a spelling match names the full issuer address to compare.
function reading(address: string): PublicIdentityReadingV1 {
  const lookalike = address === LOOKALIKE;
  return {
    schemaVersion: 'address-identity/v1', chainId: 8453, tokenAddress: address,
    standing: lookalike ? 'known_lookalike' : 'unknown_to_miorail',
    answer: lookalike ? 'No. It is not AAPLc.' : 'Miorail has nothing on file.',
    official: null, issuerRepresentation: null,
    lookalike: lookalike ? {
      officialAddress: OFFICIAL, officialTicker: 'AAPLc', matchKind: 'symbol_exact',
      matchedAlias: 'published_ticker', matchedValue: 'AAPLc', declaredSymbol: 'AAPLc',
      declaredName: 'Apple on Base', firstFlaggedAt: '2026-09-16T03:00:00.000Z',
    } : null,
    corpus: { lookalikeRows: 160, lookalikesLastScannedAt: '2026-09-16T03:00:00.000Z' },
    caveats: ['Compare ADDRESSES, not symbols.'], generatedAt: '2026-09-16T08:00:00.000Z',
  };
}

async function fitsWithoutClipping(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const selector of ['.pi-verdict .cr-name', '.pi-verdict .cr-status', '.pi-compare-address', '.pi-verdict .cr-facts dd']) {
    for (const element of await page.locator(selector).all()) {
      const geometry = await element.evaluate(node => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { x: box.x, right: box.right, viewport: innerWidth, scroll: node.scrollWidth, client: node.clientWidth,
          overflow: style.overflowX, ellipsis: style.textOverflow === 'ellipsis' };
      });
      expect(geometry.x).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
      expect(geometry.ellipsis).toBe(false);
      expect(['hidden', 'clip']).not.toContain(geometry.overflow);
    }
  }
}

for (const width of [320, 390, 1366]) {
  test(`public identity preserves both full addresses without horizontal scrolling (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const writes: string[] = [], identities: string[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') {
        writes.push(path);
        return route.fulfill({ status: 405, json: { error: 'fixture_forbids_writes' } });
      }
      if (path === '/api/auth/session') return route.fulfill({ json: { user: null } });
      if (path.startsWith('/api/public/identity/')) {
        const address = path.slice('/api/public/identity/'.length);
        identities.push(address);
        return route.fulfill({ json: reading(address) });
      }
      return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
    });

    await page.goto('/is-it-real');
    await expect(page.getByRole('heading', { name: 'Is this the real one?', exact: true })).toBeVisible();
    const input = page.getByRole('textbox', { name: 'Contract address', exact: true });
    await expect(input).toBeVisible();
    await fitsWithoutClipping(page);
    expect(identities).toEqual([]);

    await input.fill(UNKNOWN);
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.locator('.pi-verdict .cr-status')).toHaveText('Nothing on file here');
    await expect(page.locator('.pi-verdict .cr-status')).toHaveAttribute('data-tone', 'off');
    await expect(page.locator('.pi-verdict .cr-name')).toHaveText(UNKNOWN);
    await fitsWithoutClipping(page);
    await page.screenshot({ path: testInfo.outputPath(`unknown-${width}.png`), fullPage: true });

    await input.fill(LOOKALIKE);
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.locator('.pi-verdict .cr-status')).toHaveText('Wearing an official name');
    await expect(page.locator('.pi-verdict .cr-status')).toHaveAttribute('data-tone', 'warn');
    await expect(page.locator('.pi-verdict .cr-name')).toHaveText(LOOKALIKE);
    await expect(page.locator('.pi-compare-address')).toHaveText(OFFICIAL);
    await fitsWithoutClipping(page);
    await page.screenshot({ path: testInfo.outputPath(`lookalike-${width}.png`), fullPage: true });

    // A shared exact-address URL must load the same result without a session.
    expect(identities).toEqual([UNKNOWN, LOOKALIKE]);
    const beforeLink = identities.length;
    await page.goto(`/is-it-real/${LOOKALIKE}`);
    await expect(page.locator('.pi-compare-address')).toHaveText(OFFICIAL);
    await fitsWithoutClipping(page);
    // React StrictMode may replay the initial read in development. Every
    // read still has to name the linked address, never another contract.
    expect(identities.length).toBeGreaterThan(beforeLink);
    expect(identities.slice(beforeLink).every(address => address === LOOKALIKE)).toBe(true);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
