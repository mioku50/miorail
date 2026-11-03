import { expect, test, type Browser } from '@playwright/test';

// Phones draw every page at three quarters of its CSS size, as Safari showed it
// at 75% page zoom (operator, 2026-11-03); a tablet keeps full size. A mobile
// browser here reads the viewport tag as a phone's does. Nothing here is a real wallet.

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

async function open(browser: Browser, size: { width: number; height: number }, userAgent: string) {
  const context = await browser.newContext({ viewport: size, screen: size, isMobile: true, hasTouch: true, userAgent });
  const page = await context.newPage();
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Spend without selling.', exact: true })).toBeVisible();
  return { context, page };
}

const drawn = (page: import('@playwright/test').Page) => page.evaluate(() => ({
  scale: Math.round((window.visualViewport?.scale ?? 0) * 100) / 100,
  layoutWidth: document.documentElement.clientWidth,
  sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));

test('a phone draws the page at three quarters, laid out in the wider viewport that implies', async ({ browser }) => {
  const { context, page } = await open(browser, { width: 393, height: 852 }, IPHONE);
  await expect.poll(() => drawn(page)).toEqual({ scale: 0.75, layoutWidth: 524, sideways: false });
  // The bottom bar is still the phone's, and its 22-pixel icons draw at about 16.5 points.
  const icon = await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'More', exact: true }).locator('svg').boundingBox();
  expect(icon?.width).toBe(22);
  await context.close();
});

test('a tablet keeps full size', async ({ browser }) => {
  const { context, page } = await open(browser, { width: 820, height: 1180 }, IPAD);
  await expect.poll(() => drawn(page)).toEqual({ scale: 1, layoutWidth: 820, sideways: false });
  await context.close();
});
