import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';

import type { LoanExecutionV1 } from './loanExecutionStore.js';
import { LOAN_NOW_FIXTURE, LOAN_OWNER_FIXTURE, LOAN_TX_FIXTURE, loanReadyFixture } from './loanExecutionTestFixtures.js';
import {
  issueStillSpendShareV1,
  loanExecutionShareV1,
  stillSpendShareOfV1,
  stillSpendShareWordsV1,
  verifyStillSpendShareV1,
  type StillSpendShareV1,
} from './stillSpendShare.js';

// A purchase card is a claim anyone can read, so what it must never carry is
// tested as hard as what it says. Every wallet, invoice and hash is synthetic.
const SECRET = 'spend-share-fixture-secret-never-production';
const NVDA = STOCKS.find((stock) => stock.id === 'NVDAc')!.token.toLowerCase();
const PAY_TO = `0x${'3'.repeat(40)}`;
const INVOICE = '2ff5ad58-0000-4000-8000-000000000000';

function paidLoan(patch: Partial<LoanExecutionV1> = {}, facts: Record<string, unknown> = {}): LoanExecutionV1 {
  const run = loanReadyFixture();
  return {
    ...LOAN_OWNER_FIXTURE, executionId: '7d0c5b1e-0000-4000-8000-000000000000', draftId: 'draft-fixture', state: 'confirmed',
    run: { ...run, facts: { ...run.facts, operation: 'borrow', venue: 'aave-v4', collateralTokenAddress: NVDA, collateralSymbol: 'NVDAc',
      payment: { merchant: 'bitrefill', orderId: INVOICE, payTo: PAY_TO, assets: '180000', productName: 'PUBG Mobile UC International',
        packageValue: '10 UC', faceCurrency: null, expiresAt: '2026-11-01T16:00:00.000Z' }, ...facts } } as LoanExecutionV1['run'],
    attemptId: 'attempt-fixture', batchId: null, transactionHash: LOAN_TX_FIXTURE, verification: { blockNumber: 53379248 }, errorCode: null,
    version: 3, createdAt: LOAN_NOW_FIXTURE.toISOString(), updatedAt: LOAN_NOW_FIXTURE.toISOString(), ...patch,
  };
}

const PUBG: StillSpendShareV1 = { productName: 'PUBG Mobile UC International', packageLabel: '10 UC', priceAtomic: '180000', collateral: 'NVDAc', venue: 'aave-v4' };

describe('a purchase card says what was bought, and nothing that leads to the wallet', () => {
  it('is issued for a confirmed loan that paid an invoice, and for nothing else', () => {
    assert.deepEqual(stillSpendShareOfV1(paidLoan()), PUBG);
    for (const state of ['ready', 'awaiting_wallet', 'submitted', 'unknown', 'failed'] as const) {
      assert.equal(stillSpendShareOfV1(paidLoan({ state })), null, state);
    }
    assert.equal(stillSpendShareOfV1(paidLoan({}, { payment: undefined })), null);
    assert.equal(stillSpendShareOfV1(paidLoan({}, { operation: 'repay' })), null);
    // A collateral outside Still's registry has no name to show.
    assert.equal(stillSpendShareOfV1(paidLoan({}, { collateralTokenAddress: `0x${'9'.repeat(40)}` })), null);
  });

  it('names the package as the paid note does, and ETH apart from WETH', () => {
    const esim = stillSpendShareOfV1(paidLoan({}, { venue: 'morpho', collateralTokenAddress: ADDRESSES.weth.toLowerCase(),
      payment: { ...paidLoan().run.facts.payment!, productName: 'Bitrefill eSIM Germany', packageValue: '25', faceCurrency: 'EUR', assets: '27500000' } }));
    assert.deepEqual(esim, { productName: 'Bitrefill eSIM Germany', packageLabel: '25 EUR', priceAtomic: '27500000', collateral: 'WETH', venue: 'morpho' });
    const native = stillSpendShareOfV1(paidLoan({}, { venue: 'morpho', collateralTokenAddress: ADDRESSES.weth.toLowerCase(),
      nativeFunding: { maximumNativeAssets: '1', reserveAssets: '0', balanceBeforeAssets: '1', balanceAfterAssets: '0', authorizedBefore: false, feeQuoteState: 'wallet_quote_required' } }));
    assert.equal(native?.collateral, 'ETH');
    assert.deepEqual(stillSpendShareWordsV1(PUBG), { priceUsdc: '0.18', collateralLabel: 'NVDA', collateralKind: 'stock', collateralName: 'NVIDIA stock', venueName: 'Aave' });
    assert.equal(stillSpendShareWordsV1({ ...PUBG, priceAtomic: '100000000' }).priceUsdc, '100.00');
    assert.equal(stillSpendShareWordsV1({ ...PUBG, priceAtomic: '13250001' }).priceUsdc, '13.250001');
  });

  it('carries no wallet, invoice, payee, transaction or block, so the link is the same for every such purchase', () => {
    const token = issueStillSpendShareV1(PUBG, SECRET);
    const decoded = Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8');
    assert.deepEqual(JSON.parse(decoded), { v: 1, n: 'PUBG Mobile UC International', p: '10 UC', a: '180000', c: 'NVDAc', m: 'aave-v4' });
    for (const secret of [LOAN_OWNER_FIXTURE.walletAddress, PAY_TO, INVOICE, LOAN_TX_FIXTURE, '53379248']) assert.equal(token.includes(secret), false, secret);
    assert.equal(issueStillSpendShareV1(PUBG, SECRET), token);
    assert.deepEqual(loanExecutionShareV1(paidLoan(), SECRET), { path: `/spend/p/${token}` });
    assert.equal(loanExecutionShareV1(paidLoan({ state: 'unknown' }), SECRET), null);
    assert.equal(loanExecutionShareV1(paidLoan(), 'short'), null);
  });

  it('reads back only what this server signed, exactly', () => {
    const token = issueStillSpendShareV1(PUBG, SECRET);
    assert.deepEqual(verifyStillSpendShareV1(token, SECRET), PUBG);
    const [prefix, body, mac] = token.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ v: 1, n: 'A yacht', p: '1', a: '180000', c: 'NVDAc', m: 'aave-v4' })).toString('base64url');
    for (const bad of [
      `${prefix}.${forged}.${mac}`,
      `${prefix}.${body}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`,
      `ss2.${body}.${mac}`,
      `${prefix}.${body}`,
      issueStillSpendShareV1(PUBG, `${SECRET}-other`),
      `${token}.extra`,
      'x'.repeat(2000),
      null,
    ]) assert.equal(verifyStillSpendShareV1(bad, SECRET), null, String(bad).slice(0, 40));
    // Nothing outside the card's own words can be signed.
    assert.throws(() => issueStillSpendShareV1({ ...PUBG, collateral: 'DOGE' }, SECRET), /still_spend_share_invalid/);
    assert.throws(() => issueStillSpendShareV1({ ...PUBG, productName: 'line\nbreak' }, SECRET), /still_spend_share_invalid/);
    assert.throws(() => issueStillSpendShareV1(PUBG, 'short'), /still_spend_share_invalid/);
  });
});
