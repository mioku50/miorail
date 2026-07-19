import {
  EvidenceRecordV1Schema,
  EvidenceSetV1Schema,
  ZERO_HASH_V1,
  findLiquidityOverlapsV1,
  hashEvidenceRecordV1,
  hashEvidenceSetV1,
  stableHashV1,
  type EvidenceRecordV1,
  type EvidenceSetV1,
  type HashV1,
  type MoneyV1,
  type ProviderRefV1,
} from '@mioagent/route-domain';

export interface BuildSimulationEvidenceInputV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  intentHash: HashV1;
  candidateHash: HashV1;
  provider: ProviderRefV1;
  observedAt: string;
  expiresAt: string;
  /** null only for outcomes that never reached a schema-valid provider
   * response (invalid_response / provider unreachable). */
  blockNumber: string | null;
  requestHash: HashV1;
  responseHash: HashV1;
  cost: MoneyV1;
  intelligenceChargeId: string;
  validationStatus: 'valid' | 'invalid' | 'unavailable';
  validationErrors?: string[];
}

/** New immutable EvidenceRecordV1 (evidenceType 'simulation', freeOrPaid
 * 'paid') for the just-completed paid simulation. */
export function buildSimulationEvidenceRecordV1(input: BuildSimulationEvidenceInputV1): EvidenceRecordV1 {
  const id = `evidence:${stableHashV1('paid-intelligence-evidence-id/v1', {
    requestHash: input.requestHash,
    responseHash: input.responseHash,
    intelligenceChargeId: input.intelligenceChargeId,
  }).slice(2)}`;
  const draft: Omit<EvidenceRecordV1, 'evidenceHash'> = {
    schemaVersion: 'evidence-record/v1',
    id,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: 8453,
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
    status: 'observed',
    intentHash: input.intentHash,
    candidateHash: input.candidateHash,
    evidenceType: 'simulation',
    provider: input.provider,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
    blockNumber: input.blockNumber,
    requestHash: input.requestHash,
    responseHash: input.responseHash,
    assets: [],
    pools: [],
    liquiditySources: [],
    freeOrPaid: 'paid',
    cost: input.cost,
    intelligenceChargeId: input.intelligenceChargeId,
    validationStatus: input.validationStatus,
    validationErrors: input.validationErrors ?? [],
  };
  const withPlaceholder = { ...draft, evidenceHash: ZERO_HASH_V1 } as EvidenceRecordV1;
  return EvidenceRecordV1Schema.parse({
    ...withPlaceholder,
    evidenceHash: hashEvidenceRecordV1(withPlaceholder),
  });
}

function dedupeSortedByHash(records: readonly EvidenceRecordV1[]): EvidenceRecordV1[] {
  const seen = new Set<string>();
  const unique: EvidenceRecordV1[] = [];
  for (const record of records) {
    if (seen.has(record.evidenceHash)) continue;
    seen.add(record.evidenceHash);
    unique.push(record);
  }
  return unique.sort((left, right) => left.evidenceHash.localeCompare(right.evidenceHash));
}

export interface BuildUpdatedEvidenceSetInputV1 {
  previous: EvidenceSetV1;
  newRecord: EvidenceRecordV1;
  now: string;
}

/**
 * T59 decision 7 — a BRAND NEW EvidenceSetV1 (new id, new hash); the previous
 * set is never mutated. Records are the previous set's records plus the new
 * simulation record (sorted + deduped by evidenceHash, matching the schema's
 * own invariant). requiredEvidence is carried over unchanged; 'simulation' is
 * removed from missingEvidence; status becomes 'complete' when nothing else
 * is missing, otherwise stays 'partial'.
 */
export function buildUpdatedEvidenceSetV1(input: BuildUpdatedEvidenceSetInputV1): EvidenceSetV1 {
  const { previous, newRecord, now } = input;
  const records = dedupeSortedByHash([...previous.records, newRecord]);
  const missingEvidence = previous.missingEvidence.filter((type) => type !== 'simulation');
  const status = missingEvidence.length === 0 ? 'complete' : 'partial';
  const overlapGroups = findLiquidityOverlapsV1(records);
  const id = `evidence-set:${stableHashV1('paid-intelligence-evidence-set-id/v1', {
    candidateHash: previous.candidateHash,
    evidenceHashes: records.map((record) => record.evidenceHash),
  }).slice(2)}`;
  const draft: Omit<EvidenceSetV1, 'evidenceSetHash'> = {
    schemaVersion: 'evidence-set/v1',
    id,
    tenantId: previous.tenantId,
    walletAddress: previous.walletAddress,
    chainId: previous.chainId,
    createdAt: previous.createdAt,
    updatedAt: now,
    status,
    intentHash: previous.intentHash,
    candidateHash: previous.candidateHash,
    records,
    requiredEvidence: previous.requiredEvidence,
    missingEvidence,
    sourceIndependence: previous.sourceIndependence,
    overlapGroups,
  };
  const withPlaceholder = { ...draft, evidenceSetHash: ZERO_HASH_V1 } as EvidenceSetV1;
  return EvidenceSetV1Schema.parse({
    ...withPlaceholder,
    evidenceSetHash: hashEvidenceSetV1(withPlaceholder),
  });
}
