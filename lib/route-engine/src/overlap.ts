import type { EvidenceSetV1, RouteCandidateV1 } from '@mioagent/route-domain';
import type { CrossCandidateOverlapV1 } from './contracts.js';

function sourceKeys(candidate: RouteCandidateV1, set: EvidenceSetV1): Set<string> {
  const keys = new Set<string>();
  const sources = [
    ...candidate.liquiditySources,
    ...set.records.flatMap((record) => record.liquiditySources),
  ];
  for (const source of sources) {
    if (source.poolAddress !== null) {
      keys.add(`eip155:${source.chainId}/pool:${source.poolAddress}`);
      keys.add(source.sourceKey);
    } else if (source.upstreamProvider !== null) {
      keys.add(`eip155:${source.chainId}/upstream:${source.upstreamProvider}`);
    }
  }
  for (const record of set.records) {
    for (const pool of record.pools) keys.add(`eip155:${pool.chainId}/pool:${pool.address}`);
  }
  return keys;
}

export function findCrossCandidateOverlapsV1(
  candidates: readonly RouteCandidateV1[],
  evidenceSets: readonly EvidenceSetV1[],
): CrossCandidateOverlapV1[] {
  const setByCandidate = new Map(evidenceSets.map((set) => [set.candidateHash, set]));
  const grouped = new Map<
    string,
    { candidateHashes: Set<string>; providerIds: Set<string> }
  >();
  for (const candidate of candidates) {
    const set = setByCandidate.get(candidate.candidateHash);
    if (!set) continue;
    for (const key of sourceKeys(candidate, set)) {
      const current = grouped.get(key) ?? {
        candidateHashes: new Set<string>(),
        providerIds: new Set<string>(),
      };
      current.candidateHashes.add(candidate.candidateHash);
      current.providerIds.add(candidate.provider.id);
      grouped.set(key, current);
    }
  }
  return [...grouped.entries()]
    .filter(([, value]) => value.candidateHashes.size > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceKey, value]) => ({
      sourceKey,
      candidateHashes: [...value.candidateHashes].sort() as `0x${string}`[],
      providerIds: [...value.providerIds].sort(),
    }));
}

export function hasIncompleteProvenanceV1(
  candidates: readonly RouteCandidateV1[],
  evidenceSets: readonly EvidenceSetV1[],
): boolean {
  return (
    candidates.some(
      (candidate) =>
        candidate.trustMetadata.sourceIndependence === 'unknown' ||
        candidate.liquiditySources.length === 0 ||
        candidate.liquiditySources.some(
          (source) => source.poolAddress === null && source.upstreamProvider === null,
        ),
    ) || evidenceSets.some((set) => set.sourceIndependence === 'unknown')
  );
}
