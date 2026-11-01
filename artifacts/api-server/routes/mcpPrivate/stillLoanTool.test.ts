import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';

import { verifyLendingDraftV1 } from '../../lib/lendingDraft.js';
import { rwaLendingRuntimeV1 } from '../rwaLending.js';
import { createMiorailPrivateMcpServerV1 } from './server.js';
import { StillLoanRefusalV1, stillPrepareLoanReviewV1 } from './stillLoanTool.js';

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
