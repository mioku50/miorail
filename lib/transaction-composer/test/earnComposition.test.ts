import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData, erc20Abi } from 'viem';
import { resolveEarnIntentV1 } from '@mioagent/intent-engine';
import { compareEarnRoutesV1, createCuratedEarnDataSourceV1, pinnedEarnVenueV1 } from '@mioagent/earn-engine';
import { hashApprovedCallsV1, hashExecutionBlueprintV1 } from '@mioagent/route-domain';
import type { EarnCandidateV1, EarnRouteIntentV1, ExecutionCallV1 } from '@mioagent/route-domain';
import {
  MOONWELL_MINT_ABI,
  MORPHO_DEPOSIT_ABI,
  buildEarnDepositBlueprintV1,
  buildEarnDepositCallsV1,
  runEarnSafetyKernelV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T61 §7 — earn deposit transaction composition + Safety Kernel. All fixtures
// come from the real OFFLINE engine (resolveEarnIntentV1 + curated compare), so
// intent/candidate hashes are genuine and no live provider or chain call is made.
// Adversarial cases tamper the server-built calls and prove the kernel blocks.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x2222222222222222222222222222222222222222' as const;
const NOW = new Date('2026-07-21T12:00:00.000Z');
const EVIDENCE_SET_HASH = `0x${'a'.repeat(64)}` as `0x${string}`;
const AMOUNT_ATOMIC = 500_000_000n; // 500 USDC (6dp)
const MAX_UINT256 = (1n << 256n) - 1n;

async function fixtures(): Promise<{ intent: EarnRouteIntentV1; moonwell: EarnCandidateV1; morpho: EarnCandidateV1 }> {
  const resolution = resolveEarnIntentV1({
    message: 'Deposit 500 USDC for yield.',
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    now: NOW,
  });
  assert.equal(resolution.status, 'ready');
  if (resolution.status !== 'ready') throw new Error('intent not ready');
  const comparison = await compareEarnRoutesV1(
    { dataSource: createCuratedEarnDataSourceV1() },
    { intent: resolution.intent, now: NOW },
  );
  assert.equal(comparison.ok, true);
  if (!comparison.ok) throw new Error('comparison failed');
  const byProtocol = (protocol: 'moonwell' | 'morpho') => {
    const entry = comparison.entries.find((e) => e.candidate.protocol === protocol);
    if (!entry) throw new Error(`missing ${protocol} candidate`);
    return entry.candidate;
  };
  return { intent: resolution.intent, moonwell: byProtocol('moonwell'), morpho: byProtocol('morpho') };
}

function prepareInput(intent: EarnRouteIntentV1, candidate: EarnCandidateV1) {
  return {
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    intent,
    candidate,
    evidenceSetHash: EVIDENCE_SET_HASH,
    requestId: 'earn-prepare-1',
    now: NOW,
  };
}

/** Runs the kernel over a (possibly tampered) call list against a real candidate. */
function kernel(intent: EarnRouteIntentV1, candidate: EarnCandidateV1, calls: ExecutionCallV1[]) {
  return runEarnSafetyKernelV1({
    walletAddress: WALLET,
    intent,
    candidate,
    calls,
    quoteExpiry: candidate.expiresAt,
    now: NOW,
    intentHash: intent.intentHash,
    selectedCandidateHash: candidate.candidateHash,
  }).result;
}

function failedIds(result: ReturnType<typeof kernel>): string[] {
  return result.checks.filter((c) => c.status === 'failed').map((c) => c.id);
}

describe('T61 earn deposit composition', () => {
  test('Moonwell: exact USDC approval + mint(amount) into the pinned market, single exact debit', async () => {
    const { intent, moonwell } = await fixtures();
    const result = buildEarnDepositBlueprintV1(prepareInput(intent, moonwell));
    assert.equal(result.outcome, 'prepared');
    if (result.outcome !== 'prepared') return;
    assert.equal(result.safety.verdict, 'allowed');

    const [approval, deposit] = result.blueprint.calls;
    assert.equal(approval.callType, 'approval');
    assert.equal(deposit.callType, 'deposit');

    const approveDecoded = decodeFunctionData({ abi: erc20Abi, data: approval.data });
    assert.equal(approveDecoded.functionName, 'approve');
    const [spender, approveAmount] = approveDecoded.args as readonly [`0x${string}`, bigint];
    assert.equal(spender.toLowerCase(), pinnedEarnVenueV1('moonwell').approvalSpender);
    assert.equal(approveAmount, AMOUNT_ATOMIC);
    assert.notEqual(approveAmount, MAX_UINT256);

    const mintDecoded = decodeFunctionData({ abi: MOONWELL_MINT_ABI, data: deposit.data });
    assert.equal(mintDecoded.functionName, 'mint');
    assert.equal((mintDecoded.args as readonly [bigint])[0], AMOUNT_ATOMIC);
    assert.equal(deposit.to.toLowerCase(), pinnedEarnVenueV1('moonwell').target);

    // Only the exact USDC debit is promised; the position credit is proven later.
    assert.equal(result.blueprint.expectedAssetChanges.length, 1);
    assert.equal(result.blueprint.expectedAssetChanges[0].direction, 'debit');
    assert.equal(result.blueprint.expectedAssetChanges[0].amountAtomic, '500000000');
    assert.equal(result.blueprint.requiredApprovals[0].approvalKind, 'exact');
    assert.equal(result.blueprint.requiredApprovals[0].amountAtomic, '500000000');
  });

  test('Morpho: exact USDC approval + ERC-4626 deposit(amount, wallet) into the pinned vault', async () => {
    const { intent, morpho } = await fixtures();
    const result = buildEarnDepositBlueprintV1(prepareInput(intent, morpho));
    assert.equal(result.outcome, 'prepared');
    if (result.outcome !== 'prepared') return;

    const deposit = result.blueprint.calls[1];
    const depositDecoded = decodeFunctionData({ abi: MORPHO_DEPOSIT_ABI, data: deposit.data });
    assert.equal(depositDecoded.functionName, 'deposit');
    const [assets, receiver] = depositDecoded.args as readonly [bigint, `0x${string}`];
    assert.equal(assets, AMOUNT_ATOMIC);
    assert.equal(receiver.toLowerCase(), WALLET);
    assert.equal(deposit.to.toLowerCase(), pinnedEarnVenueV1('morpho').target);
  });

  test('a clean Moonwell and Morpho build both pass every Safety Kernel check', async () => {
    const { intent, moonwell, morpho } = await fixtures();
    for (const candidate of [moonwell, morpho]) {
      const calls = buildEarnDepositCallsV1({ intent, candidate, walletAddress: WALLET });
      const result = kernel(intent, candidate, calls);
      assert.equal(result.verdict, 'allowed', `${candidate.protocol} should be allowed`);
    }
  });

  test('rejects an unlimited (MaxUint256) approval', async () => {
    const { intent, moonwell } = await fixtures();
    const calls = buildEarnDepositCallsV1({ intent, candidate: moonwell, walletAddress: WALLET });
    calls[0] = {
      ...calls[0],
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [moonwell.contracts.approvalSpender, MAX_UINT256] }),
    };
    const result = kernel(intent, moonwell, calls);
    assert.equal(result.verdict, 'blocked');
    const failed = failedIds(result);
    assert.ok(failed.includes('no_unlimited_approval'));
    assert.ok(failed.includes('exact_approval'));
  });

  test('rejects an approval whose amount differs from the intent', async () => {
    const { intent, morpho } = await fixtures();
    const calls = buildEarnDepositCallsV1({ intent, candidate: morpho, walletAddress: WALLET });
    calls[0] = {
      ...calls[0],
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [morpho.contracts.approvalSpender, AMOUNT_ATOMIC + 1n] }),
    };
    const result = kernel(intent, morpho, calls);
    assert.equal(result.verdict, 'blocked');
    assert.ok(failedIds(result).includes('exact_approval'));
  });

  test('rejects a deposit into a non-pinned target (wrong market/vault)', async () => {
    const { intent, moonwell } = await fixtures();
    const calls = buildEarnDepositCallsV1({ intent, candidate: moonwell, walletAddress: WALLET });
    calls[1] = { ...calls[1], to: '0x00000000000000000000000000000000deadbeef' };
    const result = kernel(intent, moonwell, calls);
    assert.equal(result.verdict, 'blocked');
    assert.ok(failedIds(result).includes('deposit_calldata_pinned'));
  });

  test('rejects arbitrary deposit calldata that does not decode to the pinned function', async () => {
    const { intent, morpho } = await fixtures();
    const calls = buildEarnDepositCallsV1({ intent, candidate: morpho, walletAddress: WALLET });
    calls[1] = { ...calls[1], data: '0xdeadbeef' };
    const result = kernel(intent, morpho, calls);
    assert.equal(result.verdict, 'blocked');
    assert.ok(failedIds(result).includes('deposit_calldata_pinned'));
  });

  test('rejects a Morpho deposit whose receiver is not the authenticated wallet', async () => {
    const { intent, morpho } = await fixtures();
    const calls = buildEarnDepositCallsV1({ intent, candidate: morpho, walletAddress: WALLET });
    calls[1] = {
      ...calls[1],
      data: encodeFunctionData({ abi: MORPHO_DEPOSIT_ABI, functionName: 'deposit', args: [AMOUNT_ATOMIC, OTHER] }),
    };
    const result = kernel(intent, morpho, calls);
    assert.equal(result.verdict, 'blocked');
    assert.ok(failedIds(result).includes('receiver_is_wallet'));
  });

  test('rejects a deposit for an unexpected amount (mint of the wrong size)', async () => {
    const { intent, moonwell } = await fixtures();
    const calls = buildEarnDepositCallsV1({ intent, candidate: moonwell, walletAddress: WALLET });
    calls[1] = {
      ...calls[1],
      data: encodeFunctionData({ abi: MOONWELL_MINT_ABI, functionName: 'mint', args: [AMOUNT_ATOMIC - 1n] }),
    };
    const result = kernel(intent, moonwell, calls);
    assert.equal(result.verdict, 'blocked');
    assert.ok(failedIds(result).includes('deposit_calldata_pinned'));
  });

  test('rejects an extra (arbitrary) call appended after the deposit', async () => {
    const { intent, moonwell } = await fixtures();
    const calls = buildEarnDepositCallsV1({ intent, candidate: moonwell, walletAddress: WALLET });
    calls.push({
      index: 2,
      callType: 'other',
      to: '0x00000000000000000000000000000000deadbeef',
      valueWei: '0',
      data: '0x12345678',
      asset: null,
      amountAtomic: null,
      recipient: null,
      spender: null,
    });
    const result = kernel(intent, moonwell, calls);
    assert.equal(result.verdict, 'blocked');
    assert.ok(failedIds(result).includes('call_order_and_count'));
  });

  test('blocks a wallet that does not match the stored intent', async () => {
    const { intent, moonwell } = await fixtures();
    const calls = buildEarnDepositCallsV1({ intent, candidate: moonwell, walletAddress: WALLET });
    const result = runEarnSafetyKernelV1({
      walletAddress: OTHER,
      intent,
      candidate: moonwell,
      calls,
      quoteExpiry: moonwell.expiresAt,
      now: NOW,
      intentHash: intent.intentHash,
      selectedCandidateHash: moonwell.candidateHash,
    }).result;
    assert.equal(result.verdict, 'blocked');
    assert.ok(failedIds(result).includes('tenant_wallet_binding'));
  });

  test('an expired quote/evidence yields an expired outcome, not a Blueprint', async () => {
    const { intent, morpho } = await fixtures();
    const afterExpiry = new Date(Date.parse(morpho.expiresAt) + 1_000);
    const result = buildEarnDepositBlueprintV1({ ...prepareInput(intent, morpho), now: afterExpiry });
    assert.equal(result.outcome, 'expired');
  });

  test('§9: the earn Blueprint meets the existing paid/budget simulation preconditions (reuse, no new x402 flow)', async () => {
    const { intent, morpho } = await fixtures();
    const result = buildEarnDepositBlueprintV1(prepareInput(intent, morpho));
    assert.equal(result.outcome, 'prepared');
    if (result.outcome !== 'prepared') return;
    const bp = result.blueprint;
    // runPaidSimulationV1 (T59) and runBudgetSimulationV1 (T60) re-check this
    // exact self-consistency before ever calling the provider and then drive it
    // from {blueprintHash, callsHash, calls} — all present and consistent on the
    // goal-agnostic earn Blueprint, so it simulates through the unchanged Pay
    // once / Intelligence Budget path. No earn-specific x402/Spend Permission.
    assert.equal(hashApprovedCallsV1(bp.calls), bp.callsHash);
    assert.equal(hashExecutionBlueprintV1(bp), bp.blueprintHash);
    const zero = `0x${'0'.repeat(64)}`;
    assert.notEqual(bp.intentHash, zero);
    assert.notEqual(bp.selectedCandidateHash, zero);
    assert.equal(bp.evidenceSetHash.length, 66);
    // The charge/simulation must NOT be pre-marked passed at composition time.
    assert.equal(bp.simulationState.status, 'unavailable');
  });

  test('the composed blueprint round-trips and never carries a fabricated passed simulation', async () => {
    const { intent, moonwell } = await fixtures();
    const result = buildEarnDepositBlueprintV1(prepareInput(intent, moonwell));
    assert.equal(result.outcome, 'prepared');
    if (result.outcome !== 'prepared') return;
    assert.equal(result.blueprint.simulationState.status, 'unavailable');
    assert.equal(result.blueprint.status, 'ready_for_review');
    assert.equal(result.blueprint.approvedCallsHash, null);
    assert.equal(result.blueprint.atomicRequired, true);
  });
});
