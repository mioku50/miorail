import { expect, test, type Page } from '@playwright/test';

// Still Spend paid from the wallet's own USDC, on its page: the real hook and
// screen, a server answering as the real one does, and a wallet stub that
// records what it is asked. Nothing here is a real payment.

const NOW = new Date('2026-11-03T18:00:00Z');
const WALLET = '0x1111111111111111111111111111111111111111';
const ORDER_ID = '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34';
const ATTEMPT = '0d3c6a52-6f8e-4f0a-9d3e-2b1f8c7a6e5d';
const HASH = `0x${'ab'.repeat(32)}`;
const CALL = { to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', value: '0', data: `0xa9059cbb${'0'.repeat(24)}${'33'.repeat(20)}${'0'.repeat(58)}1e8480` };
const payment = { merchant: 'bitrefill', orderId: ORDER_ID, payTo: '0x3333333333333333333333333333333333333333', assets: '2000000',
  productName: 'PUBG Mobile', packageValue: '60 UC', faceCurrency: null, expiresAt: '2026-11-03T18:15:00.000Z' };
const facts = { payment, usdcBeforeAtomic: '2120000', usdcAfterAtomic: '120000', blockNumber: 53_470_000,
  warnings: ['Your wallet sends 2 USDC of its own to Bitrefill’s invoice address 0x3333…3333 for PUBG Mobile · 60 UC. No loan is taken.'] };
const wire = (state: string, patch: Record<string, unknown> = {}) => ({ orderId: ORDER_ID, state, attemptId: state === 'ready' ? null : ATTEMPT, batchId: null,
  transactionHash: null, errorCode: null, updatedAt: NOW.toISOString(), facts,
  ...(state === 'ready' ? { calls: [CALL], callsHash: `0x${'1'.repeat(64)}`, signingTermsHash: `0x${'2'.repeat(64)}`, expiresAt: '2026-11-03T18:02:00.000Z', steps: [] } : {}), ...patch });

type Outcome = 'paid' | 'declined' | 'changed';
async function install(page: Page, outcome: Outcome) {
  await page.clock.setFixedTime(NOW);
  await page.route('https://**/*', (route) => route.abort('blockedbyclient'));
  await page.route('**/AuthProvider.tsx*', (route) => route.fulfill({ contentType: 'application/javascript', body:
    'export function AuthProvider({children}) {return children;} export function useAuthGate(){return{showPrivateSurfaces:true,phase:"authenticated",sessionAuthenticated:true};}' }));
  const state = { order: [] as string[], server: 'ready', reviews: 0, submissions: [] as Array<Record<string, unknown>>, polls: 0 };
  const base = `/api/still/spend/orders/${ORDER_ID}/wallet`;
  await page.route('**/api/**', (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } } });
    if (path === base && request.method() === 'POST') {
      state.order.push('review'); state.reviews++;
      // A second reading names other terms: the one the person read is not the one that would be sent.
      if (outcome === 'changed' && state.reviews > 1) return route.fulfill({ json: wire('ready', { signingTermsHash: `0x${'3'.repeat(64)}` }) });
      return route.fulfill({ json: wire(state.server, state.server === 'ready' ? {} : { transactionHash: HASH }) });
    }
    if (path === `${base}/arm` && request.method() === 'POST') {
      state.order.push('arm');
      expect(request.postDataJSON()).toEqual({ callsHash: `0x${'1'.repeat(64)}`, signingTermsHash: `0x${'2'.repeat(64)}` });
      state.server = 'awaiting_wallet';
      return route.fulfill({ json: { attemptId: ATTEMPT } });
    }
    if (path === `${base}/submission` && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.order.push(`submission:${String(body.outcome)}`); state.submissions.push(body);
      state.server = body.outcome === 'rejected' ? 'ready' : 'submitted';
      return route.fulfill({ json: wire(state.server, state.server === 'ready' ? {} : { transactionHash: HASH }) });
    }
    if (path === base && request.method() === 'GET') {
      state.order.push('result'); state.polls++;
      // As the server: once Base has the receipt and its transfer, the payment is confirmed.
      if (state.server === 'submitted') state.server = 'confirmed';
      return route.fulfill({ json: wire(state.server, state.server === 'ready' ? {} : { transactionHash: HASH }) });
    }
    if (path === `/api/still/spend/orders/${ORDER_ID}`) {
      return route.fulfill({ json: { order: { orderId: ORDER_ID, productId: 'pubg-mobile', productName: 'PUBG Mobile', packageValue: '60 UC', faceCurrency: null, priceAtomic: '2000000',
        payTo: payment.payTo, refillTo: null, createdAt: NOW.toISOString(), expiresAt: payment.expiresAt, paymentLink: null },
        status: { status: 'payment_confirmed', accessLink: null, esimInstallLink: null }, statusError: null } });
    }
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  const uiRoot = '/@fs' + new URL('../../../lib/ui/src/still/', import.meta.url).pathname;
  const source = await (await page.request.get(`${uiRoot}useSpendWalletPayment.ts`)).text();
  const reactPath = source.match(/from ["']([^"']*\/react\.js\?v=[^"']+)["']/)?.[1];
  expect(reactPath).toBeTruthy();
  const send = outcome === 'declined'
    ? "throw Object.assign(new Error('declined'),{code:4001});"
    : `return {transactionHash:'${HASH}'};`;
  await page.route('**/StillSpendWalletPage.tsx*', (route) => route.fulfill({ contentType: 'application/javascript', body: `
    import React from '${reactPath}';
    import {useSpendWalletPaymentV1} from '${uiRoot}useSpendWalletPayment.ts';
    import {StillSpendWalletPay} from '${uiRoot}StillSpend.tsx';
    import {skyStateV1} from '${uiRoot}skyState.ts';
    window.spendWalletSends=[];
    export function StillSpendWalletPage(){
      const model=useSpendWalletPaymentV1({orderId:location.pathname.split('/').pop(),sessionWalletAddress:'${WALLET}',walletAddress:'${WALLET}',pollMs:150,
        send:async call=>{ window.spendWalletSends.push(call); ${send} }});
      return React.createElement('main',{className:'still'},React.createElement(StillSpendWalletPay,{sky:skyStateV1({now:new Date('${NOW.toISOString()}')}),model,order:null,orderReading:false}));
    }
  ` }));
  return state;
}
const sends = (page: Page) => page.evaluate(() => (window as unknown as { spendWalletSends: unknown[] }).spendWalletSends);

for (const width of [390, 1366]) {
  test(`pays an invoice from the wallet's USDC: a fresh review, one arm, the one transfer as prepared, then the result from Base (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page, 'paid');
    await page.goto(`/spend/pay/${ORDER_ID}`);
    await expect(page.getByRole('heading', { name: '2.00 USDC for PUBG Mobile · 60 UC' })).toBeVisible();
    await expect(page.locator('.still-spend-wallet')).toContainText('In your wallet2.12 USDC');
    await expect(page.locator('.still-spend-wallet')).toContainText('After paying0.12 USDC');
    await expect(page.getByText('No loan is taken.', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Pay 2.00 USDC', exact: true }).click();
    await expect(page.getByText('Paid: Base shows your transfer to Bitrefill’s invoice.', { exact: false })).toBeVisible();
    expect(await sends(page)).toEqual([CALL]);
    expect(state.order.slice(0, 4)).toEqual(['review', 'review', 'arm', 'submission:submitted']);
    expect(state.submissions).toEqual([{ attemptId: ATTEMPT, outcome: 'submitted', transactionHash: HASH }]);
    await expect(page.getByRole('button', { name: /^Pay / })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('a payment declined in the wallet sends nothing, says so, and can be paid again', async ({ page }) => {
  const state = await install(page, 'declined');
  await page.goto(`/spend/pay/${ORDER_ID}`);
  await page.getByRole('button', { name: 'Pay 2.00 USDC', exact: true }).click();
  await expect(page.getByText('You declined in your wallet. Nothing was sent.', { exact: true })).toBeVisible();
  expect(state.order.slice(0, 4)).toEqual(['review', 'review', 'arm', 'submission:rejected']);
  expect(await sends(page)).toEqual([CALL]);
  await expect(page.getByRole('button', { name: 'Pay 2.00 USDC', exact: true })).toBeEnabled();
});

test('a payment whose terms changed since it was read is not sent', async ({ page }) => {
  const state = await install(page, 'changed');
  await page.goto(`/spend/pay/${ORDER_ID}`);
  await page.getByRole('button', { name: 'Pay 2.00 USDC', exact: true }).click();
  await expect(page.getByText('The payment changed since you read it.', { exact: false })).toBeVisible();
  expect(state.order).not.toContain('arm');
  expect(await sends(page)).toEqual([]);
});
