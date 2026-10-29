import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADDRESSES } from '@mioagent/still-engine/registry';
import { buildAaveV4PoststateProbesV1, verifyAaveV4PoststateV1 } from './aaveV4BorrowPoststate.js';
import { aaveReadFixture, aaveStandingFixture, aavePoststateFixture } from './aaveV4BorrowFixtures.testhelper.js';

describe('Aave independent whole-Spoke same-state proof', () => {
  it('keeps the cross-collateral account bounded within eight aggregate probes', async () => {
    const s = await aaveStandingFixture(), p = buildAaveV4PoststateProbesV1(s, 'borrow'); assert(p.ok); if (!p.ok) return;
    assert(p.observations.before.length <= 8); assert(p.observations.before.every(row => row.data.length <= 8194 && row.to === ADDRESSES.multicall3.toLowerCase()));
  });
  it('proves exact selected supply, USDC arrival, debt shares and Still allowance', async () => {
    const s = await aaveStandingFixture(), amount = BigInt(10_000_000), fixture = aavePoststateFixture(s, 'borrow', amount);
    const r = verifyAaveV4PoststateV1({ ...fixture, expected: { standing: s, operation: 'borrow', borrowAssets: amount } });
    assert.equal(r.ok, true, !r.ok ? r.detail : ''); if (r.ok) {
      assert.equal(r.usdcMovedAssets, amount); assert.equal(r.after.debtAssets, s.debtAssets + amount);
      assert.equal(r.after.walletCollateralAssets, BigInt(0)); assert(r.after.debtAssets <= r.capacity!.limitAssets);
    }
  });
  it('binds chain, owner, calls hash and getter order', async () => {
    const s = await aaveStandingFixture(), amount = BigInt(10_000_000), f = aavePoststateFixture(s, 'borrow', amount), expected = { standing: s, operation: 'borrow' as const, borrowAssets: amount };
    for (const request of [{ ...f.request, chainId: 1 }, { ...f.request, walletAddress: ADDRESSES.usdc }, { ...f.request, callsHash: `0x${'ff'.repeat(32)}` }]) assert(!verifyAaveV4PoststateV1({ request, response: f.response, expected }).ok);
    const response = structuredClone(f.response); response.observations.results.reverse(); assert(!verifyAaveV4PoststateV1({ request: f.request, response, expected }).ok);
  });
  it('refuses collateral theft, an extra debt, price change, malformed return and underpayment', async () => {
    const s = await aaveStandingFixture(), amount = BigInt(10_000_000);
    for (const mutation of ['stock', 'debt', 'price', 'usdc']) {
      const f = aavePoststateFixture(s, 'borrow', amount, (p, after) => { if (!after) return;
        if (mutation === 'stock') p.wallets.set(ADDRESSES.cbbtc.toLowerCase(), BigInt(0));
        if (mutation === 'debt') p.debts.set(0, BigInt(1));
        if (mutation === 'price') p.priceChange = true;
        if (mutation === 'usdc') p.wallets.set(ADDRESSES.usdc.toLowerCase(), p.wallets.get(ADDRESSES.usdc.toLowerCase())! - BigInt(1));
        if (mutation === 'stock') p.wallets.set(s.selectedStock!.token.toLowerCase(), BigInt(1));
      });
      assert(!verifyAaveV4PoststateV1({ ...f, expected: { standing: s, operation: 'borrow', borrowAssets: amount } }).ok, mutation);
    }
    const f = aavePoststateFixture(s, 'borrow', amount); f.response.observations.results[0]!.returnData += '00';
    assert(!verifyAaveV4PoststateV1({ ...f, expected: { standing: s, operation: 'borrow', borrowAssets: amount } }).ok);
  });
  it('refuses a simulated healthy borrow beyond Still’s lower whole-account limit', async () => {
    const s = await aaveStandingFixture(), amount = BigInt(200_000_000), f = aavePoststateFixture(s, 'borrow', amount);
    const r = verifyAaveV4PoststateV1({ ...f, expected: { standing: s, operation: 'borrow', borrowAssets: amount } });
    assert(!r.ok); if (!r.ok) assert.equal(r.refusal, 'aave_poststate_policy_refused');
  });
  it('partial and full repayment preserve collateral and stay under the USDC maximum', async () => {
    const s = await aaveStandingFixture('repay');
    for (const amount of [BigInt(4_000_000), BigInt(12_000_000)]) {
      const f = aavePoststateFixture(s, 'repay', amount), r = verifyAaveV4PoststateV1({ ...f, expected: { standing: s, operation: 'repay', maximumRepayAssets: amount, fullRepay: amount > s.debtAssets } });
      assert(r.ok, !r.ok ? r.detail : ''); if (r.ok) { assert(r.after.debtAssets < r.before.debtAssets); assert.equal(r.after.selectedSuppliedAssets, r.before.selectedSuppliedAssets); assert(r.usdcMovedAssets <= amount); }
    }
  });
  it('does not advertise full repayment while any debt remains', async () => {
    const s = await aaveStandingFixture('repay'), amount = BigInt(4_000_000), f = aavePoststateFixture(s, 'repay', amount);
    const r = verifyAaveV4PoststateV1({ ...f, expected: { standing: s, operation: 'repay', maximumRepayAssets: amount, fullRepay: true } }); assert(!r.ok);
  });
  it('accepts premium-only reduction with unchanged principal shares and no oracle probe', async () => {
    const read = aaveReadFixture(), RAY = BigInt(10) ** BigInt(27), loan = read.positions.find(p => p.reserveId === 7)!;
    loan.premiumShares = BigInt(1_000_000); loan.premiumOffsetRay = -BigInt(2_000_000) * RAY;
    read.snapshot.aave!.usdcDebt = { ok: true, value: BigInt(13_000_000) };
    read.snapshot.aave!.account = { ok: false, reason: 'reverted' };
    for (const reserve of read.snapshot.aave!.reserves) reserve.price = { ok: false, reason: 'reverted' };
    const s = await aaveStandingFixture('repay', read), amount = BigInt(1_000_000), f = aavePoststateFixture(s, 'repay', amount, (p, after) => { if (!after) p.riskPremium = BigInt(1000); });
    const r = verifyAaveV4PoststateV1({ ...f, expected: { standing: s, operation: 'repay', maximumRepayAssets: amount } });
    assert(r.ok, !r.ok ? r.detail : ''); if (r.ok) { assert.equal(r.after.reserves.get(7)!.position.drawnShares, r.before.reserves.get(7)!.position.drawnShares); assert.equal(r.before.debtAssets - r.after.debtAssets, amount); }
  });
  it('does not block USDC repayment because another registered debt is unchanged', async () => {
    const read = aaveReadFixture(); read.positions[0]!.drawnShares = BigInt(1);
    const s = await aaveStandingFixture('repay', read), amount = BigInt(4_000_000);
    const f = aavePoststateFixture(s, 'repay', amount, p => { p.debts.set(0, BigInt(1)); });
    const r = verifyAaveV4PoststateV1({ ...f, expected: { standing: s, operation: 'repay', maximumRepayAssets: amount } });
    assert(r.ok, !r.ok ? r.detail : '');
  });
});
