import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData } from 'viem';
import { ADDRESSES } from '@mioagent/still-engine/registry';
import { aaveV4BorrowPlanV1, aaveV4RepayPlanV1, aaveV4WriteAbiV1, matchesAaveV4CanonicalCallsV1, matchesAaveV4DeploymentV1 } from './aaveV4BorrowPlan.js';
import { aaveStandingFixture } from './aaveV4BorrowFixtures.testhelper.js';

async function input() {
  const s = await aaveStandingFixture();
  return { walletAddress: s.walletAddress, stockId: s.selectedStock!.id, collateralReserve: s.collateralReserve!, loanReserve: s.loanReserve,
    collateralSupplyAssets: s.collateralSupplyAssets, borrowAssets: BigInt(10_000_000), walletCollateralAssets: s.walletCollateralAssets,
    existingSuppliedAssets: s.existingSuppliedAssets, collateralAlreadyEnabled: false, deployment: s.deployment };
}
describe('Aave V4 code-owned atomic plan', () => {
  it('resets, bounds and clears allowance; supplies, enables and borrows only for the owner', async () => {
    const i = await input(), r = aaveV4BorrowPlanV1(i); assert.equal(r.ok, true); if (!r.ok) return;
    assert.equal(r.plan.forceAtomic, true); assert.deepEqual(r.plan.authorizations, []);
    assert.equal(r.plan.calls.length, 6); assert(r.plan.calls.every(c => c.valueWei === '0'));
    const approvals = r.plan.calls.filter(c => c.callType === 'approval');
    assert.deepEqual(approvals.map(c => c.amountAtomic), ['0', i.collateralSupplyAssets.toString(), '0']);
    assert(approvals.every(c => c.spender === ADDRESSES.aaveSpoke.toLowerCase()));
    const methods = r.plan.calls.filter(c => c.to === ADDRESSES.aaveSpoke.toLowerCase()).map(c => decodeFunctionData({ abi: aaveV4WriteAbiV1, data: c.data }));
    assert.deepEqual(methods.map(c => c.functionName), ['supply', 'setUsingAsCollateral', 'borrow']);
    assert(methods.every(c => c.args[2]!.toString().toLowerCase() === i.walletAddress.toLowerCase()));
    assert(matchesAaveV4CanonicalCallsV1(r.plan, r.plan.calls));
    assert(!matchesAaveV4CanonicalCallsV1(r.plan, r.plan.calls.map((c, n) => n === 0 ? { ...c, valueWei: '1' } : c)));
  });
  it('existing enabled collateral produces one direct borrow and no approval or new supply', async () => {
    const i = await input(), r = aaveV4BorrowPlanV1({ ...i, collateralSupplyAssets: BigInt(0), collateralAlreadyEnabled: true });
    assert.equal(r.ok, true); if (r.ok) assert.deepEqual(r.plan.calls.map(c => c.callType), ['other']);
  });
  it('refuses a new implementation, proxy runtime or chain', async () => {
    const i = await input();
    for (const change of [{ chainId: 1 }, { implementationAddress: ADDRESSES.usdc }, { proxyCodeHash: `0x${'00'.repeat(32)}` }, { implementationCodeHash: `0x${'00'.repeat(32)}` }]) {
      assert(!matchesAaveV4DeploymentV1({ ...i.deployment, ...change }));
      assert(!aaveV4BorrowPlanV1({ ...i, deployment: { ...i.deployment, ...change } }).ok);
    }
  });
  it('refuses a copied symbol, changed reserve/hub/decimals and duplicate loan reserve', async () => {
    const i = await input();
    for (const reserve of [{ ...i.collateralReserve, underlying: ADDRESSES.usdc }, { ...i.collateralReserve, hub: ADDRESSES.morpho },
      { ...i.collateralReserve, decimals: 18 }, { ...i.collateralReserve, reserveId: i.loanReserve.reserveId }]) assert(!aaveV4BorrowPlanV1({ ...i, collateralReserve: reserve }).ok);
  });
  it('refuses zero/negative amounts and a pledge outside the measured wallet', async () => {
    const i = await input();
    for (const patch of [{ borrowAssets: BigInt(0) }, { collateralSupplyAssets: -BigInt(1) }, { collateralSupplyAssets: i.walletCollateralAssets + BigInt(1) },
      { collateralSupplyAssets: BigInt(0), existingSuppliedAssets: BigInt(0) }]) assert(!aaveV4BorrowPlanV1({ ...i, ...patch }).ok);
  });
  it('repay uses the exact USDC maximum, no unlimited sentinel, no collateral or manager actions', async () => {
    const s = await aaveStandingFixture('repay'), r = aaveV4RepayPlanV1({ walletAddress: s.walletAddress, loanReserve: s.loanReserve,
      maximumRepayAssets: BigInt(4_000_000), walletUsdcAssets: s.walletUsdcAssets, deployment: s.deployment });
    assert.equal(r.ok, true); if (!r.ok) return;
    assert.equal(r.plan.calls.length, 4); assert.deepEqual(r.plan.calls.filter(c => c.callType === 'approval').map(c => c.amountAtomic), ['0', '4000000', '0']);
    const method = decodeFunctionData({ abi: aaveV4WriteAbiV1, data: r.plan.calls[2]!.data });
    assert.equal(method.functionName, 'repay'); assert.equal(method.args[1], BigInt(4_000_000));
    assert(r.plan.calls.every(c => c.to === ADDRESSES.usdc.toLowerCase() || c.to === ADDRESSES.aaveSpoke.toLowerCase()));
  });
});

describe('Aave V4 plan in steps, for a wallet that cannot send a batch', () => {
  it('asks for exactly the pledge once, then supply, enable and borrow, and no allowance resets', async () => {
    const i = await input(), r = aaveV4BorrowPlanV1({ ...i, delivery: 'sequential', allowanceAssets: 0n });
    assert.equal(r.ok, true); if (!r.ok) return;
    assert.equal(r.plan.forceAtomic, false);
    assert.deepEqual(r.plan.calls.map(c => c.callType), ['approval', 'deposit', 'other', 'other']);
    assert.equal(r.plan.calls[0]!.amountAtomic, i.collateralSupplyAssets.toString());
    assert.match(r.plan.steps[0]!.reading, /the next step uses exactly this allowance/);
    const methods = r.plan.calls.slice(1).map(c => decodeFunctionData({ abi: aaveV4WriteAbiV1, data: c.data }).functionName);
    assert.deepEqual(methods, ['supply', 'setUsingAsCollateral', 'borrow']);
    // The same supply and borrow calldata as the batch: only the allowance housekeeping differs.
    const atomic = aaveV4BorrowPlanV1(i);
    assert.ok(atomic.ok);
    if (atomic.ok) assert.deepEqual(r.plan.calls.slice(1).map(c => c.data), atomic.plan.calls.slice(2, 5).map(c => c.data));
  });
  it('an allowance already exactly in place is not asked again; any other is set exactly', async () => {
    const i = await input();
    const kept = aaveV4BorrowPlanV1({ ...i, delivery: 'sequential', allowanceAssets: i.collateralSupplyAssets, collateralAlreadyEnabled: true });
    assert.ok(kept.ok); if (kept.ok) assert.deepEqual(kept.plan.calls.map(c => c.callType), ['deposit', 'other']);
    const larger = aaveV4BorrowPlanV1({ ...i, delivery: 'sequential', allowanceAssets: i.collateralSupplyAssets + 1n });
    assert.ok(larger.ok); if (larger.ok) assert.equal(larger.plan.calls[0]!.amountAtomic, i.collateralSupplyAssets.toString());
    // Steps need the allowance read at the same block.
    assert.equal(aaveV4BorrowPlanV1({ ...i, delivery: 'sequential' }).ok, false);
  });
  it('repay in steps: the exact maximum as one allowance, then repay; none again when it is in place', async () => {
    const s = await aaveStandingFixture('repay');
    const base = { walletAddress: s.walletAddress, loanReserve: s.loanReserve, maximumRepayAssets: BigInt(4_000_000), walletUsdcAssets: s.walletUsdcAssets, deployment: s.deployment };
    const steps = aaveV4RepayPlanV1({ ...base, delivery: 'sequential', allowanceAssets: 0n });
    assert.ok(steps.ok); if (!steps.ok) return;
    assert.deepEqual(steps.plan.calls.map(c => [c.callType, c.amountAtomic]), [['approval', '4000000'], ['other', '4000000']]);
    const ready = aaveV4RepayPlanV1({ ...base, delivery: 'sequential', allowanceAssets: BigInt(4_000_000) });
    assert.ok(ready.ok); if (ready.ok) assert.equal(ready.plan.calls.length, 1);
  });
});

describe('Aave V4 repay all, then take the stock back', () => {
  async function back(repay: boolean, steps?: { allowanceAssets: bigint }) {
    const s = await aaveStandingFixture('repay');
    const r = aaveV4RepayPlanV1({ walletAddress: s.walletAddress, loanReserve: s.loanReserve, maximumRepayAssets: repay ? BigInt(20_000_000) : BigInt(0),
      walletUsdcAssets: s.walletUsdcAssets, deployment: s.deployment, ...(steps ? { delivery: 'sequential' as const, allowanceAssets: steps.allowanceAssets } : {}),
      returnCollateral: { stockId: s.selectedStock!.id, collateralReserve: s.collateralReserve!, assets: s.existingSuppliedAssets, repay } });
    return { s, r };
  }
  const methodsOf = (calls: readonly { to: string; data: `0x${string}` }[]) => calls.filter(c => c.to === ADDRESSES.aaveSpoke.toLowerCase()).map(c => decodeFunctionData({ abi: aaveV4WriteAbiV1, data: c.data }));
  it('repays within the bound, clears the allowance, then withdraws exactly the measured deposit to the owner', async () => {
    const { s, r } = await back(true); assert.equal(r.ok, true); if (!r.ok) return;
    assert.deepEqual(r.plan.calls.map(c => c.callType), ['approval', 'approval', 'other', 'approval', 'withdraw']);
    const methods = methodsOf(r.plan.calls);
    assert.deepEqual(methods.map(m => m.functionName), ['repay', 'withdraw']);
    assert.deepEqual(methods[1]!.args.slice(0, 2), [BigInt(s.collateralReserve!.reserveId), s.existingSuppliedAssets]);
    assert.equal(String(methods[1]!.args[2]).toLowerCase(), s.walletAddress.toLowerCase());
    assert.equal(r.plan.calls.at(-1)!.recipient, s.walletAddress.toLowerCase());
    assert.doesNotMatch(r.plan.steps[2]!.reading, /without withdrawing collateral/);
  });
  it('with no debt left only withdraws: it approves nothing and asks for no USDC', async () => {
    const { r } = await back(false); assert.equal(r.ok, true); if (!r.ok) return;
    assert.deepEqual(r.plan.calls.map(c => c.callType), ['withdraw']);
    assert.deepEqual(methodsOf(r.plan.calls).map(m => m.functionName), ['withdraw']);
  });
  it('in steps: the repayment, then the withdrawal, with no cleanup call between them', async () => {
    const fresh = await back(true, { allowanceAssets: BigInt(0) }); assert.equal(fresh.r.ok, true);
    if (fresh.r.ok) assert.deepEqual(fresh.r.plan.calls.map(c => c.callType), ['approval', 'other', 'withdraw']);
    const allowed = await back(true, { allowanceAssets: BigInt(20_000_000) }); assert.equal(allowed.r.ok, true);
    if (allowed.r.ok) assert.deepEqual(allowed.r.plan.calls.map(c => c.callType), ['other', 'withdraw']);
  });
  it('refuses a USDC maximum without a repayment, a zero one with it, and any reserve but the stock’s own', async () => {
    const s = await aaveStandingFixture('repay');
    const base = { walletAddress: s.walletAddress, loanReserve: s.loanReserve, walletUsdcAssets: s.walletUsdcAssets, deployment: s.deployment };
    const own = { stockId: s.selectedStock!.id, collateralReserve: s.collateralReserve!, assets: s.existingSuppliedAssets };
    assert.equal(aaveV4RepayPlanV1({ ...base, maximumRepayAssets: BigInt(1), returnCollateral: { ...own, repay: false } }).ok, false);
    assert.equal(aaveV4RepayPlanV1({ ...base, maximumRepayAssets: BigInt(0), returnCollateral: { ...own, repay: true } }).ok, false);
    assert.equal(aaveV4RepayPlanV1({ ...base, maximumRepayAssets: BigInt(0), returnCollateral: { ...own, repay: false, assets: BigInt(0) } }).ok, false);
    for (const collateralReserve of [s.loanReserve, { ...s.collateralReserve!, underlying: ADDRESSES.cbbtc }]) {
      const r = aaveV4RepayPlanV1({ ...base, maximumRepayAssets: BigInt(0), returnCollateral: { ...own, repay: false, collateralReserve } });
      assert.equal(r.ok === false && r.refusal, 'aave_reserve_mismatch');
    }
  });
});
