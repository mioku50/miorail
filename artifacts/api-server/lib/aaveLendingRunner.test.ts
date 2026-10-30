import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stableHashV1 } from '@mioagent/route-domain';
import type { SimulationProvider, SimulationProviderResponseV1 } from '@mioagent/paid-intelligence';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';
import { aavePoststateFixture, aaveReadFixture, aaveStandingFixture, AAVE_TEST_WALLET } from './aaveV4BorrowFixtures.testhelper.js';
import { runAaveLendingV1 } from './aaveLendingRunner.js';
import type { LendingQuestionV1 } from './lendingDraft.js';
import type { StillAaveStandingV1 } from './stillAaveStanding.js';

const ZERO = BigInt(0), NOW = new Date('2026-10-21T15:00:00Z');
async function harness(operation: 'borrow' | 'repay' = 'borrow', change?: (body: SimulationProviderResponseV1) => void) {
  const s = await aaveStandingFixture(operation), amount = BigInt(4_000_000);
  const q: LendingQuestionV1 = operation === 'borrow'
    ? { operation, collateralTokenAddress: s.selectedStock!.token.toLowerCase(), borrowAssets: amount.toString(), collateralSupplyAssets: s.collateralSupplyAssets.toString() }
    : { operation, collateralTokenAddress: s.selectedStock!.token.toLowerCase(), amountMode: 'assets', repayAssets: amount.toString(), maximumAssets: amount.toString() };
  let simulations = 0;
  const provider: SimulationProvider = { providerId: 'aave-fixture', async simulate(request) {
    simulations++;
    const f = aavePoststateFixture(s, operation, amount);
    const observations = { ...f.response.observations, requestHash: stableHashV1('simulation-observations/v1', { chainId: 8453, walletAddress: request.walletAddress.toLowerCase(), callsHash: request.callsHash,
      before: request.observations!.before, after: request.observations!.after }) };
    const body: SimulationProviderResponseV1 = { status: 'success', blockNumber: s.blockNumber, gasUsed: '200000', stateChanges: [], revertReason: null, observations,
      assetChanges: { status: 'available', unavailableReason: null, changes: [
        { kind: 'erc20_transfer', token: ADDRESSES.usdc, direction: operation === 'borrow' ? 'in' : 'out', amountAtomic: amount.toString(), counterparty: ADDRESSES.aaveHub, callIndex: operation === 'borrow' ? 3 : 2 },
        ...(operation === 'borrow' && s.collateralSupplyAssets > ZERO ? [{ kind: 'erc20_transfer' as const, token: s.selectedStock!.token, direction: 'out' as const, amountAtomic: s.collateralSupplyAssets.toString(), counterparty: ADDRESSES.aaveHub, callIndex: 2 }] : []),
      ] } };
    change?.(body); return { ok: true, body };
  } };
  const deps = { read: async () => ({ state: 'read' as const, standing: s }), deploymentAt: async () => s.deployment,
    chain: { providers: [provider], batchCapableIds: new Set(['aave-fixture']) }, now: () => NOW };
  return { s, q, deps, simulations: () => simulations };
}

describe('Aave runner keeps the observed action bound to the owned question', () => {
  it('produces a short-lived atomic review only after asset and whole-account proofs', async () => {
    for (const operation of ['borrow', 'repay'] as const) {
      const h = await harness(operation), r = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: h.q }, h.deps);
      assert.equal(r.state, 'ready', r.state === 'refused' ? r.detail : ''); if (r.state === 'ready') {
        assert.equal(r.atomicRequired, true); assert.equal(r.facts.venue, 'aave-v4'); assert.equal(r.facts.requestedAssets, '4000000');
        assert.equal(r.expiresAt, '2026-10-21T15:00:30.000Z'); assert(r.calls.every(c => c.valueWei === '0'));
      }
    }
  });
  it('refuses a changed runtime pin at the simulation block with separated diagnostic codes', async () => {
    const h = await harness();
    const r = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: h.q }, { ...h.deps, deploymentAt: async () => ({ ...h.s.deployment, implementationAddress: ADDRESSES.usdc }) });
    assert.equal(r.state, 'refused');
    if (r.state === 'refused') assert.equal(r.refusal, 'aave_deployment_changed');

    const cases = [
      { status: 'implementation_mismatch' as const, refusal: 'aave_deployment_changed' },
      { status: 'code_hash_mismatch' as const, refusal: 'aave_deployment_code_mismatch' },
      { status: 'slot_unreadable' as const, refusal: 'aave_deployment_slot_unreadable' },
      { status: 'block_unavailable' as const, refusal: 'aave_deployment_block_unavailable' },
      { status: 'rpc_unavailable' as const, refusal: 'aave_deployment_rpc_unavailable' },
    ];
    for (const c of cases) {
      const res = await runAaveLendingV1(
        { walletAddress: AAVE_TEST_WALLET, question: h.q },
        { ...h.deps, inspectDeploymentAt: async () => ({ status: c.status, deployment: null }) },
      );
      assert.equal(res.state, 'refused', c.status);
      if (res.state === 'refused') assert.equal(res.refusal, c.refusal);
    }
  });
  it('normalizes zero-debt uint256.max health factor to null and preserves 0.05 -> 0.050001 USDC share-rounding facts', async () => {
    const raw = aaveReadFixture();
    raw.snapshot.aave!.usdcDebt = { ok: true, value: ZERO };
    raw.positions.find(p => p.reserveId === 7)!.drawnShares = ZERO;
    const s = await aaveStandingFixture('borrow', raw, BigInt(80_000));
    const ask = BigInt(50_000); // 0.05 USDC
    const q: LendingQuestionV1 = {
      operation: 'borrow',
      collateralTokenAddress: s.selectedStock!.token.toLowerCase(),
      borrowAssets: ask.toString(),
      collateralSupplyAssets: s.collateralSupplyAssets.toString(),
    };
    const drawnIndex = BigInt('1010000000000000000000000000'); // > 1e27 so ceil(ceil(50000*1e27/idx)*idx/1e27) === 50001
    const uint256Max = (BigInt(1) << BigInt(256)) - BigInt(1);
    const provider: SimulationProvider = {
      providerId: 'aave-fixture',
      async simulate(request) {
        const f = aavePoststateFixture(s, 'borrow', ask, (phase, after) => {
          phase.drawnIndex = drawnIndex;
          if (!after) phase.healthFactor = uint256Max;
          else phase.healthFactor = BigInt('2264514777517564444');
        });
        const observations = {
          ...f.response.observations,
          requestHash: stableHashV1('simulation-observations/v1', {
            chainId: 8453,
            walletAddress: request.walletAddress.toLowerCase(),
            callsHash: request.callsHash,
            before: request.observations!.before,
            after: request.observations!.after,
          }),
        };
        return {
          ok: true,
          body: {
            status: 'success',
            blockNumber: s.blockNumber,
            gasUsed: '200000',
            stateChanges: [],
            revertReason: null,
            observations,
            assetChanges: {
              status: 'available',
              unavailableReason: null,
              changes: [
                { kind: 'erc20_transfer', token: ADDRESSES.usdc, direction: 'in', amountAtomic: ask.toString(), counterparty: ADDRESSES.aaveHub, callIndex: 3 },
                { kind: 'erc20_transfer', token: s.selectedStock!.token, direction: 'out', amountAtomic: s.collateralSupplyAssets.toString(), counterparty: ADDRESSES.aaveHub, callIndex: 2 },
              ],
            },
          },
        };
      },
    };
    const r = await runAaveLendingV1(
      { walletAddress: AAVE_TEST_WALLET, question: q },
      {
        read: async () => ({ state: 'read', standing: s }),
        inspectDeploymentAt: async () => ({ status: 'matched', deployment: s.deployment }),
        chain: { providers: [provider], batchCapableIds: new Set(['aave-fixture']) },
        now: () => NOW,
      },
    );
    assert.equal(r.state, 'ready', r.state === 'refused' ? r.detail : '');
    if (r.state === 'ready') {
      assert.equal(r.facts.debtBeforeAssets, '0');
      assert.equal(r.facts.healthBeforeWad, null);
      assert.equal(r.facts.requestedAssets, '50000');
      assert.equal(r.measured.loanDeltaAssets, '50000');
      assert.equal(r.facts.debtAfterAssets, '50001');
      assert.equal(r.facts.healthAfterWad, '2264514777517564444');
    }
  });
  it('never treats status success without observations and asset effects as ready', async () => {
    for (const missing of ['observations', 'assetChanges'] as const) {
      const h = await harness('borrow', body => { delete body[missing]; });
      assert.equal((await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: h.q }, h.deps)).state, 'refused');
    }
  });
  it('rejects extra USDC circulation even if its net delta matches the request', async () => {
    for (const operation of ['borrow', 'repay'] as const) {
      const h = await harness(operation, body => {
        body.assetChanges!.changes.push(
          { kind: 'erc20_transfer', token: ADDRESSES.usdc, direction: 'out', amountAtomic: '9000000', counterparty: ADDRESSES.aaveHub, callIndex: 2 },
          { kind: 'erc20_transfer', token: ADDRESSES.usdc, direction: 'in', amountAtomic: '9000000', counterparty: ADDRESSES.aaveHub, callIndex: 2 });
      });
      assert.equal((await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: h.q }, h.deps)).state, 'refused', operation);
    }
  });
  it('rejects a different sender or collateral returned by the reader before simulation', async () => {
    for (const change of [
      (s: StillAaveStandingV1) => { s.walletAddress = ADDRESSES.usdc; },
      (s: StillAaveStandingV1) => { s.selectedStock = STOCKS.find(v => v.id === 'AAPLc')!; },
      (s: StillAaveStandingV1) => { s.collateralSupplyAssets = ZERO; },
    ]) {
      const h = await harness(); change(h.s);
      const r = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: h.q }, h.deps);
      assert.equal(r.state, 'refused'); assert.equal(h.simulations(), 0);
    }
  });
  it('refuses an unrequested token movement rather than ignoring it', async () => {
    const h = await harness('repay', body => { body.assetChanges!.changes.push({ kind: 'erc20_transfer', token: ADDRESSES.cbbtc, direction: 'out', amountAtomic: '1', counterparty: ADDRESSES.aaveHub, callIndex: 2 }); });
    assert.equal((await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: h.q }, h.deps)).state, 'refused');
  });
});
