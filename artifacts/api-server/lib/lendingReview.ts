import type { ExecutionCallV1 } from '@mioagent/route-domain';
import type { LendingPaymentV1 } from './lendingDraft.js';

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
  /** Still Spend: the borrowed USDC pays this Bitrefill invoice in the same batch. */
  payment?: LendingPaymentV1;
  warnings: string[];
}

/** One batch, or, for a wallet that cannot send one (Rabby; Coinbase Wallet
 * with an imported key), the same calls one transaction at a time. The server
 * grants steps only for an Aave V4 loan or repayment; each later step is
 * reviewed again before it is signed (lendingSteps). */
export type LendingDeliveryV1 = { atomicRequired: true; delivery?: undefined } | { atomicRequired: false; delivery: 'sequential' };

export type LendingRunV1 =
  | { state: 'refused'; refusal: string; detail: string; facts?: LendingFactsV1 }
  | ({ state: 'ready'; facts: LendingFactsV1; calls: readonly ExecutionCallV1[];
      callsHash: string; signingTermsHash: string; expiresAt: string;
      steps: readonly { index: number; to: string; reading: string }[];
      measured: { provider: string; blockNumber: number; loanDeltaAssets: string } } & LendingDeliveryV1);

export function lendingWireV1(run: LendingRunV1): Record<string, unknown> {
  if (run.state === 'refused') return run;
  return { ...run, calls: run.calls.map(call => ({ to: call.to, data: call.data, value: call.valueWei })) };
}

const NO_DEBT_HEALTH_SENTINEL = 1n << 128n;
const HEALTH_HUNDREDTH_WAD = 10n ** 16n;
const HEALTH_FAR_WAD = 100n * 10n ** 18n;

/**
 * Quantizes WAD health ratio to hundredths (0.01) so sub-basis-point index ticks
 * (e.g. 9th-decimal fluctuations across 2-second blocks) do not invalidate signing
 * terms while any material health shift (>= 0.01) requires re-confirmation.
 * From 100 up every ratio is one bucket: a debt of a few atomic units read
 * 2,152,681.13 then 2,152,681.09 (2026-11-01) and asked the person to confirm
 * again, though the collateral could fall 99% either way.
 */
export function materialLendingHealthBucketV1(wad: string | null | undefined, debtAssets: string): string | null {
  if (debtAssets === '0' || wad == null) return null;
  try {
    const parsed = BigInt(wad);
    if (parsed < 0n || parsed >= NO_DEBT_HEALTH_SENTINEL) return null;
    if (parsed >= HEALTH_FAR_WAD) return 'far';
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
    ...(facts.payment ? { payment: facts.payment } : {}),
    warnings: facts.warnings,
  };
}

