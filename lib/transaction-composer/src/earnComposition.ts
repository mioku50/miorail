import { encodeFunctionData, erc20Abi } from 'viem';
import {
  ExecutionBlueprintV1Schema,
  SafetyKernelResultV1Schema,
  ZERO_HASH_V1,
  hashApprovedCallsV1,
  hashExecutionBlueprintV1,
  stableHashV1,
  type EarnCandidateV1,
  type EarnRouteIntentV1,
  type ExecutionBlueprintV1,
  type ExecutionCallV1,
  type ExpectedAssetChangeV1,
  type HashV1,
  type RequiredApprovalV1,
  type SimulationStateV1,
} from '@mioagent/route-domain';
import { runEarnSafetyKernelV1 } from './earnSafetyKernel.js';
import type { SafetyKernelResultV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T61 §7 — earn deposit transaction composition. Builds the EXACT unsigned
// calls for a selected earn candidate — a single exact-amount USDC approval to
// the pinned target, then the pinned deposit — and assembles them into the
// goal-agnostic ExecutionBlueprintV1 (reused verbatim from route-domain, so the
// existing approve + Base Account batch-submission surfaces carry it unchanged). The
// server only ever emits these two calls; it never signs, broadcasts, or adds
// arbitrary calldata. The earn Safety Kernel re-validates the bytes before the
// Blueprint is returned.
// ---------------------------------------------------------------------------

/** Moonwell mErc20 `mint(uint256)`: supply USDC, mTokens credited to msg.sender
 * (the wallet). No receiver arg — the wallet IS the receiver by construction. */
export const MOONWELL_MINT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'mintAmount', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** Morpho MetaMorpho ERC-4626 `deposit(uint256 assets, address receiver)`. */
export const MORPHO_DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
] as const;

/** YO Gateway deposit — vault is explicit, shares are bounded, partnerId=0. */
export const YO_GATEWAY_DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'vault', type: 'address' },
      { name: 'assets', type: 'uint256' },
      { name: 'minShares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'partnerId', type: 'uint32' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
] as const;

const UNAVAILABLE_SIMULATION_V1: SimulationStateV1 = {
  status: 'unavailable',
  observedAt: null,
  blockNumber: null,
  requestHash: null,
  responseHash: null,
  errorCode: 'no_simulation_provider',
};

export function earnBlueprintIdV1(input: {
  tenantId: string;
  walletAddress: `0x${string}`;
  intentHash: HashV1;
  candidateHash: HashV1;
  requestId: string;
}): string {
  const hash = stableHashV1('earn-blueprint-request/v1', {
    tenantId: input.tenantId,
    walletAddress: input.walletAddress.toLowerCase(),
    intentHash: input.intentHash,
    candidateHash: input.candidateHash,
    requestId: input.requestId,
  });
  return `earn-blueprint:${hash.slice(2)}`;
}

/** Builds the two exact, unsigned earn deposit calls (approval then deposit).
 * Amounts come from the stored intent — never a client-supplied value. */
export function buildEarnDepositCallsV1(input: {
  intent: EarnRouteIntentV1;
  candidate: EarnCandidateV1;
  walletAddress: `0x${string}`;
}): ExecutionCallV1[] {
  const amount = BigInt(input.intent.amount.amountAtomic);
  const usdc = input.candidate.contracts.asset;
  const target = input.candidate.contracts.target;
  const spender = input.candidate.contracts.approvalSpender;

  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
  const expectedShares =
    input.candidate.expectedPositionAtomic === undefined ||
    input.candidate.expectedPositionAtomic === null
      ? null
      : BigInt(input.candidate.expectedPositionAtomic);
  const minimumShares = expectedShares === null ? null : (expectedShares * 9_950n) / 10_000n;
  if (input.candidate.protocol === 'yo' && (minimumShares === null || minimumShares <= 0n)) {
    throw new TypeError('YO deposit requires a fresh positive share conversion');
  }
  const depositData =
    input.candidate.protocol === 'moonwell'
      ? encodeFunctionData({ abi: MOONWELL_MINT_ABI, functionName: 'mint', args: [amount] })
      : input.candidate.protocol === 'morpho'
        ? encodeFunctionData({ abi: MORPHO_DEPOSIT_ABI, functionName: 'deposit', args: [amount, input.walletAddress] })
        : encodeFunctionData({
            abi: YO_GATEWAY_DEPOSIT_ABI,
            functionName: 'deposit',
            args: [target, amount, minimumShares!, input.walletAddress, 0],
          });

  const approvalCall: ExecutionCallV1 = {
    index: 0,
    callType: 'approval',
    to: usdc,
    valueWei: '0',
    data: approveData,
    asset: input.intent.asset,
    amountAtomic: input.intent.amount.amountAtomic,
    recipient: null,
    spender,
  };
  const depositCall: ExecutionCallV1 = {
    index: 1,
    callType: 'deposit',
    to: input.candidate.protocol === 'yo' ? spender : target,
    valueWei: '0',
    data: depositData,
    asset: input.intent.asset,
    amountAtomic: input.intent.amount.amountAtomic,
    recipient: input.walletAddress,
    spender: null,
  };
  return [approvalCall, depositCall];
}

export interface BuildEarnDepositBlueprintInputV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  intent: EarnRouteIntentV1;
  candidate: EarnCandidateV1;
  evidenceSetHash: HashV1;
  requestId: string;
  now: Date;
  /** Defaults to the candidate evidence expiry. */
  quoteExpiry?: string;
  /** Defaults to an honest `unavailable` state (no fabricated `passed`). */
  simulationState?: SimulationStateV1;
}

export type BuildEarnDepositBlueprintResultV1 =
  | { outcome: 'prepared'; blueprint: ExecutionBlueprintV1; safety: SafetyKernelResultV1 }
  | { outcome: 'expired'; reason: string }
  | { outcome: 'blocked'; reason: string; safety: SafetyKernelResultV1 };

/**
 * Composes and Safety-Kernel-validates a full earn deposit Blueprint. The
 * blueprint's only asserted balance change is the EXACT USDC debit — the
 * variable position credit (mTokens / vault shares) is deliberately not
 * promised here and is proven from on-chain state by the Route Proof (§8).
 */
export function buildEarnDepositBlueprintV1(
  input: BuildEarnDepositBlueprintInputV1,
): BuildEarnDepositBlueprintResultV1 {
  const quoteExpiry = input.quoteExpiry ?? input.candidate.expiresAt;
  if (Date.parse(quoteExpiry) <= input.now.getTime()) {
    return { outcome: 'expired', reason: 'Earn quote/evidence has expired and can no longer be prepared' };
  }

  if (
    input.candidate.protocol === 'yo' &&
    (input.candidate.expectedPositionAtomic === null ||
      input.candidate.expectedPositionAtomic === undefined ||
      BigInt(input.candidate.expectedPositionAtomic) <= 0n)
  ) {
    const reason = 'YO requires a fresh positive onchain share conversion before deposit preparation';
    return {
      outcome: 'blocked',
      reason,
      safety: SafetyKernelResultV1Schema.parse({
        schemaVersion: 'safety-kernel-result/v1',
        verdict: 'blocked',
        checks: [{
          id: 'yo_share_quote_present',
          description: 'YO deposit requires a fresh positive convertToShares result',
          status: 'failed',
          detail: reason,
        }],
        blockedReason: reason,
      }),
    };
  }

  if (
    input.candidate.protocol === 'yo' &&
    (input.candidate.expectedPositionAtomic === null ||
      input.candidate.expectedPositionAtomic === undefined ||
      BigInt(input.candidate.expectedPositionAtomic) <= 0n)
  ) {
    const reason = 'YO requires a fresh positive onchain share conversion before deposit preparation';
    return {
      outcome: 'blocked',
      reason,
      safety: SafetyKernelResultV1Schema.parse({
        schemaVersion: 'safety-kernel-result/v1',
        verdict: 'blocked',
        checks: [{
          id: 'yo_share_quote_present',
          description: 'YO deposit requires a fresh positive convertToShares result',
          status: 'failed',
          detail: reason,
        }],
        blockedReason: reason,
      }),
    };
  }

  const calls = buildEarnDepositCallsV1({
    intent: input.intent,
    candidate: input.candidate,
    walletAddress: input.walletAddress,
  });

  const { result: safety } = runEarnSafetyKernelV1({
    walletAddress: input.walletAddress,
    intent: input.intent,
    candidate: input.candidate,
    calls,
    quoteExpiry,
    now: input.now,
    intentHash: input.intent.intentHash,
    selectedCandidateHash: input.candidate.candidateHash,
  });
  if (safety.verdict === 'blocked') {
    return { outcome: 'blocked', reason: safety.blockedReason ?? 'Earn Safety Kernel blocked this deposit', safety };
  }

  const nowIso = input.now.toISOString();
  const expectedAssetChanges: ExpectedAssetChangeV1[] = [
    {
      asset: input.intent.asset,
      direction: 'debit',
      amountAtomic: input.intent.amount.amountAtomic,
      minimumAmountAtomic: input.intent.amount.amountAtomic,
      maximumAmountAtomic: input.intent.amount.amountAtomic,
    },
  ];
  const requiredApprovals: RequiredApprovalV1[] = [
    {
      asset: input.intent.asset,
      spender: input.candidate.contracts.approvalSpender,
      amountAtomic: input.intent.amount.amountAtomic,
      approvalKind: 'exact',
      state: 'required',
    },
  ];

  const draft: ExecutionBlueprintV1 = {
    schemaVersion: 'execution-blueprint/v1',
    goal: 'earn',
    id: earnBlueprintIdV1({
      tenantId: input.tenantId,
      walletAddress: input.walletAddress,
      intentHash: input.intent.intentHash,
      candidateHash: input.candidate.candidateHash,
      requestId: input.requestId,
    }),
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: 8453,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'ready_for_review',
    intentHash: input.intent.intentHash,
    selectedCandidateHash: input.candidate.candidateHash,
    evidenceSetHash: input.evidenceSetHash,
    blueprintHash: ZERO_HASH_V1,
    callsHash: hashApprovedCallsV1(calls),
    approvedCallsHash: null,
    quoteExpiry,
    calls,
    expectedAssetChanges,
    requiredApprovals,
    simulationState: input.simulationState ?? UNAVAILABLE_SIMULATION_V1,
    atomicRequired: true,
  };
  const blueprint = ExecutionBlueprintV1Schema.parse({
    ...draft,
    blueprintHash: hashExecutionBlueprintV1(draft),
  });
  return { outcome: 'prepared', blueprint, safety };
}
