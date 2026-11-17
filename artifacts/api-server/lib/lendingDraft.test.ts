import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STOCKS, CRYPTO } from '@mioagent/still-engine/registry';
import { issueLendingDraftV1, verifyLendingDraftV1, type LendingQuestionV1 } from './lendingDraft.js';

const walletAddress = '0x1111111111111111111111111111111111111111';
const owner = { walletAddress, tenantId: `eip155:8453:${walletAddress}` };
const secret = 'lending-unit-fixture-secret-never-a-production-key';
const now = new Date('2026-10-29T03:00:00Z');
const questions: LendingQuestionV1[] = [
  { operation: 'borrow', collateralTokenAddress: STOCKS[5]!.token.toLowerCase(), borrowAssets: '3000000', collateralSupplyAssets: '100000000' },
  { operation: 'borrow', collateralTokenAddress: CRYPTO[0]!.token.toLowerCase(), borrowAssets: '3000000', collateralSupplyAssets: '0' },
  { operation: 'repay', collateralTokenAddress: STOCKS[5]!.token.toLowerCase(), amountMode: 'assets', repayAssets: '2000000', maximumAssets: '2000000' },
  { operation: 'repay', collateralTokenAddress: CRYPTO[1]!.token.toLowerCase(), amountMode: 'all', repayAssets: null, maximumAssets: '3000000' },
];
describe('a repayment that takes the stock back', () => {
  const stock = STOCKS[5]!.token.toLowerCase();
  it('round trips with Repay all for a stock on Aave V4 and cbBTC on Morpho, the maximum zero when nothing is owed', () => {
    for (const [token, maximumAssets] of [[stock, '3000000'], [stock, '0'], [CRYPTO[0]!.token.toLowerCase(), '1'], [CRYPTO[0]!.token.toLowerCase(), '0']] as const) {
      const question: LendingQuestionV1 = { operation: 'repay', collateralTokenAddress: token, amountMode: 'all', repayAssets: null, maximumAssets, returnCollateral: true };
      const issued = issueLendingDraftV1({ ...owner, question, secret, now }), read = verifyLendingDraftV1({ ...owner, ...issued, secret, now });
      assert(read.ok); assert.deepEqual(read.claims.question, question);
    }
  });
  it('is refused for an exact repayment, a false flag, and a zero maximum without it', () => {
    for (const question of [
      { operation: 'repay', collateralTokenAddress: stock, amountMode: 'assets', repayAssets: '1', maximumAssets: '1', returnCollateral: true },
      { operation: 'repay', collateralTokenAddress: stock, amountMode: 'all', repayAssets: null, maximumAssets: '1', returnCollateral: false },
      { operation: 'repay', collateralTokenAddress: stock, amountMode: 'all', repayAssets: null, maximumAssets: '0' },
    ]) assert.throws(() => issueLendingDraftV1({ ...owner, question: question as LendingQuestionV1, secret, now }), /lending_question_invalid/);
  });
});
describe('owned lending questions bind consent, not calldata or a prior answer', () => {
  for (const [index, question] of questions.entries()) it(`round trips registered operation ${index}`, () => {
    const issued = issueLendingDraftV1({ ...owner, question, secret, now });
    const read = verifyLendingDraftV1({ ...owner, ...issued, secret, now });
    assert(read.ok); assert.deepEqual(read.claims.question, question);
    assert.equal(read.claims.venue, index === 0 || index === 2 ? 'aave-v4' : 'morpho');
    assert.equal(Object.keys(read.claims).includes('calls'), false);
  });
  it('rejects a changed question, different owner, secret and expired link', () => {
    const issued = issueLendingDraftV1({ ...owner, question: questions[0]!, secret, now });
    const parts = issued.draft.split('.'), changed = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    changed.question.borrowAssets = '4000000'; parts[1] = Buffer.from(JSON.stringify(changed)).toString('base64url');
    assert.equal(verifyLendingDraftV1({ ...owner, draft: parts.join('.'), secret, now }).ok, false);
    assert.deepEqual(verifyLendingDraftV1({ tenantId: 'eip155:8453:0x2222222222222222222222222222222222222222', walletAddress: '0x2222222222222222222222222222222222222222', draft: issued.draft, secret, now }), { ok: false, refusal: 'lending_draft_wrong_wallet' });
    assert.equal(verifyLendingDraftV1({ ...owner, draft: issued.draft, secret: secret + 'different', now }).ok, false);
    assert.deepEqual(verifyLendingDraftV1({ ...owner, draft: issued.draft, secret, now: new Date(now.getTime() + 300000) }), { ok: false, refusal: 'lending_draft_expired' });
  });
  it('never accepts arbitrary markets, hidden calls, rounded amounts or a budget below consent', () => {
    for (const question of [
      { ...questions[0], collateralTokenAddress: '0x3333333333333333333333333333333333333333' },
      { ...questions[0], calls: [] }, { ...questions[0], borrowAssets: '3.00' },
      { ...questions[2], maximumAssets: '1' }, { ...questions[3], repayAssets: '100' },
      { ...questions[3], maximumAssets: '0' },
    ]) assert.throws(() => issueLendingDraftV1({ ...owner, question: question as LendingQuestionV1, secret, now }));
  });
  it('rejects oversized or legacy borrow/repay links in this purpose domain', () => {
    for (const draft of ['', 'x'.repeat(6001), 'miorail-borrow-v1.abc.def', 'miorail-repay-v1.abc.def']) {
      assert.equal(verifyLendingDraftV1({ ...owner, draft, secret, now }).ok, false);
    }
  });
  it('a loan that pays a Bitrefill invoice binds the invoice, for exactly the loan, and never with native ETH', () => {
    const payment = { merchant: 'bitrefill' as const, orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', payTo: '0x3333333333333333333333333333333333333333',
      assets: '13250000', productName: 'Bitrefill eSIM Germany', packageValue: '10GB, 30 Days', faceCurrency: 'USD', expiresAt: '2026-11-01T12:15:00.000Z' };
    const question: LendingQuestionV1 = { operation: 'borrow', collateralTokenAddress: STOCKS[0]!.token.toLowerCase(), borrowAssets: '13250000', collateralSupplyAssets: '0', payment };
    const issued = issueLendingDraftV1({ ...owner, question, secret, now });
    assert.match(issued.draft, /^miorail-lending-v3\./);
    const verified = verifyLendingDraftV1({ ...owner, draft: issued.draft, secret, now });
    assert.deepEqual(verified.ok && verified.claims.question, question);
    // The address and the amount are the server's; a changed one breaks the signature.
    const parts = issued.draft.split('.'), changed = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    changed.question.payment.payTo = '0x4444444444444444444444444444444444444444'; parts[1] = Buffer.from(JSON.stringify(changed)).toString('base64url');
    assert.equal(verifyLendingDraftV1({ ...owner, draft: parts.join('.'), secret, now }).ok, false);
    for (const bad of [
      { ...question, payment: { ...payment, assets: '13250001' } },
      { ...question, payment: { ...payment, payTo: '0x0000000000000000000000000000000000000000' } },
      { ...question, payment: { ...payment, merchant: 'somewhere' } },
      { ...question, payment: { ...payment, extra: true } },
      { ...question, payment: { ...payment, productId: 'Itunes Germany' } },
      { ...question, payment: { ...payment, productId: '' } },
      { ...question, payment: { ...payment, productId: null } },
      { ...question, collateralTokenAddress: CRYPTO.find(asset => asset.id === 'ETH')!.token.toLowerCase(), collateralSupplyAssets: '1', nativeFundingAssets: '1' },
    ]) assert.throws(() => issueLendingDraftV1({ ...owner, question: bad as LendingQuestionV1, secret, now }), /lending_question_invalid/);
  });
  it('a paid loan names its Bitrefill product, signed, and one issued before it did still opens', () => {
    const payment = { merchant: 'bitrefill' as const, orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', payTo: '0x3333333333333333333333333333333333333333',
      assets: '25000000', productName: 'iTunes Germany', packageValue: '25 EUR', faceCurrency: 'EUR', expiresAt: '2026-11-01T12:15:00.000Z' };
    const named: LendingQuestionV1 = { operation: 'borrow', collateralTokenAddress: STOCKS[0]!.token.toLowerCase(), borrowAssets: '25000000', collateralSupplyAssets: '0',
      payment: { ...payment, productId: 'itunes-germany' } };
    const issued = issueLendingDraftV1({ ...owner, question: named, secret, now });
    const verified = verifyLendingDraftV1({ ...owner, draft: issued.draft, secret, now });
    assert.equal(verified.ok && verified.claims.question.operation === 'borrow' && verified.claims.question.payment?.productId, 'itunes-germany');
    // The product is the server's word: changing it breaks the signature.
    const parts = issued.draft.split('.'), changed = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    changed.question.payment.productId = 'amazon_de-germany'; parts[1] = Buffer.from(JSON.stringify(changed)).toString('base64url');
    assert.equal(verifyLendingDraftV1({ ...owner, draft: parts.join('.'), secret, now }).ok, false);
    // A draft from before the product was named, and the status reads of its attempt, still verify.
    const older = issueLendingDraftV1({ ...owner, question: { ...named, payment }, secret, now });
    assert.equal(verifyLendingDraftV1({ ...owner, draft: older.draft, secret, now }).ok, true);
  });
  it('the assistant that prepared a loan is signed into its draft, and Still’s own pages name none', () => {
    const question: LendingQuestionV1 = { operation: 'borrow', collateralTokenAddress: STOCKS[0]!.token.toLowerCase(), borrowAssets: '25000000', collateralSupplyAssets: '0' };
    const fromClaude = issueLendingDraftV1({ ...owner, question, secret, now, origin: { kind: 'mcp', client: 'claude' } });
    const verified = verifyLendingDraftV1({ ...owner, draft: fromClaude.draft, secret, now });
    assert.deepEqual(verified.ok && verified.claims.origin, { kind: 'mcp', client: 'claude' });
    // The page cannot rename it: a changed client breaks the signature.
    const parts = fromClaude.draft.split('.'), changed = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    changed.origin.client = 'chatgpt'; parts[1] = Buffer.from(JSON.stringify(changed)).toString('base64url');
    assert.equal(verifyLendingDraftV1({ ...owner, draft: parts.join('.'), secret, now }).ok, false);
    // Still's own page: no origin claim at all, exactly as before.
    const own = verifyLendingDraftV1({ ...owner, draft: issueLendingDraftV1({ ...owner, question, secret, now }).draft, secret, now });
    assert.equal(own.ok && 'origin' in own.claims, false);
    for (const bad of [{ kind: 'web', client: 'claude' }, { kind: 'mcp', client: 'gemini' }, { kind: 'mcp' }, { kind: 'mcp', client: 'claude', name: 'x' }]) {
      assert.throws(() => issueLendingDraftV1({ ...owner, question, secret, now, origin: bad as never }), /lending_question_invalid/);
    }
  });
});
