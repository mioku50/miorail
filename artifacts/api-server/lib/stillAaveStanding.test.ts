import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADDRESSES } from '@mioagent/still-engine/registry';
import { calendar } from '../../../lib/still-engine/test/fixtures.js';
import { aaveReadFixture, AAVE_TEST_WALLET } from './aaveV4BorrowFixtures.testhelper.js';
import { readAaveStandingV1, readStillAaveStandingV1, stillAaveCapacityV1 } from './stillAaveStanding.js';

const input = (r = aaveReadFixture()) => ({ walletAddress: AAVE_TEST_WALLET, operation: 'borrow' as const, stockId: 'NVDAc' as const, collateralSupplyAssets: BigInt(0),
  deps: { now: () => new Date('2026-10-21T15:00:00Z'), snapshot: async () => r, calendar: async () => calendar() } });
describe('Still Aave bounded same-block standing', () => {
  it('counts only pledged/enabled stock and explicitly selected wallet supply', async () => {
    const base = input(), r = await readStillAaveStandingV1(base), extra = await readStillAaveStandingV1({ ...base, collateralSupplyAssets: BigInt(100_000_000) });
    assert.equal(r.state, 'read'); assert.equal(extra.state, 'read'); if (r.state !== 'read' || extra.state !== 'read') return;
    assert(r.standing.capacity!.limitAssets > BigInt(0));
    assert(extra.standing.capacity!.limitAssets > r.standing.capacity!.limitAssets);
    const unchanged = aaveReadFixture(); unchanged.snapshot.balances.set(ADDRESSES.cbbtc.toLowerCase(), { ok: true, value: BigInt(100_000_000_000) });
    const otherWallet = await readStillAaveStandingV1(input(unchanged)); assert.equal(otherWallet.state, 'read');
    if (otherWallet.state === 'read') assert.equal(otherWallet.standing.capacity!.limitAssets, r.standing.capacity!.limitAssets);
  });
  it('uses 40 percent for unread earnings and a closed-market window', () => {
    const r = aaveReadFixture(), common = { ...r, selectedStockId: 'NVDAc' as const, additionalCollateralAssets: BigInt(0) };
    const day = stillAaveCapacityV1({ ...common, calendar: calendar(), now: new Date('2026-10-21T15:00:00Z') });
    const unread = stillAaveCapacityV1({ ...common, calendar: { ok: false }, now: new Date('2026-10-21T15:00:00Z') });
    const weekend = stillAaveCapacityV1({ ...common, calendar: calendar(), now: new Date('2026-10-24T15:00:00Z') });
    assert.equal(day.shareBpsByStock.NVDAc, 5000); assert.equal(unread.shareBpsByStock.NVDAc, 4000); assert.equal(weekend.shareBpsByStock.NVDAc, 4000);
    assert(unread.limitAssets < day.limitAssets);
  });
  it('does not require a health factor, oracle or borrow allowance for repayment', async () => {
    const r = aaveReadFixture(); if (!r.snapshot.aave) throw Error('fixture');
    r.snapshot.aave.account = { ok: false, reason: 'reverted' };
    for (const reserve of r.snapshot.aave.reserves) reserve.price = { ok: false, reason: 'reverted' };
    const result = await readStillAaveStandingV1({ ...input(r), operation: 'repay' });
    assert.equal(result.state, 'read'); if (result.state === 'read') { assert.equal(result.standing.capacity, null); assert.equal(result.standing.debtAssets, BigInt(10_000_000)); }
  });
  it('refuses missing required balances, changed deployment and unknown reserves', async () => {
    const noUsdc = aaveReadFixture(); noUsdc.snapshot.balances.delete(ADDRESSES.usdc.toLowerCase());
    assert.equal((await readStillAaveStandingV1(input(noUsdc))).state, 'refused');
    const changed = aaveReadFixture(); changed.deployment.implementationAddress = ADDRESSES.usdc;
    assert.equal((await readStillAaveStandingV1(input(changed))).state, 'refused');
    const foreign = aaveReadFixture(); foreign.reserves[0]!.underlying = ADDRESSES.cbbtc;
    assert.equal((await readStillAaveStandingV1(input(foreign))).state, 'refused');
  });
  it('the address entry accepts an exact stock and USDC-only repayment', async () => {
    const r = aaveReadFixture(), base = input(r), stock = r.reserves.find(s => s.reserveId === 5)!;
    assert.equal((await readAaveStandingV1({ walletAddress: AAVE_TEST_WALLET, tokenAddress: stock.underlying, operation: 'borrow', deps: base.deps })).state, 'read');
    assert.equal((await readAaveStandingV1({ walletAddress: AAVE_TEST_WALLET, tokenAddress: ADDRESSES.usdc, operation: 'repay', deps: base.deps })).state, 'read');
    assert.equal((await readAaveStandingV1({ walletAddress: AAVE_TEST_WALLET, tokenAddress: ADDRESSES.cbbtc, operation: 'borrow', deps: base.deps })).state, 'refused');
  });
});
