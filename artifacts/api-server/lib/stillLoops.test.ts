import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { InMemoryStillLoopRepositoryV1 } from '@mioagent/route-storage';
import { STOCKS } from '@mioagent/still-engine/registry';

import type { LendingOriginV1 } from './lendingDraft.js';
import type { LoanExecutionV1 } from './loanExecutionStore.js';
import { LOAN_OWNER_FIXTURE, LOAN_WALLET_FIXTURE, loanReadyFixture } from './loanExecutionTestFixtures.js';
import {
  noteStillLoopV1,
  stillLoopCandidateOfV1,
  stillLoopDeliveryOfV1,
  stillLoopOfExecutionV1,
  stillLoopViaV1,
  stillLoopsEnabledV1,
  stillLoopsRuntimeV1,
  stillLoopWireV1,
  stillTeamWalletsV1,
} from './stillLoops.js';

const token = (id: string) => STOCKS.find((stock) => stock.id === id)!.token.toLowerCase();
const EXECUTION = '0f6b2a8e-1c4d-4e5f-8a9b-0c1d2e3f4a5b';

function paidLoan(input: { collateral?: string; productId?: string | null; state?: LoanExecutionV1['state']; operation?: 'borrow' | 'repay'; origin?: LendingOriginV1 } = {}): LoanExecutionV1 {
  const run = loanReadyFixture();
  run.facts = {
    ...run.facts, operation: input.operation ?? 'borrow', venue: 'aave-v4', collateralTokenAddress: token(input.collateral ?? 'AAPLc'), collateralSymbol: input.collateral ?? 'AAPLc',
    payment: {
      merchant: 'bitrefill', orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', payTo: `0x${'3'.repeat(40)}`, assets: '27340000',
      productName: 'iTunes Germany', packageValue: '25', faceCurrency: 'EUR', expiresAt: '2026-11-20T12:15:00.000Z',
      ...(input.productId === null ? {} : { productId: input.productId ?? 'itunes-germany' }),
    },
    ...(input.origin ? { origin: input.origin } : {}),
  };
  return {
    ...LOAN_OWNER_FIXTURE, executionId: EXECUTION, draftId: 'd1', state: input.state ?? 'confirmed', run, attemptId: null, batchId: null,
    transactionHash: null, verification: null, errorCode: null, version: 3, createdAt: '2026-11-20T12:00:00.000Z', updatedAt: '2026-11-20T12:01:00.000Z',
  };
}

describe('which confirmed loans are Loops', () => {
  it('a loan against Apple that paid an Apple card, rounded to the dollar, named by its assistant', () => {
    const candidate = stillLoopCandidateOfV1(paidLoan({ origin: { kind: 'mcp', client: 'claude' } }), new Set());
    assert.deepEqual(candidate, {
      executionId: EXECUTION, walletAddress: LOAN_WALLET_FIXTURE, brand: 'apple', collateral: 'AAPLc', productId: 'itunes-germany',
      productName: 'iTunes Germany', packageLabel: '25 EUR', priceRoundedAtomic: '27000000', venue: 'aave-v4', via: 'claude', team: false,
      confirmedAt: '2026-11-20T12:01:00.000Z',
    });
    assert.equal(stillLoopCandidateOfV1(paidLoan(), new Set([LOAN_WALLET_FIXTURE]))?.team, true);
  });

  it('not a loan against another stock, before it is confirmed, without the product, or a repayment', () => {
    for (const loan of [paidLoan({ collateral: 'NVDAc' }), paidLoan({ collateral: 'AMZNc' }), paidLoan({ state: 'submitted' }), paidLoan({ productId: null }),
      paidLoan({ operation: 'repay' })]) assert.equal(stillLoopCandidateOfV1(loan, new Set()), null);
  });

  it('names who prepared it, and reads the team and the switch from the environment', () => {
    assert.equal(stillLoopViaV1(undefined), 'web');
    assert.equal(stillLoopViaV1({ kind: 'mcp', client: 'chatgpt' }), 'chatgpt');
    assert.equal(stillLoopViaV1({ kind: 'mcp', client: 'other' }), 'assistant');
    assert.deepEqual([...stillTeamWalletsV1({ STILL_TEAM_WALLETS: ` ${'0xAB'.padEnd(42, 'c')}, nope ,${LOAN_WALLET_FIXTURE}` })],
      [`0xab${'c'.repeat(38)}`, LOAN_WALLET_FIXTURE]);
    assert.equal(stillLoopsEnabledV1({}), false);
    assert.equal(stillLoopsEnabledV1({ STILL_LOOPS_V1: ' ON ' }), true);
    assert.deepEqual(['complete', 'blocked', 'denied', 'payment_error', 'paid', 'unpaid', null].map((s) => stillLoopDeliveryOfV1(s as never)),
      ['complete', 'blocked', 'denied', 'payment_error', null, null, null]);
  });
});

describe('a Loop is written when its loan is read as confirmed', () => {
  const original = { ...stillLoopsRuntimeV1 };
  afterEach(() => Object.assign(stillLoopsRuntimeV1, original));
  const now = new Date('2026-11-20T12:02:00.000Z');

  it('once, and Bitrefill’s word on the card is kept', async () => {
    const repository = new InMemoryStillLoopRepositoryV1();
    const first = await noteStillLoopV1({ execution: paidLoan(), invoiceStatus: 'payment_confirmed', repository, team: new Set(), now });
    assert.deepEqual(first && stillLoopWireV1(first), { loopNo: 1, brand: 'apple', complete: false, undelivered: null, onWall: false, team: false });
    const delivered = await noteStillLoopV1({ execution: paidLoan(), invoiceStatus: 'complete', repository, team: new Set(), now });
    assert.deepEqual(delivered && [delivered.loopNo, delivered.deliveredAt], [1, now.toISOString()]);
  });

  it('only while Loops are on, and a failure to write never reaches the loan’s answer', async () => {
    let asked = 0;
    Object.assign(stillLoopsRuntimeV1, { enabled: () => false, repository: () => { asked += 1; return new InMemoryStillLoopRepositoryV1(); } });
    assert.equal(await stillLoopOfExecutionV1(paidLoan()), null);
    assert.equal(asked, 0, 'off reads nothing');
    const repository = new InMemoryStillLoopRepositoryV1();
    Object.assign(stillLoopsRuntimeV1, { enabled: () => true, repository: () => repository, team: () => new Set<string>(), now: () => now });
    assert.equal((await stillLoopOfExecutionV1(paidLoan(), 'complete'))?.deliveredAt, now.toISOString());
    assert.equal(await stillLoopOfExecutionV1(paidLoan({ collateral: 'NVDAc' })), null);
    Object.assign(stillLoopsRuntimeV1, { repository: () => ({ record: async () => { throw new Error('db down'); } }) });
    assert.equal(await stillLoopOfExecutionV1(paidLoan()), null);
  });
});
