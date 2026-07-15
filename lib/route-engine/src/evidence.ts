import {
  EvidenceRecordV1Schema,
  EvidenceSetV1Schema,
  ZERO_HASH_V1,
  canonicalJsonV1,
  findLiquidityOverlapsV1,
  hashEvidenceRecordV1,
  hashEvidenceSetV1,
  stableHashV1,
  type EvidenceRecordV1,
  type EvidenceSetV1,
  type EvidenceTypeV1,
  type RouteCandidateV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import { REQUIRED_EVIDENCE_V1 } from './policy.js';

export class RouteEvidenceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RouteEvidenceError';
  }
}

function isFresh(record: EvidenceRecordV1, nowMs: number): boolean {
  return (
    record.status === 'observed' &&
    record.validationStatus === 'valid' &&
    Date.parse(record.observedAt) <= nowMs &&
    (record.expiresAt === null || Date.parse(record.expiresAt) > nowMs)
  );
}

function validateRecordLinkage(
  record: EvidenceRecordV1,
  candidate: RouteCandidateV1,
  intent: RouteIntentV1,
  nowMs: number,
): void {
  if (
    record.tenantId !== intent.tenantId ||
    record.walletAddress !== intent.walletAddress ||
    record.chainId !== intent.chainId ||
    record.intentHash !== intent.intentHash ||
    record.candidateHash !== candidate.candidateHash
  ) {
    throw new RouteEvidenceError('engine_invalid_evidence_linkage');
  }
  if (Date.parse(record.observedAt) > nowMs) {
    throw new RouteEvidenceError('engine_future_evidence_observation');
  }
}

function deduplicateRecords(records: readonly EvidenceRecordV1[]): EvidenceRecordV1[] {
  const byId = new Map<string, string>();
  const byHash = new Map<string, EvidenceRecordV1>();
  for (const record of records) {
    const content = canonicalJsonV1(record);
    const existingContent = byId.get(record.id);
    if (existingContent !== undefined && existingContent !== content) {
      throw new RouteEvidenceError('engine_conflicting_evidence_id');
    }
    byId.set(record.id, content);
    if (!byHash.has(record.evidenceHash)) byHash.set(record.evidenceHash, record);
  }
  return [...byHash.values()].sort((left, right) =>
    left.evidenceHash.localeCompare(right.evidenceHash),
  );
}

function deriveGasEvidence(
  candidate: RouteCandidateV1,
  parent: EvidenceRecordV1,
  nowMs: number,
): EvidenceRecordV1 | null {
  if (BigInt(candidate.estimatedGas.gasUnits) <= 0n || parent.evidenceType !== 'quote') return null;
  if (parent.validationStatus !== 'valid' || parent.status !== 'observed') return null;

  const stale = parent.expiresAt !== null && Date.parse(parent.expiresAt) <= nowMs;
  const unavailable = candidate.estimatedGas.estimatedCostUsd === null;
  const status = stale ? 'expired' : unavailable ? 'unavailable' : 'observed';
  const validationStatus = stale ? 'stale' : unavailable ? 'unavailable' : 'valid';
  const responseHash = stableHashV1('swap-route-derived-gas-response/v1', {
    gas: candidate.estimatedGas,
    parentQuoteEvidenceHash: parent.evidenceHash,
  });
  const idHash = stableHashV1('swap-route-derived-gas-id/v1', {
    candidateHash: candidate.candidateHash,
    parentQuoteEvidenceHash: parent.evidenceHash,
  });
  const draft: EvidenceRecordV1 = {
    schemaVersion: 'evidence-record/v1',
    id: `evidence:derived-gas:${idHash.slice(2)}`,
    tenantId: candidate.tenantId,
    walletAddress: candidate.walletAddress,
    chainId: candidate.chainId,
    createdAt: parent.observedAt,
    updatedAt: parent.observedAt,
    status,
    intentHash: candidate.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceHash: ZERO_HASH_V1,
    evidenceType: 'gas',
    provider: parent.provider,
    observedAt: parent.observedAt,
    expiresAt: parent.expiresAt,
    blockNumber: parent.blockNumber,
    requestHash: parent.requestHash,
    responseHash,
    assets: parent.assets,
    pools: parent.pools,
    liquiditySources: parent.liquiditySources,
    freeOrPaid: 'free',
    cost: null,
    intelligenceChargeId: null,
    validationStatus,
    validationErrors: unavailable ? ['estimated_gas_usd_unavailable'] : [],
  };
  return EvidenceRecordV1Schema.parse({
    ...draft,
    evidenceHash: hashEvidenceRecordV1(draft),
  });
}

function sourceIndependence(
  candidate: RouteCandidateV1,
  records: readonly EvidenceRecordV1[],
): EvidenceSetV1['sourceIndependence'] {
  if (candidate.trustMetadata.sourceIndependence !== 'independent') {
    return candidate.trustMetadata.sourceIndependence;
  }
  const sources = [...candidate.liquiditySources, ...records.flatMap((record) => record.liquiditySources)];
  if (
    sources.length === 0 ||
    sources.some((source) => source.poolAddress === null && source.upstreamProvider === null)
  ) {
    return 'unknown';
  }
  return 'independent';
}

export interface BuiltEvidenceSetV1 {
  evidenceSet: EvidenceSetV1;
  freshByType: ReadonlyMap<EvidenceTypeV1, EvidenceRecordV1[]>;
}

export function buildEvidenceSetV1(input: {
  intent: RouteIntentV1;
  candidate: RouteCandidateV1;
  providerEvidence: readonly EvidenceRecordV1[];
  now: Date;
}): BuiltEvidenceSetV1 {
  const nowMs = input.now.getTime();
  const parsed = input.providerEvidence.map((record) => EvidenceRecordV1Schema.parse(record));
  parsed.forEach((record) => validateRecordLinkage(record, input.candidate, input.intent, nowMs));
  let records = deduplicateRecords(parsed);
  const quote = records.find((record) => record.evidenceType === 'quote');
  if (!quote) throw new RouteEvidenceError('engine_missing_quote_evidence');
  if (
    quote.observedAt !== input.candidate.quoteObservedAt ||
    quote.expiresAt !== input.candidate.quoteExpiresAt
  ) {
    throw new RouteEvidenceError('engine_invalid_quote_timestamp_binding');
  }

  const gas = deriveGasEvidence(input.candidate, quote, nowMs);
  if (gas) records = deduplicateRecords([...records, gas]);

  const requiredEvidence: EvidenceTypeV1[] = [
    ...REQUIRED_EVIDENCE_V1[input.intent.verificationDepth],
  ];
  const freshByType = new Map<EvidenceTypeV1, EvidenceRecordV1[]>();
  for (const record of records) {
    if (!isFresh(record, nowMs)) continue;
    const current = freshByType.get(record.evidenceType) ?? [];
    current.push(record);
    freshByType.set(record.evidenceType, current);
  }
  const missingEvidence = requiredEvidence.filter((type) => !freshByType.has(type));
  const staleRequired = records.some(
    (record) =>
      requiredEvidence.includes(record.evidenceType) &&
      record.expiresAt !== null &&
      Date.parse(record.expiresAt) <= nowMs,
  );
  const status: EvidenceSetV1['status'] = staleRequired
    ? 'stale'
    : missingEvidence.length > 0
      ? 'partial'
      : 'complete';
  const draft: EvidenceSetV1 = {
    schemaVersion: 'evidence-set/v1',
    id: `evidence-set:${stableHashV1('swap-route-evidence-set-id/v1', {
      candidateHash: input.candidate.candidateHash,
      evidenceHashes: records.map((record) => record.evidenceHash),
      verificationDepth: input.intent.verificationDepth,
    }).slice(2)}`,
    tenantId: input.intent.tenantId,
    walletAddress: input.intent.walletAddress,
    chainId: input.intent.chainId,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    status,
    intentHash: input.intent.intentHash,
    candidateHash: input.candidate.candidateHash,
    evidenceSetHash: ZERO_HASH_V1,
    records,
    requiredEvidence,
    missingEvidence,
    sourceIndependence: sourceIndependence(input.candidate, records),
    overlapGroups: findLiquidityOverlapsV1(records),
  };
  return {
    evidenceSet: EvidenceSetV1Schema.parse({
      ...draft,
      evidenceSetHash: hashEvidenceSetV1(draft),
    }),
    freshByType,
  };
}
