import {
  canonicalJsonV1,
  EvidenceRecordV1Schema,
  EvidenceSetV1Schema,
  ExecutionBlueprintV1Schema,
  IntelligenceChargeV1Schema,
  PathScoreV1Schema,
  RouteCandidateV1Schema,
  RouteCardV1Schema,
  RouteIntentV1Schema,
  RouteProofEventV1Schema,
  RouteProofV1Schema,
  type EvidenceRecordV1,
  type EvidenceSetV1,
  type ExecutionBlueprintV1,
  type IntelligenceChargeV1,
  type PathScoreV1,
  type RouteCandidateV1,
  type RouteCardV1,
  type RouteIntentV1,
  type RouteProofEventV1,
  type RouteProofV1,
} from '@mioagent/route-domain';
import { RouteStorageIntegrityError, RouteStorageTenantError } from './types.js';

export const routeStorageSchemas = {
  routeRun: RouteIntentV1Schema,
  candidate: RouteCandidateV1Schema,
  evidence: EvidenceRecordV1Schema,
  evidenceSet: EvidenceSetV1Schema,
  score: PathScoreV1Schema,
  routeCard: RouteCardV1Schema,
  blueprint: ExecutionBlueprintV1Schema,
  proof: RouteProofV1Schema,
  proofEvent: RouteProofEventV1Schema,
  intelligenceCharge: IntelligenceChargeV1Schema,
} as const;

export function parseRouteIntent(value: unknown): RouteIntentV1 {
  return RouteIntentV1Schema.parse(structuredClone(value));
}

export function parseRouteCandidate(value: unknown): RouteCandidateV1 {
  return RouteCandidateV1Schema.parse(structuredClone(value));
}

export function parseEvidenceRecord(value: unknown): EvidenceRecordV1 {
  return EvidenceRecordV1Schema.parse(structuredClone(value));
}

export function parseEvidenceSet(value: unknown): EvidenceSetV1 {
  return EvidenceSetV1Schema.parse(structuredClone(value));
}

export function parsePathScore(value: unknown): PathScoreV1 {
  return PathScoreV1Schema.parse(structuredClone(value));
}

export function parseRouteCard(value: unknown): RouteCardV1 {
  return RouteCardV1Schema.parse(structuredClone(value));
}

export function parseExecutionBlueprint(value: unknown): ExecutionBlueprintV1 {
  return ExecutionBlueprintV1Schema.parse(structuredClone(value));
}

export function parseRouteProof(value: unknown): RouteProofV1 {
  return RouteProofV1Schema.parse(structuredClone(value));
}

export function parseRouteProofEvent(value: unknown): RouteProofEventV1 {
  return RouteProofEventV1Schema.parse(structuredClone(value));
}

export function parseIntelligenceCharge(value: unknown): IntelligenceChargeV1 {
  return IntelligenceChargeV1Schema.parse(structuredClone(value));
}

export function payloadEquals(left: unknown, right: unknown): boolean {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

export function assertTenant(payloadTenantId: string, expectedUserId: string): void {
  if (payloadTenantId !== expectedUserId) {
    throw new RouteStorageTenantError('Domain payload tenant does not match the route owner');
  }
}

export function assertLinkedHash(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new RouteStorageIntegrityError(`${label} does not match its persisted parent`);
  }
}

export function payloadFromDatabase(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new RouteStorageIntegrityError('Stored JSONB payload is not valid JSON');
  }
}

export function databaseTimestamp(value: unknown, label: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string') {
    const timestamp = new Date(value);
    if (Number.isFinite(timestamp.getTime())) return timestamp.toISOString();
  }
  throw new RouteStorageIntegrityError(`Stored ${label} is not a valid timestamp`);
}

export function databaseNullableTimestamp(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return databaseTimestamp(value, label);
}

export function databaseString(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  throw new RouteStorageIntegrityError(`Stored ${label} is not a string`);
}

export function databaseNullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return databaseString(value, label);
}

export function databaseNumber(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return Number(value);
  throw new RouteStorageIntegrityError(`Stored ${label} is not a number`);
}
