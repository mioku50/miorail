import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { MarketPoolReadingRepositoryV1, MarketPoolReadingV1 } from '../src/poolReadings.js';

// ---------------------------------------------------------------------------
// What the pool-reading store guarantees, on memory and on Postgres alike.
//
// The rule that matters most here is that a newer partial answer never beats
// an older whole one. A venue is the sharpest case: a pool's factory never
// changes and neither does that factory's `voter()`, so a pool once read as
// Aerodrome stays Aerodrome. Only a failed read makes it look like a shape.
// ---------------------------------------------------------------------------

const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const AERO_POOL = '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9';
const MEME_POOL = '0xa6350e8d7988b97ce9ef991349083d6c503e2061';
const AERO_CL_FACTORY = '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef';
const UNI_V3_FACTORY = '0x33128a8fc17869897dce68ed026d694621f6fdfd';

export function poolReading(patch: Partial<MarketPoolReadingV1> = {}): MarketPoolReadingV1 {
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

export function poolReadingsContract(
  name: string,
  fresh: () => Promise<MarketPoolReadingRepositoryV1>,
): void {
  const only = async (repo: MarketPoolReadingRepositoryV1) =>
    (await repo.readingsForToken({ chainId: 8453, tokenAddress: NVDA, limit: 10 }))[0];

  describe(`${name}: the pool-reading store`, () => {
    test('deepest first, by the measured balance', async () => {
      const repo = await fresh();
      await repo.recordReadings({
        readings: [
          poolReading({ poolAddress: MEME_POOL, venueId: 'uniswap_v3', factoryAddress: UNI_V3_FACTORY, tokenBalanceAtomic: '9000000000' }),
          poolReading(),
        ],
      });
      const rows = await repo.readingsForToken({ chainId: 8453, tokenAddress: NVDA, limit: 10 });
      assert.deepEqual(rows.map((row) => row.poolAddress), [AERO_POOL, MEME_POOL]);
    });

    test('a late retry cannot age the screen', async () => {
      const repo = await fresh();
      await repo.recordReadings({ readings: [poolReading({ blockNumber: 51009999, tokenBalanceAtomic: '380000000000' })] });
      await repo.recordReadings({ readings: [poolReading()] });
      assert.equal((await only(repo))?.blockNumber, 51009999);
    });

    test('a throttled pass cannot erase the pair or the factory it failed to read', async () => {
      const repo = await fresh();
      await repo.recordReadings({ readings: [poolReading()] });
      await repo.recordReadings({
        readings: [
          poolReading({
            blockNumber: 51009999,
            pairedTokenAddress: null,
            pairedBalanceAtomic: null,
            pairedDecimals: null,
            pairedSymbol: null,
          }),
        ],
      });
      await repo.recordReadings({ readings: [poolReading({ blockNumber: 51009999, venueId: null, factoryAddress: null })] });
      const row = await only(repo);
      assert.equal(row?.pairedBalanceAtomic, '1614910950000');
      assert.equal(row?.factoryAddress, AERO_CL_FACTORY);
      assert.equal(row?.venueId, 'aerodrome_cl');
      assert.equal(row?.blockNumber, 51004615);
    });

    test('a pass that could not read the voter cannot demote Aerodrome to a shape, and still refreshes the balance', async () => {
      // Measured on production 2026-10-04: from 0 to 3 of the 3 Aerodrome
      // factories answered `voter()` per run, and the deepest NVDAc pool, which
      // holds $1.6m, was shown as "Concentrated pool, venue not named".
      const repo = await fresh();
      await repo.recordReadings({ readings: [poolReading()] });
      await repo.recordReadings({
        readings: [poolReading({ blockNumber: 51009999, venueId: 'unnamed_cl', tokenBalanceAtomic: '380000000000' })],
      });
      const row = await only(repo);
      assert.equal(row?.venueId, 'aerodrome_cl');
      assert.equal(row?.tokenBalanceAtomic, '380000000000');
      assert.equal(row?.blockNumber, 51009999);
    });

    test('a pass that could not place the pool keeps its venue and still refreshes the balance', async () => {
      const repo = await fresh();
      await repo.recordReadings({ readings: [poolReading()] });
      await repo.recordReadings({
        readings: [poolReading({ blockNumber: 51009999, venueId: null, tokenBalanceAtomic: '380000000000' })],
      });
      const row = await only(repo);
      assert.equal(row?.venueId, 'aerodrome_cl');
      assert.equal(row?.tokenBalanceAtomic, '380000000000');
    });

    test('a stronger reading replaces a weaker one, and an engine never demotes a protocol', async () => {
      const repo = await fresh();
      await repo.recordReadings({ readings: [poolReading({ venueId: 'unnamed_cl' })] });
      await repo.recordReadings({ readings: [poolReading({ blockNumber: 51009999 })] });
      assert.equal((await only(repo))?.venueId, 'aerodrome_cl');
      await repo.recordReadings({ readings: [poolReading({ blockNumber: 51010000, venueId: 'algebra_cl' })] });
      assert.equal((await only(repo))?.venueId, 'aerodrome_cl');
    });

    test('a pair that genuinely emptied still lands', async () => {
      const repo = await fresh();
      await repo.recordReadings({ readings: [poolReading()] });
      await repo.recordReadings({ readings: [poolReading({ blockNumber: 51009999, pairedBalanceAtomic: '0' })] });
      const row = await only(repo);
      assert.equal(row?.pairedBalanceAtomic, '0');
      assert.equal(row?.blockNumber, 51009999);
    });
  });
}
