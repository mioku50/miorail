import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Address } from 'viem';
import { morphoAccruedTotalsV1, morphoAfterBorrowV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { readCalendar } from '../src/calendar.js';
import { computeMirror } from '../src/mirror.js';
import { TERMS } from '../src/policy.js';
import { loadUniverse, readWallet } from '../src/read.js';
import { ADDRESSES, CRYPTO } from '../src/registry.js';
import { replaying, type RecordedBatch } from './replay.js';
import { assertMatches } from './matches.js';

// Real Base answers for the burn address (not a person's wallet), captured on Sunday
// 2026-10-25 at block 53,075,866 by Still's capture script, before the move. Recapture after
// changing what is read.
// USDC balanceOf for that same public burn address was added from its original
// pinned block on 2026-10-28; the prior raw results are retained byte for byte.
// Recaptured at the same pinned block on 2026-11-05, when SPCXc joined the stocks and the read
// gained the position's stored risk premium: all 142 earlier calls answered byte for byte as
// recorded, and three were new (the wallet's SPCXc, Coinbase's registry for it, the premium).
// Recaptured there again on 2026-11-07, when PAXG joined on Morpho (test/capture.ts): all 145
// earlier calls answered as recorded, and two were new, the wallet's PAXG and the PAXG market's
// parameters. That market was created on 2026-10-27, after this block, so its parameters answer
// zeros and the registry check closes it, as it would close any market that is not the one we name.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/burn-address.json', import.meta.url), 'utf8')) as {
  address: Address;
  block: string;
  batches: RecordedBatch[];
};

// Aave's earnings calendar as it answered later that Sunday (18:08 UTC); no window was open then.
const calendarAnswer = readFileSync(new URL('./fixtures/aave-calendar.json', import.meta.url), 'utf8');

async function replay() {
  const provider = replaying(fixture.batches);
  const universe = await loadUniverse([provider]);
  const snapshot = await readWallet([provider], universe, fixture.address);
  const calendar = await readCalendar('https://api.test/graphql', async () => new Response(calendarAnswer), new Date('2026-10-25T18:08:00Z'), 1_000);
  const report = computeMirror({
    universe,
    snapshot,
    calendar: { ok: true, calendar },
    subject: { address: fixture.address, name: null, input: fixture.address },
    assembledAt: new Date('2026-10-25T15:11:21Z'),
  });
  return { universe, snapshot, report };
}

describe('a real read, replayed from raw Multicall3 bytes', () => {
  it('finds the venues the registry expects, and nothing else', async () => {
    const { universe } = await replay();
    if (!universe.aave.ok) throw new Error(`aave: ${universe.aave.problem}`);
    assert.deepEqual(universe.aave.reserves.map((r) => (r.role.kind === 'stock' ? r.role.asset.id : r.role.kind)), [
      'AAPLc', 'AMZNc', 'GOOGLc', 'METAc', 'MSFTc', 'NVDAc', 'TSLAc', 'usdc',
    ]);
    assert.equal(universe.aave.oracleDecimals, 8);
    assert.deepEqual(universe.morpho.map((m) => (m.ok ? m.market.params.lltv : m.problem)), [860_000_000_000_000_000n, 860_000_000_000_000_000n, 'market_mismatch']);
  });

  it('reads one block for everything', async () => {
    const { snapshot } = await replay();
    assert.equal(snapshot.block.number.toString(), fixture.block);
    assert.equal(fixture.batches.filter((b) => b.blockNumber !== null).every((b) => b.blockNumber === fixture.block), true);
    assert.equal(snapshot.balances.get(ADDRESSES.usdc.toLowerCase())?.ok, true);
    // USDC, cbBTC, WETH, PAXG and the eight stocks.
    assert.equal(snapshot.balances.size, 12);
  });

  it('can pin the initial wallet batch and refuses a provider answering another block', async () => {
    const provider = replaying(fixture.batches);
    const universe = await loadUniverse([provider]);
    const pinned = await readWallet([provider], universe, fixture.address, BigInt(fixture.block));
    assert.equal(pinned.block.number, BigInt(fixture.block));
    await assert.rejects(readWallet([provider], universe, fixture.address, BigInt(fixture.block) + 1n), /requested block/);
  });

  it('gives the same report it gave that Sunday', async () => {
    const { report } = await replay();
    assert.equal(report.terms.weekend.active, true);
    assert.deepEqual(report.headline, { state: 'funded', availableCents: '871518', complete: true, reason: null, weekdayAvailableCents: '875674' });
    assert.deepEqual(report.coverage.failed, []);
    const byAsset = Object.fromEntries(report.assets.map((l) => [l.asset, l]));
    assertMatches(byAsset.AAPLc, { capacityCents: '16055', priceCents: '34733', priceUpdatedAt: '2026-10-23T14:25:55.000Z', stillFactorBps: 3120 });
    // Apple reports on Monday Nov 2: its window opens Sunday Nov 1 at 00:00 New York, a week later.
    assert.deepEqual(byAsset.AAPLc!.earnings, {
      source: 'calendar',
      reportDate: '2026-11-02',
      window: { startsAt: '2026-11-01T04:00:00.000Z', endsAt: '2026-11-04T01:00:00.000Z' },
      lowered: false,
    });
    // Dividends raised NVDAc's multiplier: 0.09497630 tokens are 0.09502739 shares.
    assertMatches(byAsset.NVDAc, { wallet: { raw: '9497630', decimals: 8 }, shares: { raw: '9502739', decimals: 8 }, capacityCents: '562' });
    assertMatches(byAsset.ETH, { capacityCents: '854568', limits: ['gas_reserve'] });
    assert.deepEqual(report.venues.map((v) => [v.label, v.debtCents, v.availableCents]), [
      ['Aave V4 · Coinbase Stocks', '0', '16618'],
      ['Morpho · cbBTC/USDC', '0', '332'],
      ['Morpho · WETH/USDC', '0', '854568'],
    ]);
  });

  it('what Still offers on Morpho, the borrow review accepts at twice the contract’s minimum health', async () => {
    // Miorail's borrow review checks a borrow with morphoAfterBorrowV1. Pledge what the Mirror
    // counted, borrow exactly what it offers, on the same block's totals.
    const { snapshot, report } = await replay();
    for (const asset of CRYPTO) {
      // PAXG's market did not exist yet at this block: no market, so nothing offered there.
      if (asset.id === 'PAXG') {
        assert.equal(snapshot.morpho.get(asset.id), null);
        assert.equal(report.venues.some((v) => v.market === asset.morphoMarket), false);
        continue;
      }
      const market = snapshot.morpho.get(asset.id)!;
      if (!market.market.ok || !market.price.ok || !market.borrowRatePerSecond.ok || !market.position.ok) throw new Error(asset.id);
      const token = snapshot.balances.get(asset.token.toLowerCase());
      if (!token?.ok || !snapshot.nativeEth.ok) throw new Error(asset.id);
      const native = asset.includesNativeEth ? snapshot.nativeEth.value - TERMS.ethGasReserveWei : 0n;
      const totals = morphoAccruedTotalsV1(market.market.value, market.borrowRatePerSecond.value, snapshot.block.timestamp);
      const offered = BigInt(report.venues.find((v) => v.market === asset.morphoMarket)!.availableCents!) * 10_000n;
      assert.ok(offered > 0n, asset.id);
      const after = morphoAfterBorrowV1({
        market: {
          collateralPrice: market.price.value,
          lltvWad: market.info.params.lltv,
          totalSupplyAssets: totals.totalSupplyAssets,
          totalBorrowAssets: totals.totalBorrowAssets,
          totalBorrowShares: totals.totalBorrowShares,
          blockNumber: Number(snapshot.block.number),
        },
        position: { collateral: market.position.value.collateral + token.value + native, borrowShares: market.position.value.borrowShares },
        assets: offered,
      });
      assert.ok(after?.health.healthy, asset.id);
      // Still lends half of what the contract allows: health factor 2, less a unit of rounding.
      assert.ok(after!.health.healthFactorWad! >= 1_999_999n * 10n ** 12n, `${asset.id} ${after!.health.healthFactorWad}`);
    }
  });
});
