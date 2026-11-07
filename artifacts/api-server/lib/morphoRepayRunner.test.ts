import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeFunctionResult, type Address } from 'viem';
import { stableHashV1 } from '@mioagent/route-domain';
import type { SimulationProvider, SimulationProviderResponseV1 } from '@mioagent/paid-intelligence';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import { morphoAbi, erc20Abi } from '@mioagent/still-engine/abi';
import { runMorphoRepayV1 } from './morphoRepayRunner.js';
import { STILL_REPAY_BLUE_BUNDLES_V1, STILL_REPAY_BLUE_BUNDLES_RUNTIME_HASH_V1, type StillRepayStandingV1 } from './stillRepayStanding.js';

const wallet = '0x1111111111111111111111111111111111111111' as Address;
const now = new Date('2026-10-29T03:00:00Z'), timestamp = BigInt(now.getTime() / 1000);
function harness(all = false, mutate?: (body: SimulationProviderResponseV1) => void) {
  // Public immutable registered cbBTC tuple; every wallet amount is synthetic.
  const params = { loanToken: ADDRESSES.usdc, collateralToken: ADDRESSES.cbbtc,
    oracle: '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9' as Address, irm: '0x46415998764C29aB2a25CbeA6254146D50D22687' as Address, lltv: 860_000_000_000_000_000n };
  const totals = { totalSupplyAssets: 2_000_000n, totalSupplyShares: 2_000_000_000_000n, totalBorrowAssets: 1_000_000n,
    totalBorrowShares: 1_000_000_000_000n, lastUpdate: timestamp, fee: 0n };
  const s: StillRepayStandingV1 = { chainId: 8453, walletAddress: wallet, marketId: CRYPTO[0]!.morphoMarket,
    collateral: { address: ADDRESSES.cbbtc, symbol: 'cbBTC', decimals: 8 }, loan: { address: ADDRESSES.usdc, symbol: 'USDC', decimals: 6 }, params,
    position: { collateral: 100_000_000n, borrowShares: 500_000_000_000n }, storedTotals: totals, accruedTotals: { ...totals }, debtAssets: 500_000n,
    walletLoanAssets: 2_000_000n, walletCollateralAssets: 777n, block: { number: 53_100_000n, timestamp }, blueBundlesRuntimeHash: STILL_REPAY_BLUE_BUNDLES_RUNTIME_HASH_V1 };
  const amount = all ? 500_000n : 200_000n, maximum = all ? 600_000n : amount;
  let simulated = 0;
  const provider: SimulationProvider = { providerId: 'repay-fixture', async simulate(req) {
    simulated++;
    const encode = (id: string, after: boolean) => {
      if (id === 'market_params') return encodeFunctionResult({ abi: morphoAbi, functionName: 'idToMarketParams', result: [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv] });
      if (id === 'position') return encodeFunctionResult({ abi: morphoAbi, functionName: 'position', result: [123n, s.position.borrowShares - (after ? amount * 1_000_000n : 0n), s.position.collateral] });
      if (id === 'market') return encodeFunctionResult({ abi: morphoAbi, functionName: 'market', result: [totals.totalSupplyAssets, totals.totalSupplyShares,
        totals.totalBorrowAssets - (after ? amount : 0n), totals.totalBorrowShares - (after ? amount * 1_000_000n : 0n), timestamp, 0n] });
      return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: id === 'loan_wallet_balance' ? s.walletLoanAssets - (after ? amount : 0n) : s.walletCollateralAssets });
    };
    const observations = req.observations!;
    const body: SimulationProviderResponseV1 = { status: 'success', blockNumber: Number(s.block.number), gasUsed: '200000', stateChanges: [], revertReason: null,
      observations: { requestHash: stableHashV1('simulation-observations/v1', { chainId: 8453, walletAddress: wallet, callsHash: req.callsHash, ...observations }),
        results: (['before','after'] as const).flatMap(phase => observations[phase].map(p => ({ phase, ...p, status: 'success' as const, returnData: encode(p.id, phase === 'after') }))) },
      assetChanges: { status: 'available', unavailableReason: null, changes: [
        { kind: 'erc20_transfer', token: ADDRESSES.usdc, direction: 'out', amountAtomic: maximum.toString(), counterparty: STILL_REPAY_BLUE_BUNDLES_V1, callIndex: 2 },
        ...(all ? [{ kind: 'erc20_transfer' as const, token: ADDRESSES.usdc, direction: 'in' as const, amountAtomic: (maximum - amount).toString(), counterparty: STILL_REPAY_BLUE_BUNDLES_V1, callIndex: 2 }] : []),
      ] } };
    mutate?.(body); return { ok: true, body };
  } };
  return { s, request: { collateralTokenAddress: s.collateral.address, marketId: s.marketId, walletAddress: wallet,
    amount: all ? { mode: 'all' as const } : { mode: 'assets' as const, assets: amount }, maximumAssets: maximum },
    deps: { read: async () => ({ state: 'read' as const, readAt: now.toISOString(), standing: s }), chain: { providers: [provider], batchCapableIds: new Set(['repay-fixture']) }, now: () => now }, simulated: () => simulated };
}
describe('canonical repayment runner proves the actual debt reduction', () => {
  it('a full repayment whose maximum is below the debt is refused with both numbers', async () => {
    const h = harness(true), r = await runMorphoRepayV1({ ...h.request, maximumAssets: 1n }, h.deps);
    assert.equal(r.state, 'refused');
    if (r.state === 'refused') {
      assert.equal(r.refusal, 'repay_maximum_exceeded');
      assert.match(r.detail, /^The debt is [\d.]+ USDC now, more than your maximum of 0\.000001 USDC: interest adds to it every second\./);
    }
    assert.equal(h.simulated(), 0);
  });
  it('an exact repayment above the debt is refused in its own numbers, pointing to Repay all, before any simulation', async () => {
    // 2026-11-07: Max put the 0.840001 USDC shown into Exact USDC, and the review said only that it could not be established.
    const h = harness(), r = await runMorphoRepayV1({ ...h.request, amount: { mode: 'assets', assets: 500_001n }, maximumAssets: 500_001n }, h.deps);
    assert.equal(r.state, 'refused');
    if (r.state === 'refused') {
      assert.equal(r.refusal, 'repay_exceeds_debt');
      assert.equal(r.detail, 'An exact repayment of 0.500001 USDC is more than this debt. Morpho keeps a debt as shares: at block 53,100,000 these are worth no more than 0.5 USDC, '
        + 'the debt shown, which is rounded up. An exact repayment has to be less than the debt. To repay all of it, choose Repay all debt: it repays the shares themselves, '
        + 'with the interest until the transaction lands, and leaves nothing behind.');
    }
    assert.equal(h.simulated(), 0);
  });
  it('accepts exact assets and full shares with an atomic bounded funding/refund', async () => {
    for (const all of [false, true]) {
      const h = harness(all), r = await runMorphoRepayV1(h.request, h.deps);
      assert.equal(r.state, 'ready', r.state === 'refused' ? `${r.refusal}: ${r.detail}` : '');
      if (r.state === 'ready') { assert.equal(r.calls.length, 4); assert.equal(r.atomicRequired, true); assert.equal(r.facts.debtAfterShares, all ? '0' : '300000000000'); }
    }
  });
  it('requires gross funding, exact counterparties, observations and every wallet asset effect', async () => {
    for (const mutate of [
      (b: SimulationProviderResponseV1) => { delete b.observations; },
      (b: SimulationProviderResponseV1) => { b.assetChanges!.changes[0]!.counterparty = ADDRESSES.morpho; },
      (b: SimulationProviderResponseV1) => { b.assetChanges!.changes[0]!.amountAtomic = '199999'; },
      (b: SimulationProviderResponseV1) => { b.assetChanges!.changes.push({ kind: 'erc20_transfer', token: ADDRESSES.cbbtc, direction: 'out', amountAtomic: '1', counterparty: ADDRESSES.morpho, callIndex: 2 }); },
      (b: SimulationProviderResponseV1) => { b.status = 'reverted'; },
    ]) { const h = harness(false, mutate); assert.equal((await runMorphoRepayV1(h.request, h.deps)).state, 'refused'); }
  });
  it('does not simulate a different owner, different market or insufficient funding', async () => {
    for (const mutate of [
      (s: StillRepayStandingV1) => { s.walletAddress = ADDRESSES.usdc; },
      (s: StillRepayStandingV1) => { s.marketId = CRYPTO[1]!.morphoMarket; },
      (s: StillRepayStandingV1) => { s.walletLoanAssets = 1n; },
    ]) { const h = harness(); mutate(h.s); assert.equal((await runMorphoRepayV1({ ...h.request }, h.deps)).state, 'refused'); assert.equal(h.simulated(), 0); }
  });
});

describe('repay all and take the collateral back on Morpho', () => {
  function returning(debt = true, mutate?: (body: SimulationProviderResponseV1) => void) {
    const params = { loanToken: ADDRESSES.usdc, collateralToken: ADDRESSES.cbbtc,
      oracle: '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9' as Address, irm: '0x46415998764C29aB2a25CbeA6254146D50D22687' as Address, lltv: 860_000_000_000_000_000n };
    const totals = { totalSupplyAssets: 2_000_000n, totalSupplyShares: 2_000_000_000_000n, totalBorrowAssets: 1_000_000n,
      totalBorrowShares: 1_000_000_000_000n, lastUpdate: timestamp, fee: 0n };
    const shares = debt ? 500_000_000_000n : 0n, owed = debt ? 500_000n : 0n, maximum = debt ? 600_000n : 0n, collateral = 100_000_000n;
    const s: StillRepayStandingV1 = { chainId: 8453, walletAddress: wallet, marketId: CRYPTO[0]!.morphoMarket,
      collateral: { address: ADDRESSES.cbbtc, symbol: 'cbBTC', decimals: 8 }, loan: { address: ADDRESSES.usdc, symbol: 'USDC', decimals: 6 }, params,
      position: { collateral, borrowShares: shares }, storedTotals: totals, accruedTotals: { ...totals }, debtAssets: owed,
      walletLoanAssets: 2_000_000n, walletCollateralAssets: 777n, block: { number: 53_100_000n, timestamp }, blueBundlesRuntimeHash: STILL_REPAY_BLUE_BUNDLES_RUNTIME_HASH_V1 };
    let simulated = 0;
    const provider: SimulationProvider = { providerId: 'repay-fixture', async simulate(req) {
      simulated++;
      const encode = (id: string, after: boolean) => {
        if (id === 'market_params') return encodeFunctionResult({ abi: morphoAbi, functionName: 'idToMarketParams', result: [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv] });
        if (id === 'position') return encodeFunctionResult({ abi: morphoAbi, functionName: 'position', result: [123n, after ? 0n : shares, after ? 0n : collateral] });
        if (id === 'market') return encodeFunctionResult({ abi: morphoAbi, functionName: 'market', result: [totals.totalSupplyAssets, totals.totalSupplyShares,
          totals.totalBorrowAssets - (after ? owed : 0n), totals.totalBorrowShares - (after ? shares : 0n), timestamp, 0n] });
        return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: id === 'loan_wallet_balance' ? s.walletLoanAssets - (after ? owed : 0n) : s.walletCollateralAssets + (after ? collateral : 0n) });
      };
      const observations = req.observations!;
      const body: SimulationProviderResponseV1 = { status: 'success', blockNumber: Number(s.block.number), gasUsed: '250000', stateChanges: [], revertReason: null,
        observations: { requestHash: stableHashV1('simulation-observations/v1', { chainId: 8453, walletAddress: wallet, callsHash: req.callsHash, ...observations }),
          results: (['before','after'] as const).flatMap(phase => observations[phase].map(p => ({ phase, ...p, status: 'success' as const, returnData: encode(p.id, phase === 'after') }))) },
        assetChanges: { status: 'available', unavailableReason: null, changes: [
          ...(debt ? [{ kind: 'erc20_transfer' as const, token: ADDRESSES.usdc, direction: 'out' as const, amountAtomic: maximum.toString(), counterparty: STILL_REPAY_BLUE_BUNDLES_V1, callIndex: 2 },
            { kind: 'erc20_transfer' as const, token: ADDRESSES.usdc, direction: 'in' as const, amountAtomic: (maximum - owed).toString(), counterparty: STILL_REPAY_BLUE_BUNDLES_V1, callIndex: 2 }] : []),
          { kind: 'erc20_transfer', token: ADDRESSES.cbbtc, direction: 'in', amountAtomic: collateral.toString(), counterparty: ADDRESSES.morpho, callIndex: debt ? 4 : 0 },
        ] } };
      mutate?.(body); return { ok: true, body };
    } };
    return { s, request: { collateralTokenAddress: s.collateral.address, marketId: s.marketId, walletAddress: wallet, amount: { mode: 'all' as const }, maximumAssets: maximum, returnCollateral: true },
      deps: { read: async () => ({ state: 'read' as const, readAt: now.toISOString(), standing: s }), chain: { providers: [provider], batchCapableIds: new Set(['repay-fixture']) }, now: () => now }, simulated: () => simulated };
  }
  it('repays the whole debt and then the wallet itself withdraws the whole collateral, all in one batch', async () => {
    const h = returning(), r = await runMorphoRepayV1(h.request, h.deps);
    assert.equal(r.state, 'ready', r.state === 'refused' ? `${r.refusal}: ${r.detail}` : ''); if (r.state !== 'ready') return;
    assert.deepEqual(r.calls.map(c => c.callType), ['approval', 'approval', 'other', 'approval', 'withdraw']);
    assert.equal(r.calls.at(-1)!.to, ADDRESSES.morpho.toLowerCase());
    assert.deepEqual([r.facts.collateralReturnAssets, r.facts.collateralAfterAssets, r.facts.debtAfterShares, r.facts.maximumDebitAssets], ['100000000', '0', '0', '600000']);
    assert.match(r.facts.warnings[0]!, /repays all USDC debt in this Morpho market, then returns your cbBTC collateral/);
    assert.match(r.steps[2]!.reading, /the next one returns it/);
  });
  it('with no debt left only withdraws: no USDC, a zero maximum, and no deadline-bound repayment', async () => {
    const h = returning(false), r = await runMorphoRepayV1(h.request, h.deps);
    assert.equal(r.state, 'ready', r.state === 'refused' ? `${r.refusal}: ${r.detail}` : ''); if (r.state !== 'ready') return;
    assert.deepEqual(r.calls.map(c => c.callType), ['withdraw']);
    assert.deepEqual([r.facts.maximumDebitAssets, r.measured.loanDeltaAssets, r.facts.debtBeforeAssets], ['0', '0', '0']);
    assert.match(r.facts.warnings[0]!, /No USDC debt is open in this Morpho market/);
  });
  it('refuses with nothing deposited, short collateral, USDC moving without debt, or collateral arriving unasked', async () => {
    const empty = returning(); empty.s.position = { ...empty.s.position, collateral: 0n };
    const a = await runMorphoRepayV1(empty.request, empty.deps); assert.equal(a.state === 'refused' && a.refusal, 'nothing_to_return'); assert.equal(empty.simulated(), 0);
    const short = returning(true, b => { b.assetChanges!.changes.at(-1)!.amountAtomic = '99999999'; });
    assert.equal((await runMorphoRepayV1(short.request, short.deps)).state, 'refused');
    const usdc = returning(false, b => { b.assetChanges!.changes.push({ kind: 'erc20_transfer', token: ADDRESSES.usdc, direction: 'out', amountAtomic: '1', counterparty: STILL_REPAY_BLUE_BUNDLES_V1, callIndex: 0 }); });
    assert.equal((await runMorphoRepayV1(usdc.request, usdc.deps)).state, 'refused');
    const plain = harness(true, b => { b.assetChanges!.changes.push({ kind: 'erc20_transfer', token: ADDRESSES.cbbtc, direction: 'in', amountAtomic: '1', counterparty: ADDRESSES.morpho, callIndex: 2 }); });
    const d = await runMorphoRepayV1(plain.request, plain.deps); assert.equal(d.state === 'refused' && d.refusal, 'repay_unrequested_asset_change');
  });
});
