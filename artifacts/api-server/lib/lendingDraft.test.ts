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
});
