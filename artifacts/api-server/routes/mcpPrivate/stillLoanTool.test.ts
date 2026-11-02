import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BitrefillGuestCheckoutV1, SpendProductV1 } from '@mioagent/commerce-engine';
import { ADDRESSES, CRYPTO, STOCKS } from '@mioagent/still-engine/registry';

import { verifyLendingDraftV1 } from '../../lib/lendingDraft.js';
import { createSpendOrderStoreV1, type SpendOrderStoreV1 } from '../../lib/stillSpendOrders.js';
import { rwaLendingRuntimeV1 } from '../rwaLending.js';
import { stillSpendRuntimeV1 } from '../stillSpend.js';
import { createMiorailPrivateMcpServerV1 } from './server.js';
import { StillLoanRefusalV1, stillPrepareLoanReviewV1, stillPreparePurchaseV1, stillPrepareRepayReviewV1 } from './stillLoanTool.js';

const WALLET = `0x${'1'.repeat(40)}` as const;
const IDENTITY = { tenantId: `eip155:8453:${WALLET}` as const, walletAddress: WALLET };
const SECRET = 'a-test-secret-long-enough';
const NOW = new Date('2026-11-02T15:00:00.000Z');
const NVDAC = STOCKS.find((stock) => stock.id === 'NVDAc')!.token.toLowerCase();

function draftOf(url: string) {
  const draft = url.replace('https://stills.lat/lending/', '');
  const verified = verifyLendingDraftV1({ draft, ...IDENTITY, secret: SECRET, now: NOW });
  assert.ok(verified.ok, 'the link carries a draft this server signed for this wallet');
  return verified.claims;
}

test('a stock loan is the same wallet-bound Aave V4 question Get money issues', () => {
  const review = stillPrepareLoanReviewV1(IDENTITY, { collateral: 'NVDAc', addCollateral: '0.05', borrowUsdc: '500' }, { secret: SECRET, now: NOW });
  assert.match(review.reviewUrl, /^https:\/\/stills\.lat\/lending\/miorail-lending-v1\./);
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
  assert.match(prepared.reviewUrl, /^https:\/\/stills\.lat\/lending\/miorail-lending-v3\./);
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

test('with paying switched off the purchase is refused before Bitrefill is asked', async (t) => {
  const { opened } = spend(t, { enabled: false });
  await assert.rejects(stillPreparePurchaseV1(IDENTITY,
    { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'NVDAc', addCollateral: '0' }, { secret: SECRET, now: NOW }),
  (error: unknown) => error instanceof StillLoanRefusalV1 && error.code === 'spend_pay_off');
  assert.equal(opened.length, 0);
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
  for (const read of ['still_find_spend', 'still_spend_product']) assert.equal(tools.find((entry) => entry.name === read)?.annotations?.readOnlyHint, true, read);

  const bought = await client.callTool({ name: 'miorail_prepare_still_purchase',
    arguments: { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'TSLAc', addCollateral: '0' } });
  const answer = (bought as unknown as { structuredContent: { reviewUrl: string } }).structuredContent;
  assert.equal(draftOf(answer.reviewUrl).walletAddress, WALLET);
  assert.ok(!JSON.stringify(bought).includes(EMAIL));
  const native = await client.callTool({ name: 'miorail_prepare_still_purchase',
    arguments: { productId: ESIM.id, packageValue: '5GB, 30 Days', email: EMAIL, collateral: 'ETH', addCollateral: '0.01' } });
  assert.equal((native as { isError?: boolean }).isError, true);
  const repaid = await client.callTool({ name: 'miorail_prepare_still_repay', arguments: { collateral: 'NVDAc', repayUsdc: 'all', maximumUsdc: '75' } });
  assert.equal(draftOf((repaid as unknown as { structuredContent: { reviewUrl: string } }).structuredContent.reviewUrl).question.operation, 'repay');
  const unbounded = await client.callTool({ name: 'miorail_prepare_still_repay', arguments: { collateral: 'NVDAc', repayUsdc: 'all' } });
  assert.match(JSON.stringify(unbounded), /still_repay_amount_invalid/);
});
