import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { StillLoopInvoiceReadRepositoryV1 } from '../src/stillLoopInvoiceReads.js';

// What both repositories of kept Loop invoice reads must do (lib/db/drizzle/0108, audit LOOP-1).
const ORDER = '00000000-0000-4000-8000-000000000065';
const WALLET = `0x${'a'.repeat(40)}`;
const AT = new Date('2026-11-22T10:00:00.000Z');

export function stillLoopInvoiceReadsContractV1(label: string, make: () => Promise<StillLoopInvoiceReadRepositoryV1>): void {
  describe(`${label}: a Loop card's kept invoice read`, () => {
    test('is kept once, read by its own wallet only, touched, forgotten and pruned', async () => {
      const reads = await make();
      await reads.keep({ orderId: ORDER, walletAddress: WALLET, readEnc: 'x'.repeat(40), at: AT });
      await reads.keep({ orderId: ORDER, walletAddress: WALLET, readEnc: 'y'.repeat(40), at: new Date(AT.getTime() + 1_000) });
      const kept = await reads.get({ orderId: ORDER, walletAddress: WALLET });
      assert.deepEqual(kept, { orderId: ORDER, walletAddress: WALLET, readEnc: 'x'.repeat(40), createdAt: AT.toISOString(), readAt: null }, 'the first keep stands');
      assert.equal(await reads.get({ orderId: ORDER, walletAddress: `0x${'b'.repeat(40)}` }), null);
      await reads.touched({ orderId: ORDER, at: new Date(AT.getTime() + 60_000) });
      assert.equal((await reads.get({ orderId: ORDER, walletAddress: WALLET }))?.readAt, new Date(AT.getTime() + 60_000).toISOString());
      await reads.forget({ orderId: ORDER });
      assert.equal(await reads.get({ orderId: ORDER, walletAddress: WALLET }), null);
      await reads.keep({ orderId: ORDER, walletAddress: WALLET, readEnc: 'z'.repeat(40), at: AT });
      assert.equal(await reads.prune({ before: AT }), 0);
      assert.equal(await reads.prune({ before: new Date(AT.getTime() + 1) }), 1);
      assert.equal(await reads.get({ orderId: ORDER, walletAddress: WALLET }), null);
      await assert.rejects(() => reads.keep({ orderId: 'nope', walletAddress: WALLET, readEnc: 'x'.repeat(40), at: AT }), /order_invalid/);
      await assert.rejects(() => reads.keep({ orderId: ORDER, walletAddress: WALLET, readEnc: 'short', at: AT }), /read_invalid/);
    });
  });
}
