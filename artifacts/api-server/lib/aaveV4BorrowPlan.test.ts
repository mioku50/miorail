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
