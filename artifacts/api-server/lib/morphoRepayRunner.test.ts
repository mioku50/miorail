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
