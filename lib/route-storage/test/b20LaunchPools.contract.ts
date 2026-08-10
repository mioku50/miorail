import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  launchPoolCoversWindowV1,
  type B20LaunchPoolRepositoryV1,
  type B20LaunchPoolRowV1,
} from '../src/b20LaunchPools.js';

const TOKEN = '0xb200000000000000000000ce8154bc4cd7bfea01';
const POOL = `0x${'a'.repeat(64)}`;
const HOOK = '0x985c14baa2a18316ffda0aefb3a632fadfca2acc';
const WETH = '0x0000000000000000000000000000000000000000';

export function resolvedFixtureV1(overrides: Record<string, unknown> = {}): B20LaunchPoolRowV1 {
  return {
    tokenAddress: TOKEN,
    searchFromBlock: '49535953',
    searchToBlock: '49535962',
    resolvedAt: '2026-08-10T12:00:00.000Z',
    outcome: 'resolved',
    poolId: POOL,
    currency0: WETH,
    currency1: TOKEN,
    fee: 0,
    tickSpacing: 200,
    hooks: HOOK,
    quoteAsset: WETH,
    tokenIsCurrency0: false,
    poolBlockNumber: '49535954',
    ...overrides,
  } as B20LaunchPoolRowV1;
}

export function absentFixtureV1(overrides: Record<string, unknown> = {}): B20LaunchPoolRowV1 {
  return {
    tokenAddress: TOKEN,
    searchFromBlock: '49535953',
    searchToBlock: '49535962',
    resolvedAt: '2026-08-10T12:00:00.000Z',
    outcome: 'absent',
    poolId: null,
    currency0: null,
    currency1: null,
    fee: null,
    tickSpacing: null,
    hooks: null,
    quoteAsset: null,
    tokenIsCurrency0: null,
    poolBlockNumber: null,
    ...overrides,
  } as B20LaunchPoolRowV1;
}

/** Run against BOTH repositories. The in-memory fake must refuse exactly what
 * the CHECK constraints refuse — that gap has produced production bugs. */
export function b20LaunchPoolContractV1(
  label: string,
  makeRepository: () => Promise<{ repository: B20LaunchPoolRepositoryV1 }>,
): void {
  describe(`${label}: b20 launch pool cache`, () => {
    test('a resolved pool round-trips with its whole PoolKey intact', async () => {
      const { repository } = await makeRepository();
      const written = await repository.upsertLaunchPool(resolvedFixtureV1());
      assert.equal(written.outcome, 'resolved');
      const read = await repository.readLaunchPool(TOKEN);
      assert.equal(read?.outcome, 'resolved');
      // Types matter as much as values: a fee read back as a string would be
      // encoded into a PoolKey as the wrong type and hash to no pool at all.
      assert.equal(read?.fee, 0);
      assert.equal(typeof read?.fee, 'number');
      assert.equal(read?.tickSpacing, 200);
      assert.equal(typeof read?.tickSpacing, 'number');
      assert.equal(read?.hooks, HOOK);
      assert.equal(read?.tokenIsCurrency0, false);
      assert.equal(read?.poolBlockNumber, '49535954');
    });

    test('a searched-and-empty window is remembered, because it cannot change', async () => {
      const { repository } = await makeRepository();
      await repository.upsertLaunchPool(absentFixtureV1());
      const read = await repository.readLaunchPool(TOKEN);
      assert.equal(read?.outcome, 'absent');
      assert.equal(read?.poolId, null);
    });

    test('an unknown token is null, which is "nothing known", not "no pool"', async () => {
      const { repository } = await makeRepository();
      assert.equal(await repository.readLaunchPool(`0x${'b'.repeat(40)}`), null);
    });

    test('a later search supersedes an earlier one for the same token', async () => {
      const { repository } = await makeRepository();
      await repository.upsertLaunchPool(absentFixtureV1());
      await repository.upsertLaunchPool(resolvedFixtureV1({ resolvedAt: '2026-08-10T13:00:00.000Z' }));
      const read = await repository.readLaunchPool(TOKEN);
      assert.equal(read?.outcome, 'resolved');
      assert.equal(read?.poolId, POOL);
    });

    test('a resolved row missing part of its PoolKey is refused', async () => {
      // A partial key hashes to a pool id that names nothing, and quoting
      // against it fails in a way that looks like the token's fault.
      const { repository } = await makeRepository();
      for (const missing of ['poolId', 'currency0', 'fee', 'tickSpacing', 'hooks', 'quoteAsset'] as const) {
        await assert.rejects(
          () => repository.upsertLaunchPool(resolvedFixtureV1({ [missing]: null })),
          `expected refusal when ${missing} is missing`,
        );
      }
    });

    test('an absent row carrying pool fields is refused', async () => {
      const { repository } = await makeRepository();
      await assert.rejects(() => repository.upsertLaunchPool(absentFixtureV1({ poolId: POOL })));
      await assert.rejects(() => repository.upsertLaunchPool(absentFixtureV1({ hooks: HOOK })));
    });

    test('addresses must be lowercase, or a pinned comparison silently misreads', async () => {
      const { repository } = await makeRepository();
      await assert.rejects(() => repository.upsertLaunchPool(resolvedFixtureV1({ hooks: HOOK.toUpperCase().replace('0X', '0x') })));
      await assert.rejects(() => repository.upsertLaunchPool(resolvedFixtureV1({ tokenAddress: TOKEN.toUpperCase().replace('0X', '0x') })));
    });

    test('a window that ends before it starts is refused', async () => {
      const { repository } = await makeRepository();
      await assert.rejects(
        () => repository.upsertLaunchPool(resolvedFixtureV1({ searchFromBlock: '100', searchToBlock: '99' })),
      );
    });
  });

  describe(`${label}: window coverage`, () => {
    const row = { searchFromBlock: '1000', searchToBlock: '1009' };

    test('the exact window is covered', () => {
      assert.equal(launchPoolCoversWindowV1(row, { fromBlock: 1000, toBlock: 1009 }), true);
    });

    test('a narrower ask inside the searched window is covered', () => {
      assert.equal(launchPoolCoversWindowV1(row, { fromBlock: 1000, toBlock: 1005 }), true);
    });

    test('a wider ask is NOT covered — widening must re-ask, never inherit', () => {
      assert.equal(launchPoolCoversWindowV1(row, { fromBlock: 1000, toBlock: 1019 }), false);
    });

    test('a different origin is a different question, even when ranges overlap', () => {
      // The resolver walks forward FROM the launch block, so a search that
      // began elsewhere answers something else.
      assert.equal(launchPoolCoversWindowV1(row, { fromBlock: 1001, toBlock: 1009 }), false);
      assert.equal(launchPoolCoversWindowV1(row, { fromBlock: 999, toBlock: 1009 }), false);
    });
  });
}
