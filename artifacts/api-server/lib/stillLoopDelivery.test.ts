import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { InMemoryStillLoopInvoiceReadRepositoryV1, InMemoryStillLoopRepositoryV1 } from '@mioagent/route-storage';
import { STOCKS } from '@mioagent/still-engine/registry';

import type { LoanExecutionV1 } from './loanExecutionStore.js';
import { loanReadyFixture } from './loanExecutionTestFixtures.js';
import {
  keepStillLoopInvoiceReadV1,
  settleStillLoopDeliveriesV1,
  stillLoopInvoiceReadsRuntimeV1,
  stillLoopKeptInvoiceRefV1,
  stillLoopProductV1,
} from './stillLoopDelivery.js';
import { stillLoopOfExecutionV1, stillLoopsRuntimeV1 } from './stillLoops.js';

// ---------------------------------------------------------------------------
// Audit LOOP-1, 2026-11-20: a Loop's card was read only while Spend held the open order, half an hour in memory, so a
// card delivered later, or after a restart, left the Loop "on its way" for good while the draw counted it.
// ---------------------------------------------------------------------------

const WALLET = `0x${'a'.repeat(40)}`;
const AAPLC = STOCKS.find((stock) => stock.id === 'AAPLc')!.token.toLowerCase();
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const OWNER = { tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET };
const TOKEN = 'tok_0123456789abcdef0123456789abcdef';

function paidLoan(n: number, confirmedAt: string): LoanExecutionV1 {
  const run = loanReadyFixture();
  run.facts = { ...run.facts, operation: 'borrow', venue: 'aave-v4', collateralTokenAddress: AAPLC, collateralSymbol: 'AAPLc',
    payment: { merchant: 'bitrefill', orderId: id(100 + n), payTo: `0x${'3'.repeat(40)}`, assets: '27340000', productName: 'iTunes Germany',
      packageValue: '25', faceCurrency: 'EUR', expiresAt: '2026-11-22T12:15:00.000Z', productId: 'itunes-germany' } };
  return { tenantId: OWNER.tenantId, walletAddress: WALLET, executionId: id(n), draftId: `d${n}`, state: 'confirmed', run, attemptId: null, batchId: null,
    transactionHash: null, verification: null, errorCode: null, version: 3,
    createdAt: new Date(Date.parse(confirmedAt) - 60_000).toISOString(), updatedAt: confirmedAt };
}

const loops = { ...stillLoopsRuntimeV1 }, reads = { ...stillLoopInvoiceReadsRuntimeV1 };
let loopRepo: InMemoryStillLoopRepositoryV1, readRepo: InMemoryStillLoopInvoiceReadRepositoryV1, now: Date;
beforeEach(() => {
  loopRepo = new InMemoryStillLoopRepositoryV1();
  readRepo = new InMemoryStillLoopInvoiceReadRepositoryV1();
  now = new Date('2026-11-22T10:00:00.000Z');
  Object.assign(stillLoopsRuntimeV1, { enabled: () => true, team: () => new Set<string>(), repository: () => loopRepo, now: () => now });
  Object.assign(stillLoopInvoiceReadsRuntimeV1, { repository: () => readRepo, secret: () => 'a-test-session-secret-of-some-length', now: () => now });
});
afterEach(() => {
  Object.assign(stillLoopsRuntimeV1, loops);
  Object.assign(stillLoopInvoiceReadsRuntimeV1, reads);
});

describe('a Loop’s card, read until Bitrefill has said', () => {
  it('keeps the invoice of a Loop brand’s card only, encrypted, and reads it back for its own wallet only', async () => {
    assert.deepEqual(['itunes-germany', 'amazon-de', 'google-play-us', 'meta-quest-uk', 'xbox-live-us', 'netflix-us', 'esim-europe'].map(stillLoopProductV1),
      [true, true, true, true, true, false, false]);
    await keepStillLoopInvoiceReadV1({ orderId: id(101), walletAddress: WALLET, productId: 'itunes-germany', accessToken: TOKEN });
    await keepStillLoopInvoiceReadV1({ orderId: id(102), walletAddress: WALLET, productId: 'netflix-us', accessToken: TOKEN });
    const kept = await readRepo.get({ orderId: id(101), walletAddress: WALLET });
    assert.ok(kept);
    assert.doesNotMatch(kept.readEnc, /tok_/, 'never the token itself');
    assert.equal(await readRepo.get({ orderId: id(102), walletAddress: WALLET }), null, 'not a card a Loop is made of');
    assert.deepEqual(await stillLoopKeptInvoiceRefV1(OWNER, id(101)), { orderId: id(101), accessToken: TOKEN });
    const other = `0x${'b'.repeat(40)}`;
    assert.equal(await stillLoopKeptInvoiceRefV1({ tenantId: `eip155:8453:${other}`, walletAddress: other }, id(101)), null);
    // Off while Loops are off.
    Object.assign(stillLoopsRuntimeV1, { enabled: () => false });
    await keepStillLoopInvoiceReadV1({ orderId: id(103), walletAddress: WALLET, productId: 'itunes-germany', accessToken: TOKEN });
    assert.equal(await readRepo.get({ orderId: id(103), walletAddress: WALLET }), null);
  });

  it('asks again each Loop with no word, at most every nine minutes, and lets the read go once the word is in', async () => {
    const loan = paidLoan(1, '2026-11-22T09:00:00.000Z');
    await keepStillLoopInvoiceReadV1({ orderId: id(101), walletAddress: WALLET, productId: 'itunes-germany', accessToken: TOKEN });
    assert.equal((await stillLoopOfExecutionV1(loan))?.deliveredAt, null, 'the Loop is written, its card on its way');
    let status: string | null = 'processing';
    const asked: string[] = [];
    const deps = {
      loanOf: async (_owner: unknown, executionId: string) => (executionId === loan.executionId ? loan : null),
      readInvoice: async (_owner: unknown, ref: { orderId: string; accessToken: string }) => { asked.push(`${ref.orderId}:${ref.accessToken}`); return status; },
    };
    assert.deepEqual(await settleStillLoopDeliveriesV1(deps), { asked: 1, settled: 0 });
    assert.deepEqual(asked, [`${id(101)}:${TOKEN}`]);
    now = new Date(now.getTime() + 5 * 60_000);
    assert.deepEqual(await settleStillLoopDeliveriesV1(deps), { asked: 0, settled: 0 }, 'not again within nine minutes');
    now = new Date(now.getTime() + 5 * 60_000);
    status = 'complete';
    assert.deepEqual(await settleStillLoopDeliveriesV1(deps), { asked: 1, settled: 1 });
    assert.notEqual((await loopRepo.byExecution(loan.executionId))?.deliveredAt, null, 'counted, and may go on the wall');
    assert.equal(await readRepo.get({ orderId: id(101), walletAddress: WALLET }), null, 'the read goes once the word is in');
    now = new Date(now.getTime() + 60 * 60_000);
    assert.deepEqual(await settleStillLoopDeliveriesV1(deps), { asked: 0, settled: 0 });
  });

  it('keeps a read no longer than 14 days', async () => {
    await keepStillLoopInvoiceReadV1({ orderId: id(101), walletAddress: WALLET, productId: 'itunes-germany', accessToken: TOKEN });
    now = new Date(now.getTime() + 15 * 24 * 3_600_000);
    await settleStillLoopDeliveriesV1({ loanOf: async () => null, readInvoice: async () => null });
    assert.equal(await readRepo.get({ orderId: id(101), walletAddress: WALLET }), null);
  });
});
