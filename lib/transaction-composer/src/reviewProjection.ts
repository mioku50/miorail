import {
  ContractSecuritySummaryV1Schema,
  TransactionReviewProjectionV1Schema,
  hashTransactionReviewProjectionV1,
  type ContractSecuritySummaryV1,
  type TransactionReviewProjectionV1,
} from '@mioagent/route-card';
import type { ExecutionBlueprintV1, ProviderRefV1, SafetyKernelResultV1, TokenAmountV1 } from '@mioagent/route-domain';

export interface BuildTransactionReviewProjectionInput {
  routeRunId: string;
  provider: ProviderRefV1;
  input: TokenAmountV1;
  expectedOutput: TokenAmountV1;
  minimumOutput: TokenAmountV1;
  cardExpectedOutput: TokenAmountV1;
  cardMinimumOutput: TokenAmountV1;
  blueprint: ExecutionBlueprintV1;
  safety: SafetyKernelResultV1;
  contractSecurity: ContractSecuritySummaryV1;
  simulationWarning: string | null;
}

export function buildTransactionReviewProjectionV1(
  input: BuildTransactionReviewProjectionInput,
): TransactionReviewProjectionV1 {
  const attachedNativeValueWei = input.blueprint.calls
    .reduce((sum, call) => sum + BigInt(call.valueWei), 0n)
    .toString();

  const draft: TransactionReviewProjectionV1 = {
    schemaVersion: 'transaction-review-projection/v1',
    projectionHash: '0x'.padEnd(66, '0') as `0x${string}`,
    readOnly: true,
    routeRunId: input.routeRunId,
    intentHash: input.blueprint.intentHash,
    selectedCandidateHash: input.blueprint.selectedCandidateHash,
    blueprintHash: input.blueprint.blueprintHash,
    callsHash: input.blueprint.callsHash,
    blueprintStatus: input.blueprint.status,
    provider: input.provider,
    input: input.input,
    expectedOutput: input.expectedOutput,
    minimumOutput: input.minimumOutput,
    cardExpectedOutput: input.cardExpectedOutput,
    cardMinimumOutput: input.cardMinimumOutput,
    quoteExpiry: input.blueprint.quoteExpiry,
    calls: input.blueprint.calls,
    requiredApprovals: input.blueprint.requiredApprovals,
    attachedNativeValueWei,
    safety: input.safety,
    contractSecurity: ContractSecuritySummaryV1Schema.parse(input.contractSecurity),
    simulationState: input.blueprint.simulationState,
    simulationWarning: input.simulationWarning,
  };
  return TransactionReviewProjectionV1Schema.parse({
    ...draft,
    projectionHash: hashTransactionReviewProjectionV1(draft),
  });
}
