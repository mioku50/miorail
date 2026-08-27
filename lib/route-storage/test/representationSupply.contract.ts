import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { RepresentationSupplyRepositoryV1 } from '../src/representationSupply.js';

export const SUPPLY_TOKEN_V1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BLOCK_A = `0x${'a1'.repeat(32)}`;
const BLOCK_B = `0x${'b2'.repeat(32)}`;
const EV_A = `0x${'e1'.repeat(32)}`;
const EV_B = `0x${'e2'.repeat(32)}`;

export function representationSupplyContractV1(
  label: string,
  open: () => Promise<{ repository: RepresentationSupplyRepositoryV1 }>,
): void {
  const successful = (
    over: Partial<Parameters<RepresentationSupplyRepositoryV1['recordObservation']>[0]> = {},
  ) => ({
    chainId: 8453,
    tokenAddress: SUPPLY_TOKEN_V1,
    totalSupplyAtomic: '0',
    decimals: 18,
    blockNumber: '50000000',
    blockHash: BLOCK_A,
    evidenceHash: EV_A,
    readOutcome: 'success' as const,
    failureCode: null,
    observedAt: '2026-08-27T12:00:00.000Z',
    now: '2026-08-27T12:00:01.000Z',
    ...over,
  });

  describe(`representation supply (${label})`, () => {
    test('the first successful observation is a baseline, never a transition', async () => {
      const { repository } = await open();
      const first = await repository.recordObservation(successful());
      assert.equal(first.outcome, 'first_observation');
      assert.equal(first.row.state, 'zero_supply');
      assert.equal(first.row.changes, 0);
      assert.deepEqual(await repository.recentChanges({ chainId: 8453, limit: 10 }), []);
    });

    test('zero to positive re-enters automatically and leaves append-only evidence', async () => {
      const { repository } = await open();
      await repository.recordObservation(successful());
      const positive = await repository.recordObservation(
        successful({
          totalSupplyAtomic: '7007870000000000000000',
          blockNumber: '50000001',
          blockHash: BLOCK_B,
          evidenceHash: EV_B,
          observedAt: '2026-08-27T13:00:00.000Z',
          now: '2026-08-27T13:00:01.000Z',
        }),
      );
      assert.equal(positive.outcome, 'changed');
      assert.equal(positive.row.state, 'positive_supply');
      const changes = await repository.recentChanges({ chainId: 8453, limit: 10 });
      assert.equal(changes[0]?.fromTotalSupplyAtomic, '0');
      assert.equal(changes[0]?.toTotalSupplyAtomic, '7007870000000000000000');
      const observations = await repository.recentObservations({
        chainId: 8453,
        tokenAddress: SUPPLY_TOKEN_V1,
        limit: 10,
      });
      assert.equal(observations.length, 2);
    });

    test('positive to zero leaves the denominator without losing evidence', async () => {
      const { repository } = await open();
      await repository.recordObservation(successful({ totalSupplyAtomic: '10' }));
      const zero = await repository.recordObservation(
        successful({
          blockNumber: '50000001',
          blockHash: BLOCK_B,
          evidenceHash: EV_B,
          observedAt: '2026-08-27T13:00:00.000Z',
          now: '2026-08-27T13:00:01.000Z',
        }),
      );
      assert.equal(zero.outcome, 'changed');
      assert.equal(zero.row.state, 'zero_supply');
      assert.equal(zero.row.changes, 1);
    });

    test('a failed read becomes unknown, never zero, and preserves the prior success in history', async () => {
      const { repository } = await open();
      await repository.recordObservation(successful({ totalSupplyAtomic: '10' }));
      const failed = await repository.recordObservation(
        successful({
          totalSupplyAtomic: null,
          decimals: null,
          blockNumber: '50000001',
          blockHash: BLOCK_B,
          evidenceHash: EV_B,
          readOutcome: 'rpc_failure',
          failureCode: 'rpc_timeout',
          observedAt: '2026-08-27T13:00:00.000Z',
          now: '2026-08-27T13:00:01.000Z',
        }),
      );
      assert.equal(failed.outcome, 'unresolved');
      assert.equal(failed.row.state, 'supply_unknown');
      assert.equal(failed.row.totalSupplyAtomic, null);
      assert.equal(failed.row.changes, 0);
      const observations = await repository.recentObservations({
        chainId: 8453,
        tokenAddress: SUPPLY_TOKEN_V1,
        limit: 10,
      });
      assert.deepEqual(
        observations.map((row) => row.state),
        ['supply_unknown', 'positive_supply'],
      );
    });
  });
}
