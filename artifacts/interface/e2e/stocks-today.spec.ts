import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stockBriefV1 } from '../../../lib/rwa-market-reality/src/stockBrief.js';
import {
  briefInput,
  FEED,
  TOKEN,
  briefFixture,
  NOW,
} from '../../../lib/rwa-market-reality/test/fixtures/stockBrief.js';
import type { StockPositionQuoteV1 } from '@mioagent/rwa-market-reality/stock-position-quote';

const WALLET = '0x1111111111111111111111111111111111111111';
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

function sharedInboxFixture() {
  const read = new Map<string, Set<string>>();
  const reviewed = new Map<string, string>();
  const proofs = new Map<string, { wallet: string; ids: string[] }>();
  let count = 2,
    failRead = false,
    failSave = false;
  const writes: string[] = [];
  return {
    writes,
    add() {
      count++;
    },
    failRead(value: boolean) {
      failRead = value;
    },
    failSave(value: boolean) {
      failSave = value;
    },
    async install(page: import('@playwright/test').Page, wallet = WALLET) {
      await page.route('**/AuthProvider.tsx*', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: `export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:'authenticated', sessionAuthenticated:true }; }`,
        }),
      );
      await page.route('**/api/**', (route) => {
        const req = route.request(),
          url = new URL(req.url());
        if (req.method() !== 'GET') writes.push(url.pathname);
        if (url.pathname === '/api/auth/session')
          return route.fulfill({
            json: { user: { id: `eip155:8453:${wallet}`, address: wallet, chainId: 8453 } },
          });
        if (url.pathname === '/api/status')
          return route.fulfill({
            json: {
              chainId: 8453,
              productMigration: { routeIntelligenceV1: true },
              rpc: { status: 'connected' },
            },
          });
        if (url.pathname === '/api/stocks/inbox/read') {
          if (failSave)
            return route.fulfill({
              status: 503,
              json: { code: 'stock_inbox_receipt_unavailable' },
            });
          const body = req.postDataJSON();
          expect(Object.keys(body)).toEqual(['reviewToken']);
          const proof = proofs.get(body.reviewToken)!;
          expect(proof.wallet).toBe(wallet);
          const ids = read.get(wallet) ?? new Set<string>();
          proof.ids.forEach((id) => ids.add(id));
          read.set(wallet, ids);
          reviewed.set(wallet, NOW.toISOString());
          return route.fulfill({
            json: { reviewedAt: NOW.toISOString(), markedCount: proof.ids.length },
          });
        }
        if (url.pathname === '/api/stocks/today') {
          const data = briefFixture(),
            token = data.holdings[0]!.tokenAddress;
          const history = url.searchParams.get('view') === 'history';
          const all = Array.from({ length: count }, (_, i) => String(count - i)).filter(
            (id) => history || !read.get(wallet)?.has(id),
          );
          const later = url.searchParams.has('cursor');
          const ids = later ? all.slice(1) : all.slice(0, 1);
          data.changes!.cards = ids.map((id) => ({
            signalId: id,
            chainId: 8453,
            kind: 'official_asset_multiplier_changed',
            subjectAddress: token,
            subjectTicker: 'NVDAc',
            officialAddress: null,
            officialTicker: null,
            occurredAt: '2026-09-20T10:00:00.000Z',
            recordedAt: '2026-09-30T20:00:00.000Z',
            facts: { multiplierWad: '1050000000000000000' },
          }));
          const proof = `proof-${wallet}-${ids.join('-')}`;
          proofs.set(proof, { wallet, ids });
          data.inbox = {
            ...data.inbox,
            view: history ? 'history' : 'unread',
            openedAt: NOW.toISOString(),
            reviewedAt: reviewed.get(wallet) ?? null,
            heldCount: ids.length,
            watchedCount: 0,
            nextCursor: !later && all.length > 1 ? 'older' : null,
            reviewToken: history || failRead ? null : proof,
            items: ids.map((id) => ({
              signalId: id,
              relation: 'held',
              relatedTokenAddress: token,
              inspectionHref: `/investigate?token=${token}`,
              relatedInspectionHref: null,
            })),
          };
          data.changesUnavailable = failRead;
          if (failRead) data.changes = null;
          return route.fulfill({ json: data });
        }
        if (url.pathname.endsWith('/rwa/underlyings'))
          return route.fulfill({ json: fixture('underlyings') });
        if (
          url.pathname.includes('/rwa/market-reality/') &&
          !/\/(measure|history|ask)$/.test(url.pathname)
        )
          return route.fulfill({ json: fixture('nvda-market') });
        return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
      });
    },
  };
}

for (const width of [1440, 390]) {
  test(`shared receipts survive another browser; history and pagination keep unseen updates (${width}px)`, async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = sharedInboxFixture();
    // Old browser receipts are never silently imported into server history.
    await page.addInitScript(
      (wallet) =>
        localStorage.setItem(`miorail:stocks-reviewed:v1:${wallet}`, '2026-09-30T20:55:00.000Z'),
      WALLET,
    );
    await fixture.install(page);
    await page.goto('/stocks');
    const card = page.getByRole('region', { name: 'My stocks today', exact: true });
    await expect(card.getByRole('heading', { name: 'Unread updates' })).toBeVisible();
    await expect(card.getByText('Your stock', { exact: true })).toBeVisible();
    await expect(card.getByText(/Sep 20.*seen by Miorail Sep 30/)).toBeVisible();
    await expect(
      card.getByRole('link', { name: 'See details', exact: true }),
    ).toHaveAttribute('href', `/investigate?token=${briefFixture().holdings[0]!.tokenAddress}`);
    await page.reload();
    await expect(card.getByRole('button', { name: 'Mark this page as read' })).toBeEnabled();
    expect(fixture.writes.filter((p) => !p.endsWith('/measure'))).toEqual([]);
    await card.getByRole('button', { name: 'Older updates', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Newest updates' })).toBeVisible();
    await card.getByRole('button', { name: 'Mark as read', exact: true }).click();
    await expect(card.getByText(/Read receipt saved/)).toBeVisible();
    await card.getByRole('button', { name: 'Newest updates' }).click();
    await expect(card.getByText('Your stock', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Mark as read', exact: true }).click();
    await expect(card.getByText(/No unread update/)).toBeVisible();
    const otherContext = await browser.newContext({ viewport: { width, height: 1000 } });
    try {
      const second = await otherContext.newPage();
      await fixture.install(second);
      await second.goto('/stocks');
      const secondCard = second.getByRole('region', { name: 'My stocks today', exact: true });
      await expect(secondCard.getByText(/No unread update/)).toBeVisible();
      await secondCard.getByRole('button', { name: 'History', exact: true }).click();
      await expect(secondCard.getByRole('heading', { name: 'Your update history' })).toBeVisible();
      await expect(secondCard.getByText('Your stock', { exact: true })).toBeVisible();
      await expect(
        secondCard.getByRole('button', { name: 'Mark as read', exact: true }),
      ).toHaveCount(0);
      fixture.add();
      await card.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(card.getByText('Your stock', { exact: true })).toBeVisible();
      expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await card.screenshot({ path: `/tmp/miorail-shared-inbox-${width}.png` });
      const foreign = await otherContext.newPage();
      await fixture.install(foreign, '0x2222222222222222222222222222222222222222');
      await foreign.goto('/stocks');
      await expect(
        foreign
          .getByRole('region', { name: 'My stocks today', exact: true })
          .getByRole('button', { name: 'Mark this page as read' }),
      ).toBeEnabled();
    } finally {
      await otherContext.close();
    }
    expect(fixture.writes.filter((p) => !p.endsWith('/measure'))).toEqual([
      '/api/stocks/inbox/read',
      '/api/stocks/inbox/read',
    ]);
  });
}

for (const width of [1440, 390]) {
  test(`one issuer transaction is one visible update; evidence and receipts retain all logs (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await sharedInboxFixture().install(page);
    const transactionHash = `0x${'a'.repeat(64)}`;
    const cards = ['ui_multiplier_updated', 'multiplier_updated', 'announcement'].map(
      (event, i) => ({
        signalId: String(3 - i),
        chainId: 8453 as const,
        kind:
          event === 'announcement'
            ? ('official_asset_corporate_action_announced' as const)
            : ('official_asset_multiplier_changed' as const),
        subjectAddress: TOKEN,
        officialAddress: null,
        subjectTicker: 'NVDAc',
        officialTicker: null,
        occurredAt: '2026-09-30T16:47:47.000Z',
        recordedAt: '2026-09-30T16:59:27.058Z',
        facts: { transactionHash, event, multiplierWad: '1000537939576369481' },
      }),
    );
    let read = false;
    const acknowledged: string[] = [];
    await page.route('**/api/stocks/today*', (route) => {
      const history = new URL(route.request().url()).searchParams.get('view') === 'history';
      const data = stockBriefV1({
        ...briefInput(),
        changes: { ...FEED, cards: read && !history ? [] : cards },
      });
      data.inbox.view = history ? 'history' : 'unread';
      data.inbox.reviewToken = read || history ? null : 'all-three-records';
      return route.fulfill({ json: data });
    });
    await page.route('**/api/stocks/inbox/read', (route) => {
      expect(route.request().postDataJSON()).toEqual({ reviewToken: 'all-three-records' });
      acknowledged.push(...cards.map((card) => card.signalId));
      read = true;
      return route.fulfill({ json: { reviewedAt: NOW.toISOString(), markedCount: 3 } });
    });
    await page.goto('/stocks');
    const card = page.getByRole('region', { name: 'My stocks today', exact: true });
    const headline = card.getByText('NVDAc: Shares per token changed', { exact: true });
    await expect(headline).toHaveCount(1);
    await expect(headline).toBeVisible();
    await expect(card.getByText(/1 about stocks you hold/)).toBeVisible();
    await expect(card.getByText(/one NVDAc to about 1\.00053794/)).toBeVisible();
    const evidence = card
      .locator('details')
      .filter({
        has: page.locator('summary', { hasText: 'Source records · 3' }),
      });
    await expect(evidence).not.toHaveAttribute('open', '');
    await expect(
      evidence.getByText('The issuer announced a corporate action', { exact: true }),
    ).not.toBeVisible();
    await card.screenshot({ path: `/tmp/miorail-inbox-news-${width}.png` });
    await evidence.locator('summary').click();
    await expect(
      evidence.getByText('The issuer announced a corporate action', { exact: true }),
    ).toBeVisible();
    await expect(evidence.getByRole('link', { name: 'View transaction' })).toHaveAttribute(
      'href',
      `https://basescan.org/tx/${transactionHash}`,
    );
    await card.getByRole('button', { name: 'Mark as read', exact: true }).click();
    await expect(card.getByText(/No unread update/)).toBeVisible();
    expect(acknowledged).toEqual(['3', '2', '1']);
    await card.getByRole('button', { name: 'History', exact: true }).click();
    await expect(headline).toHaveCount(1);
    await expect(
      card.locator('summary', { hasText: 'Source records · 3' }),
    ).toBeVisible();
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

test('unavailable data and failed persistence keep updates unread and show a retry path', async ({
  page,
}) => {
  const fixture = sharedInboxFixture();
  await fixture.install(page);
  await page.goto('/stocks');
  const card = page.getByRole('region', { name: 'My stocks today', exact: true });
  await expect(card.getByRole('button', { name: 'Mark this page as read' })).toBeEnabled();
  fixture.failSave(true);
  await card.getByRole('button', { name: 'Mark this page as read' }).click();
  await expect(card.getByRole('alert')).toHaveText(/Could not save the read receipt/);
  await page.reload();
  await expect(card.getByText('Your stock', { exact: true })).toBeVisible();
  fixture.failRead(true);
  await card.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Mark this page as read' })).toBeDisabled();
  await expect(card.getByText(/Changes could not be read/)).toBeVisible();
  fixture.failRead(false);
  fixture.failSave(false);
  await card.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Mark this page as read' })).toBeEnabled();
  await card.getByRole('button', { name: 'Mark this page as read' }).click();
  await expect(card.getByText(/Read receipt saved/)).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`cash out is explicit, expires honestly and never invokes an action (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.install({ time: width === 390 ? new Date('2000-01-01T00:00:00Z') : NOW });
    let quoteCalls = 0;
    let fail = false;
    const writes: string[] = [];
    await page.route('**/AuthProvider.tsx*', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:'authenticated', sessionAuthenticated:true }; }`,
      }),
    );
    await page.route('**/api/**', (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (req.method() !== 'GET') writes.push(url.pathname);
      if (url.pathname === '/api/auth/session')
        return route.fulfill({
          json: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } },
        });
      if (url.pathname === '/api/status')
        return route.fulfill({
          json: {
            chainId: 8453,
            productMigration: { routeIntelligenceV1: true },
            rpc: { status: 'connected' },
          },
        });
      if (url.pathname === '/api/stocks/today') return route.fulfill({ json: briefFixture() });
      if (url.pathname === '/api/stocks/cash-out') {
        quoteCalls++;
        expect(req.postDataJSON()).toEqual({
          tokenAddress: briefFixture().holdings[0]!.tokenAddress,
        });
        const quote: StockPositionQuoteV1 = {
          schemaVersion: 'my-stock-cash-out/v1',
          chainId: 8453,
          tokenAddress: briefFixture().holdings[0]!.tokenAddress,
          tokenSymbol: 'NVDAc',
          generatedAt: NOW.toISOString(),
          holding: {
            balanceAtomic: '88158',
            tokens: '0.00088158',
            decimals: 8,
            blockTag: '0x3197501',
          },
          status: 'quoted',
          destination: 'USDC',
          destinationDecimals: 6,
          returnedAtomic: '201555',
          observedAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
          selectedSource: 'kyberswap',
          approvedSources: ['kyberswap'],
          sources: [{ source: 'kyberswap', status: 'full', errorCode: null }],
          executionProven: false,
          createsApproval: false,
          createsCalldata: false,
          createsTransaction: false,
          caveats: ['No wallet-specific transfer check or simulation was performed.'],
        };
        return route.fulfill(
          fail
            ? { status: 503, json: { error: 'stock_cash_out_measurement_unread' } }
            : { json: quote },
        );
      }
      if (url.pathname.endsWith('/rwa/underlyings'))
        return route.fulfill({ json: fixture('underlyings') });
      if (
        url.pathname.includes('/rwa/market-reality/') &&
        !/\/(measure|history|ask)$/.test(url.pathname)
      )
        return route.fulfill({ json: fixture('nvda-market') });
      return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
    });
    await page.goto('/stocks');
    const card = page.getByRole('region', { name: 'My stocks today', exact: true });
    await expect(card.getByRole('button', { name: 'Check cash out', exact: true })).toBeVisible();
    expect(quoteCalls).toBe(0);
    await card.getByRole('button', { name: 'Check cash out', exact: true }).click();
    await expect(card.getByText('Router quote: 0.201555 USDC', { exact: true })).toBeVisible();
    await expect(card.getByText(/for.*0.00088158 NVDAc/)).toBeVisible();
    await expect(card.getByText(/balance just read differs/)).toBeVisible();
    await card.getByText('Cash out measurement details', { exact: true }).click();
    await expect(card.getByText(/No wallet-specific transfer check/)).toBeVisible();
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/miorail-cash-out-${width}.png`, fullPage: false });
    await page.clock.fastForward(21_000);
    await expect(card.getByText('Last quoted: 0.201555 USDC', { exact: true })).toBeVisible();
    await expect(card.getByText(/Price expired/)).toBeVisible();
    expect(quoteCalls).toBe(1, 'expiry must not poll or measure again');
    fail = true;
    await card.getByRole('button', { name: 'Check cash out again', exact: true }).click();
    await expect(card.getByText(/Cash out could not be checked/)).toBeVisible();
    await expect(card.getByText('Last quoted: 0.201555 USDC', { exact: true })).toBeVisible();
    expect(quoteCalls).toBe(2);
    expect(writes.filter((path) => !path.endsWith('/measure'))).toEqual([
      '/api/stocks/cash-out',
      '/api/stocks/cash-out',
    ]);
  });
}
