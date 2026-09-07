import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  MarketPoolReadingV1Schema,
  POOL_VENUE_IDS_V1,
  assertMarketPoolReadingV1,
  createMemoryMarketPoolReadingRepository,
  type MarketPoolReadingV1,
} from '../src/index.js';

const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const KUMA = '0x1111111111111111111111111111111111111111';
const AERO_POOL = '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9';
const MEME_POOL = '0xa6350e8d7988b97ce9ef991349083d6c503e2061';
const AERO_CL_FACTORY = '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef';
const UNI_V3_FACTORY = '0x33128a8fc17869897dce68ed026d694621f6fdfd';

function reading(patch: Partial<MarketPoolReadingV1> = {}): MarketPoolReadingV1 {
  return {
    chainId: 8453,
    poolAddress: AERO_POOL,
    tokenAddress: NVDA,
    venueId: 'aerodrome_cl',
    factoryAddress: AERO_CL_FACTORY,
    // 3,739.9865 NVDAc at 8 decimals — the balance measured at block 51004615.
    tokenBalanceAtomic: '373998650000',
    tokenDecimals: 8,
    pairedTokenAddress: USDC,
    pairedBalanceAtomic: '1614910950000',
    pairedDecimals: 6,
    pairedSymbol: 'USDC',
    blockNumber: 51004615,
    readAt: '2026-09-07T16:30:00.000Z',
    ...patch,
  };
}

describe('a pool reading is about one token, and carries both sides', () => {
  test('the measured shape is accepted', () => {
    const row = assertMarketPoolReadingV1(reading());
    assert.equal(row.venueId, 'aerodrome_cl');
    assert.equal(row.tokenBalanceAtomic, '373998650000');
    assert.equal(row.pairedSymbol, 'USDC');
  });

  test('a pool with no paired side read is still a reading', () => {
    // The address answered `factory()` and holds the token, but the other side
    // could not be read. Storing the half we have beats storing nothing —
    // provided the half we do not have stays null rather than becoming a zero.
    const row = assertMarketPoolReadingV1(
      reading({ pairedTokenAddress: null, pairedBalanceAtomic: null, pairedDecimals: null, pairedSymbol: null }),
    );
    assert.equal(row.pairedBalanceAtomic, null);
  });

  test('half a paired side is refused', () => {
    // An amount with no token to denominate it would force the screen to
    // invent the missing half in order to render the row.
    assert.throws(
      () => assertMarketPoolReadingV1(reading({ pairedBalanceAtomic: null, pairedDecimals: null })),
      /address, amount and decimals together/,
    );
    assert.throws(
      () => assertMarketPoolReadingV1(reading({ pairedTokenAddress: null })),
      /address, amount and decimals together/,
    );
  });

  test('a venue may not be named without the factory it was read from', () => {
    // The venue is a conclusion about a factory. Naming Aerodrome with no
    // factory on the row is precisely the guess this table exists to refuse.
    assert.throws(
      () => assertMarketPoolReadingV1(reading({ factoryAddress: null })),
      /must carry the factory/,
    );
  });

  test('an unidentified factory is a state, not an absence', () => {
    // Two of the factories holding NVDAc answered and are not ones we have
    // identified. Dropping those pools would delete real money from the answer.
    const row = assertMarketPoolReadingV1(reading({ venueId: null }));
    assert.equal(row.venueId, null);
    assert.equal(row.factoryAddress, AERO_CL_FACTORY);
  });

  test('a pool cannot be paired with itself', () => {
    assert.throws(
      () => assertMarketPoolReadingV1(reading({ pairedTokenAddress: NVDA })),
      /cannot be paired with the token/,
    );
  });

  test('balances are digit strings, never numbers', () => {
    // 1,614,910.95 USDC is 1614910950000 atomic. Rounding it once rounds it
    // forever, so the column refuses anything that is not an integer string.
    assert.equal(MarketPoolReadingV1Schema.safeParse(reading({ tokenBalanceAtomic: '3.74' })).success, false);
    assert.equal(
      MarketPoolReadingV1Schema.safeParse({ ...reading(), tokenBalanceAtomic: 373998650000 }).success,
      false,
    );
  });

  test('addresses must be lowercase', () => {
    assert.equal(
      MarketPoolReadingV1Schema.safeParse(reading({ poolAddress: AERO_POOL.toUpperCase() })).success,
      false,
    );
  });

  test('the venue list is the one the reader can name', () => {
    assert.deepEqual([...POOL_VENUE_IDS_V1], ['aerodrome_cl', 'aerodrome_v2', 'uniswap_v3']);
  });
});

describe('the store ranks by what was measured, never by count', () => {
  test('deepest first', async () => {
    const repo = createMemoryMarketPoolReadingRepository();
    await repo.recordReadings({
      readings: [
        // A memecoin pair: 71 NVDAc against 212 million KUMA. Real, and not a
        // market — it must not outrank the book that holds the money.
        reading({
          poolAddress: MEME_POOL,
          venueId: 'uniswap_v3',
          factoryAddress: UNI_V3_FACTORY,
          tokenBalanceAtomic: '7119280000',
          pairedTokenAddress: KUMA,
          pairedBalanceAtomic: '212701444430000000000000000',
          pairedDecimals: 18,
          pairedSymbol: 'KUMA',
        }),
        reading(),
      ],
    });
    const rows = await repo.readingsForToken({ chainId: 8453, tokenAddress: NVDA, limit: 10 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.poolAddress, AERO_POOL, 'the deepest pool leads');
    assert.equal(rows[1]?.poolAddress, MEME_POOL);
  });

  test('a reading replaces the one before it', async () => {
    const repo = createMemoryMarketPoolReadingRepository();
    await repo.recordReadings({ readings: [reading()] });
    await repo.recordReadings({
      readings: [reading({ tokenBalanceAtomic: '400000000000', blockNumber: 51004999 })],
    });
    const rows = await repo.readingsForToken({ chainId: 8453, tokenAddress: NVDA, limit: 10 });
    assert.equal(rows.length, 1, 'one row per pool and token, not a history');
    assert.equal(rows[0]?.tokenBalanceAtomic, '400000000000');
  });

  test('a late retry cannot age the screen', async () => {
    // Two passes racing: the older one must not replace a fresher fact with a
    // stale one that looks identical.
    const repo = createMemoryMarketPoolReadingRepository();
    await repo.recordReadings({ readings: [reading({ blockNumber: 51004999, tokenBalanceAtomic: '400000000000' })] });
    await repo.recordReadings({ readings: [reading({ blockNumber: 51004615, tokenBalanceAtomic: '1' })] });
    const rows = await repo.readingsForToken({ chainId: 8453, tokenAddress: NVDA, limit: 10 });
    assert.equal(rows[0]?.tokenBalanceAtomic, '400000000000');
    assert.equal(rows[0]?.blockNumber, 51004999);
  });

  test('a throttled pass cannot erase the pair it failed to read', async () => {
    // Measured 2026-09-07: a run against a rate-limited endpoint read the token
    // balance and lost the pair on a third of the rows, and because its block
    // was newer it replaced "3,774.69 against 1,629,587.32 USDC" with "the
    // other side was not read". A newer half-answer is not a better answer.
    const repo = createMemoryMarketPoolReadingRepository();
    await repo.recordReadings({ readings: [reading()] });
    await repo.recordReadings({
      readings: [
        reading({
          blockNumber: 51009999,
          tokenBalanceAtomic: '380000000000',
          pairedTokenAddress: null,
          pairedBalanceAtomic: null,
          pairedDecimals: null,
          pairedSymbol: null,
        }),
      ],
    });
    const rows = await repo.readingsForToken({ chainId: 8453, tokenAddress: NVDA, limit: 10 });
    assert.equal(rows[0]?.pairedBalanceAtomic, '1614910950000', 'the pair survives');
    assert.equal(rows[0]?.blockNumber, 51004615, 'and the row keeps the block it was read at');
  });

  test('a pair that genuinely emptied still lands', async () => {
    // Zero is a READ value; null is a failed call. The rule above must not hide
    // a pool that actually drained.
    const repo = createMemoryMarketPoolReadingRepository();
    await repo.recordReadings({ readings: [reading()] });
    await repo.recordReadings({
      readings: [reading({ blockNumber: 51009999, pairedBalanceAtomic: '0' })],
    });
    const rows = await repo.readingsForToken({ chainId: 8453, tokenAddress: NVDA, limit: 10 });
    assert.equal(rows[0]?.pairedBalanceAtomic, '0');
    assert.equal(rows[0]?.blockNumber, 51009999);
  });

  test('a first reading with no pair is still stored', async () => {
    const repo = createMemoryMarketPoolReadingRepository();
    await repo.recordReadings({
      readings: [
        reading({
          pairedTokenAddress: null,
          pairedBalanceAtomic: null,
          pairedDecimals: null,
          pairedSymbol: null,
        }),
      ],
    });
    const rows = await repo.readingsForToken({ chainId: 8453, tokenAddress: NVDA, limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.pairedBalanceAtomic, null);
  });

  test('the fake refuses what the database refuses', async () => {
    // A fake that accepts a row Postgres would reject turns a schema violation
    // into a production-only 500.
    const repo = createMemoryMarketPoolReadingRepository();
    await assert.rejects(
      repo.recordReadings({ readings: [reading({ factoryAddress: null })] }),
      /must carry the factory/,
    );
    assert.deepEqual(await repo.readingsForToken({ chainId: 8453, tokenAddress: NVDA, limit: 10 }), []);
  });

  test('another token on the same pool is another reading', async () => {
    // "3,740 NVDAc against $1.61m USDC" and its mirror are the same pool and
    // different answers, so both may be stored and neither overwrites the other.
    const repo = createMemoryMarketPoolReadingRepository();
    await repo.recordReadings({
      readings: [
        reading(),
        reading({
          tokenAddress: USDC,
          tokenBalanceAtomic: '1614910950000',
          tokenDecimals: 6,
          pairedTokenAddress: NVDA,
          pairedBalanceAtomic: '373998650000',
          pairedDecimals: 8,
          pairedSymbol: 'NVDAc',
        }),
      ],
    });
    assert.equal((await repo.readingsForToken({ chainId: 8453, tokenAddress: NVDA, limit: 10 })).length, 1);
    assert.equal((await repo.readingsForToken({ chainId: 8453, tokenAddress: USDC, limit: 10 })).length, 1);
  });
});
