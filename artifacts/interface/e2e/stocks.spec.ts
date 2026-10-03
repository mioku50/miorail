import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const NVDA = 'security:isin:US67066G1040';
const COIN = 'security:isin:US19260Q1076';
const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';

/** Exercise real routing, hooks, components and CSS. Authentication alone is
 * bypassed in this local browser module; every API call is intercepted. No
 * wallet provider, production cookie, live network or signature is needed. */
async function stubApi(page: Page, holding: unknown = { state: 'read', balanceAtomic: '43417', decimals: 8, blockTag: '0x308c458' }, catalog?: { index: unknown; market: unknown }) {
  const confirmations: unknown[] = [];
  const termsAsked: unknown[] = [];
  const forbiddenWrites: string[] = [];
  await page.route('**/RequireSession.tsx*', route => route.fulfill({
    contentType: 'application/javascript',
    body: 'export function RequireSession({children}) { return children; }',
  }));
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json: unknown;
    if (path === '/api/status') json = { chainId: 8453, productMigration: { routeIntelligenceV1: true }, rpc: { status: 'connected' } };
    else if (path === '/api/auth/session') json = { user: null };
    else if (path.endsWith('/rwa/underlyings') || path === '/api/public/stocks/underlyings') json = catalog?.index ?? fixture('underlyings');
    else if (path.endsWith('/stock-action/test-sell/confirm')) {
      confirmations.push(request.postDataJSON());
      json = { clearance: 'fixture-clearance', expiresAt: '2026-09-05T22:00:00Z' };
    } else if (path.endsWith('/stock-action/test-sell/sell-terms')) {
      // Phase 17.9 — the routers, asked about the exact amount in the box.
      const body = request.postDataJSON() as { tokenAmountAtomic: string };
      termsAsked.push(body);
      json = {
        holding,
        terms: {
          status: 'established', sizeMeasured: true,
          tokenAmountAtomic: body.tokenAmountAtomic, tokenDecimals: 8,
          destination: 'USDC', destinationDecimals: 6, returnedAtomic: '90000',
          sources: [{ source: 'kyberswap', status: 'full', errorCode: null }],
          approvedSources: ['kyberswap'],
          observedAt: '2026-09-06T18:00:00.000Z', expiresAt: '2026-09-06T18:00:20.000Z',
          createsApproval: false, createsCalldata: false, createsTransaction: false,
        },
      };
    } else if (path.endsWith('/stock-action/test-sell')) {
      json = {
        outcome: 'review', evidenceState: 'expired_quote', holding,
        representation: { tokenAddress: TOKEN, caip10: `eip155:8453:${TOKEN}`, issuerId: 'coinbase' },
        question: { direction: 'sell', requestedCashAtomic: '1000000000', destination: 'USDC' },
        sizeContext: {
          boardSizeBasis: 'cash_equivalent', boardRequestedCashAtomic: '1000000000',
          saleSizeBasis: 'exact_token_in', termsEstablished: false,
          detail: 'The market figures below were measured for the cash size this draft was prepared with.',
        },
        reality: fixture('nvda-market'),
      };
    } else if ((path.includes('/rwa/market-reality/') || path.includes('/public/stocks/market-reality/')) && !/\/(measure|history|ask)$/.test(path)) {
      json = catalog?.market ?? fixture(path.includes('US19260') ? 'coin-market' : 'nvda-market');
    } else if (/\/(release|submission|approve)$/.test(path)) forbiddenWrites.push(path);
    return json ? route.fulfill({ json }) : route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return { confirmations, termsAsked, forbiddenWrites };
}

for (const width of [1440, 390]) {
  test(`issuer API listing without NAV opens its exact stock (${width}px)`, async ({ page }) => {
    const { tokens } = JSON.parse(readFileSync(new URL('../../../lib/rwa-official/test/fixtures/coinbase-stocks-api.json', import.meta.url), 'utf8'));
    const index = fixture('underlyings');
    index.entries = tokens.map((row: { isin: string; name: string; symbol: string; total_supply?: number }) => ({
      underlyingKey: `security:isin:${row.isin}`, canonicalName: row.name,
      displaySymbol: row.symbol.slice(0, -1), assetClass: 'equity',
      identifierScheme: 'isin', identifierValue: row.isin,
      representationCount: 1, liveRepresentationCount: (row.total_supply ?? 0) > 0 ? 1 : 0,
      issuerIds: ['coinbase'], coinbaseIssued: true, multiIssuer: false,
    }));
    index.totals = { underlyings: 58, boundRepresentations: 58, multiIssuerUnderlyings: 0, coinbaseUnderlyings: 58, allUnderlyings: 58 };
    const netflix = tokens.find((row: { symbol: string }) => row.symbol === 'NFLXc');
    const market = fixture('nvda-market');
    const asset = market.representations.find((row: { issuerId: string }) => row.issuerId === 'coinbase');
    const address = netflix.contract_address.toLowerCase();
    asset.tokenAddress = address;
    asset.issuerInstrumentKey = `coinbase:b20_address:${address}`;
    // An absent issuer NAV is an evidence gap, not a zero-dollar price.
    asset.reference = { ...market.representations[0].reference, reason: 'No reviewed reference feed is established for this exact address.' };
    market.question.underlyingKey = `security:isin:${netflix.isin}`;
    market.representations = [asset];
    market.universe = { reviewedRepresentationCount: 1, positiveSupplyRepresentationCount: 1, zeroSupplyRepresentationCount: 0, unresolvedSupplyRepresentationCount: 0 };
    market.marketOutcomeCoverage.eligibleRepresentationCount = 1;
    market.numericComparisonCoverage.eligibleRepresentationCount = 1;
    await page.setViewportSize({ width, height: 1000 });
    await stubApi(page, undefined, { index, market });
    await page.goto('/market');
    await page.getByPlaceholder('Search stocks, ticker or ISIN').fill('NFLX');
    const choice = page.getByRole('option', { name: /^NFLX / });
    await expect(choice).toBeVisible();
    await choice.click();
    await expect(choice).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(market.question.underlyingKey)));
    // The identifiers are evidence, folded under the card since 2026-10-03.
    await page.getByText('How we know this', { exact: false }).first().click();
    await expect(page.getByText(`ISIN ${netflix.isin}`, { exact: true }).first()).toBeVisible();
    await expect(page.getByText('No reviewed reference feed is established for this exact address.', { exact: false }).first()).toBeAttached();
    await page.reload();
    await expect(page.getByRole('option', { name: /^NFLX / })).toHaveAttribute('aria-selected', 'true');
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`selected stock survives navigation, reload and theme changes (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await stubApi(page);
    await page.goto(`/market?key=${encodeURIComponent(NVDA)}`);
    const nvda = page.getByRole('option', { name: /^NVDA / });
    const coin = page.getByRole('option', { name: /^COIN / });
    await expect(nvda).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => nvda.evaluate(e => getComputedStyle(e).boxShadow)).toContain('2px inset');
    await coin.click();
    await expect(coin).toHaveAttribute('aria-selected', 'true');
    await expect(nvda).toHaveAttribute('aria-selected', 'false');
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(COIN)));
    await expect.poll(() => coin.evaluate(e => getComputedStyle(e).boxShadow)).toContain('2px inset');
    await page.reload();
    await expect(coin).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Base', exact: true }).click();
    await expect.poll(() => coin.evaluate(e => getComputedStyle(e).boxShadow)).toContain('2px inset');
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect.poll(() => coin.evaluate(e => getComputedStyle(e).boxShadow)).toContain('2px inset');
  });

  test(`Use & access gives visible feedback and removes market-only controls (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await stubApi(page);
    await page.goto(`/market?key=${encodeURIComponent(COIN)}`);
    // The evidence is folded under the stock's card since 2026-10-03.
    await page.getByText('How we know this', { exact: false }).first().click();
    const utility = page.getByRole('tab', { name: 'Use & access', exact: true });
    await utility.click();
    await expect(utility).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tablist', { name: 'Direction', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tablist', { name: 'Size', exact: true })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Use & access' })).toBeInViewport();
    await page.getByRole('tab', { name: 'Market Reality', exact: true }).click();
    // Pressing a tab inside the evidence does not fold it shut.
    await expect(page.getByRole('tablist', { name: 'Direction', exact: true })).toBeVisible();
  });
}

test('SELL confirms exact token atoms without opening a wallet', async ({ page }) => {
  const { confirmations, termsAsked, forbiddenWrites } = await stubApi(page);
  await page.goto('/action/test-sell');
  const amount = page.getByLabel('Token amount to sell');
  const confirm = page.getByRole('button', { name: 'Confirm token amount', exact: true });
  await expect(confirm).toBeDisabled();
  await amount.fill('0.000434171');
  await expect(confirm).toBeDisabled();
  await amount.fill('1e-8');
  await expect(confirm).toBeDisabled();
  await amount.fill('0.00043418');
  await expect(confirm).toBeDisabled();
  await page.getByRole('button', { name: 'Use available balance' }).click();
  await expect(amount).toHaveValue('0.00043417');
  // Phase 17.9 — a valid amount is not yet a confirmable one. The board above
  // answers the draft's CASH question; until the routers are asked about THIS
  // amount, confirming would approve a picture of a different trade.
  await expect(confirm).toBeDisabled();
  await page.getByRole('button', { name: 'Check this amount', exact: true }).click();
  await expect.poll(() => termsAsked).toEqual([{ tokenAmountAtomic: '43417' }]);
  await expect(confirm).toBeEnabled();
  // Edit it again and the terms no longer describe what is in the box.
  await amount.fill('0.00043416');
  await expect(confirm).toBeDisabled();
  await page.getByRole('button', { name: 'Use available balance' }).click();
  await page.getByRole('button', { name: 'Check this amount', exact: true }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect.poll(() => confirmations).toEqual([{ tokenAmountAtomic: '43417' }]);
  await expect(page.getByText('Confirmed sell: 0.00043417 tokens (43417 base units).', { exact: true })).toBeVisible();
  expect(forbiddenWrites).toEqual([]);
});

test('one wallet attempt stays pending until the wallet resolves', async ({ page }) => {
  await stubApi(page);
  // Replace the wallet-owning host with a controllable wallet double. The
  // shared review hook, API client and review screen remain the real modules.
  const uiRoot = '/@fs' + new URL('../../../lib/ui/src/console/', import.meta.url).pathname;
  await page.route('**/StockActionReviewPage.tsx*', route => route.fulfill({
    contentType: 'application/javascript', body: `
      import React from '/node_modules/.vite/deps/react.js';
      import {useStockActionReviewConsoleV1} from '${uiRoot}stockActionReviewConsole.ts';
      import {StockActionReviewScreen} from '${uiRoot}StockActionReviewScreen.tsx';
      window.walletAttempts = 0;
      export function StockActionReviewPage() {
        const {model} = useStockActionReviewConsoleV1({draft:'test-sell',
          sendCalls: async () => { window.walletAttempts++; await new Promise(resolve => { window.finishWallet = resolve; }); return 'test-batch'; },
          recordSubmission: async () => {}});
        return React.createElement(StockActionReviewScreen, {model});
      }`,
  }));
  let releases = 0;
  await page.route('**/api/route-intelligence/rwa/stock-action/release', route => {
    releases++;
    return route.fulfill({ json: { action: { calls: [{ to: TOKEN, value: '0x0', data: '0x' }], atomicRequired: true } } });
  });
  await page.goto('/action/test-sell');
  await page.getByRole('button', { name: 'Use available balance' }).click();
  await page.getByRole('button', { name: 'Check this amount', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm token amount', exact: true }).click();
  await page.getByRole('button', { name: 'Open in your wallet', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { walletAttempts: number }).walletAttempts)).toBe(1);
  await expect(page.getByRole('button', { name: 'Waiting for your wallet…', exact: true })).toBeDisabled();
  expect(releases).toBe(1);
  await page.evaluate(() => (window as unknown as { finishWallet: () => void }).finishWallet());
  await expect(page.getByText('Submitted from your Base Account.', { exact: true })).toBeVisible();
});

for (const holding of [null, { state: 'unread' }, { state: 'read', decimals: 8, balanceAtomic: '0' }]) {
  test(`SELL refuses an unavailable amount: ${JSON.stringify(holding)}`, async ({ page }) => {
    const { confirmations } = await stubApi(page, holding);
    await page.goto('/action/test-sell');
    await expect(page.getByRole('button', { name: 'Confirm token amount', exact: true })).toBeDisabled();
    await page.getByLabel('Token amount to sell').fill('0.00000001');
    await expect(page.getByRole('button', { name: 'Confirm token amount', exact: true })).toBeDisabled();
    expect(confirmations).toEqual([]);
  });
}
