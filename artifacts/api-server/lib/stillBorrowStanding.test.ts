import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { morphoAccruedTotalsV1, toAssetsUpV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import { snapshot, universe, reverted } from '../../../lib/still-engine/test/fixtures.js';
import { readBorrowStandingV1, stillBorrowCapacityWireV1 } from './stillBorrowStanding.js';

const WALLET = `0x${'1'.repeat(40)}`;
function readFixture() {
  return { universe: universe(), snapshot: snapshot({ wallet: { cbBTC: 10_000_000n }, morpho: { cbBTC: { collateral: 1_000_000n, borrowShares: 1_000_000n } } }) };
}

describe('Still execution reads the registered market, on chain', () => {
  it('uses exact parameters and accrued totals; does not pledge wallet balances or claim APR is APY', async () => {
    const read = readFixture();
    read.snapshot.block.timestamp += 3600n;
    const result = await readBorrowStandingV1({ tokenAddress: ADDRESSES.cbbtc, walletAddress: WALLET,
      deps: { snapshot: async (wallet) => { assert.equal(wallet, WALLET); return read; } } });
    assert.equal(result.state, 'read');
    if (result.state !== 'read') return;
    assert.equal(result.markets.length, 1);
    const standing = result.markets[0]!;
    const source = read.snapshot.morpho.get('cbBTC')!;
    assert(source.market.ok && source.borrowRatePerSecond.ok);
    const accrued = morphoAccruedTotalsV1(source.market.value, source.borrowRatePerSecond.value, read.snapshot.block.timestamp);
    assert.equal(standing.market.marketId, CRYPTO[0]!.morphoMarket);
    assert.equal(standing.position!.collateral, 1_000_000n);
    assert.equal(standing.market.curated, null);
    assert.equal(standing.market.borrowApyWad, null);
    assert.equal(standing.market.borrowAprWad, source.borrowRatePerSecond.value * 31_536_000n);
    assert.equal(standing.market.state.totalBorrowAssets, accrued.totalBorrowAssets);
    assert.equal(standing.health!.borrowedAssets, toAssetsUpV1(1_000_000n, accrued.totalBorrowAssets, accrued.totalBorrowShares));
    assert.equal(standing.market.state.blockNumber, Number(read.snapshot.block.number));
    const still = stillBorrowCapacityWireV1(ADDRESSES.cbbtc, standing)!;
    assert.equal(still.scope, 'existing_collateral');
    assert.equal(still.shareBps, 5000);
    assert(BigInt(still.availableAtomic) < standing.capacity!.assets);
    assert.equal(stillBorrowCapacityWireV1(ADDRESSES.weth, standing), null);
  });
  for (const field of ['position', 'price', 'market', 'borrowRatePerSecond'] as const) {
    it(`refuses an unread ${field} without replacing it by zero`, async () => {
      const read = readFixture();
      const source = read.snapshot.morpho.get('cbBTC')!;
      Object.assign(source, { [field]: reverted() });
      const result = await readBorrowStandingV1({ tokenAddress: ADDRESSES.cbbtc, walletAddress: WALLET, deps: { snapshot: async () => read } });
      assert.equal(result.state, 'refused');
      assert.equal('markets' in result, false);
    });
  }
  it('refuses a different loan asset or market even if a snapshot was otherwise readable', async () => {
    const read = readFixture();
    read.snapshot.morpho.get('cbBTC')!.info = { ...read.snapshot.morpho.get('cbBTC')!.info,
      params: { ...read.snapshot.morpho.get('cbBTC')!.info.params, loanToken: ADDRESSES.weth } };
    const result = await readBorrowStandingV1({ tokenAddress: ADDRESSES.cbbtc, walletAddress: WALLET, deps: { snapshot: async () => read } });
    assert.equal(result.state, 'refused');
  });
  it('transport failure is our reading failure, not no collateral', async () => {
    const result = await readBorrowStandingV1({ tokenAddress: ADDRESSES.weth, walletAddress: WALLET,
      deps: { snapshot: async () => { throw new Error('private RPC unavailable'); } } });
    assert.equal(result.state, 'refused');
    if (result.state === 'refused') { assert.equal(result.refusal, 'venue_unread'); assert.doesNotMatch(result.detail!, /private RPC/); }
  });
});
