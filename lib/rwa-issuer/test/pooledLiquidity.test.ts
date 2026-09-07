import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { B20BatchCallV1, B20ReaderV1, B20RpcResultV1 } from '@mioagent/b20-control';

import {
  AERODROME_VOTER_V1,
  POOL_SELECTORS_V1,
  UNISWAP_V3_FACTORY_BASE_V1,
  measurePoolsV1,
  poolVenueFromIdentityV1,
  readFactoryIdentityV1,
  readPoolShapesV1,
  type PoolIdentityV1,
} from '../src/pooledLiquidity.js';

const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const KUMA = '0x2222222222222222222222222222222222222222';
const AERO_POOL = '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9';
const MEME_POOL = '0xa6350e8d7988b97ce9ef991349083d6c503e2061';
const DEAD = '0x9999999999999999999999999999999999999999';
const AERO_CL_FACTORY = '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef';
const AERO_V2_FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da';
// Factories measured on Base holding tokenized-stock pools, named here only so
// a test reads like the chain it came from. None of them is a discriminator:
// the classifier decides on the METHODS each one answers, never the address.
const ALGEBRA_FACTORY = '0x36077d39cdc65e1e3fb65810430e5b2c4d5fa29e';
const PANCAKE_V3_FACTORY = '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865';
const PANCAKE_V2_FACTORY = '0x02a84c1b3bbd7401a5f7fa98a384ebc70bb5749e';
const MINESWAP_FACTORY = '0xb0c2d8a877a5b48607d9c89b6ad761f36bc79c88';
const UNPLACEABLE_FACTORY = '0xa215f5c5b1a0fc322376593f75fa422fceb6712d';

const word = (value: string) => `0x${value.replace('0x', '').padStart(64, '0')}`;
const uint = (value: bigint) => word(value.toString(16));
const stringWord = (value: string) => {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  const padded = hex.padEnd(Math.max(64, Math.ceil(hex.length / 64) * 64), '0');
  return `0x${uint(32n).slice(2)}${uint(BigInt(value.length)).slice(2)}${padded}`;
};

/** A reader that answers only what the test told it, and REVERTS on anything
 * else — so a call this module makes but the test did not anticipate fails
 * loudly rather than silently reading as an empty pool. */
function readerFor(answers: Record<string, string>): B20ReaderV1 {
  const asked: string[] = [];
  const call = async (input: B20BatchCallV1): Promise<B20RpcResultV1<string>> => {
    const key = `${input.to}:${input.data}`;
    asked.push(key);
    const value = answers[key];
    if (value === undefined) return { ok: false, reason: 'reverted' } as B20RpcResultV1<string>;
    return { ok: true, value, raw: value } as B20RpcResultV1<string>;
  };
  return {
    call,
    callMany: async (inputs: readonly B20BatchCallV1[]) => {
      const out: B20RpcResultV1<string>[] = [];
      for (const input of inputs) out.push(await call(input));
      return out;
    },
    asked,
  } as unknown as B20ReaderV1 & { asked: string[] };
}

const balanceCall = (token: string, holder: string) =>
  `${token}:0x${POOL_SELECTORS_V1.balanceOf}${holder.replace('0x', '').padStart(64, '0')}`;

describe('a venue is read, never guessed', () => {
  const identity = (patch: Partial<PoolIdentityV1>): PoolIdentityV1 => ({
    factory: AERO_CL_FACTORY,
    voter: AERODROME_VOTER_V1,
    concentrated: true,
    initCodePairHash: false,
    lmPoolDeployer: false,
    defaultPluginFactory: false,
    enumeratesPairs: false,
    ...patch,
  });

  test('a factory answering the Aerodrome voter is Aerodrome, whatever its own address', () => {
    // Three different Aerodrome factories serve these tokens and the published
    // CL address is not the one most tokenized-stock pools sit in. The voter is
    // what makes the identity independent of any address list.
    assert.equal(poolVenueFromIdentityV1(identity({})), 'aerodrome_cl');
    assert.equal(
      poolVenueFromIdentityV1(identity({ factory: AERO_V2_FACTORY, concentrated: false })),
      'aerodrome_v2',
    );
  });

  test('Uniswap v3 is named by its pinned factory', () => {
    assert.equal(
      poolVenueFromIdentityV1(
        identity({ factory: UNISWAP_V3_FACTORY_BASE_V1, voter: null, concentrated: false }),
      ),
      'uniswap_v3',
    );
  });

  test('a factory that answers nothing at all still names no venue', () => {
    // Measured: one factory holding tokenized-stock pools publishes no method
    // of its own and deploys its pools as minimal-proxy clones. Guessing the
    // commonest answer would put a wrong venue on a real pool.
    assert.equal(
      poolVenueFromIdentityV1(
        identity({ factory: UNPLACEABLE_FACTORY, voter: null, concentrated: false }),
      ),
      null,
    );
  });

  test('each protocol is named by a method only it publishes', () => {
    // Read on Base at block 51,011,096: none of these three methods exists on
    // Uniswap's factories or on each other's, so each one pins a protocol the
    // way the Aerodrome voter does — without an address list.
    assert.equal(
      poolVenueFromIdentityV1(
        identity({ factory: ALGEBRA_FACTORY, voter: null, concentrated: false, defaultPluginFactory: true }),
      ),
      'algebra_cl',
    );
    assert.equal(
      poolVenueFromIdentityV1(
        identity({ factory: PANCAKE_V3_FACTORY, voter: null, concentrated: false, lmPoolDeployer: true }),
      ),
      'pancakeswap_v3',
    );
    assert.equal(
      poolVenueFromIdentityV1(
        identity({
          factory: PANCAKE_V2_FACTORY,
          voter: null,
          concentrated: false,
          initCodePairHash: true,
          enumeratesPairs: true,
        }),
      ),
      'pancakeswap_v2',
    );
  });

  test('a factory we cannot name still places the pool by shape', () => {
    // "39 pools, six of them somewhere we could not say" reads worse than it
    // is: the shape is readable even when the brand is not.
    assert.equal(
      poolVenueFromIdentityV1(
        identity({ factory: MINESWAP_FACTORY, voter: null, concentrated: false, enumeratesPairs: true }),
      ),
      'unnamed_pair',
    );
    assert.equal(
      poolVenueFromIdentityV1(
        identity({ factory: UNPLACEABLE_FACTORY, voter: null, concentrated: false }),
        { concentrated: true, pair: false },
      ),
      'unnamed_cl',
    );
  });

  test('a concentrated pool that also answers getReserves is not called a pair', () => {
    // An Algebra pool answers `getReserves()` as well. Testing the pair shape
    // first would describe concentrated liquidity as a constant-product pair —
    // a different market, stated as fact.
    assert.equal(
      poolVenueFromIdentityV1(
        identity({ factory: UNPLACEABLE_FACTORY, voter: null, concentrated: false }),
        { concentrated: true, pair: true },
      ),
      'unnamed_cl',
    );
  });

  test('a shape is never invented for a caller that read none', () => {
    assert.equal(
      poolVenueFromIdentityV1(identity({ factory: UNPLACEABLE_FACTORY, voter: null, concentrated: false })),
      null,
    );
  });

  test('no factory is no venue', () => {
    assert.equal(poolVenueFromIdentityV1(identity({ factory: null, voter: null, concentrated: false })), null);
  });

  test('a pool is asked its own shape only where its factory said nothing', async () => {
    // The clone case, measured: the factory publishes no method, so the pool
    // answers `tickSpacing()` and nothing else. A reader that reverts on an
    // unanticipated call proves we ask for exactly these three.
    const CLONE_POOL = '0xa6f55795c696130b48feea45eb600620e24559b9';
    const reader = readerFor({
      [`${CLONE_POOL}:0x${POOL_SELECTORS_V1.tickSpacing}`]: word('0x0a'),
    }) as B20ReaderV1 & { asked: string[] };
    const shapes = await readPoolShapesV1({ reader, pools: [CLONE_POOL], blockTag: '0x1' });
    assert.deepEqual(shapes.get(CLONE_POOL), { concentrated: true, pair: false });
    assert.equal(reader.asked.length, 3);
  });

  test('asking no pools costs no calls', async () => {
    const reader = readerFor({}) as B20ReaderV1 & { asked: string[] };
    assert.equal((await readPoolShapesV1({ reader, pools: [], blockTag: '0x1' })).size, 0);
    assert.equal(reader.asked.length, 0);
  });

  test('identity is read once per factory, not once per pool', async () => {
    const reader = readerFor({
      [`${AERO_CL_FACTORY}:0x${POOL_SELECTORS_V1.voter}`]: word(AERODROME_VOTER_V1),
    }) as B20ReaderV1 & { asked: string[] };
    const map = await readFactoryIdentityV1({
      reader,
      factories: [AERO_CL_FACTORY, AERO_CL_FACTORY.toUpperCase(), AERO_CL_FACTORY],
      blockTag: '0x1',
    });
    assert.equal(map.size, 1);
    assert.equal(map.get(AERO_CL_FACTORY)?.voter, AERODROME_VOTER_V1);
    assert.equal(reader.asked.filter((key) => key.endsWith(`0x${POOL_SELECTORS_V1.voter}`)).length, 1);
  });
});

describe('measuring what a pool holds', () => {
  const factoryIdentity = new Map<string, PoolIdentityV1>([
    [
      AERO_CL_FACTORY,
      {
        factory: AERO_CL_FACTORY,
        voter: AERODROME_VOTER_V1,
        concentrated: true,
        initCodePairHash: false,
        lmPoolDeployer: false,
        defaultPluginFactory: false,
        enumeratesPairs: false,
      },
    ],
    [
      UNISWAP_V3_FACTORY_BASE_V1,
      {
        factory: UNISWAP_V3_FACTORY_BASE_V1,
        voter: null,
        concentrated: false,
        initCodePairHash: false,
        lmPoolDeployer: false,
        defaultPluginFactory: false,
        enumeratesPairs: false,
      },
    ],
  ]);

  const base = {
    chainId: 8453 as const,
    tokenAddress: NVDA,
    tokenDecimals: 8,
    blockNumber: 51004615,
    blockTag: '0x30a4007',
    readAt: '2026-09-07T16:30:00.000Z',
    factoryIdentity,
  };

  test('both sides at one block, with the venue named from the factory', async () => {
    const reader = readerFor({
      [`${AERO_POOL}:0x${POOL_SELECTORS_V1.factory}`]: word(AERO_CL_FACTORY),
      [`${AERO_POOL}:0x${POOL_SELECTORS_V1.token0}`]: word(USDC),
      [`${AERO_POOL}:0x${POOL_SELECTORS_V1.token1}`]: word(NVDA),
      [balanceCall(NVDA, AERO_POOL)]: uint(373_998_650_000n),
      [balanceCall(USDC, AERO_POOL)]: uint(1_614_910_950_000n),
      [`${USDC}:0x${POOL_SELECTORS_V1.decimals}`]: uint(6n),
      [`${USDC}:0x${POOL_SELECTORS_V1.symbol}`]: stringWord('USDC'),
    });
    const outcome = await measurePoolsV1({ ...base, reader, pools: [AERO_POOL] });
    assert.equal(outcome.readings.length, 1);
    const row = outcome.readings[0]!;
    assert.equal(row.venueId, 'aerodrome_cl');
    assert.equal(row.factoryAddress, AERO_CL_FACTORY);
    assert.equal(row.tokenBalanceAtomic, '373998650000');
    assert.equal(row.pairedTokenAddress, USDC);
    assert.equal(row.pairedBalanceAtomic, '1614910950000');
    assert.equal(row.pairedDecimals, 6);
    assert.equal(row.pairedSymbol, 'USDC');
    assert.equal(row.blockNumber, 51004615);
    assert.deepEqual(outcome.notPools, []);
    assert.deepEqual(outcome.unread, []);
  });

  test('a memecoin pair is measured, not excluded', async () => {
    // 71 NVDAc against 212 million KUMA is not a market, and it IS a fact. The
    // measurement records it; the ranking is what stops it leading the screen.
    const reader = readerFor({
      [`${MEME_POOL}:0x${POOL_SELECTORS_V1.factory}`]: word(UNISWAP_V3_FACTORY_BASE_V1),
      [`${MEME_POOL}:0x${POOL_SELECTORS_V1.token0}`]: word(NVDA),
      [`${MEME_POOL}:0x${POOL_SELECTORS_V1.token1}`]: word(KUMA),
      [balanceCall(NVDA, MEME_POOL)]: uint(7_119_280_000n),
      [balanceCall(KUMA, MEME_POOL)]: uint(212_701_444_430_000_000_000_000_000n),
      [`${KUMA}:0x${POOL_SELECTORS_V1.decimals}`]: uint(18n),
      [`${KUMA}:0x${POOL_SELECTORS_V1.symbol}`]: stringWord('KUMA'),
    });
    const outcome = await measurePoolsV1({ ...base, reader, pools: [MEME_POOL] });
    assert.equal(outcome.readings[0]?.venueId, 'uniswap_v3');
    assert.equal(outcome.readings[0]?.pairedSymbol, 'KUMA');
  });

  test('an unreadable balance is not a zero', async () => {
    // Storing zero would report an unmeasured pool as an empty one — the exact
    // lie this product refuses. It leaves the readings entirely.
    const reader = readerFor({
      [`${DEAD}:0x${POOL_SELECTORS_V1.factory}`]: word(AERO_CL_FACTORY),
    });
    const outcome = await measurePoolsV1({ ...base, reader, pools: [DEAD] });
    assert.deepEqual(outcome.readings, []);
    assert.deepEqual(outcome.unread, [DEAD]);
  });

  test('an address with no factory is recorded as not a pool, and still measured', async () => {
    const reader = readerFor({
      [balanceCall(NVDA, DEAD)]: uint(16_130_000n),
    });
    const outcome = await measurePoolsV1({ ...base, reader, pools: [DEAD] });
    assert.deepEqual(outcome.notPools, [DEAD]);
    assert.equal(outcome.readings.length, 1);
    assert.equal(outcome.readings[0]?.factoryAddress, null);
    assert.equal(outcome.readings[0]?.venueId, null);
  });

  test('an unreadable pair leaves the paired side null, never half-written', async () => {
    const reader = readerFor({
      [`${AERO_POOL}:0x${POOL_SELECTORS_V1.factory}`]: word(AERO_CL_FACTORY),
      [`${AERO_POOL}:0x${POOL_SELECTORS_V1.token0}`]: word(USDC),
      [`${AERO_POOL}:0x${POOL_SELECTORS_V1.token1}`]: word(NVDA),
      [balanceCall(NVDA, AERO_POOL)]: uint(373_998_650_000n),
      // USDC balance and decimals both refused.
    });
    const outcome = await measurePoolsV1({ ...base, reader, pools: [AERO_POOL] });
    const row = outcome.readings[0]!;
    assert.equal(row.tokenBalanceAtomic, '373998650000');
    assert.equal(row.pairedTokenAddress, null);
    assert.equal(row.pairedBalanceAtomic, null);
    assert.equal(row.pairedDecimals, null);
  });

  test('every call goes to the same block', async () => {
    const reader = readerFor({
      [`${AERO_POOL}:0x${POOL_SELECTORS_V1.factory}`]: word(AERO_CL_FACTORY),
      [`${AERO_POOL}:0x${POOL_SELECTORS_V1.token0}`]: word(USDC),
      [`${AERO_POOL}:0x${POOL_SELECTORS_V1.token1}`]: word(NVDA),
      [balanceCall(NVDA, AERO_POOL)]: uint(1n),
      [balanceCall(USDC, AERO_POOL)]: uint(2n),
      [`${USDC}:0x${POOL_SELECTORS_V1.decimals}`]: uint(6n),
      [`${USDC}:0x${POOL_SELECTORS_V1.symbol}`]: stringWord('USDC'),
    });
    const seen: string[] = [];
    const spy: B20ReaderV1 = {
      ...reader,
      callMany: async (inputs) => {
        for (const input of inputs) seen.push(input.blockTag);
        return reader.callMany!(inputs);
      },
    };
    await measurePoolsV1({ ...base, reader: spy, pools: [AERO_POOL] });
    assert.ok(seen.length > 0);
    assert.deepEqual([...new Set(seen)], ['0x30a4007'], 'one block for every read');
  });

  test('no pools is no reads', async () => {
    const reader = readerFor({}) as B20ReaderV1 & { asked: string[] };
    const outcome = await measurePoolsV1({ ...base, reader, pools: [] });
    assert.deepEqual(outcome.readings, []);
    assert.equal(reader.asked.length, 0);
  });
});
