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
  nativeFunding?: {
    maximumNativeAssets: string; reserveAssets: string; balanceBeforeAssets: string; balanceAfterAssets: string;
    authorizedBefore: boolean; feeQuoteState: 'wallet_quote_required';
  };
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

const NO_DEBT_HEALTH_SENTINEL = 1n << 128n;
const HEALTH_HUNDREDTH_WAD = 10n ** 16n;

/**
 * Quantizes WAD health ratio to hundredths (0.01) so sub-basis-point index ticks
 * (e.g. 9th-decimal fluctuations across 2-second blocks) do not invalidate signing
 * terms while any material health shift (>= 0.01) requires re-confirmation.
 */
export function materialLendingHealthBucketV1(wad: string | null | undefined, debtAssets: string): string | null {
  if (debtAssets === '0' || wad == null) return null;
  try {
    const parsed = BigInt(wad);
    if (parsed < 0n || parsed >= NO_DEBT_HEALTH_SENTINEL) return null;
    return (parsed / HEALTH_HUNDREDTH_WAD).toString();
  } catch {
    return null;
  }
}

/**
 * Canonical material economic terms bound by `signingTermsHash`.
 * Excludes informational block number and internal share counters when atomic asset
 * amounts are unchanged, and binds health ratio at 0.01 precision.
 */
export function lendingSigningTermsFactsV1(facts: LendingFactsV1): Record<string, unknown> {
  return {
    operation: facts.operation,
    venue: facts.venue,
    collateralTokenAddress: facts.collateralTokenAddress,
    collateralSymbol: facts.collateralSymbol,
    collateralDecimals: facts.collateralDecimals,
    marketId: facts.marketId,
    amountMode: facts.amountMode,
    requestedAssets: facts.requestedAssets,
    maximumDebitAssets: facts.maximumDebitAssets,
    collateralSupplyAssets: facts.collateralSupplyAssets,
    debtBeforeAssets: facts.debtBeforeAssets,
    debtAfterAssets: facts.debtAfterAssets,
    collateralBeforeAssets: facts.collateralBeforeAssets,
    collateralAfterAssets: facts.collateralAfterAssets,
    healthBeforeBucket: materialLendingHealthBucketV1(facts.healthBeforeWad, facts.debtBeforeAssets),
    healthAfterBucket: materialLendingHealthBucketV1(facts.healthAfterWad, facts.debtAfterAssets),
    policyLimitAssets: facts.policyLimitAssets ?? null,
    protocolLimitAssets: facts.protocolLimitAssets ?? null,
    termsVersion: facts.termsVersion ?? null,
    ...(facts.nativeFunding
      ? {
          nativeFunding: {
            maximumNativeAssets: facts.nativeFunding.maximumNativeAssets,
            reserveAssets: facts.nativeFunding.reserveAssets,
            authorizedBefore: facts.nativeFunding.authorizedBefore,
            feeQuoteState: facts.nativeFunding.feeQuoteState,
          },
        }
      : {}),
    warnings: facts.warnings,
  };
}

