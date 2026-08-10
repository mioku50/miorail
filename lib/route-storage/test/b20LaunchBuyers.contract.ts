import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  launchBuyerWindowClosedV1,
  launchBuyersCoverWindowV1,
  type B20LaunchBuyersRepositoryV1,
  type B20LaunchBuyersRowV1,
} from '../src/b20LaunchBuyers.js';

const TOKEN = '0xb20000000000000000000021e9e4e77e35be5401';

/** The busiest launch in the 2026-08-10 sample: 76 buyers, top 14.82%. */
export function buyersFixtureV1(overrides: Record<string, unknown> = {}): B20LaunchBuyersRowV1 {
  return {
    tokenAddress: TOKEN,
    searchFromBlock: '49488089',
    searchToBlock: '49498089',
    measuredAt: '2026-08-10T20:00:00.000Z',
    buyerCount: 76,
    totalBoughtAtomic: '714113001672080055554029248',
    topBuyerShareBps: 1482,
    topThreeShareBps: 2973,
    ...overrides,
  } as B20LaunchBuyersRowV1;
}

export function noBuyersFixtureV1(overrides: Record<string, unknown> = {}): B20LaunchBuyersRowV1 {
  return {
    tokenAddress: TOKEN,
    searchFromBlock: '49488089',
    searchToBlock: '49498089',
    measuredAt: '2026-08-10T20:00:00.000Z',
    buyerCount: 0,
    totalBoughtAtomic: '0',
    topBuyerShareBps: null,
    topThreeShareBps: null,
    ...overrides,
  } as B20LaunchBuyersRowV1;
}

export function b20LaunchBuyersContractV1(
  label: string,
  makeRepository: () => Promise<{ repository: B20LaunchBuyersRepositoryV1 }>,
): void {
  describe(`${label}: b20 launch buyers cache`, () => {
    test('a measured distribution round-trips', async () => {
      const { repository } = await makeRepository();
      await repository.upsertLaunchBuyers(buyersFixtureV1());
      const read = await repository.readLaunchBuyers(TOKEN);
      assert.equal(read?.buyerCount, 76);
      assert.equal(read?.topBuyerShareBps, 1482);
      assert.equal(read?.topThreeShareBps, 2973);
      assert.equal(read?.totalBoughtAtomic, '714113001672080055554029248');
    });

    test('a launch nobody bought stores nulls, never zero shares', async () => {
      // Zero would render as "0% concentrated" — the safest possible token,
      // which is the opposite of what an untraded launch is.
      const { repository } = await makeRepository();
      await repository.upsertLaunchBuyers(noBuyersFixtureV1());
      const read = await repository.readLaunchBuyers(TOKEN);
      assert.equal(read?.buyerCount, 0);
      assert.equal(read?.topBuyerShareBps, null);
      assert.equal(read?.topThreeShareBps, null);
    });

    test('an unmeasured token is null, which is not "nobody bought"', async () => {
      const { repository } = await makeRepository();
      assert.equal(await repository.readLaunchBuyers(`0x${'c'.repeat(40)}`), null);
    });

    test('zero buyers with a share is refused', async () => {
      const { repository } = await makeRepository();
      await assert.rejects(() => repository.upsertLaunchBuyers(noBuyersFixtureV1({ topBuyerShareBps: 10_000 })));
      await assert.rejects(() => repository.upsertLaunchBuyers(noBuyersFixtureV1({ totalBoughtAtomic: '5' })));
    });

    test('buyers without a share, or without anything bought, are refused', async () => {
      const { repository } = await makeRepository();
      await assert.rejects(() => repository.upsertLaunchBuyers(buyersFixtureV1({ topBuyerShareBps: null })));
      await assert.rejects(() => repository.upsertLaunchBuyers(buyersFixtureV1({ totalBoughtAtomic: '0' })));
    });

    test('the top three can never hold less than the top one', async () => {
      const { repository } = await makeRepository();
      await assert.rejects(
        () => repository.upsertLaunchBuyers(buyersFixtureV1({ topBuyerShareBps: 5_000, topThreeShareBps: 4_000 })),
      );
    });

    test('a share above 100% is refused', async () => {
      const { repository } = await makeRepository();
      await assert.rejects(() => repository.upsertLaunchBuyers(buyersFixtureV1({ topBuyerShareBps: 10_001 })));
    });

    test('a window that ends at or before it starts is refused', async () => {
      const { repository } = await makeRepository();
      await assert.rejects(
        () => repository.upsertLaunchBuyers(buyersFixtureV1({ searchFromBlock: '100', searchToBlock: '100' })),
      );
    });

    test('a later measurement supersedes an earlier one', async () => {
      const { repository } = await makeRepository();
      await repository.upsertLaunchBuyers(noBuyersFixtureV1());
      await repository.upsertLaunchBuyers(buyersFixtureV1({ measuredAt: '2026-08-10T21:00:00.000Z' }));
      const read = await repository.readLaunchBuyers(TOKEN);
      assert.equal(read?.buyerCount, 76);
    });
  });

  describe(`${label}: when an answer may be treated as final`, () => {
    const window = { fromBlock: 1_000, toBlock: 11_000 };

    test('a window still in the future is not closed', () => {
      // The rule this cache adds over the pool one. Caching an open window
      // would freeze "one buyer so far" as "one buyer, ever".
      assert.equal(launchBuyerWindowClosedV1(window, 10_999), false);
      assert.equal(launchBuyerWindowClosedV1(window, 1_500), false);
    });

    test('a head at or past the end closes it', () => {
      assert.equal(launchBuyerWindowClosedV1(window, 11_000), true);
      assert.equal(launchBuyerWindowClosedV1(window, 12_000), true);
    });

    test('an unknown head never closes a window', () => {
      assert.equal(launchBuyerWindowClosedV1(window, Number.NaN), false);
      assert.equal(launchBuyerWindowClosedV1(window, Number.POSITIVE_INFINITY), false);
    });

    test('coverage matches the pool rule: same origin, at least as wide', () => {
      const row = { searchFromBlock: '1000', searchToBlock: '11000' };
      assert.equal(launchBuyersCoverWindowV1(row, window), true);
      assert.equal(launchBuyersCoverWindowV1(row, { fromBlock: 1_000, toBlock: 20_000 }), false);
      assert.equal(launchBuyersCoverWindowV1(row, { fromBlock: 1_001, toBlock: 11_000 }), false);
    });
  });
}
