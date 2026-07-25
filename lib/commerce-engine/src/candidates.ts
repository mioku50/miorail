import {
  CommerceCandidateV1Schema,
  CommerceEvidenceV1Schema,
  COMMERCE_DELIVERY_MODEL_BY_KIND_V1,
  hashCommerceCandidateV1,
  hashCommerceEvidenceV1,
  stableHashV1,
  ZERO_HASH_V1,
  type CommerceCandidateV1,
  type CommerceEvidenceV1,
  type CommerceRouteIntentV1,
} from '@mioagent/route-domain';
import {
  BITREFILL_PAY_TO_V1,
  BITREFILL_PROVIDER_V1,
  COMMERCE_USDC_ADDRESS_V1,
  COMMERCE_USDC_ASSET_V1,
} from './pinned-config.js';
import { atomicToDecimalV1, decimalToAtomicV1, packageValueAsDecimalV1 } from './normalization.js';
import { validateCommerceRecipientV1, validateCommerceSpendV1 } from './validation.js';
import type {
  CommerceCatalogObservationV1,
  CommerceFailureReasonV1,
  CommercePackageObservationV1,
} from './types.js';

// ---------------------------------------------------------------------------
// Catalogue observation → validated candidates + immutable evidence.
//
// One candidate per usable denomination. An out-of-stock denomination still
// becomes a candidate — the console shows every route it found and says why it
// cannot be used, rather than hiding it — but the contract already forbids
// selecting or recommending one.
// ---------------------------------------------------------------------------

/** How many denominations a comparison may carry. Enough to show the exact
 * match plus its neighbours, few enough to stay a comparison. */
export const COMMERCE_MAX_CANDIDATES_V1 = 4;

export interface CommerceCandidateBuildV1 {
  candidate: CommerceCandidateV1;
  evidence: CommerceEvidenceV1;
}

export type CommerceCandidateResultV1 =
  | { ok: true; builds: CommerceCandidateBuildV1[]; skipped: CommerceFailureReasonV1[] }
  | { ok: false; reason: CommerceFailureReasonV1 };

function absoluteDeltaAtomicV1(left: string, right: string): bigint {
  const a = BigInt(left);
  const b = BigInt(right);
  return a > b ? a - b : b - a;
}

/**
 * Deterministic denomination ordering: closest to the requested value first,
 * then the cheaper one, then the provider's package value as a stable
 * tie-break. Pure string/BigInt comparison — no float distance.
 */
export function orderPackagesByFitV1(
  packages: readonly CommercePackageObservationV1[],
  requestedAtomic: string,
): CommercePackageObservationV1[] {
  return [...packages].sort((left, right) => {
    const leftDelta = absoluteDeltaAtomicV1(left.fees.totalAtomic, requestedAtomic);
    const rightDelta = absoluteDeltaAtomicV1(right.fees.totalAtomic, requestedAtomic);
    if (leftDelta !== rightDelta) return leftDelta < rightDelta ? -1 : 1;
    const leftTotal = BigInt(left.fees.totalAtomic);
    const rightTotal = BigInt(right.fees.totalAtomic);
    if (leftTotal !== rightTotal) return leftTotal < rightTotal ? -1 : 1;
    return left.product.packageValue < right.product.packageValue ? -1 : 1;
  });
}

export interface BuildCommerceCandidatesInputV1 {
  intent: CommerceRouteIntentV1;
  observation: CommerceCatalogObservationV1;
  requestedAtomic: string;
  now: Date;
}

export function buildCommerceCandidatesV1(
  input: BuildCommerceCandidatesInputV1,
): CommerceCandidateResultV1 {
  const { intent, observation, now } = input;
  const ordered = orderPackagesByFitV1(observation.packages, input.requestedAtomic);
  const builds: CommerceCandidateBuildV1[] = [];
  const skipped: CommerceFailureReasonV1[] = [];
  const nowIso = now.toISOString();

  for (const entry of ordered) {
    if (builds.length >= COMMERCE_MAX_CANDIDATES_V1) break;

    const recipient = validateCommerceRecipientV1({
      recipientRequired: entry.product.recipientRequired,
      recipientInput: intent.recipientInput,
    });
    if (!recipient.ok) {
      skipped.push(recipient.reason);
      continue;
    }
    const spend = validateCommerceSpendV1({
      totalAtomic: entry.fees.totalAtomic,
      maxSpendAtomic: intent.maxSpendAtomic,
    });
    if (!spend.ok) {
      skipped.push(spend.reason);
      continue;
    }

    const candidateBase = {
      schemaVersion: 'commerce-candidate/v1' as const,
      id: `commerce-candidate:${stableHashV1('commerce-candidate-id', {
        intentHash: intent.intentHash,
        productId: entry.product.productId,
        packageValue: entry.product.packageValue,
      }).slice(2, 26)}`,
      tenantId: intent.tenantId,
      walletAddress: intent.walletAddress,
      chainId: intent.chainId,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: 'quoted' as const,
      intentHash: intent.intentHash,
      candidateHash: ZERO_HASH_V1,
      product: entry.product,
      fiatPrice: { amountDecimal: entry.fiatAmountDecimal, currency: entry.product.currency },
      payment: {
        asset: COMMERCE_USDC_ASSET_V1,
        amountAtomic: entry.fees.totalAtomic,
        amountDecimal: atomicToDecimalV1(entry.fees.totalAtomic),
      },
      fees: entry.fees,
      availability: entry.availability,
      deliveryModel: COMMERCE_DELIVERY_MODEL_BY_KIND_V1[entry.product.kind],
      recipientRequired: entry.product.recipientRequired,
      paymentTarget: { asset: COMMERCE_USDC_ADDRESS_V1, payTo: BITREFILL_PAY_TO_V1 },
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
      provider: BITREFILL_PROVIDER_V1,
    };

    const parsedCandidate = CommerceCandidateV1Schema.safeParse({
      ...candidateBase,
      candidateHash: hashCommerceCandidateV1(candidateBase as unknown as CommerceCandidateV1),
    });
    if (!parsedCandidate.success) {
      skipped.push('provider_invalid_response');
      continue;
    }
    const candidate = parsedCandidate.data;

    const evidenceBase = {
      schemaVersion: 'commerce-evidence/v1' as const,
      id: `commerce-evidence:${candidate.candidateHash.slice(2, 26)}`,
      tenantId: intent.tenantId,
      walletAddress: intent.walletAddress,
      chainId: intent.chainId,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: (Date.parse(observation.expiresAt) >= now.getTime() ? 'fresh' : 'stale') as 'fresh' | 'stale',
      intentHash: intent.intentHash,
      candidateHash: candidate.candidateHash,
      evidenceHash: ZERO_HASH_V1,
      provider: BITREFILL_PROVIDER_V1,
      endpoint: observation.endpoint,
      product: entry.product,
      fiatPrice: candidate.fiatPrice,
      fees: entry.fees,
      availability: entry.availability,
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
      requestHash: observation.requestHash,
      responseHash: observation.responseHash,
      // One storefront answered. Several denominations from one catalogue read
      // are the same source seen several times, never independent proofs.
      sourceIndependence: 'overlapping' as const,
    };
    const parsedEvidence = CommerceEvidenceV1Schema.safeParse({
      ...evidenceBase,
      evidenceHash: hashCommerceEvidenceV1(evidenceBase as unknown as CommerceEvidenceV1),
    });
    if (!parsedEvidence.success) {
      skipped.push('provider_invalid_response');
      continue;
    }

    builds.push({ candidate, evidence: parsedEvidence.data });
  }

  if (builds.length === 0) {
    return { ok: false, reason: skipped[0] ?? 'denomination_unavailable' };
  }
  return { ok: true, builds, skipped };
}

/** Requested vs offered denomination, for the Route Card comparison row.
 * Compared as base units, not floats — "25" and "25.00" are the same
 * denomination and 24.99 is not. */
export function denominationDeltaV1(input: {
  requestedDecimal: string;
  candidate: CommerceCandidateV1;
}): { requestedDecimal: string; offeredDecimal: string; exact: boolean } {
  const offered =
    packageValueAsDecimalV1(input.candidate.product.packageValue) ?? input.candidate.fiatPrice.amountDecimal;
  const requestedAtomic = decimalToAtomicV1(input.requestedDecimal);
  const offeredAtomic = decimalToAtomicV1(offered);
  return {
    requestedDecimal: input.requestedDecimal,
    offeredDecimal: offered,
    exact: requestedAtomic !== null && offeredAtomic !== null && BigInt(requestedAtomic) === BigInt(offeredAtomic),
  };
}
