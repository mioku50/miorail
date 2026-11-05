import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';
import { buildAaveV4PoststateProbesV1, verifyAaveV4PoststateV1 } from './aaveV4BorrowPoststate.js';
import { aaveReadFixture, aaveRepaidReadFixture, aaveStandingFixture, aavePoststateFixture, withUnmodeledReserves } from './aaveV4BorrowFixtures.testhelper.js';

describe('Aave independent whole-Spoke same-state proof', () => {
  it('keeps the cross-collateral account bounded within eight aggregate probes', async () => {
    const s = await aaveStandingFixture(), p = buildAaveV4PoststateProbesV1(s, 'borrow'); assert(p.ok); if (!p.ok) return;
    assert(p.observations.before.length <= 8); assert(p.observations.before.every(row => row.data.length <= 8194 && row.to === ADDRESSES.multicall3.toLowerCase()));
  });
  it('a reserve Still does not model rides the same bounded proof, and the borrow still proves', async () => {
    const s = await aaveStandingFixture('borrow', withUnmodeledReserves(aaveReadFixture())), p = buildAaveV4PoststateProbesV1(s, 'borrow');
    assert(p.ok); if (!p.ok) return;
    // The eight stocks, USDC and the one Still does not model.
    assert.equal(s.reserves.length, STOCKS.length + 2); assert(p.observations.before.length <= 8);
    const amount = BigInt(10_000_000), fixture = aavePoststateFixture(s, 'borrow', amount);
    const r = verifyAaveV4PoststateV1({ ...fixture, expected: { standing: s, operation: 'borrow', borrowAssets: amount } });
    assert.equal(r.ok, true, !r.ok ? r.detail : '');
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

describe('Aave same-state proof of repaying all and taking the stock back', () => {
  const max = BigInt(20_000_000);
  it('proves the full repayment, the whole deposit leaving for the wallet, the refreshed key and a zero premium', async () => {
    const read = aaveReadFixture(), s0 = await aaveStandingFixture('repay', read);
    // A stale key on the stock's own position: the deployed withdrawal refreshes it to the latest.
    read.positions.find(p => p.reserveId === s0.collateralReserve!.reserveId)!.dynamicConfigKey += 1;
    const s = await aaveStandingFixture('repay', read), deposit = s.existingSuppliedAssets;
    const f = aavePoststateFixture(s, 'repay', max, (p, after) => { if (!after) p.riskPremium = BigInt(1000); }, true);
    const r = verifyAaveV4PoststateV1({ ...f, expected: { standing: s, operation: 'repay', maximumRepayAssets: max, fullRepay: true, returnCollateralAssets: deposit } });
    assert(r.ok, !r.ok ? r.detail : ''); if (!r.ok) return;
    assert.equal(r.after.selectedSuppliedAssets, BigInt(0)); assert.equal(r.after.walletCollateralAssets - r.before.walletCollateralAssets, deposit);
    assert.equal(r.usdcMovedAssets, s.debtAssets); assert.equal(r.after.debtAssets, BigInt(0)); assert.equal(r.after.riskPremium, BigInt(0));
    const kept = aavePoststateFixture(s, 'repay', max, (p, after) => { if (after) p.positions.get(s.collateralReserve!.reserveId)!.dynamicConfigKey = s.collateralReserve!.dynamicConfigKey + 1; }, true);
    assert(!verifyAaveV4PoststateV1({ ...kept, expected: { standing: s, operation: 'repay', maximumRepayAssets: max, fullRepay: true, returnCollateralAssets: deposit } }).ok);
  });
  it('refuses dust left behind, a stock that does not arrive, a premium kept and any other debt', async () => {
    const s = await aaveStandingFixture('repay'), id = s.collateralReserve!.reserveId, token = s.selectedStock!.token.toLowerCase();
    for (const mutation of ['dust', 'arrival', 'premium'] as const) {
      const f = aavePoststateFixture(s, 'repay', max, (p, after) => { if (!after) return;
        if (mutation === 'dust') { p.positions.get(id)!.suppliedShares = BigInt(1); p.supplied.set(id, BigInt(1)); }
        if (mutation === 'arrival') p.wallets.set(token, p.wallets.get(token)! - BigInt(1));
        if (mutation === 'premium') p.riskPremium = BigInt(5);
      }, true);
      assert(!verifyAaveV4PoststateV1({ ...f, expected: { standing: s, operation: 'repay', maximumRepayAssets: max, fullRepay: true, returnCollateralAssets: s.existingSuppliedAssets } }).ok, mutation);
    }
    const read = aaveReadFixture(); read.positions[0]!.drawnShares = BigInt(1);
    const other = await aaveStandingFixture('repay', read);
    const f = aavePoststateFixture(other, 'repay', max, p => { p.debts.set(0, BigInt(1)); }, true);
    const r = verifyAaveV4PoststateV1({ ...f, expected: { standing: other, operation: 'repay', maximumRepayAssets: max, fullRepay: true, returnCollateralAssets: other.existingSuppliedAssets } });
    assert(!r.ok); if (!r.ok) assert.equal(r.refusal, 'aave_poststate_debt_mismatch');
    const partial = aavePoststateFixture(s, 'repay', max, undefined, true);
    assert(!verifyAaveV4PoststateV1({ ...partial, expected: { standing: s, operation: 'repay', maximumRepayAssets: max, returnCollateralAssets: s.existingSuppliedAssets } }).ok);
  });
  it('with no debt left proves the withdrawal alone, and refuses any USDC that moves', async () => {
    const s = await aaveStandingFixture('repay', aaveRepaidReadFixture());
    const expected = { standing: s, operation: 'repay' as const, maximumRepayAssets: BigInt(0), fullRepay: true, returnCollateralAssets: s.existingSuppliedAssets };
    const f = aavePoststateFixture(s, 'repay', BigInt(0), undefined, true), r = verifyAaveV4PoststateV1({ ...f, expected });
    assert(r.ok, !r.ok ? r.detail : ''); if (r.ok) { assert.equal(r.usdcMovedAssets, BigInt(0)); assert.equal(r.after.selectedSuppliedAssets, BigInt(0)); }
    const usdc = ADDRESSES.usdc.toLowerCase();
    const moved = aavePoststateFixture(s, 'repay', BigInt(0), (p, after) => { if (after) p.wallets.set(usdc, p.wallets.get(usdc)! - BigInt(1)); }, true);
    assert(!verifyAaveV4PoststateV1({ ...moved, expected }).ok);
    assert(!verifyAaveV4PoststateV1({ ...f, expected: { ...expected, maximumRepayAssets: BigInt(1) } }).ok);
  });
  it('in steps a Repay all with a buffer leaves the rest of the allowance with the Spoke, which one batch never does', async () => {
    const s = await aaveStandingFixture('repay');
    const f = aavePoststateFixture(s, 'repay', max, (p, after) => { if (after) p.allowance = max - s.debtAssets; });
    const expected = { standing: s, operation: 'repay' as const, maximumRepayAssets: max, fullRepay: true };
    assert(verifyAaveV4PoststateV1({ ...f, expected: { ...expected, sequential: true } }).ok);
    assert(!verifyAaveV4PoststateV1({ ...f, expected }).ok);
    const cleared = aavePoststateFixture(s, 'repay', max);
    assert(verifyAaveV4PoststateV1({ ...cleared, expected }).ok);
    assert(!verifyAaveV4PoststateV1({ ...cleared, expected: { ...expected, sequential: true } }).ok);
  });
});
