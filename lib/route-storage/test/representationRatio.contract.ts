import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { RepresentationRatioRepositoryV1 } from '../src/representationRatio.js';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
/** The measured Dinari Apple dShare on Base. A real address, because the point
 * of this case is that a real second issuer arrived. */
const DINARI_AAPL = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';
const WAD = (10n ** 18n).toString();
const HASH_A = `0x${'a1'.repeat(32)}`;
const HASH_B = `0x${'b2'.repeat(32)}`;
const EV_A = `0x${'e1'.repeat(32)}`;
const EV_B = `0x${'e2'.repeat(32)}`;

/**
 * The contract both repositories are held to.
 *
 * Every case is a way a corporate action could be invented or missed: the
 * first sighting announced as thirteen splits, a re-read of one block counted
 * twice, a value that moved and left no trace, an unread representation
 * rendered as one-to-one.
 */
export function representationRatioContractV1(
  label: string,
  open: () => Promise<{ repository: RepresentationRatioRepositoryV1 }>,
): void {
  const read = (over: Partial<Parameters<RepresentationRatioRepositoryV1['recordRead']>[0]> = {}) => ({
    chainId: 8453,
    tokenAddress: AAPL,
    ratioKind: 'b20_multiplier' as const,
    rawValue: WAD,
    scale: WAD,
    blockNumber: '50480605',
    blockHash: HASH_A,
    evidenceHash: EV_A,
    observedAt: '2026-08-26T12:00:00.000Z',
    now: '2026-08-26T12:00:01.000Z',
    ...over,
  });

  describe(`representation ratio (${label})`, () => {
    test('the first sighting is not a corporate action', async () => {
      // The day this first ran, thirteen representations had a multiplier of
      // exactly 1.0 and none of them had ever had a split. Deriving "changed"
      // from state would have announced thirteen.
      const { repository } = await open();
      const first = await repository.recordRead(read());
      assert.equal(first.outcome, 'first_observation');
      assert.equal(first.row.changes, 0);
      assert.equal(first.row.lastChangedAt, null);
      assert.deepEqual(await repository.recentChanges({ chainId: 8453, limit: 10 }), []);
    });

    test('the application comes from the kind, not from the caller', async () => {
      const { repository } = await open();
      const { row } = await repository.recordRead(read());
      assert.equal(
        row.application,
        'apply_to_raw_balance',
        'B20 stores balances raw; the caller applies the multiplier',
      );
    });

    test('a value that moved leaves a transition carrying both sides', async () => {
      const { repository } = await open();
      await repository.recordRead(read());
      const after = await repository.recordRead(
        read({
          rawValue: '1020000000000000000',
          blockNumber: '50490000',
          blockHash: HASH_B,
          evidenceHash: EV_B,
          observedAt: '2026-08-27T12:00:00.000Z',
          now: '2026-08-27T12:00:01.000Z',
        }),
      );
      assert.equal(after.outcome, 'changed');
      assert.equal(after.row.rawValue, '1020000000000000000');
      assert.equal(after.row.changes, 1);
      assert.equal(after.row.lastChangedAt, '2026-08-27T12:00:01.000Z');

      const changes = await repository.recentChanges({ chainId: 8453, limit: 10 });
      assert.equal(changes.length, 1);
      assert.equal(changes[0]?.fromRawValue, WAD);
      assert.equal(changes[0]?.toRawValue, '1020000000000000000');
      assert.equal(changes[0]?.scale, WAD, 'the scale travels with the change, never assumed');
    });

    test('re-reading the same block is one observation however many times it is made', async () => {
      const { repository } = await open();
      await repository.recordRead(read());
      const moved = read({
        rawValue: '1020000000000000000',
        blockNumber: '50490000',
        blockHash: HASH_B,
        evidenceHash: EV_B,
        observedAt: '2026-08-27T12:00:00.000Z',
        now: '2026-08-27T12:00:01.000Z',
      });
      await repository.recordRead(moved);
      await repository.recordRead({ ...moved, now: '2026-08-27T13:00:00.000Z' });
      const changes = await repository.recentChanges({ chainId: 8453, limit: 10 });
      assert.equal(changes.length, 1, 'one block, one transition');
      const rows = await repository.readRatios({ chainId: 8453, tokenAddresses: [AAPL] });
      assert.equal(rows[0]?.changes, 1);
      assert.equal(rows[0]?.reads, 3, 'every read still counts as a read');
    });

    test('an unchanged read moves the clock and claims nothing', async () => {
      const { repository } = await open();
      await repository.recordRead(read());
      const again = await repository.recordRead(
        read({ blockNumber: '50490001', blockHash: HASH_B, now: '2026-08-26T13:00:00.000Z' }),
      );
      assert.equal(again.outcome, 'unchanged');
      assert.equal(again.row.lastCheckedAt, '2026-08-26T13:00:00.000Z');
      assert.equal(again.row.lastChangedAt, null);
      assert.equal(again.row.changes, 0);
    });

    test('a representation nobody read has no row, which is not a ratio of one', async () => {
      const { repository } = await open();
      await repository.recordRead(read());
      const rows = await repository.readRatios({ chainId: 8453, tokenAddresses: [AAPL, NVDA] });
      assert.deepEqual(
        rows.map((row) => row.tokenAddress),
        [AAPL],
        'the absent address is absent, not defaulted',
      );
    });

    test("two issuers' conventions never merge into one column", async () => {
      // The whole reason this is not a B20 table. Same shape of number, and
      // applying it the same way on both would double-count every dShare
      // split — Dinari's balanceOf has already applied it.
      const { repository } = await open();
      const b20 = await repository.recordRead(read());
      const dshare = await repository.recordRead(
        read({
          tokenAddress: DINARI_AAPL,
          ratioKind: 'dinari_balance_per_share',
          rawValue: WAD,
          scale: WAD,
        }),
      );
      assert.equal(b20.row.application, 'apply_to_raw_balance');
      assert.equal(dshare.row.application, 'already_applied_by_token');
      // And where the scale came from is carried too: a B20 publishes
      // WAD_PRECISION() and a dShare publishes nothing, so one is measured and
      // one is a reviewed constant even though both read 1e18.
      assert.equal(b20.row.scaleSource, 'read_from_contract');
      assert.equal(dshare.row.scaleSource, 'reviewed_constant');
    });

    test('two representations keep separate histories', async () => {
      const { repository } = await open();
      await repository.recordRead(read());
      await repository.recordRead(read({ tokenAddress: NVDA }));
      await repository.recordRead(
        read({
          tokenAddress: NVDA,
          rawValue: '4000000000000000000',
          blockNumber: '50490000',
          blockHash: HASH_B,
          now: '2026-08-27T12:00:01.000Z',
        }),
      );
      const rows = await repository.readRatios({ chainId: 8453, tokenAddresses: [AAPL, NVDA] });
      const byAddress = new Map(rows.map((row) => [row.tokenAddress, row]));
      assert.equal(byAddress.get(AAPL)?.changes, 0);
      assert.equal(byAddress.get(NVDA)?.changes, 1);
      const changes = await repository.recentChanges({ chainId: 8453, limit: 10 });
      assert.equal(changes.length, 1);
      assert.equal(changes[0]?.tokenAddress, NVDA);
    });
  });
}
