import { expect, test, type Page } from '@playwright/test';
import { computeMirror } from '../../../lib/still-engine/src/mirror.js';
import { stillTerms } from '../../../lib/still-engine/src/terms.js';
import { EXAMPLE, calendar, snapshot, universe } from '../../../lib/still-engine/test/fixtures.js';

// Still's shell on the web: Home, Assets, the Agent, More and a console page
// in the frame, drawn from the engine's own example wallet. Every API request
// is intercepted; nothing signs and nothing is sent anywhere.

const WALLET = '0x1111111111111111111111111111111111111111';
const MONDAY = new Date('2026-10-26T18:05:00Z'); // 2:05 PM in New York, the session open
const SATURDAY = new Date('2026-10-31T15:00:00Z'); // 11:00 AM in New York, Wall Street closed

function report(address: string, name: string | null = null, earningsCalendar = calendar()) {
  return JSON.parse(JSON.stringify(computeMirror({
    universe: universe(), snapshot: snapshot(EXAMPLE), calendar: earningsCalendar,
    subject: { address: address as `0x${string}`, name, input: name ?? address }, assembledAt: new Date('2026-10-21T15:00:01Z'),
  })));
}

const DIVIDENDS = {
  schemaVersion: 'dividend-wallet/v1', generatedAt: '2026-10-26T18:00:00Z', blockNumber: 53_000_000, receivedUsd: '0.52', passThroughPercent: '49.5',
  holdings: [{
    underlyingKey: 'security:isin:US0378331005', symbol: 'AAPL', company: 'Apple', tokenAddress: '0xb200000000000000000000c2e324d24d7eecd1fb', tokenSymbol: 'AAPLc', tokens: '1.5',
    upcoming: [{ state: 'estimated', reason: null, amountPerShare: '0.27', payDate: '2026-11-12', payDateApproximate: true, kind: 'estimate', tokens: '1.5', shares: '0.0006', usd: '0.19', at: null }],
    received: [],
  }],
};

async function install(page: Page, signedIn: boolean, now: Date, earningsCalendar = calendar()) {
  const reads: string[] = [], writes: string[] = [];
  await page.clock.setFixedTime(now);
  await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript',
    body: `export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:${signedIn}, phase:'${signedIn ? 'authenticated' : 'disconnected'}', sessionAuthenticated:${signedIn} }; }` }));
  await page.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    (request.method() === 'GET' ? reads : writes).push(path);
    if (path === '/api/auth/session') return route.fulfill({ json: { user: signedIn ? { id: 'fixture', address: WALLET, chainId: 8453 } : null } });
    if (path === '/api/public/still/terms') return route.fulfill({ json: JSON.parse(JSON.stringify(stillTerms(calendar(), now))) });
    if (path === '/api/still/mine' && signedIn) return route.fulfill({ json: { outcome: 'report', report: report(WALLET, null, earningsCalendar), cached: false } });
    if (path === '/api/stocks/dividends/mine' && signedIn) return route.fulfill({ json: DIVIDENDS });
    if (path === '/api/public/still/mirror') {
      const subject = url.searchParams.get('subject') ?? '';
      if (subject === 'nobody.base.eth') return route.fulfill({ status: 404, json: { outcome: 'name_not_found', input: subject, name: subject } });
      return route.fulfill({ json: { outcome: 'report', report: report('0x2222222222222222222222222222222222222222'), cached: false } });
    }
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { reads, writes };
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [390, 1280]) {
  test(`signed out, Home is the sky and a check of any wallet (${width}px)`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 844 });
    const { writes } = await install(page, false, MONDAY);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Spend without selling.', exact: true })).toBeVisible();
    await expect(page.getByText('Market open · full limits', { exact: true })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const label of ['Home', 'Assets', 'Agent', 'Stocks', 'More']) await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    // No example numbers before a wallet was asked about.
    await expect(page.getByText(/\$\d/)).toHaveCount(0);

    const field = page.getByLabel('Wallet address or name');
    await field.fill('nobody.base.eth');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText('nobody.base.eth does not point to a wallet.', { exact: true })).toBeVisible();
    await field.fill('0x2222222222222222222222222222222222222222');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByText('0x2222…2222 could spend', { exact: true })).toBeVisible();
    await expect(page.locator('.still-big .d').first()).toHaveText('$784');
    await expect(page.getByText('Not offered to US persons.', { exact: false })).toBeVisible();
    await noSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`home-signed-out-${width}.png`), fullPage: true });
    expect(writes).toEqual([]);
  });

  test(`signed in, the wallet's own numbers move through Home, Assets, the Agent and More (${width}px)`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    const { reads, writes } = await install(page, true, MONDAY);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'In balance.', exact: true })).toBeVisible();
    await expect(page.getByText('NVIDIA can fall 52% before the weight wins.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('$784.62 available', { exact: true })).toBeVisible();
    await expect(page.getByText('Owed $240.17', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: /NVDA.* on the left hold up a \$240\.17 loan on the right/ })).toBeVisible();
    await expect(page.getByText('≈ NOV 12 Apple dividend · ≈ $0.19 as more AAPLc, an estimate', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'For assistants', exact: true })).toHaveAttribute('href', '/assistants');
    await noSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`home-signed-in-${width}.png`), fullPage: true });

    await page.getByRole('link', { name: 'Your assets', exact: true }).click();
    await expect(page).toHaveURL(/\/assets$/);
    await expect(page.getByRole('heading', { name: 'Assets', exact: true })).toBeVisible();
    await expect(page.getByText('4.2 NVDAc', { exact: true })).toBeVisible();
    await expect(page.getByText('3.4 hold up your Aave loan', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Loans · 1', exact: true }).click();
    await expect(page.getByText('Prices can fall 52% together before liquidation.', { exact: true })).toBeVisible();
    await noSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`assets-${width}.png`), fullPage: true });

    const nav = page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('link', { name: 'Agent', exact: true }).click();
    await expect(page).toHaveURL(/\/agent$/);
    await page.getByRole('button', { name: 'How much can I spend without selling?', exact: true }).click();
    await expect(page.getByText('Now $784.62 without selling. Your $240.17 owed is already counted.', { exact: true })).toBeVisible();
    await page.getByLabel('A question about your money').fill('Когда выходные лимиты?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByText(/^С Fri 8 PM до Sun 8 PM по Нью-Йорку/)).toBeVisible();

    await nav.getByRole('link', { name: 'More', exact: true }).click();
    await expect(page).toHaveURL(/\/more$/);
    await expect(page.getByRole('main').getByText('0x1111…1111', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: /Still for assistants/ }).click();
    await expect(page).toHaveURL(/\/assistants$/);
    await expect(page.getByText('Use the Miorail plugin for Wallet MCP: https://miorail.xyz/wallet-mcp/miorail.md', { exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'More', exact: true })).toHaveAttribute('aria-current', 'page');

    // A console page, in the same frame: its title from the breadcrumb, the five places beside it.
    await nav.getByRole('link', { name: 'Stocks', exact: true }).click();
    await expect(page).toHaveURL(/\/stocks$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Stocks', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Stocks', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.mio-console.app')).toHaveCount(0);
    await noSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`stocks-in-frame-${width}.png`) });

    // One read of the wallet for the whole visit, and nothing written.
    expect(reads.filter(path => path === '/api/still/mine')).toHaveLength(1);
    expect(writes).toEqual([]);
  });
}

test('Home and the command palette reach all Still pages without another wallet read', async ({ page }) => {
  const { reads, writes } = await install(page, true, MONDAY);
  await page.goto('/');
  await page.getByRole('link', { name: 'For assistants', exact: true }).click();
  await expect(page).toHaveURL(/\/assistants$/);
  for (const [label, path] of [['Home', '/'], ['Assets', '/assets'], ['Agent', '/agent'], ['More', '/more'], ['For assistants', '/assistants']] as const) {
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Command Palette', exact: true }).fill(label);
    await page.getByRole('option', { name: label, exact: true }).click();
    await expect(page).toHaveURL(`http://127.0.0.1:5187${path}`);
    await expect(page.getByRole('combobox', { name: 'Command Palette', exact: true })).toHaveCount(0);
  }
  expect(reads.filter(path => path === '/api/still/mine')).toHaveLength(1);
  expect(writes).toEqual([]);
});

test('Coming up names only the next known earnings window, not active or unread ones', async ({ page }) => {
  const { reads, writes } = await install(page, true, MONDAY, calendar({ NVDAc: ['2026-10-29'], AAPLc: ['2026-10-26'] }, ['TSLAc']));
  await page.goto('/');
  const events = page.locator('.still-coming');
  await expect(events.getByText('WED 12 AM NVIDIA reports Oct 29: new loans against it will count at 40% of the protocol’s limit until Fri 8 PM.', { exact: true })).toBeVisible();
  await expect(events.getByText(/Apple reports|Tesla reports/)).toHaveCount(0);
  await expect(events.getByText('≈ NOV 12 Apple dividend · ≈ $0.19 as more AAPLc, an estimate', { exact: true })).toBeVisible();
  expect(reads.filter(path => path === '/api/still/mine')).toHaveLength(1);
  expect(writes).toEqual([]);
});

test.describe('Agent language', () => {
  test.use({ locale: 'ru-RU' });

  test('keeps the UI English in a Russian browser and answers a Russian question in Russian', async ({ page }) => {
    const { reads, writes } = await install(page, true, MONDAY);
    await page.goto('/agent');
    expect(await page.evaluate(() => navigator.language)).toBe('ru-RU');
    await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible();
    await expect(page.getByText('Reads your wallet and Still’s numbers. Never signs.', { exact: true })).toBeVisible();
    await expect(page.getByText('Ask about your money.', { exact: true })).toBeVisible();
    for (const prompt of ['How much can I spend without selling?', 'How safe is my loan?', 'When do weekend limits start?', 'When is my next dividend?']) {
      await expect(page.getByRole('button', { name: prompt, exact: true })).toBeEnabled();
    }
    const question = page.getByRole('textbox', { name: 'A question about your money', exact: true });
    await expect(question).toHaveAttribute('placeholder', 'Ask about your money');
    await question.fill('Сколько я могу взять?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByText('Сейчас $784.62 без продажи. Ваш долг $240.17 уже учтён.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'How much can I spend without selling?', exact: true })).toBeVisible();
    await expect(question).toHaveAttribute('placeholder', 'Ask about your money');
    expect(reads.filter(path => path === '/api/still/mine')).toHaveLength(1);
    expect(writes).toEqual([]);
  });
});

test('while Wall Street is closed the frame is night, and the sky says until when', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await install(page, false, SATURDAY);
  await page.goto('/');
  await expect(page.getByText('Wall Street is closed. Base is open.', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Until Sun 8 PM new loans against stocks count at 40% of the protocol’s limit, not 50%\./)).toBeVisible();
  await expect(page.locator('.still-frame')).toHaveAttribute('data-sky', 'night');
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
});

test('after hours the sky is dark, so the name and the mobile over it are drawn light', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await install(page, true, new Date('2026-10-26T21:48:00Z')); // 5:48 PM in New York
  await page.goto('/');
  await expect(page.getByText('After hours · full limits', { exact: true })).toBeVisible();
  await expect(page.locator('.still-hero')).toHaveAttribute('data-phase', 'dusk');
  await expect(page.locator('.still-wallet-brand')).toBeVisible();
  expect(await page.locator('.still-wallet-brand').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(238, 241, 255)');
  expect(await page.locator('.still-hero .still-brand').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(238, 241, 255)');
  expect(await page.locator('.still-hero .sm-wire').first().evaluate((e) => getComputedStyle(e).stroke)).toBe('rgb(238, 241, 255)');
});

test('a link that carried a question to "/" still lands on Stocks', async ({ page }) => {
  await install(page, false, MONDAY);
  await page.goto('/?key=security%3Aisin%3AUS67066G1040');
  await expect(page).toHaveURL(/\/stocks\?key=security%3Aisin%3AUS67066G1040$/);
});

test('a desktop conversation brings each new answer into view', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const { writes } = await install(page, true, MONDAY);
  await page.goto('/agent');
  const question = page.getByRole('button', { name: 'How safe is my loan?', exact: true });
  for (let i = 0; i < 5; i++) await question.click();
  await expect(page.locator('.still-agent-chat .still-bubble')).toHaveCount(5);
  const chat = page.locator('.still-agent-chat');
  expect(await chat.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(() => chat.evaluate(element => Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight))).toBeLessThan(2);
  expect(writes).toEqual([]);
});

for (const width of [390, 1366, 1920]) {
  test(`the signed-in overview and asset actions use the viewport without oversized artwork (${width}px)`, async ({ page }, testInfo) => {
    const height = width === 1366 ? 768 : width === 390 ? 844 : 1080;
    await page.setViewportSize({ width, height });
    const { writes } = await install(page, true, MONDAY);
    await page.goto('/');
    const money = page.getByLabel('$784.62 available', { exact: true });
    await expect(money).toBeVisible();
    const moneyBox = await money.boundingBox();
    expect(moneyBox!.y + moneyBox!.height).toBeLessThan(height - (width < 900 ? 76 : 0));
    await expect(page.locator('.still-wallet-trigger').first()).toBeVisible();
    const hero = await page.locator('.still-hero > svg').boundingBox();
    expect(hero!.width).toBeLessThanOrEqual(481);
    expect(hero!.height).toBeLessThanOrEqual(383);
    if (width === 390) {
      expect(hero!.y).toBe(0);
      expect(hero!.height).toBeCloseTo(310, 0);
      expect((await page.getByRole('navigation', { name: 'Main' }).boundingBox())!.height).toBe(76);
    }
    if (width >= 1100) {
      const main = await page.locator('main.still-main').boundingBox();
      expect(main!.width).toBeGreaterThan((width - 220) * 0.7);
      const actions = await page.getByRole('link', { name: 'Your assets', exact: true }).boundingBox();
      expect(actions!.y + actions!.height).toBeLessThan(height);
    }
    await noSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`home-layout-${width}.png`), fullPage: true });

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assets', exact: true }).click();
    await expect(page.getByText('4.2 NVDAc', { exact: true })).toBeVisible();
    const dividends = page.getByRole('link', { name: /Your dividends/ });
    const card = await dividends.boundingBox();
    expect(card!.height).toBeLessThanOrEqual(140);
    const arrow = await dividends.locator('svg').boundingBox();
    expect(arrow!.width).toBeLessThanOrEqual(20);
    expect(arrow!.height).toBeLessThanOrEqual(20);
    await noSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`assets-layout-${width}.png`), fullPage: true });

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Agent', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'A question about your money', exact: true })).toBeVisible();
    if (width >= 1100) {
      const input = await page.locator('.still-agent-composer').boundingBox();
      expect(input!.y + input!.height).toBeLessThan(height);
      const workspace = await page.locator('.still-agent-workspace').boundingBox();
      expect(workspace!.height).toBeLessThanOrEqual(480);
    } else {
      expect(await page.locator('.still-agent-workspace').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
      expect((await page.locator('.still-agent-composer input').boundingBox())!.height).toBe(48);
    }
    await noSidewaysScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`agent-layout-${width}.png`), fullPage: true });
    expect(writes).toEqual([]);
  });
}

for (const [label, now, card] of [
  ['day', MONDAY, 'rgb(255, 255, 255)'],
  ['night', SATURDAY, 'rgb(22, 27, 77)'],
] as const) {
  test(`console surfaces use the Sky palette without changing the unframed console (${label})`, async ({ page }) => {
    const { writes } = await install(page, false, now);
    await page.goto('/extensions');
    await expect(page.getByRole('heading', { name: 'Wallet MCP', exact: true })).toBeVisible();
    const frame = page.locator('.still-console');
    await expect(frame.locator('.rp').first()).toBeVisible();
    const themed = await frame.evaluate(element => {
      const style = getComputedStyle(element);
      const panel = getComputedStyle(element.querySelector('.rp')!);
      const button = getComputedStyle(element.querySelector('.btn')!);
      return {
        radius: style.getPropertyValue('--r').trim(), card: panel.backgroundColor,
        buttonFill: button.backgroundColor, buttonImage: button.backgroundImage,
        semantic: ['--green', '--red', '--amber'].map(token => style.getPropertyValue(token).trim()),
      };
    });
    expect(themed.radius).toBe('18px');
    expect(themed.card).toBe(card);
    expect(themed.buttonFill).toBe('rgb(0, 82, 255)');
    expect(themed.buttonImage).toBe('none');
    await noSidewaysScroll(page);

    // Keep the same document/theme while leaving Still's frame. The classic
    // console and miniapp stylesheet must retain their own design tokens.
    await page.evaluate(() => { history.pushState(null, '', '/is-it-real'); dispatchEvent(new PopStateEvent('popstate')); });
    await expect(page.getByRole('heading', { name: 'Is this the real one?', exact: true })).toBeVisible();
    const classic = await page.locator('.pi-page').evaluate(element => {
      const style = getComputedStyle(element);
      return { radius: style.getPropertyValue('--r').trim(), gradient: style.getPropertyValue('--grad'),
        semantic: ['--green', '--red', '--amber'].map(token => style.getPropertyValue(token).trim()) };
    });
    expect(classic.radius).toBe('10px');
    expect(classic.gradient).toContain('linear-gradient');
    expect(classic.semantic).toEqual(themed.semantic);
    expect(writes).toEqual([]);
  });
}
