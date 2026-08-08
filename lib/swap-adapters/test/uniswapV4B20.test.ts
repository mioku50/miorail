import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { b20RoundTripV4V1, createB20PoolCacheV1 } from '../src/uniswap-v4-b20.js';
import { UNISWAP_V4_INITIALIZE_TOPIC_V1, UNISWAP_V4_POOL_MANAGER_V1 } from '../src/uniswap-v4-pinned.js';
import type { B20PoolV1 } from '../src/uniswap-v4-pool.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOKEN = '0xb200000000000000000000294511530ba9d34201';
const HOOK = '0x985c14baa2a18316ffda0aefb3a632fadfca2acc';

/** PDRSTR's pool: USDC is currency0, the token is currency1. */
const POOL: B20PoolV1 = {
  poolId: `0x${'07'.repeat(32)}`,
  key: { currency0: USDC, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK },
  token: TOKEN,
  quoteAsset: USDC,
  tokenIsCurrency0: false,
  blockNumber: 49_404_602,
};

const result = (amount: bigint): string =>
  `0x${amount.toString(16).padStart(64, '0')}${'0'.repeat(64)}`;

/** Answers each quote in turn; '' is a revert. */
function scriptedCall(answers: readonly string[]) {
  const seen: string[] = [];
  let index = 0;
  return {
    seen,
    call: async (request: { to: string; data: string }) => {
      seen.push(request.data);
      return answers[index++] ?? '';
    },
  };
}

/** Word 6 of the argument area carries `zeroForOne`. */
const directionOf = (data: string): boolean =>
  BigInt(`0x${(data.slice(10).match(/.{64}/g) ?? [])[6]}`) === 1n;

describe('the round trip asks both directions, at the size someone would hold', () => {
  test('entry then exit, and the cost is stated in bps of the position', () => {
    // 1 USDC in, 0.98 USDC back: 200 bps of round-trip cost.
    const { call } = scriptedCall([result(500_000_000_000n), result(980_000n)]);
    return b20RoundTripV4V1({ pool: POOL, positionAtomic: '1000000', call }).then((trip) => {
      assert.equal(trip.entryRouteFound, true);
      assert.equal(trip.exitRouteFound, true);
      assert.equal(trip.entryOutputAtomic, '500000000000');
      assert.equal(trip.exitReturnAtomic, '980000');
      assert.equal(trip.roundTripBps, 200);
      assert.equal(trip.quotesUsed, 2);
    });
  });

  test('the exit quote spends exactly what entry produced', async () => {
    const { seen, call } = scriptedCall([result(777n), result(900_000n)]);
    await b20RoundTripV4V1({ pool: POOL, positionAtomic: '1000000', call });
    const exitAmount = BigInt(`0x${(seen[1]!.slice(10).match(/.{64}/g) ?? [])[7]}`);
    assert.equal(exitAmount, 777n, 'selling something other than what was bought is not a round trip');
  });

  test('direction is derived from the key, not assumed', async () => {
    const { seen, call } = scriptedCall([result(10n), result(10n)]);
    await b20RoundTripV4V1({ pool: POOL, positionAtomic: '1000000', call });
    // USDC is currency0 here, so entry is 0→1 and exit is the reverse.
    assert.equal(directionOf(seen[0]!), true);
    assert.equal(directionOf(seen[1]!), false);

    const flipped = scriptedCall([result(10n), result(10n)]);
    await b20RoundTripV4V1({
      pool: { ...POOL, key: { ...POOL.key, currency0: TOKEN, currency1: USDC }, tokenIsCurrency0: true },
      positionAtomic: '1000000',
      call: flipped.call,
    });
    assert.equal(directionOf(flipped.seen[0]!), false, 'the token on the other side reverses entry');
  });
});

describe('a leg that does not price is reported, never rounded away', () => {
  test('no entry quote costs one call and claims nothing', async () => {
    const { call } = scriptedCall(['']);
    const trip = await b20RoundTripV4V1({ pool: POOL, positionAtomic: '1000000', call });
    assert.deepEqual(trip, {
      entryRouteFound: false,
      exitRouteFound: false,
      entryOutputAtomic: null,
      exitReturnAtomic: null,
      roundTripBps: null,
      quotesUsed: 1,
    });
  });

  test('entry priced but exit reverted is the worst answer, and says so', async () => {
    // A holder can get in and cannot get out. Collapsing this into "no route"
    // would hide the one thing the exit-first rail exists to state.
    const { call } = scriptedCall([result(500n), '']);
    const trip = await b20RoundTripV4V1({ pool: POOL, positionAtomic: '1000000', call });
    assert.equal(trip.entryRouteFound, true);
    assert.equal(trip.exitRouteFound, false);
    assert.equal(trip.entryOutputAtomic, '500');
    assert.equal(trip.roundTripBps, null, 'a one-legged trip has no cost to quote');
  });

  test('a pool that returns more than it took reports zero, not a negative cost', async () => {
    const { call } = scriptedCall([result(10n), result(1_100_000n)]);
    const trip = await b20RoundTripV4V1({ pool: POOL, positionAtomic: '1000000', call });
    assert.equal(trip.roundTripBps, 0);
  });
});

describe('the pool lookup spends the metered budget once per token', () => {
  function logsFor(token: string) {
    return [
      {
        address: UNISWAP_V4_POOL_MANAGER_V1,
        topics: [
          UNISWAP_V4_INITIALIZE_TOPIC_V1,
          `0x${'07'.repeat(32)}`,
          `0x${'0'.repeat(24)}${USDC.slice(2)}`,
          `0x${'0'.repeat(24)}${token.slice(2)}`,
        ],
        data:
          '0x' + '0'.repeat(64) + (200).toString(16).padStart(64, '0') +
          `${'0'.repeat(24)}${HOOK.slice(2)}` + '0'.repeat(64) + '0'.repeat(64),
        blockNumber: '0x1',
      },
    ];
  }

  test('a second lookup of the same token costs no requests', async () => {
    let calls = 0;
    const cache = createB20PoolCacheV1(async () => { calls += 1; return logsFor(TOKEN); });
    const first = await cache.lookup(TOKEN, 49_404_602);
    const after = calls;
    const second = await cache.lookup(TOKEN.toUpperCase(), 49_404_602);
    assert.ok(first, 'the pool resolved');
    assert.equal(calls, after, 'no further getLogs');
    assert.deepEqual(second, first, 'and the same pool, whatever the address casing');
  });

  test('a miss is remembered too — re-asking buys the same nothing', async () => {
    let calls = 0;
    const cache = createB20PoolCacheV1(async () => { calls += 1; return []; });
    assert.equal(await cache.lookup(TOKEN, 1), null);
    const after = calls;
    assert.equal(await cache.lookup(TOKEN, 1), null);
    assert.equal(calls, after);
    assert.equal(cache.size, 1);
  });
});
