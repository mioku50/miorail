import { expect, test, type Page } from '@playwright/test';
import { computeMirror } from '../../../lib/still-engine/src/mirror.js';
import { stillTerms } from '../../../lib/still-engine/src/terms.js';
import { EXAMPLE, calendar, snapshot, universe } from '../../../lib/still-engine/test/fixtures.js';

// Public links from the original stills.lat must keep naming the linked wallet,
// including when a different wallet has signed in. Every API request is a fixture.
const SELF = '0x1111111111111111111111111111111111111111';
const LINKED = '0x2222222222222222222222222222222222222222';
const NEXT = '0x3333333333333333333333333333333333333333';
const MONDAY = new Date('2026-10-26T18:05:00Z');

function report(subject: string) {
  return JSON.parse(JSON.stringify(computeMirror({
    universe: universe(), snapshot: snapshot(EXAMPLE), calendar: calendar(),
    subject: {
      address: subject === NEXT ? NEXT : LINKED,
      name: subject === 'alex.base.eth' ? subject : null,
      input: subject,
    },
    assembledAt: MONDAY,
  })));
}

async function install(page: Page, signedIn = false, recoverSubject: string | null = null) {
  const reads: string[] = [], writes: string[] = [], subjects: string[] = [];
  await page.clock.setFixedTime(MONDAY);
  await page.route('**/AuthProvider.tsx*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:${signedIn}, phase:'${signedIn ? 'authenticated' : 'disconnected'}', sessionAuthenticated:${signedIn} }; }`,
  }));
  await page.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    (request.method() === 'GET' ? reads : writes).push(path);
    if (path === '/api/auth/session') return route.fulfill({ json: { user: signedIn ? { id: 'fixture', address: SELF, chainId: 8453 } : null } });
    if (path === '/api/public/still/terms') return route.fulfill({ json: JSON.parse(JSON.stringify(stillTerms(calendar(), MONDAY))) });
    if (path === '/api/public/still/mirror') {
      const subject = url.searchParams.get('subject') ?? '';
      subjects.push(subject);
      if (subject === recoverSubject && subjects.filter(value => value === subject).length === 1) {
        return route.fulfill({ status: 503, json: { outcome: 'chain_unavailable', attempts: [] } });
      }
      if (subject === 'unavailable.base.eth') return route.fulfill({ status: 503, json: { outcome: 'chain_unavailable', attempts: [] } });
      if (subject === 'network.base.eth') return route.abort('failed');
      if (subject === 'nobody.base.eth') return route.fulfill({ status: 404, json: { outcome: 'name_not_found', input: subject, name: subject } });
      if (subject === 'alex%2Fbase.eth') return route.fulfill({ status: 400, json: { outcome: 'invalid_subject', input: subject, reason: 'not_an_address_or_name' } });
      if ([LINKED, NEXT, 'alex.base.eth'].includes(subject)) return route.fulfill({ json: { outcome: 'report', report: report(subject), cached: false } });
      return route.fulfill({ status: 400, json: { outcome: 'invalid_subject', input: subject, reason: 'not_an_address_or_name' } });
    }
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { reads, writes, subjects };
}

for (const path of ['/', `/w/${LINKED}`]) {
  test(`Check retries the same subject after a failed read on ${path}`, async ({ page }) => {
    const { reads, writes, subjects } = await install(page, path !== '/', LINKED);
    await page.goto(path);
    const field = page.getByLabel('Wallet address or name');
    if (path === '/') {
      await field.fill(LINKED);
      await page.getByRole('button', { name: 'Check', exact: true }).click();
    }
    await expect(page.getByRole('status')).toHaveText('Base could not be read just now. This is our failure, not a fact about the wallet. Try again in a minute.');
    await expect(page.locator('.still-big')).toHaveCount(0);
    await field.fill(`  ${LINKED}  `);
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText('0x2222…2222 could spend', { exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page).toHaveURL(`http://127.0.0.1:5187${path}`);
    expect(subjects).toEqual([LINKED, LINKED]);
    expect(reads.filter(read => read === '/api/public/still/mirror')).toHaveLength(2);
    expect(reads).not.toContain('/api/still/mine');
    expect(reads).not.toContain('/api/stocks/dividends/mine');
    expect(writes).toEqual([]);
  });
}

for (const width of [390, 1280]) {
  test(`a legacy wallet link opens and refreshes without signing in (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { reads, writes, subjects } = await install(page);
    await page.goto('/w/alex%2Ebase%2Eeth');
    await expect(page.getByText('alex.base.eth could spend', { exact: true })).toBeVisible();
    await expect(page.locator('.still-big .d').first()).toHaveText('$784');
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/signin?next=%2F');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await expect(page.getByText('alex.base.eth could spend', { exact: true })).toBeVisible();
    expect(subjects).toEqual(['alex.base.eth', 'alex.base.eth']);
    expect(reads).not.toContain('/api/still/mine');
    expect(writes).toEqual([]);
  });
}

test('a signed-in reader sees the linked wallet, can check another, and go back', async ({ page }) => {
  const { reads, writes, subjects } = await install(page, true);
  await page.goto(`/w/${LINKED}`);
  await expect(page.getByText('0x2222…2222 could spend', { exact: true })).toBeVisible();
  // The shared wallet header names the signed-in reader; the report must only
  // describe the wallet in the public link.
  await expect(page.getByRole('main').getByText(/0x1111/)).toHaveCount(0);
  const field = page.getByLabel('Wallet address or name');
  await field.fill(NEXT);
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:5187/w/${NEXT}`);
  await expect(page.getByText('0x3333…3333 could spend', { exact: true })).toBeVisible();
  await expect(page.getByText('0x2222…2222 could spend', { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByText('0x2222…2222 could spend', { exact: true })).toBeVisible();
  expect(subjects).toEqual([LINKED, NEXT]);
  expect(reads).not.toContain('/api/still/mine');
  expect(reads).not.toContain('/api/stocks/dividends/mine');
  expect(writes).toEqual([]);
});

test('malformed wallet paths show a refusal and never fetch a different subject', async ({ page }) => {
  const { subjects, writes } = await install(page);
  await page.goto('/w/');
  for (const path of ['/w/', '/w/%E0%A4%A', '/w/alex%2Fbase.eth', '/w/%00', `/w/${'a'.repeat(257)}`]) {
    // Vite rejects invalid URI escapes before serving HTML; exercise the same
    // client route through history so its refusal is checked independently.
    await page.evaluate((next) => {
      history.pushState(null, '', next);
      dispatchEvent(new PopStateEvent('popstate'));
    }, path);
    await expect(page.getByRole('status')).toHaveText('That is not a Base address (0x…) or a name like name.base.eth.');
    await expect(page.locator('.still-big')).toHaveCount(0);
  }
  expect(subjects).toEqual([]);
  expect(writes).toEqual([]);
});

test('a literal escaped percent is decoded once before the existing public check', async ({ page }) => {
  const { subjects, writes } = await install(page);
  await page.goto('/w/alex%252Fbase.eth');
  await expect(page.getByRole('status')).toHaveText('That is not a Base address (0x…) or a name like name.base.eth.');
  expect(subjects).toEqual(['alex%2Fbase.eth']);
  expect(writes).toEqual([]);
});

for (const [subject, message] of [
  ['nobody.base.eth', 'nobody.base.eth does not point to a wallet.'],
  ['unavailable.base.eth', 'Base could not be read just now. This is our failure, not a fact about the wallet. Try again in a minute.'],
  ['network.base.eth', 'The check failed on our side. Try again in a minute.'],
] as const) {
  test(`a legacy link states ${subject} failure and allows another check`, async ({ page }) => {
    const { reads, writes, subjects } = await install(page, true);
    await page.goto(`/w/${subject}`);
    await expect(page.getByRole('status')).toHaveText(message);
    await expect(page.locator('.still-big')).toHaveCount(0);
    await page.getByLabel('Wallet address or name').fill(LINKED);
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText('0x2222…2222 could spend', { exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
    expect(subjects).toEqual([subject, LINKED]);
    expect(reads).not.toContain('/api/still/mine');
    expect(writes).toEqual([]);
  });
}
