import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BitrefillGuestCheckoutV1, SpendProductV1 } from '@mioagent/commerce-engine';
import { ADDRESSES, CRYPTO, STOCKS } from '@mioagent/still-engine/registry';

import { verifyLendingDraftV1 } from '../../lib/lendingDraft.js';
import { STILL_PUBLIC_ORIGIN_V1 } from '../../lib/stillOrigin.js';
import { createSpendOrderStoreV1, type SpendOrderStoreV1 } from '../../lib/stillSpendOrders.js';
import { rwaLendingRuntimeV1 } from '../rwaLending.js';
import { stillMineRuntimeV1 } from '../stillMine.js';
import { stillSpendRuntimeV1 } from '../stillSpend.js';
import { createMiorailPrivateMcpServerV1 } from './server.js';
import { STILL_LOAN_COLLATERAL_V1, STILL_TOKEN_COLLATERAL_V1, StillLoanRefusalV1, stillPrepareLoanReviewV1, stillPreparePurchaseV1, stillPrepareRepayReviewV1, stillPrepareWalletPurchaseV1 } from './stillLoanTool.js';

const WALLET = `0x${'1'.repeat(40)}` as const;
const IDENTITY = { tenantId: `eip155:8453:${WALLET}` as const, walletAddress: WALLET };
const SECRET = 'a-test-secret-long-enough';
const NOW = new Date('2026-11-02T15:00:00.000Z');
const NVDAC = STOCKS.find((stock) => stock.id === 'NVDAc')!.token.toLowerCase();

function draftOf(url: string) {
  const draft = url.replace(`${STILL_PUBLIC_ORIGIN_V1}/lending/`, '');
  const verified = verifyLendingDraftV1({ draft, ...IDENTITY, secret: SECRET, now: NOW });
  assert.ok(verified.ok, 'the link carries a draft this server signed for this wallet');
  return verified.claims;
}

test('a stock loan is the same wallet-bound Aave V4 question Get money issues', () => {
  const review = stillPrepareLoanReviewV1(IDENTITY, { collateral: 'NVDAc', addCollateral: '0.05', borrowUsdc: '500' }, { secret: SECRET, now: NOW });
  assert.ok(review.reviewUrl.startsWith(`${STILL_PUBLIC_ORIGIN_V1}/lending/miorail-lending-v1.`), review.reviewUrl);
  assert.equal(review.venue, 'aave-v4');
  assert.equal(review.expiresAt, '2026-11-02T15:05:00.000Z');
  const claims = draftOf(review.reviewUrl);
  assert.equal(review.reviewId, claims.draftId, 'the status tool follows the link by the id it carries');
  assert.equal(claims.venue, 'aave-v4');
  assert.deepEqual(claims.question, { operation: 'borrow', collateralTokenAddress: NVDAC, borrowAssets: '500000000', collateralSupplyAssets: '5000000' });
  assert.match(review.next, /Nothing has been sent/);
});

test('already-pledged collateral, cbBTC, and native ETH wrapped with the loan', () => {
  const pledged = stillPrepareLoanReviewV1(IDENTITY, { collateral: 'WETH', addCollateral: '0', borrowUsdc: '25.5' }, { secret: SECRET, now: NOW });
  assert.deepEqual(draftOf(pledged.reviewUrl).question, {
    operation: 'borrow', collateralTokenAddress: ADDRESSES.weth.toLowerCase(), borrowAssets: '25500000', collateralSupplyAssets: '0',
  });
  const btc = stillPrepareLoanReviewV1(IDENTITY, { collateral: 'cbBTC', addCollateral: '0.001', borrowUsdc: '40' }, { secret: SECRET, now: NOW });
  assert.equal(btc.venue, 'morpho');
  assert.equal(draftOf(btc.reviewUrl).question.operation, 'borrow');
  const native = stillPrepareLoanReviewV1(IDENTITY, { collateral: 'ETH', addCollateral: '0.01', borrowUsdc: '10' }, { secret: SECRET, now: NOW });
  assert.match(native.reviewUrl, /\/lending\/miorail-lending-v2\./);
  assert.deepEqual(draftOf(native.reviewUrl).question, {
    operation: 'borrow', collateralTokenAddress: ADDRESSES.weth.toLowerCase(), borrowAssets: '10000000',
    collateralSupplyAssets: '10000000000000000', nativeFundingAssets: '10000000000000000',
  });
});

test('an amount that cannot be exact, native ETH with nothing to wrap, and a server without its secret are refused', () => {
  const refused = (run: () => unknown, code: string, words: RegExp) =>
    assert.throws(run, (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === code && words.test(error.message));
  refused(() => stillPrepareLoanReviewV1(IDENTITY, { collateral: 'NVDAc', addCollateral: '0.000000001', borrowUsdc: '5' }, { secret: SECRET, now: NOW }),
    'still_loan_amount_invalid', /NVDAc has 8 decimals/);
  refused(() => stillPrepareLoanReviewV1(IDENTITY, { collateral: 'NVDAc', addCollateral: '1', borrowUsdc: '0' }, { secret: SECRET, now: NOW }),
    'still_loan_amount_invalid', /above zero with at most six decimals/);
  refused(() => stillPrepareLoanReviewV1(IDENTITY, { collateral: 'ETH', addCollateral: '0', borrowUsdc: '5' }, { secret: SECRET, now: NOW }),
    'still_loan_amount_invalid', /choose WETH/);
  refused(() => stillPrepareLoanReviewV1(IDENTITY, { collateral: 'NVDAc', addCollateral: '1', borrowUsdc: '5' }, { secret: 'short', now: NOW }),
    'still_loan_unavailable', /cannot prepare a review/);
});

test('the connected surface lists it as a write that returns a link, bound to the grant’s wallet', async (t) => {
  const original = { ...rwaLendingRuntimeV1 };
  rwaLendingRuntimeV1.secret = () => SECRET;
  rwaLendingRuntimeV1.now = () => NOW;
  t.after(() => Object.assign(rwaLendingRuntimeV1, original));
  const client = new Client({ name: 'still-loan-test', version: '1' });
  const server = createMiorailPrivateMcpServerV1({ ...IDENTITY, chainId: 8453, tokenId: 'test-grant', source: 'oauth' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  t.after(() => client.close());
  const tool = (await client.listTools()).tools.find((entry) => entry.name === 'miorail_prepare_still_loan')!;
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ['addCollateral', 'borrowUsdc', 'collateral']);
  assert.equal(tool.annotations?.readOnlyHint, false);
  const result = await client.callTool({ name: 'miorail_prepare_still_loan', arguments: { collateral: 'NVDAc', addCollateral: '0', borrowUsdc: '100' } });
  const answer = (result as unknown as { structuredContent: { reviewUrl: string } }).structuredContent;
  assert.equal(draftOf(answer.reviewUrl).walletAddress, WALLET);
  const odd = await client.callTool({ name: 'miorail_prepare_still_loan', arguments: { collateral: 'NVDAc', addCollateral: '0', borrowUsdc: '0' } });
  assert.equal((odd as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(odd), /still_loan_amount_invalid/);
});

// Still Spend from an assistant. Every Bitrefill answer, address and email here is synthetic.
const PAY_TO = '0x3333333333333333333333333333333333333333';
const INVOICE = '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34';
const EMAIL = 'someone@example.com';
const ESIM: SpendProductV1 = { id: 'bitrefill-esim-japan', name: 'Bitrefill eSIM Japan', country: 'JP', inStock: true, recipientType: 'mixed', url: null,
  packages: [{ value: '5GB, 30 Days', faceCurrency: 'USD', priceUsdc: '9.80' }, { value: 'Unlimited, 30 Days', faceCurrency: 'USD', priceUsdc: '120.00' }] };
const TOP_UP: SpendProductV1 = { id: 'airtel-india', name: 'Airtel India', country: 'IN', inStock: true, recipientType: 'phone_number', url: null,
  packages: [{ value: '10', faceCurrency: 'INR', priceUsdc: '0.11' }] };

function spend(t: test.TestContext, input: { enabled?: boolean } = {}) {
  const original = { ...stillSpendRuntimeV1 };
  const orders: SpendOrderStoreV1 = createSpendOrderStoreV1({ now: () => NOW });
  const opened: Array<Parameters<BitrefillGuestCheckoutV1['createInvoice']>[0]> = [];
  Object.assign(stillSpendRuntimeV1, {
    orders, enabled: () => input.enabled ?? true, now: () => NOW,
    catalog: () => ({ search: async () => ({ ok: true, value: [] }), product: async (id: string) => ({ ok: true, value: id === TOP_UP.id ? TOP_UP : ESIM }) }),
    checkout: (): BitrefillGuestCheckoutV1 => ({
      async createInvoice(request) {
        opened.push(request);
        return { ok: true, value: { invoiceId: INVOICE, accessToken: 'access-token-0123456789', payTo: PAY_TO, amountAtomic: request.quotedAtomic,
          expiresAt: new Date(request.now.getTime() + 15 * 60_000).toISOString(), paymentLink: `https://www.bitrefill.com/invoice/${INVOICE}?token=t` } };
      },
      async readInvoice() { return { ok: true, value: { status: 'unpaid', accessLink: null, esimInstallLink: null } }; },
    }),
  });
  t.after(() => Object.assign(stillSpendRuntimeV1, original));
  return { orders, opened };
}

test('a purchase opens the invoice as Spend does, and the link is the review of the loan that pays exactly its price', async (t) => {
  const { orders, opened } = spend(t);
  const prepared = await stillPreparePurchaseV1(IDENTITY,
    { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'NVDAc', addCollateral: '0' }, { secret: SECRET, now: NOW });
  assert.ok(prepared.reviewUrl.startsWith(`${STILL_PUBLIC_ORIGIN_V1}/lending/miorail-lending-v3.`), prepared.reviewUrl);
  assert.equal(prepared.borrowUsdc, '9.8');
  assert.deepEqual(prepared.purchase, { productId: ESIM.id, productName: ESIM.name, packageValue: '5GB, 30 Days', faceCurrency: 'USD',
    priceUsdc: '9.8', invoiceExpiresAt: '2026-11-02T15:15:00.000Z' });
  const claims = draftOf(prepared.reviewUrl);
  assert.equal(prepared.reviewId, claims.draftId);
  assert.deepEqual(claims.question, { operation: 'borrow', collateralTokenAddress: NVDAC, borrowAssets: '9800000', collateralSupplyAssets: '0',
    payment: { merchant: 'bitrefill', orderId: INVOICE, payTo: PAY_TO, assets: '9800000', productName: ESIM.name, packageValue: '5GB, 30 Days',
      faceCurrency: 'USD', expiresAt: '2026-11-02T15:15:00.000Z' } });
  // The order the review will read is this wallet's, and the email went to Bitrefill only.
  assert.equal(orders.get(IDENTITY, INVOICE)?.priceAtomic, '9800000');
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.email, EMAIL);
  const said = JSON.stringify(prepared);
  for (const secret of [EMAIL, 'access-token', 'bitrefill.com/invoice']) assert.ok(!said.includes(secret), `the answer repeats ${secret}`);
  // Audit MCP-3 (2026-11-10): the assistant named the email, so the person is sent to check it on the page itself.
  assert.match(prepared.next, /^The page this link opens shows the user where Bitrefill will send the purchase: tell them to check there, before they sign, that the email \(and for a top-up the number\) is their own/);
  assert.match(prepared.next, /Nothing has been borrowed or paid/);
  assert.match(prepared.next, /Rabby/);

  const weth = await stillPreparePurchaseV1(IDENTITY,
    { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'WETH', addCollateral: '0.01' }, { secret: SECRET, now: NOW });
  assert.equal(weth.venue, 'morpho');
  assert.equal(draftOf(weth.reviewUrl).question.collateralTokenAddress, CRYPTO.find((row) => row.id === 'ETH')!.token.toLowerCase());
});

test('a top-up sends only a number of its own country, and what cannot be bought opens nothing', async (t) => {
  const { opened } = spend(t);
  const refused = async (args: Partial<Parameters<typeof stillPreparePurchaseV1>[1]>, code: string, deps = { secret: SECRET, now: NOW }) =>
    assert.rejects(stillPreparePurchaseV1(IDENTITY, { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'NVDAc', addCollateral: '0', ...args }, deps),
      (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === code && !error.message.includes(EMAIL));
  await refused({ packageValue: 'Unlimited, 30 Days' }, 'spend_over_cap');
  await refused({ packageValue: '1GB, 7 Days' }, 'spend_package_not_offered');
  await refused({ phone: '+81 90 1234 5678' }, 'spend_request_invalid');
  await refused({ productId: TOP_UP.id, packageValue: '10' }, 'spend_phone_needed');
  await refused({ productId: TOP_UP.id, packageValue: '10', phone: '+49 151 2345 6789' }, 'spend_phone_invalid');
  await refused({ addCollateral: '0.000000001' }, 'still_loan_amount_invalid');
  await refused({}, 'still_loan_unavailable', { secret: 'short', now: NOW });
  assert.equal(opened.length, 0, 'no invoice exists for a purchase that was refused');

  const topUp = await stillPreparePurchaseV1(IDENTITY,
    { productId: TOP_UP.id, packageValue: '10', email: EMAIL, phone: '+91 98765 43210', collateral: 'AAPLc', addCollateral: '0' }, { secret: SECRET, now: NOW });
  assert.equal(opened[0]!.refillInput, '919876543210');
  assert.ok(!JSON.stringify(topUp).includes('9876543210'), 'the number is not repeated back');
});

test('a purchase Bitrefill refuses says Bitrefill’s own words, and nothing was paid', async (t) => {
  spend(t);
  const refusing = stillSpendRuntimeV1.checkout;
  stillSpendRuntimeV1.checkout = () => ({ ...refusing(), createInvoice: async () => ({ ok: false as const, reason: 'bitrefill_refused' as const, detail: 'Minimum order is 1 USD' }) });
  await assert.rejects(stillPreparePurchaseV1(IDENTITY,
    { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'NVDAc', addCollateral: '0' }, { secret: SECRET, now: NOW }),
  (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === 'bitrefill_refused'
    && error.message === 'Bitrefill refused to open the invoice and said: “Minimum order is 1 USD” Nothing was paid.');
});

test('six opened invoices an hour is Still’s own limit and says so, and refusals before it are not counted', async (t) => {
  const { opened } = spend(t);
  const purchase = (packageValue = '5GB, 30 Days') => stillPreparePurchaseV1(IDENTITY,
    { productId: ESIM.id, packageValue, email: EMAIL, collateral: 'NVDAc', addCollateral: '0' }, { secret: SECRET, now: NOW });
  await assert.rejects(purchase('Unlimited, 30 Days'), (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === 'spend_over_cap');
  for (let n = 0; n < 6; n += 1) await purchase();
  await assert.rejects(purchase(), (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === 'spend_rate_limited'
    && /Still opens at most six Bitrefill invoices an hour for one wallet, and this wallet has opened six\. This is Still’s own limit, not Bitrefill’s/.test(error.message));
  assert.equal(opened.length, 6, 'the seventh never reached Bitrefill');
});

test('a catalogue Bitrefill could not serve is named as that, not as a refusal', async (t) => {
  const { opened } = spend(t);
  for (const [reason, said] of [['bitrefill_unreachable', /^Still could not reach Bitrefill just now/], ['bitrefill_rate_limited', /^Bitrefill asked Still to slow down/],
    ['bitrefill_invalid_response', /^Bitrefill answered in a way Still could not read/]] as const) {
    stillSpendRuntimeV1.catalog = () => ({ search: async () => ({ ok: true, value: [] }), product: async () => ({ ok: false, reason }) }) as unknown as ReturnType<typeof stillSpendRuntimeV1.catalog>;
    await assert.rejects(stillPreparePurchaseV1(IDENTITY,
      { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'NVDAc', addCollateral: '0' }, { secret: SECRET, now: NOW }),
    (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === reason && said.test(error.message) && !/refused/.test(error.message));
  }
  assert.equal(opened.length, 0);
});

test('a product sold only after Bitrefill’s prepayment steps is refused before Bitrefill is asked for an invoice', async (t) => {
  const { opened } = spend(t);
  stillSpendRuntimeV1.catalog = () => ({ search: async () => ({ ok: true, value: [] }),
    product: async () => ({ ok: true, value: { ...ESIM, recipientType: 'none', prepayment: true } }) }) as unknown as ReturnType<typeof stillSpendRuntimeV1.catalog>;
  await assert.rejects(stillPreparePurchaseV1(IDENTITY,
    { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'NVDAc', addCollateral: '0' }, { secret: SECRET, now: NOW }),
  (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === 'spend_product_prepayment' && /such as a game’s player ID/.test(error.message));
  assert.equal(opened.length, 0);
});

test('Bitrefill not letting Still in is said to be about every product, in Bitrefill’s own words', async (t) => {
  const { opened } = spend(t);
  stillSpendRuntimeV1.catalog = () => ({ search: async () => ({ ok: true, value: [] }),
    product: async () => ({ ok: false, reason: 'bitrefill_guest_refused', detail: 'invalid_client: client_id metadata document URL is not trusted by this authorization server' }) }) as unknown as ReturnType<typeof stillSpendRuntimeV1.catalog>;
  await assert.rejects(stillPreparePurchaseV1(IDENTITY,
    { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'NVDAc', addCollateral: '0' }, { secret: SECRET, now: NOW }),
  (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === 'bitrefill_guest_refused'
    && error.message === 'Bitrefill is not letting Still in right now, and said: “invalid_client: client_id metadata document URL is not trusted by this authorization server”. '
      + 'Until that changes Still cannot open an invoice for any product: it is not about this one, and trying again will not help. Nothing was opened or paid.');
  assert.equal(opened.length, 0);
});

test('with paying switched off the purchase is refused before Bitrefill is asked', async (t) => {
  const { opened } = spend(t, { enabled: false });
  await assert.rejects(stillPreparePurchaseV1(IDENTITY,
    { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'NVDAc', addCollateral: '0' }, { secret: SECRET, now: NOW }),
  (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === 'spend_pay_off');
  assert.equal(opened.length, 0);
});

// 2026-11-04: an assistant asked for a $0.18 card with $0.14 left to borrow could only offer to repay or pledge more.
const held = (raw: string, block = '53000123') => async () => ({ raw, decimals: 6, block });

test('a purchase from the wallet’s own USDC opens the same invoice and links Spend’s payment page, with no loan', async (t) => {
  const { orders, opened } = spend(t);
  const prepared = await stillPrepareWalletPurchaseV1(IDENTITY, { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL }, { now: NOW, readUsdc: held('12500000') });
  assert.equal(prepared.reviewUrl, `${STILL_PUBLIC_ORIGIN_V1}/spend/pay/${INVOICE}`);
  assert.deepEqual([prepared.reviewId, prepared.paidFrom, prepared.walletUsdc], [INVOICE, 'wallet', { usdc: '12.5', block: '53000123' }]);
  assert.deepEqual(prepared.purchase, { productId: ESIM.id, productName: ESIM.name, packageValue: '5GB, 30 Days', faceCurrency: 'USD',
    priceUsdc: '9.8', invoiceExpiresAt: '2026-11-02T15:15:00.000Z' });
  // The page prepares a payment while Bitrefill holds the price three more minutes.
  assert.equal(prepared.expiresAt, '2026-11-02T15:12:00.000Z');
  assert.equal(orders.get(IDENTITY, INVOICE)?.priceAtomic, '9800000');
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.email, EMAIL);
  const said = JSON.stringify(prepared);
  for (const secret of [EMAIL, 'access-token', 'bitrefill.com/invoice']) assert.ok(!said.includes(secret), `the answer repeats ${secret}`);
  // Audit MCP-3 (2026-11-10): the assistant named the email, so the person is sent to check it on the page itself.
  assert.match(prepared.next, /^The page this link opens shows the user where Bitrefill will send the purchase: tell them to check there, before they sign, that the email \(and for a top-up the number\) is their own/);
  assert.match(prepared.next, /No loan is taken\./);
  assert.match(prepared.next, /Nothing has been paid\./);
});

test('a wallet that cannot pay the price, or whose USDC Base did not give, opens no invoice', async (t) => {
  const { opened } = spend(t);
  const ask = (readUsdc: Parameters<typeof stillPrepareWalletPurchaseV1>[2]['readUsdc'], packageValue = '5GB, 30 Days') =>
    stillPrepareWalletPurchaseV1(IDENTITY, { productId: ESIM.id, packageValue, email: EMAIL }, { now: NOW, readUsdc });
  await assert.rejects(ask(held('9799999')), (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === 'spend_wallet_usdc_short'
    && error.message === 'This wallet holds 9.799999 USDC at Base block 53000123, and this package costs 9.8 USDC, so no invoice was opened. A loan from Still can pay it instead (miorail_prepare_still_purchase), within what this wallet can borrow.');
  for (const unread of [async () => null, async () => { throw new Error('rpc down'); }, async () => ({ raw: '1', decimals: 18, block: '1' })]) {
    await assert.rejects(ask(unread), (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === 'spend_wallet_usdc_unread' && /not an empty wallet/.test(error.message));
  }
  // Still's own rules come first, as for a purchase with a loan.
  await assert.rejects(ask(held('500000000'), 'Unlimited, 30 Days'), (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === 'spend_over_cap');
  assert.equal(opened.length, 0, 'no invoice exists for a purchase that was refused');
  assert.equal(stillSpendRuntimeV1.orders.openedLastHour(IDENTITY), 0, 'a refused purchase is not one of the six an hour');
});

test('with paying switched off the wallet purchase is refused before its USDC is read', async (t) => {
  const { opened } = spend(t, { enabled: false });
  let reads = 0;
  await assert.rejects(stillPrepareWalletPurchaseV1(IDENTITY, { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL },
    { now: NOW, readUsdc: async () => { reads += 1; return null; } }), (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === 'spend_pay_off');
  assert.deepEqual([reads, opened.length], [0, 0]);
});

test('a repayment is Repay’s own question: an exact amount, or all of it up to the bound the user named', () => {
  const exact = stillPrepareRepayReviewV1(IDENTITY, { collateral: 'NVDAc', repayUsdc: '50' }, { secret: SECRET, now: NOW });
  assert.equal(exact.venue, 'aave-v4');
  assert.equal(exact.reviewId, draftOf(exact.reviewUrl).draftId);
  assert.deepEqual(draftOf(exact.reviewUrl).question, {
    operation: 'repay', collateralTokenAddress: NVDAC, amountMode: 'assets', repayAssets: '50000000', maximumAssets: '50000000',
  });
  const all = stillPrepareRepayReviewV1(IDENTITY, { collateral: 'cbBTC', repayUsdc: 'all', maximumUsdc: '120.50' }, { secret: SECRET, now: NOW });
  assert.equal(all.venue, 'morpho');
  assert.equal(all.maximumUsdc, '120.5');
  assert.deepEqual(draftOf(all.reviewUrl).question, {
    operation: 'repay', collateralTokenAddress: CRYPTO.find((row) => row.id === 'cbBTC')!.token.toLowerCase(), amountMode: 'all', repayAssets: null, maximumAssets: '120500000',
  });
  const refused = (args: Parameters<typeof stillPrepareRepayReviewV1>[1], words: RegExp) =>
    assert.throws(() => stillPrepareRepayReviewV1(IDENTITY, args, { secret: SECRET, now: NOW }),
      (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === 'still_repay_amount_invalid' && words.test(error.message));
  refused({ collateral: 'NVDAc', repayUsdc: 'all' }, /needs maximumUsdc/);
  refused({ collateral: 'NVDAc', repayUsdc: '50', maximumUsdc: '60' }, /with "all" only/);
  refused({ collateral: 'NVDAc', repayUsdc: '0' }, /above zero/);
  refused({ collateral: 'NVDAc', repayUsdc: '1.0000001' }, /at most six decimals/);
});

test('taking the collateral back goes with "all", for a stock or a Morpho loan, and its maximum may be zero when nothing is owed', () => {
  const back = stillPrepareRepayReviewV1(IDENTITY, { collateral: 'NVDAc', repayUsdc: 'all', maximumUsdc: '0', returnCollateral: true }, { secret: SECRET, now: NOW });
  assert.deepEqual([back.returnCollateral, back.maximumUsdc, back.venue], [true, '0', 'aave-v4']);
  assert.deepEqual(draftOf(back.reviewUrl).question, {
    operation: 'repay', collateralTokenAddress: NVDAC, amountMode: 'all', repayAssets: null, maximumAssets: '0', returnCollateral: true,
  });
  assert.equal(stillPrepareRepayReviewV1(IDENTITY, { collateral: 'NVDAc', repayUsdc: '50' }, { secret: SECRET, now: NOW }).returnCollateral, false);
  const refused = (args: Parameters<typeof stillPrepareRepayReviewV1>[1], code: string) =>
    assert.throws(() => stillPrepareRepayReviewV1(IDENTITY, args, { secret: SECRET, now: NOW }), (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === code);
  const morpho = stillPrepareRepayReviewV1(IDENTITY, { collateral: 'cbBTC', repayUsdc: 'all', maximumUsdc: '1', returnCollateral: true }, { secret: SECRET, now: NOW });
  assert.deepEqual([morpho.venue, morpho.returnCollateral], ['morpho', true]);
  assert.deepEqual(draftOf(morpho.reviewUrl).question, {
    operation: 'repay', collateralTokenAddress: CRYPTO.find((row) => row.id === 'cbBTC')!.token.toLowerCase(), amountMode: 'all', repayAssets: null, maximumAssets: '1000000', returnCollateral: true,
  });
  refused({ collateral: 'NVDAc', repayUsdc: '50', returnCollateral: true }, 'still_repay_amount_invalid');
  refused({ collateral: 'NVDAc', repayUsdc: 'all', maximumUsdc: '0' }, 'still_repay_amount_invalid');
});

test('the connected surface lists the purchase and the repayment as writes that return links, beside Still’s Spend reads', async (t) => {
  spend(t);
  const original = { ...rwaLendingRuntimeV1 };
  rwaLendingRuntimeV1.secret = () => SECRET;
  rwaLendingRuntimeV1.now = () => NOW;
  t.after(() => Object.assign(rwaLendingRuntimeV1, original));
  const client = new Client({ name: 'still-spend-test', version: '1' });
  const server = createMiorailPrivateMcpServerV1({ ...IDENTITY, chainId: 8453, tokenId: 'test-grant', source: 'oauth' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  const purchase = tools.find((entry) => entry.name === 'miorail_prepare_still_purchase')!;
  assert.deepEqual(Object.keys(purchase.inputSchema.properties ?? {}).sort(), ['addCollateral', 'collateral', 'email', 'packageValue', 'phone', 'productId']);
  assert.equal(purchase.annotations?.readOnlyHint, false);
  assert.equal(purchase.annotations?.openWorldHint, true);
  assert.equal(tools.find((entry) => entry.name === 'miorail_prepare_still_repay')?.annotations?.readOnlyHint, false);
  const fromWallet = tools.find((entry) => entry.name === 'miorail_prepare_still_wallet_purchase')!;
  assert.deepEqual(Object.keys(fromWallet.inputSchema.properties ?? {}).sort(), ['email', 'packageValue', 'phone', 'productId']);
  assert.deepEqual([fromWallet.annotations?.readOnlyHint, fromWallet.annotations?.openWorldHint], [false, true]);
  for (const read of ['still_find_spend', 'still_spend_product']) assert.equal(tools.find((entry) => entry.name === read)?.annotations?.readOnlyHint, true, read);

  const bought = await client.callTool({ name: 'miorail_prepare_still_purchase',
    arguments: { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'TSLAc', addCollateral: '0' } });
  const answer = (bought as unknown as { structuredContent: { reviewUrl: string } }).structuredContent;
  assert.equal(draftOf(answer.reviewUrl).walletAddress, WALLET);
  assert.ok(!JSON.stringify(bought).includes(EMAIL));
  const native = await client.callTool({ name: 'miorail_prepare_still_purchase',
    arguments: { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'ETH', addCollateral: '0.01' } });
  assert.equal((native as { isError?: boolean }).isError, true);
  const usdc = stillMineRuntimeV1.readUsdc;
  stillMineRuntimeV1.readUsdc = held('20000000');
  t.after(() => { stillMineRuntimeV1.readUsdc = usdc; });
  const paid = await client.callTool({ name: 'miorail_prepare_still_wallet_purchase', arguments: { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL } });
  assert.equal((paid as unknown as { structuredContent: { reviewUrl: string } }).structuredContent.reviewUrl, `${STILL_PUBLIC_ORIGIN_V1}/spend/pay/${INVOICE}`);
  assert.ok(!JSON.stringify(paid).includes(EMAIL));
  // The SDK drops arguments a tool does not take: collateral sent here borrows nothing.
  const loanArgs = await client.callTool({ name: 'miorail_prepare_still_wallet_purchase',
    arguments: { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'NVDAc', addCollateral: '0' } });
  const stillWallet = (loanArgs as unknown as { structuredContent: { reviewUrl: string; paidFrom: string } }).structuredContent;
  assert.deepEqual([stillWallet.paidFrom, stillWallet.reviewUrl], ['wallet', `${STILL_PUBLIC_ORIGIN_V1}/spend/pay/${INVOICE}`]);
  const repaid = await client.callTool({ name: 'miorail_prepare_still_repay', arguments: { collateral: 'NVDAc', repayUsdc: 'all', maximumUsdc: '75' } });
  assert.equal(draftOf((repaid as unknown as { structuredContent: { reviewUrl: string } }).structuredContent.reviewUrl).question.operation, 'repay');
  const unbounded = await client.callTool({ name: 'miorail_prepare_still_repay', arguments: { collateral: 'NVDAc', repayUsdc: 'all' } });
  assert.match(JSON.stringify(unbounded), /still_repay_amount_invalid/);
});

test('the loan, purchase and repay tools take every stock Still models as collateral', () => {
  for (const stock of STOCKS) {
    assert.ok((STILL_LOAN_COLLATERAL_V1 as readonly string[]).includes(stock.id), stock.id);
    assert.ok((STILL_TOKEN_COLLATERAL_V1 as readonly string[]).includes(stock.id), stock.id);
  }
});
