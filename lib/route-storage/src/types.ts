import type {
  EarnCandidateV1,
  EarnEvidenceV1,
  EarnRouteCardV1,
  EarnRouteIntentV1,
  EarnScoreV1,
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

/** T62: swap route runs carry goal 'swap'; earn runs are stored in the SAME
 * route_runs table with goal 'earn' and an EarnRouteIntentV1 payload (never a
 * swap-shaped RouteIntentV1). The `goal` column keeps the two isolated. */
export type RouteRunGoalV1 = 'swap' | 'earn';

export interface RouteRunRecord {
  id: string;
  userId: string;
  walletAddress: string;
  chainId: number;
  goal: RouteRunGoalV1;
  schemaVersion: RouteIntentV1['schemaVersion'];
  status: string;
  intentHash: string;
  idempotencyKey: string;
  intent: RouteIntentV1;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** T62: earn route run record. The goal-agnostic Blueprint/Proof storage
 * (execution_blueprints / route_proofs / route_proof_events) is reused for earn;
 * only run/intent/candidate/evidence/score/card are earn-specific. */
export interface EarnRouteRunRecord {
  id: string;
  userId: string;
  walletAddress: string;
  chainId: number;
  goal: 'earn';
  schemaVersion: EarnRouteIntentV1['schemaVersion'];
  status: string;
  intentHash: string;
  idempotencyKey: string;
  intent: EarnRouteIntentV1;
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

  // --- T62: earn persistence (additive) ------------------------------------
  // Earn runs live in route_runs (goal='earn') so the goal-agnostic Blueprint/
  // Proof storage is reused; candidates/evidence/scores/cards are earn-shaped
  // and live in their own tables. Idempotency mirrors swap: (userId,
  // idempotencyKey), goal-namespaced so an earn and swap key never collide.
  createEarnRouteRun(input: EarnRouteIntentV1, idempotencyKey: string): Promise<EarnRouteRunRecord>;
  getEarnRouteRun(id: string, userId: string): Promise<EarnRouteRunRecord | null>;

  insertEarnCandidate(runId: string, candidate: EarnCandidateV1): Promise<void>;
  listEarnCandidates(runId: string, userId: string): Promise<EarnCandidateV1[]>;

  insertEarnEvidence(runId: string, candidateId: string | null, evidence: EarnEvidenceV1): Promise<void>;
  listEarnEvidence(runId: string, userId: string): Promise<EarnEvidenceV1[]>;

  insertEarnScore(runId: string, candidateId: string, score: EarnScoreV1): Promise<void>;
  listEarnScores(runId: string, userId: string): Promise<EarnScoreV1[]>;

  insertEarnRouteCard(runId: string, card: EarnRouteCardV1): Promise<void>;
  listEarnRouteCards(runId: string, userId: string): Promise<EarnRouteCardV1[]>;

  /** Earn-specific Blueprint insert: validates the earn candidate lineage (the
   * swap insertBlueprint requires a stored EvidenceSetV1, which earn does not
   * use). Stored in the SHARED execution_blueprints table (goal='earn' payload),
   * so approve/submission/proof reuse the T57/T58 machinery unchanged. */
  insertEarnBlueprint(runId: string, blueprint: ExecutionBlueprintV1, links?: BlueprintStorageLinks): Promise<void>;

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
   * T67E §2.2 — the caller's most recent charges across every run.
   *
   * `listIntelligenceCharges` is run-scoped, which is right for idempotency
   * checks and useless for "what has Miorail charged me". Newest first, capped
   * by `limit`, and scoped by user id in the QUERY rather than filtered
   * afterwards: another tenant's charge is not found rather than found and
   * dropped.
   */
  listRecentIntelligenceCharges(userId: string, limit: number): Promise<StoredIntelligenceChargeV1[]>;

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

  // --- T60: Intelligence Budget + Spend Permission reservations -------------
  // Plain records (NOT a route-domain Zod schema) — lib/intelligence-budget
  // owns the domain schema (IntelligenceBudgetV1) and maps to/from these
  // atomic-string rows; route-storage stays a leaf dependency (route-domain,
  // no reverse edge). Amounts are base-unit integer strings (numeric(78,0)
  // in Postgres) end-to-end — never coerced through a JS number.

  insertIntelligenceBudget(input: InsertIntelligenceBudgetInput): Promise<IntelligenceBudgetRecord>;
  getActiveIntelligenceBudget(
    userId: string,
    walletAddress: string,
    chainId: number,
  ): Promise<IntelligenceBudgetRecord | null>;
  getIntelligenceBudgetById(id: string, userId: string): Promise<IntelligenceBudgetRecord | null>;
  updateIntelligenceBudget(
    id: string,
    userId: string,
    updated: UpdateIntelligenceBudgetInput,
  ): Promise<IntelligenceBudgetRecord>;
  listIntelligenceBudgetReservations(
    budgetId: string,
    userId: string,
  ): Promise<IntelligenceBudgetReservationRecord[]>;

  /**
   * Single-statement, Neon-safe atomic reservation (decision 4): checks the
   * idempotency key, the active/not-revoked/not-expired budget state, the
   * per-call cap, and the monthly limit (period_spent + reserved + amount),
   * then increments `reserved_atomic` and inserts the reservation row — all
   * in ONE CTE statement. A retried call with the SAME idempotencyKey never
   * increments `reserved_atomic` a second time (idempotent_replay).
   */
  reserveIntelligenceBudget(input: ReserveIntelligenceBudgetInput): Promise<ReserveIntelligenceBudgetOutcome>;
  /** Idempotent (gated on status='reserved'): moves a reservation to
   * 'settled' and, in the SAME statement, moves its amount from
   * `reserved_atomic` to `period_spent_atomic` on the budget. A repeat call
   * on an already-settled reservation is a no-op. */
  settleIntelligenceReservation(
    reservationId: string,
    userId: string,
    now: string,
  ): Promise<SettleIntelligenceReservationResult>;
  /** Idempotent (gated on status='reserved'): moves a reservation to
   * 'released' and decrements `reserved_atomic` by its amount in the same
   * statement. `reason` is accepted for the caller's own audit trail — this
   * table has no reason column, so it is not itself persisted here. */
  releaseIntelligenceReservation(
    reservationId: string,
    userId: string,
    now: string,
    reason: string,
  ): Promise<ReleaseIntelligenceReservationResult>;
  /** Lazily called before `reserveIntelligenceBudget`: expires every
   * still-'reserved' row past its `expiresAt` for this budget and returns
   * `reserved_atomic` to the budget in one statement. */
  expireStaleIntelligenceReservations(budgetId: string, now: string): Promise<IntelligenceBudgetRecord | null>;
}

export type IntelligenceBudgetStatus = 'active' | 'paused' | 'revoked' | 'expired';
export type IntelligenceBudgetReservationStatus = 'reserved' | 'settled' | 'released' | 'expired';

export interface IntelligenceBudgetRecord {
  id: string;
  schemaVersion: string;
  userId: string;
  walletAddress: string;
  chainId: number;
  spendPermissionId: string;
  status: IntelligenceBudgetStatus;
  periodType: 'monthly';
  /** Base-unit integer strings — numeric(78,0) columns, never a JS number. */
  periodLimitAtomic: string;
  periodSpentAtomic: string;
  reservedAtomic: string;
  maxPerCallAtomic: string;
  allowedCategories: string[];
  periodStartedAt: string | null;
  periodEndsAt: string | null;
  revokedAt: string | null;
  budgetHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntelligenceBudgetReservationRecord {
  id: string;
  schemaVersion: string;
  budgetId: string;
  userId: string;
  amountAtomic: string;
  status: IntelligenceBudgetReservationStatus;
  idempotencyKey: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface InsertIntelligenceBudgetInput {
  id: string;
  schemaVersion: string;
  userId: string;
  walletAddress: string;
  chainId: number;
  spendPermissionId: string;
  status: IntelligenceBudgetStatus;
  periodType: 'monthly';
  periodLimitAtomic: string;
  maxPerCallAtomic: string;
  allowedCategories: string[];
  periodStartedAt: string | null;
  periodEndsAt: string | null;
  budgetHash: string;
  now: string;
}

export interface UpdateIntelligenceBudgetInput {
  status?: IntelligenceBudgetStatus;
  periodLimitAtomic?: string;
  maxPerCallAtomic?: string;
  allowedCategories?: string[];
  periodStartedAt?: string | null;
  periodEndsAt?: string | null;
  revokedAt?: string | null;
  budgetHash: string;
  now: string;
}

export interface ReserveIntelligenceBudgetInput {
  budgetId: string;
  userId: string;
  reservationId: string;
  amountAtomic: string;
  idempotencyKey: string;
  now: string;
  expiresAt: string;
}

export type ReserveIntelligenceBudgetOutcome =
  | { outcome: 'reserved'; reservation: IntelligenceBudgetReservationRecord; budget: IntelligenceBudgetRecord }
  | { outcome: 'idempotent_replay'; reservation: IntelligenceBudgetReservationRecord; budget: IntelligenceBudgetRecord }
  | { outcome: 'insufficient'; reservation: null; budget: IntelligenceBudgetRecord | null }
  | { outcome: 'inactive'; reservation: null; budget: IntelligenceBudgetRecord | null };

export interface SettleIntelligenceReservationResult {
  reservation: IntelligenceBudgetReservationRecord | null;
  budget: IntelligenceBudgetRecord | null;
}

export interface ReleaseIntelligenceReservationResult {
  reservation: IntelligenceBudgetReservationRecord | null;
  budget: IntelligenceBudgetRecord | null;
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
