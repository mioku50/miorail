import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createInMemoryRpcCuLedgerRepository } from '../src/rpcCuLedger.js';

const SEPTEMBER = new Date('2026-09-03T12:00:00.000Z');
const OCTOBER = new Date('2026-10-01T00:00:00.000Z');

describe('the month’s metered spend', () => {
  test('spend accumulates within a month, per provider', async () => {
    const ledger = createInMemoryRpcCuLedgerRepository();
    await ledger.recordSpend({ provider: 'alchemy', cu: 7_800, calls: 300, now: SEPTEMBER });
    await ledger.recordSpend({ provider: 'alchemy', cu: 26, calls: 1, now: SEPTEMBER });
    await ledger.recordSpend({ provider: 'fallback', cu: 52, calls: 2, now: SEPTEMBER });
    const rows = await ledger.readMonth(SEPTEMBER);
    assert.deepEqual(
      rows.map((row) => [row.provider, row.spentCu, row.callCount]),
      [
        ['alchemy', 7_826, 301],
        ['fallback', 52, 2],
      ],
    );
  });

  test('a new month starts at nothing, because the plan resets', async () => {
    const ledger = createInMemoryRpcCuLedgerRepository();
    await ledger.recordSpend({ provider: 'alchemy', cu: 1_000, calls: 10, now: SEPTEMBER });
    assert.deepEqual(await ledger.readMonth(OCTOBER), []);
    // And September is still there: a reset is not an erasure.
    assert.equal((await ledger.readMonth(SEPTEMBER))[0]?.spentCu, 1_000);
  });

  test('a zero batch writes no row, so an idle month reads as untouched', async () => {
    const ledger = createInMemoryRpcCuLedgerRepository();
    await ledger.recordSpend({ provider: 'alchemy', cu: 0, calls: 0, now: SEPTEMBER });
    assert.deepEqual(await ledger.readMonth(SEPTEMBER), []);
  });

  test('spend never goes down', async () => {
    // A decrement is a correction nobody can audit, and the fallback exists so
    // that none is needed. The DB constraint says the same thing.
    const ledger = createInMemoryRpcCuLedgerRepository();
    await ledger.recordSpend({ provider: 'alchemy', cu: 100, calls: 4, now: SEPTEMBER });
    await ledger.recordSpend({ provider: 'alchemy', cu: -500, calls: -20, now: SEPTEMBER });
    const rows = await ledger.readMonth(SEPTEMBER);
    assert.equal(rows[0]?.spentCu, 100);
    assert.equal(rows[0]?.callCount, 4);
  });
});
