import { expect, test, type Page } from '@playwright/test';

async function publicGuest(page: Page) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
}

test('a stalled external font stylesheet does not block Stocks', async ({ page }) => {
  await publicGuest(page);
  let requested = false;
  await page.route('https://fonts.googleapis.com/**', () => { requested = true; });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Reading without signing in', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/stocks$/);
  expect(requested).toBe(true);
});

test('a delayed screen chunk shows a recovery frame and then opens Stocks', async ({ page }) => {
  await publicGuest(page);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/features/rwa/MarketRealityPage.tsx*', async route => {
    await barrier;
    await route.continue();
  });
  await page.goto('/stocks', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Loading Miorail…', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload page', exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: 'Reading without signing in', exact: true })).toBeVisible();
});

test('a delayed entry module keeps the HTML recovery frame visible', async ({ page }) => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  await publicGuest(page);
  await page.route('**/src/main.tsx*', async route => {
    await barrier;
    await route.continue();
  });
  await page.goto('/', { waitUntil: 'commit' });
  await expect(page.getByRole('heading', { name: 'Loading Miorail…', exact: true })).toBeVisible();
  await expect(page.getByText('If this takes longer, reload this page.', { exact: true })).toBeVisible();
  release();
  await expect(page).toHaveURL(/\/stocks$/);
});
