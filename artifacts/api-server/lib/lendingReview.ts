import type { ExecutionCallV1 } from '@mioagent/route-domain';

/** Shared wire for risk-increasing borrowing and risk-reducing repayment.
 * Only a ready result owns calls. A batch handle is never a completion. */
export interface LendingFactsV1 {
  operation: 'borrow' | 'repay';
  venue: 'morpho' | 'aave-v4';
  collateralTokenAddress: string;
  collateralSymbol: string;
  collateralDecimals: number;
  marketId: string;
  amountMode: 'assets' | 'all';
  requestedAssets: string | null;
  maximumDebitAssets: string;
  collateralSupplyAssets: string;
  debtBeforeAssets: string;
  debtAfterAssets: string;
  collateralBeforeAssets: string;
  collateralAfterAssets: string;
  collateralBeforeShares?: string | null;
  collateralAfterShares?: string | null;
  healthBeforeWad?: string | null;
  healthAfterWad?: string | null;
  policyLimitAssets?: string;
  protocolLimitAssets?: string;
  termsVersion?: string;
  debtBeforeShares: string | null;
  debtAfterShares: string | null;
  blockNumber: number;
  warnings: string[];
}

export type LendingRunV1 =
  | { state: 'refused'; refusal: string; detail: string; facts?: LendingFactsV1 }
  | { state: 'ready'; facts: LendingFactsV1; calls: readonly ExecutionCallV1[];
      callsHash: string; signingTermsHash: string; expiresAt: string; atomicRequired: true;
      steps: readonly { index: number; to: string; reading: string }[];
      measured: { provider: string; blockNumber: number; loanDeltaAssets: string } };

export function lendingWireV1(run: LendingRunV1): Record<string, unknown> {
  if (run.state === 'refused') return run;
  return { ...run, calls: run.calls.map(call => ({ to: call.to, data: call.data, value: call.valueWei })) };
}
