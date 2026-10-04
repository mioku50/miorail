import { expect, test, type Page } from '@playwright/test';

const DEVICE = 'Dv'.repeat(21) + 'x';
const LOCKS = '2026-10-11T21:00:00.000Z';

const stock = (symbol: string, over: Record<string, unknown> = {}) => ({
  tokenAddress: `0xb2${String(symbol.charCodeAt(0)).padStart(38, '0')}`,
  symbol,
  name: `${symbol} Inc.`,
  close: '100.00',
  baseNow: { value: '101.00', moveBps: 100 },
  baseCall: null,
  crowd: null,
  result: null,
  ...over,
});

function openGame(picks: Record<string, 'up' | 'down'> | null) {
  return {
    schemaVersion: 'call-the-reopen/v1',
    generatedAt: '2026-10-10T16:00:00.000Z',
    round: {
      roundId: '2026-10-09',
      number: 1,
      state: 'open',
      opensAt: '2026-10-10T00:00:00.000Z',
      locksAt: LOCKS,
      expectedReopenAt: '2026-10-12T00:00:00.000Z',
      stocks: ['NVDA', 'TSLA', 'AAPL', 'AMZN', 'MSTR'].map((symbol) => stock(symbol)),
      players: null,
      score: null,
    },
    next: { number: 2, opensAt: '2026-10-17T00:00:00.000Z', locksAt: '2026-10-18T21:00:00.000Z', expectedReopenAt: '2026-10-19T00:00:00.000Z' },
    leaderboard: null as unknown,
    baseRecord: { rounds: 0, correct: 0, of: 0 },
    me: picks
      ? { picks, pickedAt: '2026-10-10T16:01:00.000Z', score: null, record: { played: 0, streak: 0, correct: 0, of: 0, beatBase: 0 }, signed: false }
      : null,
  };
}

/** Every API call intercepted; a visitor with no session. */
async function stubApi(page: Page, initial: unknown) {
  let game = initial as ReturnType<typeof openGame>;
  const picksSent: unknown[] = [];
  const devicesSeen: (string | null)[] = [];
  await page.route('**/RequireSession.tsx*', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: 'export function RequireSession({children}) { return children; }' }),
  );
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/status')
      return route.fulfill({ json: { chainId: 8453, productMigration: { routeIntelligenceV1: true }, rpc: { status: 'connected' } } });
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null } });
    if (path === '/api/public/reopen') {
      devicesSeen.push(request.headers()['x-miorail-reopen-device'] ?? null);
      return route.fulfill({ json: game });
    }
    if (path === '/api/public/reopen/picks') {
      const body = request.postDataJSON() as { picks: Record<string, 'up' | 'down'> };
      picksSent.push(body);
      const first = !request.headers()['x-miorail-reopen-device'];
      game = openGame(body.picks);
      return route.fulfill({ json: { game, device: first ? DEVICE : null } });
    }
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { picksSent, devicesSeen };
}

test('a visitor calls the reopen without a wallet, and the device keeps the picks (390px)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await stubApi(page, openGame(null));
  await page.goto('/stocks/weekend');
  await expect(page.getByRole('heading', { name: 'Call the reopen · #1' })).toBeVisible();
  await expect(page.getByText('No wallet needed; you can change a pick until the lock.')).toBeVisible();

  const nvda = page.getByRole('group', { name: "NVDA: above or below Friday's close" });
  await nvda.getByRole('button', { name: '▲ Above' }).click();
  await expect(nvda.getByRole('button', { name: '▲ Above' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => api.picksSent.length).toBe(1);
  expect(api.picksSent[0]).toEqual({ roundId: '2026-10-09', picks: { NVDA: 'up' } });
  await expect(page.getByText('Your picks are kept on this device only.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in to keep your streak' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('miorail.reopen.device.v1'))).toBe(DEVICE);

  // A second pick goes with the device's token, and so does the next read.
  const tsla = page.getByRole('group', { name: "TSLA: above or below Friday's close" });
  await tsla.getByRole('button', { name: '▼ Below' }).click();
  await expect.poll(() => api.picksSent.length).toBe(2);
  expect(api.picksSent[1]).toEqual({ roundId: '2026-10-09', picks: { NVDA: 'up', TSLA: 'down' } });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Call the reopen · #1' })).toBeVisible();
  await expect.poll(() => api.devicesSeen.at(-1)).toBe(DEVICE);

  // Five rows of two buttons fit a phone: nothing scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // After a pick, one way out of the game: NVIDIA, whatever was picked.
  const piece = page.getByRole('link', { name: 'A piece of NVIDIA, from $1' });
  await expect(piece).toHaveAttribute('href', '/stocks/nvda');
  await piece.click();
  await expect(page).toHaveURL(/\/stocks\/nvda$/);
});

test('a settled round shows the squares, the score and the line to share (390px)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const settled = openGame({ NVDA: 'up', TSLA: 'down' });
  Object.assign(settled.round, {
    state: 'settled',
    players: 4,
    stocks: [
      stock('NVDA', { baseNow: null, baseCall: { base: '99.00', call: 'down' }, crowd: { up: 3, down: 1 }, result: { reopen: '102.00', at: '2026-10-12T00:00:30.000Z', outcome: 'up' } }),
      stock('TSLA', { baseNow: null, baseCall: { base: '101.00', call: 'up' }, crowd: { up: 2, down: 2 }, result: { reopen: '98.00', at: '2026-10-12T00:00:30.000Z', outcome: 'down' } }),
    ],
    score: { base: { correct: 0, of: 2, cells: '🟥🟥' }, crowd: { correct: 1, of: 1, cells: '🟩⬜' } },
  });
  Object.assign(settled.me!, {
    score: { correct: 2, of: 2, cells: '🟩🟩' },
    record: { played: 1, streak: 1, correct: 2, of: 2, beatBase: 1 },
    share: 'Ab3_x-9Zq0Lm',
  });
  settled.leaderboard = {
    rounds: 1,
    players: 4,
    rows: [
      { rank: 1, name: 'a-very-long-basename-for-a-phone.base.eth', correct: 2, of: 2, played: 1, you: false },
      { rank: 1, name: 'Player 3', correct: 2, of: 2, played: 1, you: true },
      { rank: 3, name: 'Player 1', correct: 1, of: 2, played: 1, you: false },
    ],
    me: { rank: 1, correct: 2, of: 2, played: 1 },
  };
  await stubApi(page, settled);
  await page.goto('/stocks/weekend');
  await expect(page.getByText('4 people played.', { exact: false })).toBeVisible();
  // The score sits in tiles under the verdict, each with its squares.
  await expect(page.getByText('You beat Base 🎉')).toBeVisible();
  const card = page.getByRole('region', { name: 'Call the reopen' });
  await expect(card.locator('.mr-reopen-tiles .kpi')).toHaveText([/You\s*2\/2\s*🟩🟩/, /Base\s*0\/2\s*🟥🟥/, /Players\s*1\/1\s*🟩⬜/]);
  await expect(card.locator('.mr-reopen-row[data-mark="right"]')).toHaveCount(2);
  await expect(card.locator('.mr-reopen-steps .st.done')).toHaveCount(3);
  await expect(page.getByText('🟩 You ▲ above').first()).toBeVisible();
  await expect(page.getByText('Reopened above · $102.00')).toBeVisible();
  const board = page.getByLabel('Leaderboard');
  await expect(board.getByText('After 1 round · 4 players.', { exact: false })).toBeVisible();
  await expect(board.locator('tr.you')).toContainText('Player 3 · you');
  const post = page.getByRole('link', { name: 'Post on X' }).first();
  expect(decodeURIComponent((await post.getAttribute('href')) ?? '')).toContain('Call the reopen #1 🟩🟩 2/2 · Base 0/2');
  // The post links to this result, whose page previews as its picture.
  expect(decodeURIComponent((await post.getAttribute('href')) ?? '')).toContain('/stocks/weekend?call=Ab3_x-9Zq0Lm');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
