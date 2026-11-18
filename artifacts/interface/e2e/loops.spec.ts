import { expect, test, type Page } from '@playwright/test';

// /loops and its row in More. Every API request is intercepted; nothing signs and nothing is sent anywhere.

const ANSWER = {
  outcome: 'loops', weekStartsAt: '2026-11-16T00:00:00.000Z',
  counts: { total: 3, week: 2, viaAssistant: 2, byBrand: { apple: 2, amazon: 1, google: 0, meta: 0, microsoft: 0 } },
  wall: [{ loopNo: 2, brand: 'apple', brandName: 'Apple', card: 'Apple gift card', productName: 'iTunes Germany', packageLabel: '25 EUR',
    priceUsdc: '27', venueName: 'Aave', via: 'claude', day: '2026-11-17', label: 'alice.base.eth' }],
};

async function install(page: Page, open: boolean) {
  const writes: string[] = [];
  await page.route('**/AuthProvider.tsx*', (route) => route.fulfill({ contentType: 'application/javascript',
    body: 'export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:false, phase:"anonymous", sessionAuthenticated:false }; }' }));
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(path);
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null } });
    if (path === '/api/public/still/loops') return open ? route.fulfill({ json: ANSWER }) : route.fulfill({ status: 404, json: { outcome: 'loops_off' } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { writes };
}

for (const width of [390, 1280]) {
  test(`Loops show the week, how one is made and the wall, and More offers them once open (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { writes } = await install(page, true);
    await page.goto('/loops');
    await expect(page.getByRole('heading', { level: 1, name: 'Loops', exact: true })).toBeVisible();
    await expect(page.getByText('this week', { exact: true })).toBeVisible();
    await expect(page.getByText('An Xbox card, paid by a loan against MSFTc')).toBeVisible();
    await expect(page.getByText('Loop #2 · alice.base.eth')).toBeVisible();
    await expect(page.getByText(/can be liquidated if prices fall/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`loops-${width}.png`), fullPage: true });
    await page.goto('/more');
    await expect(page.getByRole('main').getByRole('link', { name: /^Loops/ })).toHaveAttribute('href', '/loops');
    expect(writes).toEqual([]);
  });
}

test('while Loops are closed the page says so and More does not offer it', async ({ page }) => {
  const { writes } = await install(page, false);
  await page.goto('/loops');
  await expect(page.getByText('Loops are not open yet.')).toBeVisible();
  await page.goto('/more');
  await expect(page.getByRole('heading', { level: 1, name: 'More', exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: /^Loops/ })).toHaveCount(0);
  expect(writes).toEqual([]);
});

// The draw: a signed-in person enters free. The entry is the only write, and it is answered by this fixture.
const WALLET = `0x${'4'.repeat(40)}`;
const OPEN = { drawId: '2026-11-28', opensAt: '2026-11-21T00:00:00.000Z', closesAt: '2026-11-28T18:00:00.000Z', winnerCount: 1, prizeUsdc: '10', state: 'open',
  entries: 4, entriesHash: null, lockedAt: null, blockAt: null, block: null, winners: [] };

async function installSignedIn(page: Page, enter: { status: number; json: unknown }, loop: { loopNo: number; ready: boolean } | null = null) {
  const writes: Array<{ path: string; body: string | null }> = [];
  let entered = false;
  await page.route('**/AuthProvider.tsx*', (route) => route.fulfill({ contentType: 'application/javascript',
    body: 'export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:"authenticated", sessionAuthenticated:true }; }' }));
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push({ path, body: request.postData() });
    if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } } });
    if (path === '/api/public/still/loops') return route.fulfill({ json: { ...ANSWER, draws: { current: OPEN, past: [] } } });
    if (path === '/api/public/still/eligibility') return route.fulfill({ json: { schemaVersion: 'still-eligibility/v1', gate: 'off', region: { state: 'allowed', country: null } } });
    if (path === '/api/still/loops/draw') {
      return route.fulfill({ json: { outcome: 'mine', team: false, entered: [],
        current: { drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z',
          entry: entered ? (enter.json as { entry: { label: string; kind: string } }).entry : null, loop: entered ? null : loop } } });
    }
    if (path === '/api/still/loops/draw/enter' && request.method() === 'POST') {
      entered = enter.status === 200;
      return route.fulfill({ status: enter.status, json: enter.json });
    }
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { writes };
}

for (const width of [390, 1280]) {
  test(`the draw takes a free entry once the rules are accepted, and says so (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { writes } = await installSignedIn(page, { status: 200, json: { outcome: 'entered', drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z',
      entry: { label: 'Entry K3F9X2', kind: 'free' } } });
    await page.goto('/loops');
    await expect(page.getByRole('heading', { level: 2, name: 'The draw · 10 USDC' })).toBeVisible();
    await expect(page.getByText('Closes Sat 28 Nov, 18:00 UTC. 4 entries so far. One winner, 10 USDC.')).toBeVisible();
    const button = page.getByRole('button', { name: 'Enter free' });
    await expect(button).toBeDisabled();
    await page.getByLabel('I am 18 or older and I accept the rules below').check();
    await button.click();
    await expect(page.getByText('You are in this draw as Entry K3F9X2.', { exact: false })).toBeVisible();
    expect(writes).toEqual([{ path: '/api/still/loops/draw/enter', body: '{"rules":true}' }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`loops-draw-${width}.png`), fullPage: true });
  });
}

test('a wallet that made a Loop while open enters with it by the same press (audit LOOP-2)', async ({ page }) => {
  const { writes } = await installSignedIn(page, { status: 200, json: { outcome: 'entered', drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z',
    entry: { label: 'Loop #7', kind: 'loop' } } }, { loopNo: 7, ready: true });
  await page.goto('/loops');
  const button = page.getByRole('button', { name: 'Enter with Loop #7' });
  await expect(button).toBeDisabled();
  await expect(page.getByText('Free entry needs Coinbase’s Verified Account attestation', { exact: false })).toHaveCount(0);
  await page.getByLabel('I am 18 or older and I accept the rules below').check();
  await button.click();
  await expect(page.getByText('You are in this draw as Loop #7.', { exact: false })).toBeVisible();
  expect(writes).toEqual([{ path: '/api/still/loops/draw/enter', body: '{"rules":true}' }]);
});

test('a refused free entry says the server’s own words and enters nothing', async ({ page }) => {
  const detail = 'Without a Loop made while this draw is open, an entry needs Coinbase’s Verified Account attestation on this wallet.';
  await installSignedIn(page, { status: 403, json: { error: 'not_verified', detail } });
  await page.goto('/loops');
  await page.getByLabel('I am 18 or older and I accept the rules below').check();
  await page.getByRole('button', { name: 'Enter free' }).click();
  await expect(page.getByText(detail)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter free' })).toBeEnabled();
});
