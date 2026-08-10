import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createMemoryB20LaunchBuyersRepository } from '@mioagent/route-storage';
import { ERC20_TRANSFER_TOPIC_V1, UNISWAP_V4_POOL_MANAGER_V1 } from '@mioagent/swap-adapters';

import { createB20BuyerMeasurementV1 } from './b20BuyerStore.js';

const TOKEN = '0xb20000000000000000000021e9e4e77e35be5401';
const BUYER = '0x7747f8d2a76bd6345cc29622a946a929647f2359';
const LAUNCH = 49_488_089;
/** The launch block plus the 10,000-block window. */
const CLOSED_HEAD = LAUNCH + 10_000;

const asTopic = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2)}`;

function buy(to: string, amount: bigint) {
  return {
    address: TOKEN,
    topics: [ERC20_TRANSFER_TOPIC_V1, asTopic(UNISWAP_V4_POOL_MANAGER_V1), asTopic(to)],
    data: `0x${amount.toString(16).padStart(64, '0')}`,
  };
}

function harness(options: {
  logs?: unknown[];
  fail?: boolean;
} = {}) {
  const repository = createMemoryB20LaunchBuyersRepository();
  let calls = 0;
  const measurement = createB20BuyerMeasurementV1({
    repository,
    now: () => new Date('2026-08-10T20:00:00.000Z'),
    getLogs: async () => {
      calls += 1;
      if (options.fail) throw new Error('429');
      return (options.logs ?? []) as never;
    },
  });
  return { repository, measurement, calls: () => calls };
}

describe('launch-window buying is measured once, and only once it can be final', () => {
  test('an open window is not measured at all', async () => {
    // The rule this adds over the pool cache: a launch an hour old has most of
    // its window in the future, and a count taken now would be frozen as
    // final — "one buyer so far" presented as "one buyer, ever".
    const { measurement, calls, repository } = harness({ logs: [buy(BUYER, 500n)] });
    const result = await measurement.ensureMeasured({
      token: TOKEN, launchBlock: LAUNCH, observedHead: CLOSED_HEAD - 1,
    });
    assert.equal(result, null);
    assert.equal(calls(), 0, 'nothing was even asked');
    assert.equal(await repository.readLaunchBuyers(TOKEN), null);
  });

  test('a closed window is measured and remembered', async () => {
    const { measurement, repository } = harness({ logs: [buy(BUYER, 700n), buy(`0x${'1'.repeat(40)}`, 300n)] });
    const result = await measurement.ensureMeasured({
      token: TOKEN, launchBlock: LAUNCH, observedHead: CLOSED_HEAD,
    });
    assert.equal(result?.buyerCount, 2);
    assert.equal(result?.topBuyerShareBps, 7_000);
    assert.equal((await repository.readLaunchBuyers(TOKEN))?.buyerCount, 2);
  });

  test('a second pass costs no request', async () => {
    const { measurement, calls } = harness({ logs: [buy(BUYER, 700n)] });
    await measurement.ensureMeasured({ token: TOKEN, launchBlock: LAUNCH, observedHead: CLOSED_HEAD });
    const spent = calls();
    await measurement.ensureMeasured({ token: TOKEN, launchBlock: LAUNCH, observedHead: CLOSED_HEAD + 5_000 });
    assert.equal(calls(), spent);
  });

  test('a launch nobody bought is remembered as nobody, with null shares', async () => {
    const { measurement, repository } = harness({ logs: [] });
    const result = await measurement.ensureMeasured({
      token: TOKEN, launchBlock: LAUNCH, observedHead: CLOSED_HEAD,
    });
    assert.equal(result?.buyerCount, 0);
    assert.equal(result?.topBuyerShareBps, null);
    assert.equal((await repository.readLaunchBuyers(TOKEN))?.buyerCount, 0);
  });

  test('an endpoint that refused stores nothing and claims nothing', async () => {
    // "No buyers" is also the common TRUE answer, so a silent zero here would
    // be indistinguishable from the real thing.
    const { measurement, repository } = harness({ fail: true });
    const result = await measurement.ensureMeasured({
      token: TOKEN, launchBlock: LAUNCH, observedHead: CLOSED_HEAD,
    });
    assert.equal(result, null);
    assert.equal(await repository.readLaunchBuyers(TOKEN), null);
  });

  test('an unknown head never closes a window', async () => {
    const { measurement, calls } = harness({ logs: [buy(BUYER, 500n)] });
    assert.equal(
      await measurement.ensureMeasured({ token: TOKEN, launchBlock: LAUNCH, observedHead: Number.NaN }),
      null,
    );
    assert.equal(calls(), 0);
  });

  test('a broken store still returns what was measured', async () => {
    const repository = createMemoryB20LaunchBuyersRepository();
    const measurement = createB20BuyerMeasurementV1({
      repository: {
        readLaunchBuyers: async () => { throw new Error('db down'); },
        upsertLaunchBuyers: async () => { throw new Error('db still down'); },
      },
      getLogs: async () => [buy(BUYER, 500n)] as never,
    });
    const result = await measurement.ensureMeasured({
      token: TOKEN, launchBlock: LAUNCH, observedHead: CLOSED_HEAD,
    });
    assert.equal(result?.buyerCount, 1);
    assert.equal(await repository.readLaunchBuyers(TOKEN), null);
  });
});
