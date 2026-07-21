import { decodeFunctionData, erc20Abi } from 'viem';
import {
  ExecutionBlueprintV1Schema,
  hashApprovedCallsV1,
  hashExecutionBlueprintV1,
  stableHashV1,
  ZERO_HASH_V1,
  type AssetRefV1,
  type ExecutionBlueprintV1,
  type ExecutionCallV1,
  type ExpectedAssetChangeV1,
  type HashV1,
  type RequiredApprovalV1,
  type SimulationStateV1,
} from '@mioagent/route-domain';
import type { SwapBuildCallV1 } from './types.js';

const PERMIT2_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

export interface ClassifySwapCallInput {
  index: number;
  call: SwapBuildCallV1;
  routerAddress: `0x${string}`;
  usdcAsset: AssetRefV1;
  walletAddress: `0x${string}`;
}

/**
 * Classifies one server-built unsigned call. ERC-20 / Permit2 approvals are
 * decoded via viem `decodeFunctionData` (never trusted from provider labels)
 * and the pinned router call is recognized by address. A call that matches
 * neither known pattern is classified 'other' (never mislabeled as a known
 * approval/swap) — the Safety Kernel's provider guard (validateUniswapSwap /
 * validateKyberSwap) then fails closed on the unrecognized target, so
 * classification itself never throws.
 */
export function classifySwapCallV1(input: ClassifySwapCallInput): ExecutionCallV1 {
  const { call } = input;
  const toLower = call.to.toLowerCase();
  const usdcAddress = input.usdcAsset.address?.toLowerCase();
  const selector = call.data.slice(0, 10).toLowerCase();

  if (usdcAddress && toLower === usdcAddress && selector === '0x095ea7b3') {
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
      if (decoded.functionName === 'approve') {
        const [spender, amount] = decoded.args as readonly [`0x${string}`, bigint];
        return {
          index: input.index,
          callType: 'approval',
          to: call.to,
          valueWei: call.value,
          data: call.data,
          asset: input.usdcAsset,
          amountAtomic: amount.toString(),
          recipient: null,
          spender: spender.toLowerCase() as `0x${string}`,
        };
      }
    } catch {
      // Falls through to 'other' below — an undecodable call targeting USDC
      // with the approve selector is never trusted as a real approval.
    }
  }

  if (selector === '0x87517c45') {
    try {
      const decoded = decodeFunctionData({ abi: PERMIT2_APPROVE_ABI, data: call.data });
      const [, spender, amount] = decoded.args as readonly [`0x${string}`, `0x${string}`, bigint, number];
      return {
        index: input.index,
        callType: 'approval',
        to: call.to,
        valueWei: call.value,
        data: call.data,
        asset: input.usdcAsset,
        amountAtomic: amount.toString(),
        recipient: null,
        spender: spender.toLowerCase() as `0x${string}`,
      };
    } catch {
      // Falls through to 'other' below.
    }
  }

  if (toLower === input.routerAddress.toLowerCase()) {
    return {
      index: input.index,
      callType: 'swap',
      to: call.to,
      valueWei: call.value,
      data: call.data,
      asset: null,
      amountAtomic: null,
      recipient: input.walletAddress,
      spender: null,
    };
  }

  return {
    index: input.index,
    callType: 'other',
    to: call.to,
    valueWei: call.value,
    data: call.data,
    asset: null,
    amountAtomic: null,
    recipient: null,
    spender: null,
  };
}

export function blueprintIdV1(input: {
  tenantId: string;
  walletAddress: `0x${string}`;
  routeRunId: string;
  routeCardHash: HashV1;
  selectedCandidateHash: HashV1;
  requestId: string;
}): string {
  const hash = stableHashV1('transaction-composer-request/v1', {
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    routeRunId: input.routeRunId,
    routeCardHash: input.routeCardHash,
    selectedCandidateHash: input.selectedCandidateHash,
    requestId: input.requestId,
  });
  return `blueprint:${hash.slice(2)}`;
}

export interface AssembleBlueprintInput {
  id: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453;
  now: Date;
  intentHash: HashV1;
  selectedCandidateHash: HashV1;
  evidenceSetHash: HashV1;
  quoteExpiry: string;
  calls: ExecutionCallV1[];
  inputAsset: AssetRefV1;
  inputAmountAtomic: string;
  outputAsset: AssetRefV1;
  outputExpectedAtomic: string;
  outputMinimumAtomic: string;
  simulationState: SimulationStateV1;
}

export function assembleExecutionBlueprintV1(input: AssembleBlueprintInput): ExecutionBlueprintV1 {
  const nowIso = input.now.toISOString();
  const expectedAssetChanges: ExpectedAssetChangeV1[] = [
    {
      asset: input.inputAsset,
      direction: 'debit',
      amountAtomic: input.inputAmountAtomic,
      minimumAmountAtomic: input.inputAmountAtomic,
      maximumAmountAtomic: input.inputAmountAtomic,
    },
    {
      asset: input.outputAsset,
      direction: 'credit',
      amountAtomic: input.outputExpectedAtomic,
      minimumAmountAtomic: input.outputMinimumAtomic,
      maximumAmountAtomic: null,
    },
  ];
  const requiredApprovals: RequiredApprovalV1[] = input.calls
    .filter((call) => call.callType === 'approval')
    .map((call) => ({
      asset: call.asset!,
      spender: call.spender!,
      amountAtomic: call.amountAtomic!,
      approvalKind: 'exact',
      state: 'required',
    }));

  const draft: ExecutionBlueprintV1 = {
    schemaVersion: 'execution-blueprint/v1',
    goal: 'swap',
    id: input.id,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: input.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'ready_for_review',
    intentHash: input.intentHash,
    selectedCandidateHash: input.selectedCandidateHash,
    evidenceSetHash: input.evidenceSetHash,
    blueprintHash: ZERO_HASH_V1,
    callsHash: hashApprovedCallsV1(input.calls),
    approvedCallsHash: null,
    quoteExpiry: input.quoteExpiry,
    calls: input.calls,
    expectedAssetChanges,
    requiredApprovals,
    simulationState: input.simulationState,
    atomicRequired: true,
  };
  return ExecutionBlueprintV1Schema.parse({ ...draft, blueprintHash: hashExecutionBlueprintV1(draft) });
}
