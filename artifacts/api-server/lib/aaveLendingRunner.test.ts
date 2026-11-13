import assert from 'node:assert/strict';
import { repayAllBoundAtomicV1, repayAllMinimumAtomicV1 } from '@mioagent/still-engine/repay';
import { usdcWordsV1 } from './repayWords.js';
import { describe, it } from 'node:test';
import { stableHashV1 } from '@mioagent/route-domain';
import type { SimulationProvider, SimulationProviderResponseV1 } from '@mioagent/paid-intelligence';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';
import { aavePoststateFixture, aaveReadFixture, aaveRepaidReadFixture, aaveStandingFixture, AAVE_TEST_WALLET } from './aaveV4BorrowFixtures.testhelper.js';
import { lendingSigningTermsFactsV1 } from './lendingReview.js';
import { runAaveLendingV1 } from './aaveLendingRunner.js';
import type { LendingQuestionV1 } from './lendingDraft.js';
import { readStillAaveStandingV1, type StillAaveStandingV1 } from './stillAaveStanding.js';
import { computeMirror } from '@mioagent/still-engine';
import { calendar } from '../../../lib/still-engine/test/fixtures.js';

const ZERO = BigInt(0), NOW = new Date('2026-10-21T15:00:00Z');
async function harness(operation: 'borrow' | 'repay' = 'borrow', change?: (body: SimulationProviderResponseV1) => void, patch?: Parameters<typeof aavePoststateFixture>[3],
  read?: ReturnType<typeof aaveReadFixture>) {
  const s = await aaveStandingFixture(operation, read), amount = BigInt(4_000_000);
  const q: LendingQuestionV1 = operation === 'borrow'
    ? { operation, collateralTokenAddress: s.selectedStock!.token.toLowerCase(), borrowAssets: amount.toString(), collateralSupplyAssets: s.collateralSupplyAssets.toString() }
    : { operation, collateralTokenAddress: s.selectedStock!.token.toLowerCase(), amountMode: 'assets', repayAssets: amount.toString(), maximumAssets: amount.toString() };
  let simulations = 0;
  const provider: SimulationProvider = { providerId: 'aave-fixture', async simulate(request) {
    simulations++;
    const f = aavePoststateFixture(s, operation, amount, patch);
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
  it('keeps signingTermsHash stable across 9th-decimal health fluctuations and block ticks while changing on material health or debt shifts', async () => {
    const runWithHealth = async (healthAfterWad: bigint, blockOffset = 0, drawnIndex = BigInt(10) ** BigInt(27)) => {
      const raw = aaveReadFixture();
      raw.snapshot.aave!.usdcDebt = { ok: true, value: ZERO };
      raw.positions.find(p => p.reserveId === 7)!.drawnShares = ZERO;
      const s = await aaveStandingFixture('borrow', raw, BigInt(80_000));
      s.blockNumber += blockOffset;
      s.snapshot.block.number += BigInt(blockOffset);
      s.deployment = { ...s.deployment, blockNumber: s.blockNumber };
      const ask = BigInt(50_000);
      const q: LendingQuestionV1 = {
        operation: 'borrow',
        collateralTokenAddress: s.selectedStock!.token.toLowerCase(),
        borrowAssets: ask.toString(),
        collateralSupplyAssets: s.collateralSupplyAssets.toString(),
      };
      const uint256Max = (BigInt(1) << BigInt(256)) - BigInt(1);
      const provider: SimulationProvider = {
        providerId: 'aave-fixture',
        async simulate(request) {
          const f = aavePoststateFixture(s, 'borrow', ask, (phase, after) => {
            phase.drawnIndex = drawnIndex;
            if (!after) phase.healthFactor = uint256Max;
            else phase.healthFactor = healthAfterWad;
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
      return runAaveLendingV1(
        { walletAddress: AAVE_TEST_WALLET, question: q },
        {
          read: async () => ({ state: 'read', standing: s }),
          inspectDeploymentAt: async () => ({ status: 'matched', deployment: s.deployment }),
          chain: { providers: [provider], batchCapableIds: new Set(['aave-fixture']) },
          now: () => NOW,
        },
      );
    };
    const first = await runWithHealth(BigInt('2494032095615730712'), 0);
    const second = await runWithHealth(BigInt('2494032094713526717'), 3);
    const materialHealthShift = await runWithHealth(BigInt('2484032094713526717'), 3);
    const atomicDebtShift = await runWithHealth(BigInt('2494032094713526717'), 3, BigInt('1010000000000000000000000000'));
    assert.equal(first.state, 'ready');
    assert.equal(second.state, 'ready');
    assert.equal(materialHealthShift.state, 'ready');
    assert.equal(atomicDebtShift.state, 'ready');
    if (first.state === 'ready' && second.state === 'ready' && materialHealthShift.state === 'ready' && atomicDebtShift.state === 'ready') {
      assert.equal(first.signingTermsHash, second.signingTermsHash);
      assert.notEqual(first.signingTermsHash, materialHealthShift.signingTermsHash);
      assert.notEqual(first.signingTermsHash, atomicDebtShift.signingTermsHash);
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

describe('Aave runner plans the same action in steps for a wallet that cannot send a batch', () => {
  it('is checked like a batch, says it goes in steps, and signs differently from the batch', async () => {
    const h = await harness();
    const atomic = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: h.q }, h.deps);
    let read: unknown = null;
    const steps = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: h.q, delivery: 'sequential' },
      { ...h.deps, allowance: async (input) => { read = input; return ZERO; } });
    assert.equal(steps.state, 'ready', steps.state === 'refused' ? steps.detail : '');
    if (steps.state !== 'ready' || atomic.state !== 'ready') return;
    assert.deepEqual([steps.atomicRequired, steps.delivery], [false, 'sequential']);
    assert.deepEqual(read, { token: h.s.selectedStock!.token, walletAddress: h.s.walletAddress, blockNumber: h.s.blockNumber });
    assert.equal(steps.calls[0]!.callType, 'approval');
    assert.ok(steps.calls.length < atomic.calls.length);
    assert.match(steps.facts.warnings.at(-1)!, /^Your wallet sends this as \d steps, one transaction each, and pays each network fee\. Still reviews each next step again/);
    assert.notEqual(steps.signingTermsHash, atomic.signingTermsHash);
    assert.deepEqual(steps.facts.requestedAssets, atomic.facts.requestedAssets);
  });
  it('refuses to plan steps when the allowance cannot be read, and never claims an atomic cleanup', async () => {
    const h = await harness();
    const unread = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: h.q, delivery: 'sequential' }, { ...h.deps, allowance: async () => null });
    assert.equal(unread.state === 'refused' && unread.refusal, 'aave_allowance_unread');
    const repay = await harness('repay');
    const r = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: repay.q, delivery: 'sequential' }, { ...repay.deps, allowance: async () => ZERO });
    assert.equal(r.state, 'ready', r.state === 'refused' ? r.detail : '');
    if (r.state === 'ready') {
      assert.ok(r.facts.warnings.every(warning => !/same atomic batch/.test(warning)));
      assert.match(r.facts.warnings.at(-1)!, /takes funds only for calls your own wallet makes/);
    }
  });
});

describe('Aave runner: repay all, then take the stock back', () => {
  it('a maximum below the debt, or above the wallet’s USDC, is refused in the wallet’s own numbers', async () => {
    const h = await returning();
    const below = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: { ...h.q, maximumAssets: (h.s.debtAssets - 1n).toString() } }, h.deps);
    assert.equal(below.state, 'refused');
    if (below.state === 'refused') {
      assert.equal(below.refusal, 'repay_maximum_exceeded');
      assert.ok(below.detail.startsWith(`The debt is ${usdcWordsV1(h.s.debtAssets)} now, more than your maximum of ${usdcWordsV1(h.s.debtAssets - 1n)}: interest adds to it every second.`), below.detail);
    }
    // Audit LEND-2 (2026-11-10): Aave takes the smaller of the debt and the bound when the repayment lands, so
    // a maximum at the debt itself leaves the interest since the read owing. The least bound is named.
    const least = repayAllBoundAtomicV1(h.s.debtAssets);
    // What is refused is a bound the debt has nearly reached (audit LA-1): the debt and room until landing.
    const minimum = repayAllMinimumAtomicV1(h.s.debtAssets);
    assert.ok(minimum > h.s.debtAssets && minimum < least);
    for (const maximum of [h.s.debtAssets, minimum - 1n]) {
      const tight = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: { ...h.q, maximumAssets: maximum.toString() } }, h.deps);
      assert.equal(tight.state, 'refused');
      if (tight.state === 'refused') {
        assert.equal(tight.refusal, 'repay_maximum_exceeded');
        // The page's own bound is what the person is told to use.
        assert.ok(tight.detail.includes(`Set the maximum to at least ${usdcWordsV1(least)}; what is not needed stays in your wallet.`), tight.detail);
        assert.doesNotMatch(tight.detail, /at least the debt/);
      }
    }
    // At the least bound the maximum is no longer what refuses: the review goes on to be simulated.
    const roomy = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: { ...h.q, maximumAssets: least.toString() } }, h.deps);
    assert.notEqual(roomy.state === 'refused' ? roomy.refusal : null, 'repay_maximum_exceeded');
    assert.equal(h.simulations(), 1);
    // Audit LA-1 (2026-11-14): the page's bound, read a moment earlier, after the debt crossed a cent since. It was
    // refused as below a bound rounded up again at the server's reading; it keeps almost all of its room, and goes.
    // The page read the debt on a cent; a second later the server reads one base unit more.
    const pageBound = repayAllBoundAtomicV1(h.s.debtAssets), later = h.s.debtAssets + 1n;
    assert.ok(pageBound < repayAllBoundAtomicV1(later), 'the debt crossed a cent between the page and the review');
    const raced = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: { ...h.q, maximumAssets: pageBound.toString() } },
      { ...h.deps, read: async () => ({ state: 'read' as const, standing: { ...h.s, debtAssets: later } }) });
    assert.notEqual(raced.state === 'refused' ? raced.refusal : null, 'repay_maximum_exceeded');
    assert.equal(h.simulations(), 2, 'it went on to be simulated');
    const short = { ...h.s, walletUsdcAssets: h.s.debtAssets - 3n };
    const funding = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: h.q }, { ...h.deps, read: async () => ({ state: 'read' as const, standing: short }) });
    assert.equal(funding.state, 'refused');
    if (funding.state === 'refused') {
      assert.equal(funding.refusal, 'aave_funding_insufficient');
      assert.match(funding.detail, /^This wallet holds [\d.]+ USDC, less than your maximum of 20 USDC\. The debt is [\d.]+ USDC, 0\.000003 USDC more than the wallet holds/);
    }
    assert.equal(h.simulations(), 2);
  });
  async function returning(debt = true, change?: (body: SimulationProviderResponseV1) => void, delivery?: 'sequential') {
    const s = await aaveStandingFixture('repay', debt ? aaveReadFixture() : aaveRepaidReadFixture());
    const maximum = debt ? BigInt(20_000_000) : ZERO, stock = s.selectedStock!;
    const q: LendingQuestionV1 = { operation: 'repay', collateralTokenAddress: stock.token.toLowerCase(), amountMode: 'all', repayAssets: null,
      maximumAssets: maximum.toString(), returnCollateral: true };
    let simulations = 0;
    const provider: SimulationProvider = { providerId: 'aave-fixture', async simulate(request) {
      simulations++;
      // In steps the repayment leaves the rest of its allowance with the Spoke.
      const f = aavePoststateFixture(s, 'repay', maximum, (p, after) => { if (after && delivery && debt) p.allowance = maximum - s.debtAssets; }, true);
      const observations = { ...f.response.observations, requestHash: stableHashV1('simulation-observations/v1', { chainId: 8453, walletAddress: request.walletAddress.toLowerCase(), callsHash: request.callsHash,
        before: request.observations!.before, after: request.observations!.after }) };
      const body: SimulationProviderResponseV1 = { status: 'success', blockNumber: s.blockNumber, gasUsed: '300000', stateChanges: [], revertReason: null, observations,
        assetChanges: { status: 'available', unavailableReason: null, changes: [
          ...(debt ? [{ kind: 'erc20_transfer' as const, token: ADDRESSES.usdc, direction: 'out' as const, amountAtomic: s.debtAssets.toString(), counterparty: ADDRESSES.aaveHub, callIndex: 2 }] : []),
          { kind: 'erc20_transfer', token: stock.token, direction: 'in', amountAtomic: s.existingSuppliedAssets.toString(), counterparty: ADDRESSES.aaveHub, callIndex: debt ? 4 : 0 },
        ] } };
      change?.(body); return { ok: true, body };
    } };
    const deps = { read: async () => ({ state: 'read' as const, standing: s }), deploymentAt: async () => s.deployment, allowance: async () => ZERO,
      chain: { providers: [provider], batchCapableIds: new Set(['aave-fixture']) }, now: () => NOW };
    return { s, q, deps, simulations: () => simulations,
      run: () => runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: q, ...(delivery ? { delivery } : {}) }, deps) };
  }
  it('repays the whole debt and returns the whole deposit in one batch, and binds the return into what is signed', async () => {
    const h = await returning(), r = await h.run();
    assert.equal(r.state, 'ready', r.state === 'refused' ? r.detail : ''); if (r.state !== 'ready') return;
    assert.equal(r.atomicRequired, true);
    assert.deepEqual(r.calls.map(c => c.callType), ['approval', 'approval', 'other', 'approval', 'withdraw']);
    assert.equal(r.facts.collateralReturnAssets, h.s.existingSuppliedAssets.toString());
    assert.deepEqual([r.facts.debtAfterAssets, r.facts.collateralAfterAssets, r.facts.maximumDebitAssets, r.facts.amountMode], ['0', '0', '20000000', 'all']);
    assert.match(r.facts.warnings[0]!, /repays all USDC debt .* then returns your NVDAc deposit to this wallet/);
    // Final audit FA3, 2026-11-04: the batch holds no zero-debt check, and Aave lets a stock leave a healthy
    // account with debt left, so nothing may promise that leftover debt reverts it.
    assert.match(r.facts.warnings[1]!, /Aave checks that the account stays healthy, not that the debt is zero, so Still reads the result from Base/);
    assert.doesNotMatch(r.facts.warnings.join(' '), /revert/);
    assert.equal(lendingSigningTermsFactsV1(r.facts).collateralReturnAssets, h.s.existingSuppliedAssets.toString());
  });
  it('with no debt left returns the stock alone: one withdrawal, no USDC and a zero maximum', async () => {
    const h = await returning(false), r = await h.run();
    assert.equal(r.state, 'ready', r.state === 'refused' ? r.detail : ''); if (r.state !== 'ready') return;
    assert.deepEqual(r.calls.map(c => c.callType), ['withdraw']);
    assert.deepEqual([r.facts.debtBeforeAssets, r.facts.maximumDebitAssets, r.measured.loanDeltaAssets], ['0', '0', '0']);
    assert.match(r.facts.warnings[0]!, /No USDC debt is open/);
  });
  it('refuses with nothing deposited or another asset borrowed, before anything is simulated', async () => {
    const empty = await returning(); empty.s.existingSuppliedAssets = ZERO;
    const a = await empty.run(); assert.equal(a.state === 'refused' && a.refusal, 'nothing_to_return'); assert.equal(empty.simulations(), 0);
    const other = await returning(); const reserve = other.s.snapshot.aave!.reserves.find(r => r.info.role.kind === 'stock')!;
    reserve.status = { ok: true, value: { usingAsCollateral: true, borrowing: true } };
    const b = await other.run(); assert.equal(b.state === 'refused' && b.refusal, 'aave_other_debt_open'); assert.equal(other.simulations(), 0);
  });
  it('refuses a stock that arrives short of the deposit, and a stock that arrives when the question did not ask for it', async () => {
    const short = await returning(true, body => { const change = body.assetChanges!.changes.at(-1)!; change.amountAtomic = (BigInt(change.amountAtomic) - BigInt(1)).toString(); });
    const a = await short.run(); assert.equal(a.state === 'refused' && a.refusal, 'aave_effects_mismatch');
    const plain = await harness('repay', body => { body.assetChanges!.changes.push({ kind: 'erc20_transfer', token: plain.s.selectedStock!.token, direction: 'in', amountAtomic: '1', counterparty: ADDRESSES.aaveHub, callIndex: 2 }); });
    const b = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: plain.q }, plain.deps);
    assert.equal(b.state === 'refused' && b.refusal, 'aave_unrequested_asset_change');
  });
  it('in steps: the repayment, then the withdrawal, with the rest of the allowance left to the Spoke', async () => {
    const h = await returning(true, undefined, 'sequential'), r = await h.run();
    assert.equal(r.state, 'ready', r.state === 'refused' ? r.detail : ''); if (r.state !== 'ready') return;
    assert.deepEqual([r.atomicRequired, r.delivery], [false, 'sequential']);
    assert.deepEqual(r.calls.map(c => c.callType), ['approval', 'other', 'withdraw']);
    assert.match(r.facts.warnings.at(-1)!, /Stopping after the repayment leaves the stock deposited/);
  });
});

describe('Aave runner: what a fall at once and a paused stock would do to a new loan', () => {
  const borrow = async (patch?: Parameters<typeof aavePoststateFixture>[3]) => {
    const h = await harness('borrow', undefined, patch);
    return { h, r: await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: h.q }, h.deps) };
  };
  it('reads each fall from the simulated health ratio, with the price that starts a liquidation', async () => {
    const { h, r } = await borrow();
    assert.equal(r.state, 'ready', r.state === 'refused' ? r.detail : '');
    if (r.state !== 'ready') return;
    const stress = r.facts.stress!, WAD = BigInt(10) ** BigInt(18);
    // The fixture's account reads a health ratio of 5.00 after the loan.
    assert.equal(r.facts.healthAfterWad, (BigInt(5) * WAD).toString());
    assert.deepEqual(stress.scenarios.map(row => [row.fallBps, row.healthWad, row.liquidatable]), [
      [1_000, (BigInt(45) * WAD / BigInt(10)).toString(), false], [2_000, (BigInt(4) * WAD).toString(), false], [3_000, (BigInt(35) * WAD / BigInt(10)).toString(), false]]);
    assert.equal(stress.marginTenths, 800);
    assert.equal(stress.scope, 'collateral');
    const reserve = h.s.snapshot.aave!.reserves.find(x => x.info.reserveId === h.s.collateralReserve!.reserveId)!;
    const price = reserve.price.ok ? reserve.price.value : ZERO, unit = BigInt(10) ** BigInt((h.s.universe.aave.ok ? h.s.universe.aave.oracleDecimals : 8) - 2);
    assert.equal(stress.priceCents, (price / unit).toString());
    assert.equal(stress.liquidationPriceCents, ((price * WAD + BigInt(5) * WAD * unit - BigInt(1)) / (BigInt(5) * WAD * unit)).toString());
    // Read at the simulation block: not paused, and this reserve gives a liquidator no shares.
    assert.deepEqual(stress.transfers, { pausable: true, paused: false, liquidationMovesToken: true });
    // Informational: the signing terms do not carry it.
    assert.equal('stress' in lendingSigningTermsFactsV1(r.facts), false);
  });
  it('says a liquidation does not wait for a pause where the reserve lets a liquidator take shares', async () => {
    const { r } = await borrow(phase => { phase.receiveShares = true; });
    assert.equal(r.state, 'ready');
    if (r.state === 'ready') assert.equal(r.facts.stress!.transfers.liquidationMovesToken, false);
  });
  it('refuses a new loan against a stock whose transfers are paused, and says repaying works', async () => {
    const { r } = await borrow(phase => { phase.transfersPaused = true; });
    assert.equal(r.state, 'refused');
    if (r.state === 'refused') {
      assert.equal(r.refusal, 'collateral_transfers_paused');
      assert.match(r.detail, /transfers are paused onchain \(Base block [\d,]+\)\. Still opens no new loan against it/);
      assert.match(r.detail, /Repaying works\.$/);
    }
  });
  // Audit LA-2 (2026-11-14): only the chosen stock's pause was read, while Still's limit counts every stock the
  // account has enabled. A loan chosen against NVDAc stood mostly on AAPLc, paused and liquidable.
  it('refuses a new loan on an account whose limit also counts a stock whose transfers are paused', async () => {
    const aapl = STOCKS.find(stock => stock.id === 'AAPLc')!.token;
    const read = () => aaveReadFixture({ AAPLc: BigInt(100_000_000) });
    const paused = await harness('borrow', undefined, phase => { phase.pausedTokens = [aapl]; }, read());
    const r = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: paused.q }, paused.deps);
    assert.equal(r.state, 'refused');
    if (r.state === 'refused') {
      assert.equal(r.refusal, 'collateral_transfers_paused');
      assert.match(r.detail, /^AAPLc is paused onchain \(Base block [\d,]+\), and this Aave account counts it as collateral beside NVDAc\. Still opens no new loan on it while it is/);
      assert.match(r.detail, /Repaying works\.$/);
    }
    // The same account with nothing paused is reviewed, and a repayment is never stopped by a pause.
    const open = await harness('borrow', undefined, undefined, read());
    assert.equal((await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: open.q }, open.deps)).state, 'ready');
    const repay = await harness('repay', undefined, phase => { phase.pausedTokens = [aapl]; }, read());
    const repaid = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: repay.q }, repay.deps);
    assert.equal(repaid.state, 'ready', repaid.state === 'refused' ? repaid.detail : '');
  });
  it('a stock that does not answer leaves the pause unread, and the loan is still reviewed', async () => {
    const { r } = await borrow(phase => { phase.pauseUnread = true; });
    assert.equal(r.state, 'ready', r.state === 'refused' ? r.detail : '');
    if (r.state === 'ready') assert.equal(r.facts.stress!.transfers.paused, null);
  });
  it('with more than one collateral says only how far all of it can fall together', async () => {
    const { r } = await borrow(phase => { phase.activeCollateralCount = BigInt(2); });
    assert.equal(r.state, 'ready');
    if (r.state === 'ready') {
      assert.equal(r.facts.stress!.scope, 'all_collateral');
      assert.deepEqual([r.facts.stress!.priceCents, r.facts.stress!.liquidationPriceCents], [null, null]);
    }
  });
  it('a repayment carries no stress and asks nothing about a pause', async () => {
    const h = await harness('repay', undefined, phase => { phase.transfersPaused = true; });
    const r = await runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: h.q }, h.deps);
    assert.equal(r.state, 'ready', r.state === 'refused' ? r.detail : '');
    if (r.state === 'ready') assert.equal(r.facts.stress, undefined);
  });
});

// Audit N13-4, 2026-11-13. A stock whose reference price was not refreshed for over a day of open market
// counts as while Wall Street is closed. The Mirror said so, and the page showed the lower limit; the loan
// itself was drawn and checked at the full share, so a loan past the shown limit was ready to sign.
describe('a stock price not refreshed for over a day of open market lowers the loan’s own limit', () => {
  // A Wednesday: the two days before it are open market, with no closed window between.
  const AT = new Date('2026-10-21T15:00:00Z');
  const ask = BigInt(60_000_000);
  async function staleRead(ageSeconds: bigint) {
    const raw = aaveReadFixture();
    raw.snapshot.block.timestamp = BigInt(AT.getTime() / 1000);
    const stock = raw.snapshot.aave!.reserves.find(r => r.info.role.kind === 'stock' && r.info.role.asset.id === 'NVDAc')!;
    raw.snapshot.balances.set(stock.info.underlying.toLowerCase(), { ok: true, value: ZERO });
    stock.priceUpdatedAt = { ok: true, value: raw.snapshot.block.timestamp - ageSeconds };
    const reading = await readStillAaveStandingV1({ walletAddress: AAVE_TEST_WALLET, operation: 'borrow', stockId: 'NVDAc', collateralSupplyAssets: ZERO,
      deps: { now: () => AT, snapshot: async () => raw, calendar: async () => calendar() } });
    if (reading.state !== 'read') throw new Error(`the fixture was not read: ${reading.refusal}`);
    return { raw, reading, s: reading.standing, token: stock.info.underlying.toLowerCase() };
  }
  /** A simulation whose block is `laterSeconds` after the read. */
  function provider(s: StillAaveStandingV1, laterSeconds = ZERO): SimulationProvider {
    const at = { ...s, snapshot: { ...s.snapshot, block: { ...s.snapshot.block, timestamp: s.snapshot.block.timestamp + laterSeconds } } };
    return { providerId: 'aave-fixture', async simulate(request) {
      const f = aavePoststateFixture(at, 'borrow', ask);
      const observations = { ...f.response.observations, requestHash: stableHashV1('simulation-observations/v1', { chainId: 8453, walletAddress: request.walletAddress.toLowerCase(),
        callsHash: request.callsHash, before: request.observations!.before, after: request.observations!.after }) };
      return { ok: true, body: { status: 'success', blockNumber: s.blockNumber, gasUsed: '200000', stateChanges: [], revertReason: null, observations,
        assetChanges: { status: 'available', unavailableReason: null, changes: [{ kind: 'erc20_transfer', token: ADDRESSES.usdc, direction: 'in', amountAtomic: ask.toString(), counterparty: ADDRESSES.aaveHub, callIndex: 0 }] } } };
    } };
  }
  const run = (s: StillAaveStandingV1, token: string, reading: Awaited<ReturnType<typeof staleRead>>['reading'], laterSeconds = ZERO) =>
    runAaveLendingV1({ walletAddress: AAVE_TEST_WALLET, question: { operation: 'borrow', collateralTokenAddress: token, borrowAssets: ask.toString(), collateralSupplyAssets: '0' } },
      { read: async () => reading, deploymentAt: async () => s.deployment, chain: { providers: [provider(s, laterSeconds)], batchCapableIds: new Set(['aave-fixture']) }, now: () => AT });

  it('counts the stock at the closed-market share, the limit the Mirror shows, and refuses a loan past it', async () => {
    const { raw, s, token, reading } = await staleRead(BigInt(48 * 3600));
    assert.equal(s.capacity!.shareBpsByStock.NVDAc, 4000);
    assert.deepEqual(s.capacity!.loweredByStock.NVDAc, { reason: 'price_stale', updatedAt: new Date(AT.getTime() - 48 * 3_600_000).toISOString() });
    const mirror = computeMirror({ universe: raw.universe, snapshot: raw.snapshot, calendar: calendar(), subject: { address: AAVE_TEST_WALLET, name: null, input: 'fixture' }, assembledAt: AT });
    const venue = mirror.venues.find(row => row.venue === 'aave-v4')!;
    assert.equal(mirror.assets.find(row => row.asset === 'NVDAc')!.stillFactorBps, 2800);
    assert.equal((s.capacity!.limitAssets / BigInt(10_000)).toString(), venue.capacityCents, 'one limit, on the page and on the loan');
    // 60 USDC more on 10 owed would be 70 against a limit of $59.33: it was ready to sign.
    const r = await run(s, token, reading);
    assert.equal(r.state, 'refused');
    if (r.state === 'refused') assert.equal(r.refusal, 'aave_over_still_limit');
  });
  it('a price that turns stale between the read and the simulation is checked again at the simulated block', async () => {
    // 24 h 50 min old when read: the full share. An hour later, at the simulated block, it is past 25 h.
    const { s, token, reading } = await staleRead(BigInt(24 * 3600 + 50 * 60));
    assert.equal(s.capacity!.shareBpsByStock.NVDAc, 5000);
    assert.ok(ask <= s.capacity!.availableAssets, 'the first check lets it through');
    const r = await run(s, token, reading, BigInt(3600));
    assert.equal(r.state, 'refused');
    if (r.state === 'refused') {
      // The poststate proof checks the debt against the limit at the simulated block, before anything is reviewed.
      assert.equal(r.refusal, 'aave_poststate_policy_refused');
      assert.match(r.detail, /measured total debt exceeds Still’s current whole-account allowance/);
    }
    // The same simulation in the same hour as the read is ready: it was the age that refused it.
    const same = await run(s, token, reading);
    assert.equal(same.state, 'ready', same.state === 'refused' ? same.detail : '');
  });
  it('a fresh price, or one whose age could not be read, keeps the full share and the loan', async () => {
    const { s, token, reading } = await staleRead(BigInt(3600));
    assert.equal(s.capacity!.shareBpsByStock.NVDAc, 5000);
    assert.equal(s.capacity!.loweredByStock.NVDAc, undefined);
    const r = await run(s, token, reading);
    assert.equal(r.state, 'ready', r.state === 'refused' ? r.detail : '');
  });
});
