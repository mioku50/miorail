import { stableHashV1, type CommerceEvidenceV1, type HashV1 } from '@mioagent/route-domain';

export type CommerceFreshnessStateV1 = 'fresh' | 'stale' | 'unknown';

/** Fresh while now ≤ expiresAt. A stale price is still SHOWN — hiding it would
 * be worse — but it is excluded from every scored dimension. */
export function commerceFreshnessStateV1(evidence: CommerceEvidenceV1, now: Date): CommerceFreshnessStateV1 {
  const expires = Date.parse(evidence.expiresAt);
  if (Number.isNaN(expires)) return 'unknown';
  return now.getTime() <= expires ? 'fresh' : 'stale';
}

export function commerceEvidenceAgeSecondsV1(evidence: CommerceEvidenceV1, now: Date): number {
  const observed = Date.parse(evidence.observedAt);
  if (Number.isNaN(observed)) return 0;
  return Math.max(0, Math.floor((now.getTime() - observed) / 1000));
}

/** Hashed as a set so the shape already matches a multi-storefront future. */
export function commerceEvidenceSetHashV1(evidence: CommerceEvidenceV1): HashV1 {
  return stableHashV1('commerce-evidence-set/v1', { evidenceHashes: [evidence.evidenceHash] });
}
