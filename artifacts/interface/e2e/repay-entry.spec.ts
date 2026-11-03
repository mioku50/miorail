import { expect, test, type Page } from '@playwright/test';
import { STOCKS, CRYPTO } from '../../../lib/still-engine/src/registry.js';
import { stillTerms } from '../../../lib/still-engine/src/terms.js';
import { calendar } from '../../../lib/still-engine/test/fixtures.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const NOW = new Date('2026-10-29T03:45:00Z');
const CBBTC = CRYPTO[0]!.token.toLowerCase();
async function install(page: Page, signedIn = true) {
  await page.clock.setFixedTime(NOW);
  await page.route('https://**/*', route => route.abort('blockedbyclient'));
  await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript', body:
    `export function AuthProvider({children}) {return children;} export function useAuthGate(){return{showPrivateSurfaces:${signedIn},phase:'${signedIn ? 'authenticated' : 'anonymous'}',sessionAuthenticated:${signedIn}};}` }));
  const state = { reads: [] as string[], intents: [] as Record<string, unknown>[], wrongToken: false, zeroDebt: false, noDeposit: false };
  await page.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: signedIn ? { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } : null } });
    if (path === '/api/public/still/terms') return route.fulfill({ json: JSON.parse(JSON.stringify(stillTerms(calendar(), NOW))) });
    if (path.endsWith('/rwa/repay/capacity') && request.method() === 'GET') {
      const token = url.searchParams.get('token')!; state.reads.push(token);
      const stock = STOCKS.find(s => s.token.toLowerCase() === token);
      return route.fulfill({ json: { state: 'read', read: { venue: stock ? 'aave-v4' : 'morpho', marketId: stock ? '0x17905db0e4a3514467539956c084180616ae7b8d' : CRYPTO[0]!.morphoMarket,
        collateralTokenAddress: state.wrongToken ? WALLET : token, collateralSymbol: stock?.id ?? 'cbBTC', collateralDecimals: 8,
        debtAtomic: state.zeroDebt ? '0' : '3125001', walletUsdcAtomic: '4500000', blockNumber: 53_200_000, collateralAtomic: state.noDeposit ? '0' : '3014121' } } });
    }
    if (path.endsWith('/rwa/repay/intent') && request.method() === 'POST') {
      state.intents.push(request.postDataJSON());
      return route.fulfill({ json: { draftId: 'fixture', reviewUrl: '/lending/miorail-lending-v1.fixture.signature', expiresAt: new Date(NOW.getTime() + 300_000).toISOString() } });
    }
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  return state;
}
for (const width of [390, 1366]) {
  test(`repayment explicitly reads and sends an exact USDC question (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); const state = await install(page);
    await page.goto('/repay?asset=cbBTC');
    const read = page.getByRole('button', { name: 'Read repayment position', exact: true }); await expect(read).toBeVisible();
    expect(state.reads).toEqual([]); expect(state.intents).toEqual([]);
    await read.click(); await expect(page.getByText('3.125001 USDC', { exact: true })).toBeVisible();
    await page.getByLabel('USDC to repay', { exact: true }).fill('3.000001');
    await page.getByRole('button', { name: 'Review repayment', exact: true }).click();
    await expect(page).toHaveURL(/\/lending\/miorail-lending-v1\.fixture\.signature$/);
    expect(state.reads).toEqual([CBBTC]);
    expect(state.intents).toEqual([{ collateralTokenAddress: CBBTC, amountMode: 'assets', repayAmountAtomic: '3000001', maximumUsdcAtomic: '3000001' }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
test('full repayment requires the person to type a maximum and keeps stock market identity', async ({ page }) => {
  const state = await install(page); await page.goto('/repay?asset=NVDAc');
  await page.getByRole('button', { name: 'Read repayment position', exact: true }).click();
  await expect(page.getByText('3.125001 USDC', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Repay all debt', exact: true }).click();
  const max = page.getByLabel('Maximum USDC funding', { exact: true }); await expect(max).toHaveValue('');
  const review = page.getByRole('button', { name: 'Review repayment', exact: true }); await expect(review).toBeDisabled();
  await max.fill('4'); await review.click(); await expect.poll(() => state.intents.length).toBe(1);
  expect(state.intents[0]).toEqual({ collateralTokenAddress: STOCKS.find(s => s.id === 'NVDAc')!.token.toLowerCase(), amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '4000000' });
});
test('Max fills from the position just read: the smaller of debt and wallet USDC, or the wallet as the bound', async ({ page }) => {
  const state = await install(page); await page.goto('/repay?asset=cbBTC');
  await page.getByRole('button', { name: 'Read repayment position', exact: true }).click();
  await expect(page.getByText('3.125001 USDC', { exact: true })).toBeVisible();
  const amount = page.getByLabel('USDC to repay', { exact: true }); await expect(amount).toHaveValue('');
  await page.getByRole('button', { name: 'Max', exact: true }).click();
  await expect(amount).toHaveValue('3.125001');
  await page.getByRole('button', { name: 'Repay all debt', exact: true }).click();
  const bound = page.getByLabel('Maximum USDC funding', { exact: true }); await expect(bound).toHaveValue('');
  await page.getByRole('button', { name: 'Max', exact: true }).click();
  await expect(bound).toHaveValue('4.5');
  // Pressing Max read nothing more and prepared nothing.
  expect(state.reads).toEqual([CBBTC]); expect(state.intents).toEqual([]);
});
test('a stock loan is repaid in full and its stock taken back in one review; with no debt left, the stock alone', async ({ page }) => {
  const state = await install(page), nvda = STOCKS.find(s => s.id === 'NVDAc')!.token.toLowerCase();
  await page.goto('/repay?asset=NVDAc');
  await page.getByRole('button', { name: 'Read repayment position', exact: true }).click();
  await expect(page.getByText('0.03014121 NVDAc', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Repay all, take back NVDAc', exact: true }).click();
  await page.getByLabel('Maximum USDC funding', { exact: true }).fill('4');
  await expect(page.getByText(/Then your 0\.03014121 NVDAc comes back to this wallet in the same review/)).toBeVisible();
  await page.getByRole('button', { name: 'Review repayment', exact: true }).click(); await expect.poll(() => state.intents.length).toBe(1);
  expect(state.intents[0]).toEqual({ collateralTokenAddress: nvda, amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '4000000', returnCollateral: true });
  state.zeroDebt = true; await page.goto('/repay?asset=NVDAc');
  await page.getByRole('button', { name: 'Read repayment position', exact: true }).click();
  await expect(page.getByText(/No debt is open in this market/)).toBeVisible();
  await expect(page.getByLabel('Maximum USDC funding', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Take back NVDAc', exact: true }).click(); await expect.poll(() => state.intents.length).toBe(2);
  expect(state.intents[1]).toEqual({ collateralTokenAddress: nvda, amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '0', returnCollateral: true });
  // A Morpho loan's collateral comes back the same way.
  await page.goto('/repay?asset=cbBTC'); await page.getByRole('button', { name: 'Read repayment position', exact: true }).click();
  await expect(page.getByText(/is still deposited in Morpho/)).toBeVisible();
  await page.getByRole('button', { name: 'Take back cbBTC', exact: true }).click(); await expect.poll(() => state.intents.length).toBe(3);
  expect(state.intents[2]).toEqual({ collateralTokenAddress: CBBTC, amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '0', returnCollateral: true });
});
test('wrong token reading never turns into a usable balance or repayment question', async ({ page }) => {
  const state = await install(page); state.wrongToken = true; await page.goto('/repay?asset=cbBTC');
  await page.getByRole('button', { name: 'Read repayment position', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be read');
  await expect(page.getByText('3.125001 USDC', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('USDC to repay', { exact: true })).toBeDisabled(); expect(state.intents).toEqual([]);
});
test('only a measured zero debt gets the no-debt sentence', async ({ page }) => {
  const state = await install(page); state.zeroDebt = true; state.noDeposit = true; await page.goto('/repay?asset=cbBTC');
  await expect(page.getByText(/No debt was recorded/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Read repayment position', exact: true }).click();
  await expect(page.getByText('No debt was recorded in this market at the reading block.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review repayment', exact: true })).toHaveCount(0); expect(state.intents).toEqual([]);
});
test('signed-out repayment does not read private debt or offer an amount field', async ({ page }) => {
  const state = await install(page, false); await page.goto('/repay?asset=cbBTC');
  await expect(page.getByRole('link', { name: 'Sign in', exact: true }).last()).toBeVisible();
  await expect(page.getByLabel('USDC to repay', { exact: true })).toHaveCount(0);
  expect(state.reads).toEqual([]); expect(state.intents).toEqual([]);
});
