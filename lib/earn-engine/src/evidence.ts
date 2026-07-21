import { stableHashV1, type EarnEvidenceV1, type HashV1 } from '@mioagent/route-domain';

export type EarnFreshnessStateV1 = 'fresh' | 'stale' | 'unknown';

/** Fresh while now ≤ expiresAt; stale once past it. Stale APY is excluded from
 * ranking (spec §4) and turns the net_yield dimension Not scored. */
export function earnFreshnessStateV1(evidence: EarnEvidenceV1, now: Date): EarnFreshnessStateV1 {
  const expires = Date.parse(evidence.expiresAt);
  if (Number.isNaN(expires)) return 'unknown';
  return now.getTime() <= expires ? 'fresh' : 'stale';
}

export function earnEvidenceAgeSecondsV1(evidence: EarnEvidenceV1, now: Date): number {
  const observed = Date.parse(evidence.observedAt);
  if (Number.isNaN(observed)) return 0;
  return Math.max(0, Math.floor((now.getTime() - observed) / 1000));
}

/** One evidence record per candidate today, but hashed as a set so the shape
 * matches the multi-source future and the score's evidenceSetHash is stable. */
export function earnEvidenceSetHashV1(evidence: EarnEvidenceV1): HashV1 {
  return stableHashV1('earn-evidence-set/v1', { evidenceHashes: [evidence.evidenceHash] });
}
