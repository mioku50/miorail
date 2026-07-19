import type {
  EvidenceRecordV1,
  EvidenceSetV1,
  ExecutionBlueprintV1,
  IntelligenceChargeV1,
  PathScoreV1,
  RouteCandidateV1,
  RouteCardV1,
  RouteIntentV1,
  RouteProofEventV1,
  RouteProofV1,
} from '@mioagent/route-domain';
import type { RouteRunHistoryParamsV1, RouteRunHistoryPageV1 } from './history.js';

export interface RouteRunRecord {
  id: string;
  userId: string;
  walletAddress: string;
  chainId: number;
  schemaVersion: RouteIntentV1['schemaVersion'];
  status: string;
  intentHash: string;
  idempotencyKey: string;
  intent: RouteIntentV1;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface BlueprintStorageLinks {
  preparedTransactionActionId?: string | null;
}

export interface IntelligenceChargeStorageLinks {
  evidenceId?: string | null;
  x402ReceiptId?: string | null;
}

export interface StoredBlueprintV1 {
  blueprint: ExecutionBlueprintV1;
  preparedTransactionActionId: string | null;
}

export interface StoredIntelligenceChargeV1 {
  charge: IntelligenceChargeV1;
  evidenceId: string | null;
  spendPermissionId: string | null;
  x402ReceiptId: string | null;
}

export interface RouteStorageRepository {
  createRouteRun(input: RouteIntentV1, idempotencyKey: string): Promise<RouteRunRecord>;
  getRouteRun(id: string, userId: string): Promise<RouteRunRecord | null>;

  insertCandidate(runId: string, candidate: RouteCandidateV1): Promise<void>;
  listCandidates(runId: string, userId: string): Promise<RouteCandidateV1[]>;

  insertEvidence(
    runId: string,
    candidateId: string | null,
    evidence: EvidenceRecordV1,
  ): Promise<void>;
  listEvidence(runId: string, userId: string): Promise<EvidenceRecordV1[]>;

  insertEvidenceSet(runId: string, candidateId: string, evidenceSet: EvidenceSetV1): Promise<void>;
  listEvidenceSets(runId: string, userId: string): Promise<EvidenceSetV1[]>;

  insertScoreSnapshot(runId: string, candidateId: string, score: PathScoreV1): Promise<void>;
  listScoreSnapshots(runId: string, userId: string): Promise<PathScoreV1[]>;

  insertRouteCard(runId: string, card: RouteCardV1): Promise<void>;
  listRouteCards(runId: string, userId: string): Promise<RouteCardV1[]>;

  insertBlueprint(
    runId: string,
    blueprint: ExecutionBlueprintV1,
    links?: BlueprintStorageLinks,
  ): Promise<void>;
  listBlueprints(runId: string, userId: string): Promise<StoredBlueprintV1[]>;

  /**
   * T57: the only mutation path for an already-inserted Blueprint. Transitions
   * `ready_for_review` -> `approved` (status, approved_calls_hash, payload,
   * updated_at only — blueprintHash and every other financial field are
   * immutable). Idempotent when the current status is already `approved` with
   * a matching approvedCallsHash (returns the stored Blueprint unchanged);
   * conflicts if `approved` with a different hash; fails closed with
   * RouteStorageIntegrityError if the Blueprint is missing or not in
   * `ready_for_review`.
   */
  approveBlueprint(
    runId: string,
    blueprintId: string,
    userId: string,
    approvedBlueprint: ExecutionBlueprintV1,
  ): Promise<ExecutionBlueprintV1>;

  upsertProofProjection(runId: string, proof: RouteProofV1): Promise<void>;
  getProofProjection(id: string, userId: string): Promise<RouteProofV1 | null>;

  appendProofEvent(proofId: string, event: RouteProofEventV1): Promise<void>;
  listProofEvents(proofId: string, userId: string): Promise<RouteProofEventV1[]>;

  /**
   * T58: cursor-paginated Route Run history for one user, newest first
   * (createdAt DESC, id DESC). Each item is enriched with the run's latest
   * Blueprint/Proof (if any) — bounded to a small, fixed number of queries
   * per page (no per-item round trips). Tenant-isolated by construction
   * (userId is always the filter, never derived from payload alone).
   */
  listRouteRunHistory(userId: string, params: RouteRunHistoryParamsV1): Promise<RouteRunHistoryPageV1>;

  insertIntelligenceCharge(
    runId: string,
    charge: IntelligenceChargeV1,
    links?: IntelligenceChargeStorageLinks,
  ): Promise<void>;
  listIntelligenceCharges(runId: string, userId: string): Promise<StoredIntelligenceChargeV1[]>;

  /**
   * T59: the only mutation path for an already-inserted Intelligence Charge —
   * moves it through its payment/service state machine (see
   * IntelligenceChargeV1's paymentState/serviceState). `updated` must keep
   * `id`/`tenantId`/`idempotencyKey` identical to the stored charge; every
   * other financial field (including chargeHash, which is a full-content hash
   * covering the mutable state-machine fields) is free to change between
   * transitions. Idempotent when `updated` is byte-for-byte identical to the
   * currently stored charge (no-op); fails closed with
   * RouteStorageIntegrityError if the charge is missing, belongs to another
   * Route Run/tenant, or the idempotencyKey changed. `links` fields are only
   * applied when explicitly provided (undefined = leave unchanged).
   */
  updateIntelligenceCharge(
    runId: string,
    chargeId: string,
    userId: string,
    updated: IntelligenceChargeV1,
    links?: IntelligenceChargeStorageLinks,
  ): Promise<void>;

  /**
   * T59 rework M2: tenant-WIDE x402 receipt lookup (across every Route Run
   * of `userId`), used for settlement replay protection — a receipt hash
   * already bound to a different charge in ANY run must be rejected, not
   * just within the current run. Returns the first matching stored charge
   * or null. Deliberately implemented as a payload-field scan
   * (payload->>'x402ReceiptHash') without new DDL/indexes — per-tenant
   * charge volumes are small.
   */
  findIntelligenceChargeByReceiptHash(
    userId: string,
    x402ReceiptHash: string,
  ): Promise<StoredIntelligenceChargeV1 | null>;
}

export type RouteStorageEntityKind =
  | 'routeRun'
  | 'candidate'
  | 'evidence'
  | 'evidenceSet'
  | 'score'
  | 'routeCard'
  | 'blueprint'
  | 'proof'
  | 'proofEvent'
  | 'intelligenceCharge';

export class RouteStorageConflictError extends Error {
  readonly code = 'ROUTE_STORAGE_CONFLICT';
}

export class RouteStorageIntegrityError extends Error {
  readonly code = 'ROUTE_STORAGE_INTEGRITY';
}

export class RouteStorageTenantError extends Error {
  readonly code = 'ROUTE_STORAGE_TENANT_MISMATCH';
}

export type SqlTemplateExecutor = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>;
