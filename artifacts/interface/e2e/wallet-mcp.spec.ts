import { expect, test } from '@playwright/test';

// Wallet MCP is one of the four main pages, and until 2026-10-04 a visitor
// clicking it met the wallet wall and nothing else. This is the visitor's
// view with no session and no catalogue: the page itself, the one thing to
// press, and Miorail's own plugin.
test('a visitor opens Wallet MCP and sees the page, not the wallet wall (390px)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null } });
    if (path === '/api/status') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });

  await page.goto('/extensions');
  await expect(page.getByRole('button', { name: 'Sign in to ask' })).toBeVisible();
  await expect(page.getByText('PRIVATE AREA')).toHaveCount(0);

  await expect(page.getByText('Miorail in your AI assistant')).toBeVisible();
  await expect(page.getByText('https://miorail.xyz/mcp/private', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read the plugin' })).toHaveAttribute('href', '/wallet-mcp/miorail.md');

  // An example only fills the box; signing in is the way to ask it.
  await page.getByRole('button', { name: /What does my wallet hold\?/ }).click();
  await expect(page.locator('#base-mcp-console-input')).toHaveValue('What does my wallet hold?');
  await page.getByRole('button', { name: 'Sign in to ask' }).click();
  await expect(page).toHaveURL(/\/signin\?next=%2Fextensions$/);
});

test('the Wallet MCP page fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null } });
    if (path === '/api/status') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  await page.goto('/extensions');
  await expect(page.getByRole('button', { name: 'Sign in to ask' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
