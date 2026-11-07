import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, keccak256, parseAbi, type Hex } from 'viem';
import { MORPHO_DIRECT_ABI_V1, MORPHO_DIRECT_WETH_BASE_V1, morphoDirectBorrowPlanV1, morphoDirectRepayPlanV1 } from '../src/morphoDirectPlan.js';
import { MORPHO_BLUE_BASE_V1, MORPHO_WITHDRAW_COLLATERAL_ABI_V1 } from '../src/morphoRepayPlan.js';

// 2026-11-07, the operator: «да делай прямые вызовы для всех кошельков». The wallet calls Morpho
// Blue itself: no bundle, no authorization, nothing that depends on the clock.
const WALLET = '0x1111111111111111111111111111111111111111';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const PAXG = '0xe904aea5e1b110c9174728fa2effc8aed19e98ef';
const BUNDLES = '0x4d28d900e381ece4b351302f1abe588496793a2b';
const params = (collateralToken: string) => ({ loanToken: USDC, collateralToken, oracle: '0x2222222222222222222222222222222222222222',
  irm: '0x46415998764c29ab2a25cbea6254146d50d22687', lltv: 770_000_000_000_000_000n });
const idOf = (p: ReturnType<typeof params>) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
  [p.loanToken as Hex, p.collateralToken as Hex, p.oracle as Hex, p.irm as Hex, p.lltv]));
const GOLD = params(PAXG), GOLD_ID = idOf(GOLD), WETH = params(MORPHO_DIRECT_WETH_BASE_V1), WETH_ID = idOf(WETH);
const approveAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
const approval = (data: string) => decodeFunctionData({ abi: approveAbi, data: data as Hex }).args;
const morpho = (data: string) => decodeFunctionData({ abi: MORPHO_DIRECT_ABI_V1, data: data as Hex });
const SUPPLY = 543_068_208_472_116n, BORROW = 840_000n;
const borrow = (patch: Partial<Parameters<typeof morphoDirectBorrowPlanV1>[0]> = {}) => morphoDirectBorrowPlanV1({ walletAddress: WALLET, marketId: GOLD_ID,
  marketParams: GOLD, collateralSymbol: 'PAXG', collateralSupplyAssets: SUPPLY, borrowAssets: BORROW, ...patch });

describe('a Morpho loan as the wallet’s own calls', () => {
  it('pledges exactly the chosen collateral and borrows exactly the chosen USDC to the wallet, with no allowance left and no grant', () => {
    const out = borrow();
    assert.equal(out.ok, true); if (!out.ok) return;
    const { calls, steps, authorizations, forceAtomic, venueSimulation } = out.plan;
    assert.deepEqual(calls.map(c => [c.to, c.callType]), [[PAXG, 'approval'], [PAXG, 'approval'], [MORPHO_BLUE_BASE_V1, 'deposit'], [MORPHO_BLUE_BASE_V1, 'other'], [PAXG, 'approval']]);
    assert.deepEqual(calls.map(c => c.index), [0, 1, 2, 3, 4]);
    const spenderAmount = (data: string) => { const [spender, value] = approval(data); return [spender.toLowerCase(), value]; };
    assert.deepEqual([calls[0], calls[1], calls[4]].map(c => spenderAmount(c!.data)), [[MORPHO_BLUE_BASE_V1, 0n], [MORPHO_BLUE_BASE_V1, SUPPLY], [MORPHO_BLUE_BASE_V1, 0n]]);
    const supply = morpho(calls[2]!.data), loan = morpho(calls[3]!.data);
    assert.equal(supply.functionName, 'supplyCollateral');
    assert.deepEqual(supply.args.slice(1), [SUPPLY, WALLET, '0x']);
    assert.equal(loan.functionName, 'borrow');
    assert.deepEqual(loan.args.slice(1), [BORROW, 0n, WALLET, WALLET]);
    assert.equal(calls.every(c => c.valueWei === '0' && c.data === c.data.toLowerCase()), true);
    assert.equal(calls.some(c => c.to === BUNDLES || c.spender === BUNDLES), false);
    assert.deepEqual(authorizations, []); assert.equal(venueSimulation, null); assert.equal(forceAtomic, true);
    assert.equal(steps.every((s, i) => s.index === i && s.to === calls[i]!.to && s.decodedByMiorail), true);
    assert.match(steps[3]!.reading, /paid straight to this wallet\. The wallet calls Morpho Blue itself, so no authorization is granted\./);
    // The same question gives the same bytes: nothing in them depends on the clock.
    assert.deepEqual(borrow(), out);
  });
  it('borrows alone against collateral already deposited', () => {
    const out = borrow({ collateralSupplyAssets: 0n });
    assert.equal(out.ok && out.plan.calls.length, 1);
    if (out.ok) assert.equal(morpho(out.plan.calls[0]!.data).functionName, 'borrow');
  });
  it('in steps, asks for the exact allowance unless it is already exactly that, and leaves out the clearing calls', () => {
    for (const [held, expected] of [[0n, ['approval', 'deposit', 'other']], [SUPPLY, ['deposit', 'other']], [SUPPLY + 1n, ['approval', 'deposit', 'other']],
      [(1n << 256n) - 1n, ['approval', 'deposit', 'other']]] as const) {
      const out = borrow({ delivery: 'sequential', allowanceAssets: held });
      assert.equal(out.ok, true, String(held)); if (!out.ok) continue;
      assert.deepEqual(out.plan.calls.map(c => c.callType), expected);
      assert.equal(out.plan.forceAtomic, false);
      if (expected[0] === 'approval') assert.deepEqual(approval(out.plan.calls[0]!.data)[1], SUPPLY);
    }
    assert.equal(borrow({ delivery: 'sequential' }).ok, false);
    // Once the pledge has landed, the step left is the borrow alone.
    const rest = borrow({ delivery: 'sequential', collateralSupplyAssets: 0n });
    assert.equal(rest.ok && rest.plan.calls.length, 1);
  });
  it('wraps native ETH in the wallet first, for the WETH market only', () => {
    const out = borrow({ marketId: WETH_ID, marketParams: WETH, collateralSymbol: 'WETH', collateralSupplyAssets: 2_800_000_000_000_000n, nativeSupply: true });
    assert.equal(out.ok, true); if (!out.ok) return;
    const [wrap, ...rest] = out.plan.calls;
    assert.equal(wrap!.to, MORPHO_DIRECT_WETH_BASE_V1); assert.equal(wrap!.valueWei, '2800000000000000'); assert.equal(wrap!.data, '0xd0e30db0');
    assert.deepEqual(rest.map(c => [c.to, c.callType, c.valueWei]), [[MORPHO_DIRECT_WETH_BASE_V1, 'approval', '0'], [MORPHO_DIRECT_WETH_BASE_V1, 'approval', '0'],
      [MORPHO_BLUE_BASE_V1, 'deposit', '0'], [MORPHO_BLUE_BASE_V1, 'other', '0'], [MORPHO_DIRECT_WETH_BASE_V1, 'approval', '0']]);
    // In steps, the calls after the wrap are exactly those of the same pledge of WETH.
    const steps = borrow({ marketId: WETH_ID, marketParams: WETH, collateralSymbol: 'WETH', collateralSupplyAssets: 2_800_000_000_000_000n, nativeSupply: true, delivery: 'sequential', allowanceAssets: 0n });
    const weth = borrow({ marketId: WETH_ID, marketParams: WETH, collateralSymbol: 'WETH', collateralSupplyAssets: 2_800_000_000_000_000n, delivery: 'sequential', allowanceAssets: 0n });
    assert.equal(steps.ok && weth.ok, true);
    if (steps.ok && weth.ok) assert.deepEqual(steps.plan.calls.slice(1).map(c => [c.to, c.data, c.valueWei]), weth.plan.calls.map(c => [c.to, c.data, c.valueWei]));
    assert.equal(borrow({ nativeSupply: true }).ok, false);
    assert.equal(borrow({ marketId: WETH_ID, marketParams: WETH, collateralSymbol: 'WETH', collateralSupplyAssets: 0n, nativeSupply: true }).ok, false);
  });
  it('refuses parameters that do not derive the market, a loan that is not USDC, and amounts that are not exact', () => {
    assert.deepEqual(borrow({ marketId: WETH_ID }), { ok: false, refusal: 'morpho_direct_market_mismatch', detail: 'The immutable parameters do not derive this market id.' });
    const notUsdc = { ...GOLD, loanToken: PAXG };
    assert.equal(borrow({ marketParams: notUsdc, marketId: idOf(notUsdc as ReturnType<typeof params>) }).ok, false);
    for (const patch of [{ borrowAssets: 0n }, { collateralSupplyAssets: -1n }, { borrowAssets: 1n << 128n }, { walletAddress: '0x0000000000000000000000000000000000000000' }]) {
      assert.equal(borrow(patch).ok, false, JSON.stringify(patch, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    }
  });
});

const repay = (patch: Partial<Parameters<typeof morphoDirectRepayPlanV1>[0]> = {}) => morphoDirectRepayPlanV1({ walletAddress: WALLET, marketId: GOLD_ID,
  marketParams: GOLD, amount: { mode: 'all' }, borrowShares: 838_563_896_936n, maximumAssets: 909_427n, repaying: true, ...patch });

describe('a Morpho repayment as the wallet’s own calls', () => {
  it('repays all the debt shares within the cap, clears the allowance, then takes the whole collateral back', () => {
    const out = repay({ returnCollateralAssets: SUPPLY });
    assert.equal(out.ok, true); if (!out.ok) return;
    const calls = out.plan.calls;
    assert.deepEqual(calls.map(c => [c.to, c.callType]), [[USDC, 'approval'], [USDC, 'approval'], [MORPHO_BLUE_BASE_V1, 'other'], [USDC, 'approval'], [MORPHO_BLUE_BASE_V1, 'withdraw']]);
    assert.deepEqual([approval(calls[0]!.data)[1], approval(calls[1]!.data)[1], approval(calls[3]!.data)[1]], [0n, 909_427n, 0n]);
    const repaid = morpho(calls[2]!.data);
    assert.equal(repaid.functionName, 'repay'); assert.deepEqual(repaid.args.slice(1), [0n, 838_563_896_936n, WALLET, '0x']);
    const back = decodeFunctionData({ abi: MORPHO_WITHDRAW_COLLATERAL_ABI_V1, data: calls[4]!.data as Hex });
    assert.deepEqual(back.args.slice(1), [SUPPLY, WALLET, WALLET]);
    assert.deepEqual(calls.map(c => c.index), [0, 1, 2, 3, 4]);
    assert.equal(calls.some(c => c.to === BUNDLES || c.spender === BUNDLES), false);
    assert.deepEqual(repay({ returnCollateralAssets: SUPPLY }), out);
  });
  it('repays an exact amount, whose cap is that amount, and keeps the collateral deposited', () => {
    const out = repay({ amount: { mode: 'assets', assets: 500_000n }, maximumAssets: 500_000n });
    assert.equal(out.ok, true); if (!out.ok) return;
    assert.deepEqual(morpho(out.plan.calls[2]!.data).args.slice(1), [500_000n, 0n, WALLET, '0x']);
    assert.match(out.plan.steps[2]!.reading, /your collateral stays deposited\.$/);
    assert.equal(repay({ amount: { mode: 'assets', assets: 500_000n }, maximumAssets: 600_000n }).ok, false);
  });
  it('in steps, sets the cap unless it is already exactly that, and has no clearing call', () => {
    for (const [held, expected] of [[0n, ['approval', 'other', 'withdraw']], [909_427n, ['other', 'withdraw']], [(1n << 256n) - 1n, ['approval', 'other', 'withdraw']]] as const) {
      const out = repay({ returnCollateralAssets: SUPPLY, delivery: 'sequential', allowanceAssets: held });
      assert.equal(out.ok && out.plan.calls.map(c => c.callType).join(), expected.join());
    }
    assert.equal(repay({ delivery: 'sequential' }).ok, false);
  });
  it('with no debt left only takes the collateral back, and moves no USDC', () => {
    const out = repay({ repaying: false, returnCollateralAssets: SUPPLY, maximumAssets: 0n, borrowShares: 0n });
    assert.equal(out.ok && out.plan.calls.length, 1);
    if (out.ok) assert.equal(out.plan.calls[0]!.callType, 'withdraw');
    assert.equal(repay({ repaying: false }).ok, false);
    assert.equal(repay({ borrowShares: 0n }).ok, false);
  });
});

