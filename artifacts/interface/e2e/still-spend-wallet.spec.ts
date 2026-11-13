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
// Where Bitrefill sends the purchase, as the server gives it with every payment it holds (audit SPEND-1).
const wire = (state: string, patch: Record<string, unknown> = {}) => ({ orderId: ORDER_ID, state, attemptId: state === 'ready' ? null : ATTEMPT, batchId: null,
  transactionHash: null, errorCode: null, updatedAt: NOW.toISOString(), facts, deliverTo: { email: 'buyer@example.com', phone: null },
  ...(state === 'ready' ? { calls: [CALL], callsHash: `0x${'1'.repeat(64)}`, signingTermsHash: `0x${'2'.repeat(64)}`, expiresAt: '2026-11-03T18:02:00.000Z', steps: [] } : {}), ...patch });

// paid: the wallet answers with a hash. batch / manual: with a batch id only that wallet knows, which
// it can (batch) or cannot (manual) say more about. lost: Still does not hear the answer the first time.
// switch: another account is picked in the wallet while the payment is being armed.
type Outcome = 'paid' | 'declined' | 'changed' | 'batch' | 'manual' | 'lost' | 'switch';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
async function install(page: Page, outcome: Outcome) {
  await page.clock.setFixedTime(NOW);
  await page.route('https://**/*', (route) => route.abort('blockedbyclient'));
  await page.route('**/AuthProvider.tsx*', (route) => route.fulfill({ contentType: 'application/javascript', body:
    'export function AuthProvider({children}) {return children;} export function useAuthGate(){return{showPrivateSurfaces:true,phase:"authenticated",sessionAuthenticated:true};}' }));
  const state = { order: [] as string[], server: 'ready', reviews: 0, submissions: [] as Array<Record<string, unknown>>, polls: 0,
    hash: null as string | null, batch: null as string | null, hints: [] as string[], loseNextSubmission: outcome === 'lost' };
  // As the server's wire: what the wallet answered rides on every reading after the arm.
  const held = (status: string, patch: Record<string, unknown> = {}) => wire(status, status === 'ready' ? patch : { transactionHash: state.hash, batchId: state.batch, ...patch });
  const base = `/api/still/spend/orders/${ORDER_ID}/wallet`;
  await page.route('**/api/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } } });
    if (path === base && request.method() === 'POST') {
      state.order.push('review'); state.reviews++;
      // A second reading names other terms: the one the person read is not the one that would be sent.
      if (outcome === 'changed' && state.reviews > 1) return route.fulfill({ json: wire('ready', { signingTermsHash: `0x${'3'.repeat(64)}` }) });
      return route.fulfill({ json: held(state.server) });
    }
    if (path === `${base}/arm` && request.method() === 'POST') {
      state.order.push('arm');
      expect(request.postDataJSON()).toEqual({ callsHash: `0x${'1'.repeat(64)}`, signingTermsHash: `0x${'2'.repeat(64)}` });
      state.server = 'awaiting_wallet';
      // The other account is picked while Still arms the payment; the answer comes after.
      if (outcome === 'switch') await page.evaluate((next) => (window as unknown as { switchWallet: (wallet: string) => void }).switchWallet(next), OTHER_WALLET);
      return route.fulfill({ json: { attemptId: ATTEMPT } });
    }
    if (path === `${base}/submission` && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.order.push(`submission:${String(body.outcome)}`); state.submissions.push(body);
      if (state.loseNextSubmission) { state.loseNextSubmission = false; return route.fulfill({ status: 502, json: { error: 'fixture_lost' } }); }
      state.server = body.outcome === 'rejected' ? 'ready' : 'submitted';
      state.hash ??= typeof body.transactionHash === 'string' ? body.transactionHash : null;
      state.batch ??= typeof body.batchId === 'string' ? body.batchId : null;
      return route.fulfill({ json: held(state.server) });
    }
    if (path === `${base}/transaction` && request.method() === 'POST') {
      const body = request.postDataJSON() as { transactionHash: string };
      state.order.push('hint'); state.hints.push(body.transactionHash);
      state.server = 'unknown'; state.hash = body.transactionHash;
      return route.fulfill({ json: held('unknown', { errorCode: 'spend_wallet_transaction_hint_unverified' }) });
    }
    if (path === base && request.method() === 'GET') {
      state.order.push('result'); state.polls++;
      // As the server: a hash it can read on Base, with its transfer, confirms the payment; a batch id
      // only the wallet knows tells it nothing.
      if ((state.server === 'submitted' || state.server === 'unknown') && state.hash === HASH) state.server = 'confirmed';
      const unmatched = state.server === 'unknown' && state.hash !== null && state.hash !== HASH;
      return route.fulfill({ json: held(state.server, unmatched ? { errorCode: 'spend_wallet_receipt_not_matched' } : {}) });
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
    : outcome === 'batch' || outcome === 'manual' ? "return {batchId:'mm-batch-1'};" : `return {transactionHash:'${HASH}'};`;
  const lookup = outcome === 'batch' ? `return ['${HASH.toUpperCase().replace('0X', '0x')}'];` : 'return null;';
  await page.route('**/StillSpendWalletPage.tsx*', (route) => route.fulfill({ contentType: 'application/javascript', body: `
    import React from '${reactPath}';
    import {useSpendWalletPaymentV1} from '${uiRoot}useSpendWalletPayment.ts';
    import {StillSpendWalletPay} from '${uiRoot}StillSpend.tsx';
    import {skyStateV1} from '${uiRoot}skyState.ts';
    window.spendWalletSends=[]; window.spendWalletLookups=[];
    export function StillSpendWalletPage(){
      const [wallet,setWallet]=React.useState('${WALLET}');
      window.switchWallet=setWallet;
      const model=useSpendWalletPaymentV1({orderId:location.pathname.split('/').pop(),sessionWalletAddress:'${WALLET}',walletAddress:wallet,pollMs:150,
        send:async call=>{ window.spendWalletSends.push(call); ${send} },
        lookup:async id=>{ window.spendWalletLookups.push(id); ${lookup} }});
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

// Re-audit R2, 2026-11-04: an account picked in the wallet while the payment was being armed was asked
// to send it as itself. Now that wallet is never asked, and the arm is let go for the next press.
test('an account picked in the wallet while the payment is armed is never asked to send it', async ({ page }) => {
  const state = await install(page, 'switch');
  await page.goto(`/spend/pay/${ORDER_ID}`);
  await page.getByRole('button', { name: 'Pay 2.00 USDC', exact: true }).click();
  await expect(page.getByText('Sign in and connect the wallet that opened this invoice to pay it.', { exact: true })).toBeVisible();
  await expect.poll(() => state.submissions).toEqual([{ attemptId: ATTEMPT, outcome: 'rejected' }]);
  expect(state.order.slice(0, 4)).toEqual(['review', 'review', 'arm', 'submission:rejected']);
  expect(await sends(page)).toEqual([]);
});

// Re-audit R5, 2026-11-04: a batch id only the wallet knows never resolved on the server, and a payment
// that had landed stayed on its way for good.
test('a batch only the wallet knows is asked of that wallet, and its hash settles the payment from Base', async ({ page }) => {
  const state = await install(page, 'batch');
  await page.goto(`/spend/pay/${ORDER_ID}`);
  await page.getByRole('button', { name: 'Pay 2.00 USDC', exact: true }).click();
  await expect(page.getByText('Paid: Base shows your transfer to Bitrefill’s invoice.', { exact: false })).toBeVisible();
  expect(state.submissions).toEqual([{ attemptId: ATTEMPT, outcome: 'submitted', batchId: 'mm-batch-1' }]);
  expect(await page.evaluate(() => (window as unknown as { spendWalletLookups: string[] }).spendWalletLookups)).toContain('mm-batch-1');
  expect(state.hints).toEqual([HASH]);
  expect(await sends(page)).toEqual([CALL]);
});

test('an answer Still did not hear is given again by the next reading, for the same attempt', async ({ page }) => {
  const state = await install(page, 'lost');
  await page.goto(`/spend/pay/${ORDER_ID}`);
  await page.getByRole('button', { name: 'Pay 2.00 USDC', exact: true }).click();
  await expect(page.getByText('Paid: Base shows your transfer to Bitrefill’s invoice.', { exact: false })).toBeVisible();
  expect(state.submissions).toEqual([
    { attemptId: ATTEMPT, outcome: 'submitted', transactionHash: HASH },
    { attemptId: ATTEMPT, outcome: 'submitted', transactionHash: HASH },
  ]);
  await expect(page.getByText(/could not record it just now/)).toHaveCount(0);
  expect(await sends(page)).toEqual([CALL]);
});

test('a hash pasted from the wallet’s activity is checked against this payment, and nothing is sent', async ({ page }) => {
  const state = await install(page, 'manual');
  await page.goto(`/spend/pay/${ORDER_ID}`);
  await page.getByRole('button', { name: 'Pay 2.00 USDC', exact: true }).click();
  await page.getByText('Your wallet sent it, and the result is not here?', { exact: true }).click();
  await page.getByLabel('Transaction hash').fill(`0x${'cd'.repeat(32)}`);
  await page.getByRole('button', { name: 'Find this transaction', exact: true }).click();
  await expect(page.getByText('Base has that transaction, and it is not this payment.', { exact: false })).toBeVisible();
  await page.getByLabel('Transaction hash').fill(HASH.toUpperCase().replace('0X', '0x'));
  await page.getByRole('button', { name: 'Find this transaction', exact: true }).click();
  await expect(page.getByText('Paid: Base shows your transfer to Bitrefill’s invoice.', { exact: false })).toBeVisible();
  expect(state.hints).toEqual([`0x${'cd'.repeat(32)}`, HASH]);
  expect(await sends(page)).toEqual([CALL]);
});
