import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Address } from 'viem';
import { readCalendar } from '../src/calendar.js';
import { computeMirror } from '../src/mirror.js';
import { loadUniverse, readWallet } from '../src/read.js';
import { replaying, type RecordedBatch } from './replay.js';
import { assertMatches } from './matches.js';

// Real Base answers for the burn address (not a person's wallet), captured on Sunday
// 2026-10-25 at block 53,075,866 by Still's capture script, before the move. Recapture after
// changing what is read.
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
    assert.deepEqual(universe.morpho.map((m) => m.ok && m.market.params.lltv), [860_000_000_000_000_000n, 860_000_000_000_000_000n]);
  });

  it('reads one block for everything', async () => {
    const { snapshot } = await replay();
    assert.equal(snapshot.block.number.toString(), fixture.block);
    assert.equal(fixture.batches.filter((b) => b.blockNumber !== null).every((b) => b.blockNumber === fixture.block), true);
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
});
