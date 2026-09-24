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
import {
  RouteStorageConflictError,
  RouteStorageIntegrityError,
  RouteStorageTenantError,
  type BlueprintStorageLinks,
  type EarnRouteRunRecord,
  type InsertIntelligenceBudgetInput,
  type IntelligenceBudgetRecord,
  type IntelligenceBudgetReservationRecord,
  type IntelligenceChargeStorageLinks,
  type ReleaseIntelligenceReservationResult,
  type ReserveIntelligenceBudgetInput,
  type ReserveIntelligenceBudgetOutcome,
  type RouteRunGoalV1,
  type RouteRunRecord,
  type RouteStorageEntityKind,
  type RouteStorageRepository,
  type SettleIntelligenceReservationResult,
  type StoredBlueprintV1,
  type StoredIntelligenceChargeV1,
  type UpdateIntelligenceBudgetInput,
} from './types.js';
import {
  decodeRouteHistoryCursorV1,
  encodeRouteHistoryCursorV1,
  summarizeRouteIntentV1,
  type RouteRunHistoryItemV1,
  type RouteRunHistoryPageV1,
  type RouteRunHistoryParamsV1,
} from './history.js';
import {
  assertLinkedHash,
  assertTenant,
  parseEarnCandidate,
  parseEarnEvidence,
  parseEarnRouteCard,
  parseEarnRouteIntent,
  parseEarnScore,
  parseEvidenceRecord,
  parseEvidenceSet,
  parseExecutionBlueprint,
  parseIntelligenceCharge,
  parsePathScore,
  parseRouteCandidate,
  parseRouteCard,
  parseRouteIntent,
  parseRouteProof,
  parseRouteProofEvent,
  payloadEquals,
} from './validation.js';

interface StoredRun {
  id: string;
  userId: string;
  walletAddress: string;
  chainId: number;
  goal: RouteRunGoalV1;
  schemaVersion: string;
  status: string;
  intentHash: string;
  idempotencyKey: string;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface StoredEntity {
  id: string;
  runId: string;
  userId: string;
  hash: string;
  payload: unknown;
}

interface StoredCandidate extends StoredEntity {
  providerId: string;
}

interface StoredEvidence extends StoredEntity {
  candidateId: string | null;
}

interface StoredEvidenceSet extends StoredEntity {
  candidateId: string;
}

interface StoredScore extends StoredEntity {
  candidateId: string;
}

interface StoredCard extends StoredEntity {
  selectedCandidateId: string | null;
}

interface StoredBlueprint extends StoredEntity {
  preparedTransactionActionId: string | null;
}

interface StoredProof extends StoredEntity {
  blueprintId: string;
}

interface StoredProofEvent extends StoredEntity {
  proofId: string;
  sequence: number;
}

interface StoredCharge extends StoredEntity {
  evidenceId: string | null;
  spendPermissionId: string | null;
  x402ReceiptId: string | null;
}

function conflict(message: string): never {
  throw new RouteStorageConflictError(message);
}

// T60 — schema_version is owned by route-storage (the caller's input list
// deliberately omits it, decision 4), mirroring how DB DEFAULTs/constants
// live in the storage layer rather than every call site.
const INTELLIGENCE_BUDGET_RESERVATION_SCHEMA_VERSION = 'intelligence-budget-reservation/v1';

function cloneBudget(budget: IntelligenceBudgetRecord): IntelligenceBudgetRecord {
  return { ...budget, allowedCategories: [...budget.allowedCategories] };
}

function cloneReservation(
  reservation: IntelligenceBudgetReservationRecord,
): IntelligenceBudgetReservationRecord {
  return { ...reservation };
}

function immutableDuplicate(
  existing: StoredEntity,
  next: StoredEntity,
  linkFieldsMatch = true,
): boolean {
  return (
    existing.id === next.id &&
    existing.runId === next.runId &&
    existing.userId === next.userId &&
    existing.hash === next.hash &&
    linkFieldsMatch &&
    payloadEquals(existing.payload, next.payload)
  );
}

export class InMemoryRouteStorageRepository implements RouteStorageRepository {
  private readonly runs = new Map<string, StoredRun>();
  private readonly runByIdempotency = new Map<string, string>();
  private readonly candidates = new Map<string, StoredCandidate>();
  private readonly evidence = new Map<string, StoredEvidence>();
  private readonly evidenceSets = new Map<string, StoredEvidenceSet>();
  private readonly scores = new Map<string, StoredScore>();
  private readonly cards = new Map<string, StoredCard>();
  private readonly blueprints = new Map<string, StoredBlueprint>();
  private readonly proofs = new Map<string, StoredProof>();
  private readonly proofEvents = new Map<string, StoredProofEvent>();
  private readonly charges = new Map<string, StoredCharge>();
  private readonly intelligenceBudgets = new Map<string, IntelligenceBudgetRecord>();
  private readonly intelligenceBudgetReservations = new Map<string, IntelligenceBudgetReservationRecord>();
  // T62: earn-shaped entities. Earn runs live in `runs` (goal='earn'); earn
  // blueprints/proofs reuse the goal-agnostic `blueprints`/`proofs` maps.
  private readonly earnCandidates = new Map<string, StoredCandidate>();
  private readonly earnEvidence = new Map<string, StoredEvidence>();
  private readonly earnScores = new Map<string, StoredScore>();
  private readonly earnCards = new Map<string, StoredCard>();

  async createRouteRun(input: RouteIntentV1, idempotencyKey: string): Promise<RouteRunRecord> {
    const intent = parseRouteIntent(input);
    if (idempotencyKey.trim().length === 0) {
      throw new RouteStorageIntegrityError('Route run idempotency key must not be empty');
    }
    if (intent.goal === 'send') {
      throw new RouteStorageIntegrityError('A send intent is stored by createSendRouteRun');
    }
    const key = `${intent.tenantId}\u0000${idempotencyKey}`;
    const byId = this.runs.get(intent.id);
    const byKeyId = this.runByIdempotency.get(key);
    const byKey = byKeyId ? this.runs.get(byKeyId) : undefined;
    if (byId || byKey) {
      const existing = byId ?? byKey!;
      if (
        existing.id !== intent.id ||
        existing.userId !== intent.tenantId ||
        existing.idempotencyKey !== idempotencyKey ||
        !payloadEquals(existing.payload, intent)
      ) {
        conflict('Route run ID or user-scoped idempotency key already has different content');
      }
      return this.routeRunRecord(existing);
    }

    const stored: StoredRun = {
      id: intent.id,
      userId: intent.tenantId,
      walletAddress: intent.walletAddress,
      chainId: intent.chainId,
      goal: 'swap',
      schemaVersion: intent.schemaVersion,
      status: intent.status,
      intentHash: intent.intentHash,
      idempotencyKey,
      payload: structuredClone(intent),
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
      completedAt: null,
    };
    this.runs.set(stored.id, stored);
    this.runByIdempotency.set(key, stored.id);
    return this.routeRunRecord(stored);
  }

  async getRouteRun(id: string, userId: string): Promise<RouteRunRecord | null> {
    const stored = this.runs.get(id);
    // T62: never return an earn run through the swap getter — its payload is an
    // EarnRouteIntentV1 that would fail to parse as a swap RouteIntentV1. A send
    // run's payload is a RouteIntentV1, and Postgres returns it here too (its
    // query filters `goal IN ('swap', 'send')`): the goal-agnostic submission
    // and proof paths read it through this getter, and the swap composer
    // refuses its goal.
    if (!stored || stored.userId !== userId || (stored.goal !== 'swap' && stored.goal !== 'send')) return null;
    return this.routeRunRecord(stored);
  }

  // --- Gift from holdings ----------------------------------------------------

  async createSendRouteRun(input: RouteIntentV1, idempotencyKey: string): Promise<RouteRunRecord> {
    const intent = parseRouteIntent(input);
    if (intent.goal !== 'send') {
      throw new RouteStorageIntegrityError('createSendRouteRun requires a send intent');
    }
    if (idempotencyKey.trim().length === 0) {
      throw new RouteStorageIntegrityError('Send route run idempotency key must not be empty');
    }
    // One key space per user in Postgres (route_runs_user_idempotency_unique),
    // so a send key never shares a slot with a swap key either.
    const key = `${intent.tenantId}\u0000${idempotencyKey}`;
    const byId = this.runs.get(intent.id);
    const byKeyId = this.runByIdempotency.get(key);
    const byKey = byKeyId ? this.runs.get(byKeyId) : undefined;
    if (byId || byKey) {
      const existing = byId ?? byKey!;
      if (
        existing.id !== intent.id ||
        existing.userId !== intent.tenantId ||
        existing.goal !== 'send' ||
        existing.idempotencyKey !== idempotencyKey ||
        !payloadEquals(existing.payload, intent)
      ) {
        conflict('Send route run ID or user-scoped idempotency key already has different content');
      }
      return this.routeRunRecord(existing);
    }
    const stored: StoredRun = {
      id: intent.id,
      userId: intent.tenantId,
      walletAddress: intent.walletAddress,
      chainId: intent.chainId,
      goal: 'send',
      schemaVersion: intent.schemaVersion,
      status: intent.status,
      intentHash: intent.intentHash,
      idempotencyKey,
      payload: structuredClone(intent),
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
      completedAt: null,
    };
    this.runs.set(stored.id, stored);
    this.runByIdempotency.set(key, stored.id);
    return this.routeRunRecord(stored);
  }

  async getSendRouteRun(id: string, userId: string): Promise<RouteRunRecord | null> {
    const stored = this.runs.get(id);
    if (!stored || stored.userId !== userId || stored.goal !== 'send') return null;
    return this.routeRunRecord(stored);
  }

  async insertSendBlueprint(runId: string, input: ExecutionBlueprintV1): Promise<void> {
    const blueprint = parseExecutionBlueprint(input);
    if (blueprint.goal !== 'send') {
      throw new RouteStorageIntegrityError('insertSendBlueprint requires a send-goal Blueprint');
    }
    const run = this.runs.get(runId);
    if (!run || run.goal !== 'send') throw new RouteStorageTenantError('Send Route Run is missing or belongs to another tenant');
    if (run.userId !== blueprint.tenantId) {
      throw new RouteStorageTenantError('Send Route Run is missing or belongs to another tenant');
    }
    const record = this.routeRunRecord(run);
    assertLinkedHash(blueprint.intentHash, record.intentHash, 'sendBlueprint.intentHash');
    const next: StoredBlueprint = {
      id: blueprint.id,
      runId,
      userId: blueprint.tenantId,
      hash: blueprint.blueprintHash,
      preparedTransactionActionId: null,
      payload: structuredClone(blueprint),
    };
    const existing =
      this.blueprints.get(blueprint.id) ??
      this.findByRunHash(this.blueprints, runId, blueprint.blueprintHash);
    if (existing) {
      if (immutableDuplicate(existing, next, existing.preparedTransactionActionId === null)) return;
      conflict('Send Blueprint ID or run-scoped hash already has different content');
    }
    this.blueprints.set(next.id, next);
  }

  // --- T62: earn persistence -----------------------------------------------

  async createEarnRouteRun(input: EarnRouteIntentV1, idempotencyKey: string): Promise<EarnRouteRunRecord> {
    const intent = parseEarnRouteIntent(input);
    if (idempotencyKey.trim().length === 0) {
      throw new RouteStorageIntegrityError('Earn route run idempotency key must not be empty');
    }
    // Goal-namespaced idempotency key so an earn and swap key never collide.
    const key = `${intent.tenantId}\\0earn\\0${idempotencyKey}`;
    const byId = this.runs.get(intent.id);
    const byKeyId = this.runByIdempotency.get(key);
    const byKey = byKeyId ? this.runs.get(byKeyId) : undefined;
    if (byId || byKey) {
      const existing = byId ?? byKey!;
      if (
        existing.id !== intent.id ||
        existing.userId !== intent.tenantId ||
        existing.goal !== 'earn' ||
        existing.idempotencyKey !== idempotencyKey ||
        !payloadEquals(existing.payload, intent)
      ) {
        conflict('Earn route run ID or user-scoped idempotency key already has different content');
      }
      return this.earnRouteRunRecord(existing);
    }
    const stored: StoredRun = {
      id: intent.id,
      userId: intent.tenantId,
      walletAddress: intent.walletAddress,
      chainId: intent.chainId,
      goal: 'earn',
      schemaVersion: intent.schemaVersion,
      status: intent.status,
      intentHash: intent.intentHash,
      idempotencyKey,
      payload: structuredClone(intent),
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
      completedAt: null,
    };
    this.runs.set(stored.id, stored);
    this.runByIdempotency.set(key, stored.id);
    return this.earnRouteRunRecord(stored);
  }

  async getEarnRouteRun(id: string, userId: string): Promise<EarnRouteRunRecord | null> {
    const stored = this.runs.get(id);
    if (!stored || stored.userId !== userId || stored.goal !== 'earn') return null;
    return this.earnRouteRunRecord(stored);
  }

  async insertEarnCandidate(runId: string, input: EarnCandidateV1): Promise<void> {
    const candidate = parseEarnCandidate(input);
    const run = this.ownedEarnRun(runId, candidate.tenantId);
    assertLinkedHash(candidate.intentHash, run.intentHash, 'earnCandidate.intentHash');
    const next: StoredCandidate = {
      id: candidate.id,
      runId,
      userId: candidate.tenantId,
      hash: candidate.candidateHash,
      providerId: candidate.provider.id,
      payload: structuredClone(candidate),
    };
    const existing =
      this.earnCandidates.get(candidate.id) ??
      this.findByRunHash(this.earnCandidates, runId, candidate.candidateHash);
    if (existing) {
      if (immutableDuplicate(existing, next, existing.providerId === next.providerId)) return;
      conflict('Earn candidate ID or run-scoped hash already has different content');
    }
    this.earnCandidates.set(next.id, next);
  }

  async listEarnCandidates(runId: string, userId: string): Promise<EarnCandidateV1[]> {
    if (!this.isOwnedEarnRun(runId, userId)) return [];
    return this.byRun(this.earnCandidates, runId).map((stored) => {
      const candidate = parseEarnCandidate(stored.payload);
      this.assertEntityEnvelope(stored, candidate.id, candidate.tenantId, candidate.candidateHash);
      return candidate;
    });
  }

  async insertEarnEvidence(
    runId: string,
    candidateId: string | null,
    input: EarnEvidenceV1,
  ): Promise<void> {
    const evidence = parseEarnEvidence(input);
    const run = this.ownedEarnRun(runId, evidence.tenantId);
    assertLinkedHash(evidence.intentHash, run.intentHash, 'earnEvidence.intentHash');
    if (candidateId !== null) {
      const candidate = this.ownedEarnCandidate(candidateId, runId, evidence.tenantId);
      assertLinkedHash(evidence.candidateHash, candidate.hash, 'earnEvidence.candidateHash');
    }
    const next: StoredEvidence = {
      id: evidence.id,
      runId,
      userId: evidence.tenantId,
      hash: evidence.evidenceHash,
      candidateId,
      payload: structuredClone(evidence),
    };
    const existing =
      this.earnEvidence.get(evidence.id) ??
      this.findByRunHash(this.earnEvidence, runId, evidence.evidenceHash);
    if (existing) {
      if (immutableDuplicate(existing, next, existing.candidateId === candidateId)) return;
      conflict('Earn evidence ID or run-scoped hash already has different content');
    }
    this.earnEvidence.set(next.id, next);
  }

  async listEarnEvidence(runId: string, userId: string): Promise<EarnEvidenceV1[]> {
    if (!this.isOwnedEarnRun(runId, userId)) return [];
    return this.byRun(this.earnEvidence, runId).map((stored) => {
      const evidence = parseEarnEvidence(stored.payload);
      this.assertEntityEnvelope(stored, evidence.id, evidence.tenantId, evidence.evidenceHash);
      return evidence;
    });
  }

  async insertEarnScore(runId: string, candidateId: string, input: EarnScoreV1): Promise<void> {
    const score = parseEarnScore(input);
    const run = this.ownedEarnRun(runId, score.tenantId);
    assertLinkedHash(score.intentHash, run.intentHash, 'earnScore.intentHash');
    const candidate = this.ownedEarnCandidate(candidateId, runId, score.tenantId);
    assertLinkedHash(score.candidateHash, candidate.hash, 'earnScore.candidateHash');
    const next: StoredScore = {
      id: score.id,
      runId,
      userId: score.tenantId,
      hash: score.earnScoreHash,
      candidateId,
      payload: structuredClone(score),
    };
    const existing =
      this.earnScores.get(score.id) ??
      this.findByRunHash(this.earnScores, runId, score.earnScoreHash);
    if (existing) {
      if (immutableDuplicate(existing, next, existing.candidateId === candidateId)) return;
      conflict('Earn score ID or run-scoped hash already has different content');
    }
    this.earnScores.set(next.id, next);
  }

  async listEarnScores(runId: string, userId: string): Promise<EarnScoreV1[]> {
    if (!this.isOwnedEarnRun(runId, userId)) return [];
    return this.byRun(this.earnScores, runId).map((stored) => {
      const score = parseEarnScore(stored.payload);
      this.assertEntityEnvelope(stored, score.id, score.tenantId, score.earnScoreHash);
      return score;
    });
  }

  async insertEarnRouteCard(runId: string, input: EarnRouteCardV1): Promise<void> {
    const card = parseEarnRouteCard(input);
    const run = this.ownedEarnRun(runId, card.tenantId);
    assertLinkedHash(card.intentHash, run.intentHash, 'earnRouteCard.intentHash');
    const selected = card.recommendedCandidateHash
      ? this.findByRunHash(this.earnCandidates, runId, card.recommendedCandidateHash)
      : undefined;
    if (card.recommendedCandidateHash && !selected) {
      throw new RouteStorageIntegrityError('Earn Route Card recommends an unstored candidate');
    }
    const next: StoredCard = {
      id: card.id,
      runId,
      userId: card.tenantId,
      hash: card.routeCardHash,
      selectedCandidateId: selected?.id ?? null,
      payload: structuredClone(card),
    };
    const existing =
      this.earnCards.get(card.id) ?? this.findByRunHash(this.earnCards, runId, card.routeCardHash);
    if (existing) {
      if (immutableDuplicate(existing, next, existing.selectedCandidateId === next.selectedCandidateId)) return;
      conflict('Earn route card ID or run-scoped hash already has different content');
    }
    this.earnCards.set(next.id, next);
  }

  async listEarnRouteCards(runId: string, userId: string): Promise<EarnRouteCardV1[]> {
    if (!this.isOwnedEarnRun(runId, userId)) return [];
    return this.byRun(this.earnCards, runId).map((stored) => {
      const card = parseEarnRouteCard(stored.payload);
      this.assertEntityEnvelope(stored, card.id, card.tenantId, card.routeCardHash);
      return card;
    });
  }

  async insertEarnBlueprint(
    runId: string,
    input: ExecutionBlueprintV1,
    links: BlueprintStorageLinks = {},
  ): Promise<void> {
    const blueprint = parseExecutionBlueprint(input);
    if (blueprint.goal !== 'earn') {
      throw new RouteStorageIntegrityError('insertEarnBlueprint requires an earn-goal Blueprint');
    }
    const run = this.ownedEarnRun(runId, blueprint.tenantId);
    assertLinkedHash(blueprint.intentHash, run.intentHash, 'earnBlueprint.intentHash');
    const candidate = this.findByRunHash(this.earnCandidates, runId, blueprint.selectedCandidateHash);
    if (!candidate) {
      throw new RouteStorageIntegrityError('Earn Blueprint references an unstored earn candidate');
    }
    const next: StoredBlueprint = {
      id: blueprint.id,
      runId,
      userId: blueprint.tenantId,
      hash: blueprint.blueprintHash,
      preparedTransactionActionId: links.preparedTransactionActionId ?? null,
      payload: structuredClone(blueprint),
    };
    const existing =
      this.blueprints.get(blueprint.id) ??
      this.findByRunHash(this.blueprints, runId, blueprint.blueprintHash);
    if (existing) {
      if (
        immutableDuplicate(existing, next, existing.preparedTransactionActionId === next.preparedTransactionActionId)
      )
        return;
      conflict('Earn Blueprint ID or run-scoped hash already has different content');
    }
    this.blueprints.set(next.id, next);
  }

  private earnRouteRunRecord(stored: StoredRun): EarnRouteRunRecord {
    const intent = parseEarnRouteIntent(stored.payload);
    if (
      intent.id !== stored.id ||
      intent.tenantId !== stored.userId ||
      intent.walletAddress !== stored.walletAddress ||
      intent.chainId !== stored.chainId ||
      intent.intentHash !== stored.intentHash
    ) {
      throw new RouteStorageIntegrityError('Stored earn Route Run envelope differs from its intent');
    }
    return {
      id: stored.id,
      userId: stored.userId,
      walletAddress: stored.walletAddress,
      chainId: stored.chainId,
      goal: 'earn',
      schemaVersion: intent.schemaVersion,
      status: stored.status,
      intentHash: stored.intentHash,
      idempotencyKey: stored.idempotencyKey,
      intent,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      completedAt: stored.completedAt,
    };
  }

  private ownedEarnRun(runId: string, userId: string): StoredRun {
    const run = this.runs.get(runId);
    if (!run || run.goal !== 'earn') throw new RouteStorageIntegrityError('Earn Route Run does not exist');
    if (run.userId !== userId) throw new RouteStorageTenantError('Earn Route Run belongs to another tenant');
    return run;
  }

  private isOwnedEarnRun(runId: string, userId: string): boolean {
    const run = this.runs.get(runId);
    return Boolean(run && run.userId === userId && run.goal === 'earn');
  }

  private ownedEarnCandidate(id: string, runId: string, userId: string): StoredCandidate {
    const stored = this.earnCandidates.get(id);
    if (!stored || stored.runId !== runId) {
      throw new RouteStorageIntegrityError('Earn candidate does not belong to the earn Route Run');
    }
    if (stored.userId !== userId) {
      throw new RouteStorageTenantError('Earn candidate belongs to another tenant');
    }
    return stored;
  }

  async insertCandidate(runId: string, input: RouteCandidateV1): Promise<void> {
    const candidate = parseRouteCandidate(input);
    const run = this.ownedRun(runId, candidate.tenantId);
    assertLinkedHash(candidate.intentHash, run.intentHash, 'candidate.intentHash');
    const next: StoredCandidate = {
      id: candidate.id,
      runId,
      userId: candidate.tenantId,
      hash: candidate.candidateHash,
      providerId: candidate.provider.id,
      payload: structuredClone(candidate),
    };
    const existingById = this.candidates.get(candidate.id);
    const existingByHash = this.findByRunHash(this.candidates, runId, candidate.candidateHash);
    const existing = existingById ?? existingByHash;
    if (existing) {
      if (immutableDuplicate(existing, next, existing.providerId === next.providerId)) return;
      conflict('Candidate ID or run-scoped candidate hash already has different content');
    }
    this.candidates.set(next.id, next);
  }

  async listCandidates(runId: string, userId: string): Promise<RouteCandidateV1[]> {
    if (!this.isOwnedRun(runId, userId)) return [];
    return this.byRun(this.candidates, runId).map((stored) => {
      const candidate = parseRouteCandidate(stored.payload);
      this.assertEntityEnvelope(stored, candidate.id, candidate.tenantId, candidate.candidateHash);
      return candidate;
    });
  }

  async insertEvidence(
    runId: string,
    candidateId: string | null,
    input: EvidenceRecordV1,
  ): Promise<void> {
    const evidence = parseEvidenceRecord(input);
    const run = this.ownedRun(runId, evidence.tenantId);
    assertLinkedHash(evidence.intentHash, run.intentHash, 'evidence.intentHash');
    if (candidateId !== null) {
      const candidate = this.ownedCandidate(candidateId, runId, evidence.tenantId);
      assertLinkedHash(evidence.candidateHash, candidate.candidateHash, 'evidence.candidateHash');
    }
    const next: StoredEvidence = {
      id: evidence.id,
      runId,
      userId: evidence.tenantId,
      hash: evidence.evidenceHash,
      candidateId,
      payload: structuredClone(evidence),
    };
    const existing =
      this.evidence.get(evidence.id) ??
      this.findByRunHash(this.evidence, runId, evidence.evidenceHash);
    if (existing) {
      if (immutableDuplicate(existing, next, existing.candidateId === candidateId)) return;
      conflict('Evidence ID or run-scoped evidence hash already has different content');
    }
    this.evidence.set(next.id, next);
  }

  async listEvidence(runId: string, userId: string): Promise<EvidenceRecordV1[]> {
    if (!this.isOwnedRun(runId, userId)) return [];
    return this.byRun(this.evidence, runId).map((stored) => {
      const evidence = parseEvidenceRecord(stored.payload);
      this.assertEntityEnvelope(stored, evidence.id, evidence.tenantId, evidence.evidenceHash);
      return evidence;
    });
  }

  async insertEvidenceSet(runId: string, candidateId: string, input: EvidenceSetV1): Promise<void> {
    const evidenceSet = parseEvidenceSet(input);
    const run = this.ownedRun(runId, evidenceSet.tenantId);
    assertLinkedHash(evidenceSet.intentHash, run.intentHash, 'evidenceSet.intentHash');
    const candidate = this.ownedCandidate(candidateId, runId, evidenceSet.tenantId);
    assertLinkedHash(
      evidenceSet.candidateHash,
      candidate.candidateHash,
      'evidenceSet.candidateHash',
    );
    for (const record of evidenceSet.records) {
      const stored = this.findByRunHash(this.evidence, runId, record.evidenceHash);
      if (!stored || stored.userId !== evidenceSet.tenantId) {
        throw new RouteStorageIntegrityError('Evidence Set references an unstored evidence record');
      }
    }
    const next: StoredEvidenceSet = {
      id: evidenceSet.id,
      runId,
      userId: evidenceSet.tenantId,
      hash: evidenceSet.evidenceSetHash,
      candidateId,
      payload: structuredClone(evidenceSet),
    };
    const existing =
      this.evidenceSets.get(evidenceSet.id) ??
      this.findByRunHash(this.evidenceSets, runId, evidenceSet.evidenceSetHash);
    if (existing) {
      if (immutableDuplicate(existing, next, existing.candidateId === candidateId)) return;
      conflict('Evidence Set ID or run-scoped hash already has different content');
    }
    this.evidenceSets.set(next.id, next);
  }

  async listEvidenceSets(runId: string, userId: string): Promise<EvidenceSetV1[]> {
    if (!this.isOwnedRun(runId, userId)) return [];
    return this.byRun(this.evidenceSets, runId).map((stored) => {
      const evidenceSet = parseEvidenceSet(stored.payload);
      this.assertEntityEnvelope(
        stored,
        evidenceSet.id,
        evidenceSet.tenantId,
        evidenceSet.evidenceSetHash,
      );
      return evidenceSet;
    });
  }

  async insertScoreSnapshot(runId: string, candidateId: string, input: PathScoreV1): Promise<void> {
    const score = parsePathScore(input);
    const run = this.ownedRun(runId, score.tenantId);
    assertLinkedHash(score.intentHash, run.intentHash, 'score.intentHash');
    const candidate = this.ownedCandidate(candidateId, runId, score.tenantId);
    assertLinkedHash(score.candidateHash, candidate.candidateHash, 'score.candidateHash');
    const evidenceSet = this.findByRunHash(this.evidenceSets, runId, score.evidenceSetHash);
    if (!evidenceSet || evidenceSet.userId !== score.tenantId) {
      throw new RouteStorageIntegrityError('Path Score references an unstored Evidence Set');
    }
    const parsedEvidenceSet = parseEvidenceSet(evidenceSet.payload);
    assertLinkedHash(parsedEvidenceSet.intentHash, run.intentHash, 'score.evidenceSet.intentHash');
    assertLinkedHash(
      parsedEvidenceSet.candidateHash,
      candidate.candidateHash,
      'score.evidenceSet.candidateHash',
    );
    if (evidenceSet.candidateId !== candidateId) {
      throw new RouteStorageIntegrityError('Path Score Evidence Set has different lineage');
    }
    const next: StoredScore = {
      id: score.id,
      runId,
      userId: score.tenantId,
      hash: score.pathScoreHash,
      candidateId,
      payload: structuredClone(score),
    };
    const existing =
      this.scores.get(score.id) ??
      [...this.scores.values()].find(
        (stored) => stored.candidateId === candidateId && stored.hash === score.pathScoreHash,
      );
    if (existing) {
      if (immutableDuplicate(existing, next, existing.candidateId === candidateId)) return;
      conflict('Immutable Path Score snapshot conflicts with an existing ID or hash');
    }
    this.scores.set(next.id, next);
  }

  async listScoreSnapshots(runId: string, userId: string): Promise<PathScoreV1[]> {
    if (!this.isOwnedRun(runId, userId)) return [];
    return this.byRun(this.scores, runId).map((stored) => {
      const score = parsePathScore(stored.payload);
      this.assertEntityEnvelope(stored, score.id, score.tenantId, score.pathScoreHash);
      return score;
    });
  }

  async insertRouteCard(runId: string, input: RouteCardV1): Promise<void> {
    const card = parseRouteCard(input);
    const run = this.ownedRun(runId, card.tenantId);
    assertLinkedHash(card.intentHash, run.intentHash, 'routeCard.intentHash');
    const selected = this.findByRunHash(this.candidates, runId, card.selectedCandidateHash);
    if (selected && selected.userId !== card.tenantId) {
      throw new RouteStorageTenantError('Selected candidate belongs to another tenant');
    }
    const next: StoredCard = {
      id: card.id,
      runId,
      userId: card.tenantId,
      hash: card.routeCardHash,
      selectedCandidateId: selected?.id ?? null,
      payload: structuredClone(card),
    };
    const existing =
      this.cards.get(card.id) ?? this.findByRunHash(this.cards, runId, card.routeCardHash);
    if (existing) {
      if (
        immutableDuplicate(
          existing,
          next,
          existing.selectedCandidateId === next.selectedCandidateId,
        )
      )
        return;
      conflict('Route Card versions cannot silently mutate existing history');
    }
    this.cards.set(next.id, next);
  }

  async listRouteCards(runId: string, userId: string): Promise<RouteCardV1[]> {
    if (!this.isOwnedRun(runId, userId)) return [];
    return this.byRun(this.cards, runId).map((stored) => {
      const card = parseRouteCard(stored.payload);
      this.assertEntityEnvelope(stored, card.id, card.tenantId, card.routeCardHash);
      return card;
    });
  }

  async insertBlueprint(
    runId: string,
    input: ExecutionBlueprintV1,
    links: BlueprintStorageLinks = {},
  ): Promise<void> {
    const blueprint = parseExecutionBlueprint(input);
    const run = this.ownedRun(runId, blueprint.tenantId);
    assertLinkedHash(blueprint.intentHash, run.intentHash, 'blueprint.intentHash');
    const candidate = this.findByRunHash(this.candidates, runId, blueprint.selectedCandidateHash);
    const evidenceSet = this.findByRunHash(this.evidenceSets, runId, blueprint.evidenceSetHash);
    if (!candidate || !evidenceSet) {
      throw new RouteStorageIntegrityError(
        'Blueprint references an unstored candidate or Evidence Set',
      );
    }
    const parsedEvidenceSet = parseEvidenceSet(evidenceSet.payload);
    assertLinkedHash(
      parsedEvidenceSet.intentHash,
      run.intentHash,
      'blueprint.evidenceSet.intentHash',
    );
    assertLinkedHash(
      parsedEvidenceSet.candidateHash,
      blueprint.selectedCandidateHash,
      'blueprint.evidenceSet.candidateHash',
    );
    if (evidenceSet.candidateId !== candidate.id) {
      throw new RouteStorageIntegrityError('Blueprint Evidence Set has different lineage');
    }
    const next: StoredBlueprint = {
      id: blueprint.id,
      runId,
      userId: blueprint.tenantId,
      hash: blueprint.blueprintHash,
      preparedTransactionActionId: links.preparedTransactionActionId ?? null,
      payload: structuredClone(blueprint),
    };
    const existing =
      this.blueprints.get(blueprint.id) ??
      this.findByRunHash(this.blueprints, runId, blueprint.blueprintHash);
    if (existing) {
      if (
        immutableDuplicate(
          existing,
          next,
          existing.preparedTransactionActionId === next.preparedTransactionActionId,
        )
      )
        return;
      conflict('Blueprint ID or run-scoped hash already has different content');
    }
    this.blueprints.set(next.id, next);
  }

  async listBlueprints(runId: string, userId: string): Promise<StoredBlueprintV1[]> {
    if (!this.isOwnedRun(runId, userId)) return [];
    return this.byRun(this.blueprints, runId).map((stored) => {
      const blueprint = parseExecutionBlueprint(stored.payload);
      this.assertEntityEnvelope(stored, blueprint.id, blueprint.tenantId, blueprint.blueprintHash);
      return {
        blueprint,
        preparedTransactionActionId: stored.preparedTransactionActionId,
      };
    });
  }

  async approveBlueprint(
    runId: string,
    blueprintId: string,
    userId: string,
    input: ExecutionBlueprintV1,
  ): Promise<ExecutionBlueprintV1> {
    const approved = parseExecutionBlueprint(input);
    if (approved.status !== 'approved') {
      throw new RouteStorageIntegrityError('approveBlueprint requires an approved Blueprint payload');
    }
    if (approved.id !== blueprintId || approved.tenantId !== userId) {
      throw new RouteStorageIntegrityError('approveBlueprint payload does not match the requested Blueprint');
    }
    const stored = this.blueprints.get(blueprintId);
    if (!stored || stored.runId !== runId || stored.userId !== userId) {
      throw new RouteStorageIntegrityError('Blueprint does not exist for this Route Run and tenant');
    }
    const current = parseExecutionBlueprint(stored.payload);
    if (current.blueprintHash !== approved.blueprintHash) {
      throw new RouteStorageIntegrityError(
        'approveBlueprint payload blueprintHash does not match the stored Blueprint',
      );
    }
    if (current.status === 'approved') {
      if (current.approvedCallsHash === approved.approvedCallsHash) return current;
      conflict('Blueprint is already approved with a different approved-calls hash');
    }
    if (current.status !== 'ready_for_review') {
      throw new RouteStorageIntegrityError(`Blueprint status ${current.status} cannot be approved`);
    }
    stored.payload = structuredClone(approved);
    return approved;
  }

  async upsertProofProjection(runId: string, input: RouteProofV1): Promise<void> {
    const proof = parseRouteProof(input);
    const run = this.ownedRun(runId, proof.tenantId);
    assertLinkedHash(proof.intentHash, run.intentHash, 'proof.intentHash');
    const blueprint = this.findByRunHash(this.blueprints, runId, proof.blueprintHash);
    if (!blueprint || blueprint.userId !== proof.tenantId) {
      throw new RouteStorageIntegrityError('Route Proof references an unstored Blueprint');
    }
    const parsedBlueprint = parseExecutionBlueprint(blueprint.payload);
    assertLinkedHash(
      proof.selectedCandidateHash,
      parsedBlueprint.selectedCandidateHash,
      'proof.selectedCandidateHash',
    );
    assertLinkedHash(
      proof.evidenceSetHash,
      parsedBlueprint.evidenceSetHash,
      'proof.evidenceSetHash',
    );
    assertLinkedHash(proof.approvedCallsHash, parsedBlueprint.callsHash, 'proof.approvedCallsHash');
    const conflictingHash = this.findByRunHash(this.proofs, runId, proof.proofHash);
    if (conflictingHash && conflictingHash.id !== proof.id) {
      conflict('Route Proof hash is already assigned to another projection');
    }
    const existing = this.proofs.get(proof.id);
    if (
      existing &&
      (existing.runId !== runId ||
        existing.userId !== proof.tenantId ||
        existing.blueprintId !== blueprint.id)
    ) {
      conflict('Route Proof projection ID is bound to different lineage');
    }
    this.proofs.set(proof.id, {
      id: proof.id,
      runId,
      userId: proof.tenantId,
      hash: proof.proofHash,
      blueprintId: blueprint.id,
      payload: structuredClone(proof),
    });
  }

  async getProofProjection(id: string, userId: string): Promise<RouteProofV1 | null> {
    const stored = this.proofs.get(id);
    if (!stored || stored.userId !== userId) return null;
    const proof = parseRouteProof(stored.payload);
    this.assertEntityEnvelope(stored, proof.id, proof.tenantId, proof.proofHash);
    return proof;
  }

  async appendProofEvent(proofId: string, input: RouteProofEventV1): Promise<void> {
    const event = parseRouteProofEvent(input);
    const proof = this.proofs.get(proofId);
    if (!proof || proof.userId !== event.tenantId) {
      throw new RouteStorageIntegrityError('Route Proof event references an unknown proof');
    }
    const parsedProof = parseRouteProof(proof.payload);
    if (event.routeProofId !== proofId || proof.runId === '') {
      throw new RouteStorageIntegrityError('Route Proof event lineage does not match its proof');
    }
    assertLinkedHash(event.intentHash, parsedProof.intentHash, 'event.intentHash');
    assertLinkedHash(event.candidateHash, parsedProof.selectedCandidateHash, 'event.candidateHash');
    assertLinkedHash(event.blueprintHash, parsedProof.blueprintHash, 'event.blueprintHash');
    const duplicate = [...this.proofEvents.values()].find(
      (stored) =>
        stored.proofId === proofId &&
        (stored.sequence === event.eventIndex || stored.hash === event.eventHash),
    );
    if (this.proofEvents.has(event.id) || duplicate) {
      conflict('Append-only Route Proof event sequence or hash already exists');
    }
    this.proofEvents.set(event.id, {
      id: event.id,
      runId: proof.runId,
      userId: event.tenantId,
      hash: event.eventHash,
      proofId,
      sequence: event.eventIndex,
      payload: structuredClone(event),
    });
  }

  async listProofEvents(proofId: string, userId: string): Promise<RouteProofEventV1[]> {
    const proof = this.proofs.get(proofId);
    if (!proof || proof.userId !== userId) return [];
    return [...this.proofEvents.values()]
      .filter((stored) => stored.proofId === proofId && stored.userId === userId)
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
      .map((stored) => {
        const event = parseRouteProofEvent(stored.payload);
        this.assertEntityEnvelope(stored, event.id, event.tenantId, event.eventHash);
        if (event.eventIndex !== stored.sequence) {
          throw new RouteStorageIntegrityError('Stored proof event sequence differs from payload');
        }
        return event;
      });
  }

  async listRouteRunHistory(userId: string, params: RouteRunHistoryParamsV1): Promise<RouteRunHistoryPageV1> {
    const cursor = params.cursor ? decodeRouteHistoryCursorV1(params.cursor) : null;
    // The same goal filter as Postgres: only runs whose payload is a
    // RouteIntentV1 belong in this list.
    const runs = [...this.runs.values()]
      .filter((run) => run.userId === userId && (run.goal === 'swap' || run.goal === 'send'))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const afterCursor = cursor
      ? runs.filter(
          (run) =>
            run.createdAt < cursor.createdAt || (run.createdAt === cursor.createdAt && run.id < cursor.id),
        )
      : runs;
    const page = afterCursor.slice(0, params.limit + 1);
    const hasMore = page.length > params.limit;
    const pageRuns = page.slice(0, params.limit);

    const items: RouteRunHistoryItemV1[] = pageRuns.map((run) => {
      const runBlueprints = this.byRun(this.blueprints, run.id)
        .map((entry) => ({ entry, payload: entry.payload as { createdAt?: unknown; status?: unknown } }))
        .sort((left, right) => String(left.payload.createdAt ?? '').localeCompare(String(right.payload.createdAt ?? '')));
      const latestBlueprint = runBlueprints.at(-1)?.entry;
      const runProofs = [...this.proofs.values()]
        .filter((proof) => proof.runId === run.id)
        .map((proof) => ({
          proof,
          payload: proof.payload as { createdAt?: unknown; finalStatus?: unknown; reconciliationState?: unknown },
        }))
        .sort((left, right) => String(left.payload.createdAt ?? '').localeCompare(String(right.payload.createdAt ?? '')));
      const latestProof = runProofs.at(-1);
      const linkedBlueprint = latestProof
        ? runBlueprints.find((candidate) => candidate.entry.id === latestProof.proof.blueprintId)?.entry
        : undefined;
      const blueprintEntry = linkedBlueprint ?? latestBlueprint;
      const proofPayload = latestProof?.payload;
      const intent = parseRouteIntent(run.payload);

      return {
        routeRunId: run.id,
        createdAt: run.createdAt,
        runStatus: run.status,
        intentHash: run.intentHash,
        intentSummary: summarizeRouteIntentV1({
          goal: intent.goal,
          fromAsset: intent.fromAsset,
          toAsset: intent.toAsset,
          amount: intent.amount,
          intentHash: run.intentHash,
        }),
        blueprintId: blueprintEntry?.id ?? null,
        blueprintStatus: blueprintEntry ? parseExecutionBlueprint(blueprintEntry.payload).status : null,
        proofId: latestProof?.proof.id ?? null,
        proofFinalStatus: typeof proofPayload?.finalStatus === 'string' ? proofPayload.finalStatus : null,
        reconciliationState: typeof proofPayload?.reconciliationState === 'string' ? proofPayload.reconciliationState : null,
        provider: null,
      };
    });

    const last = pageRuns.at(-1);
    const nextCursor = hasMore && last ? encodeRouteHistoryCursorV1({ createdAt: last.createdAt, id: last.id }) : null;
    return { items, nextCursor };
  }

  async insertIntelligenceCharge(
    runId: string,
    input: IntelligenceChargeV1,
    links: IntelligenceChargeStorageLinks = {},
  ): Promise<void> {
    const charge = parseIntelligenceCharge(input);
    const run = this.ownedRun(runId, charge.tenantId);
    assertLinkedHash(charge.intentHash, run.intentHash, 'charge.intentHash');
    const evidenceId = links.evidenceId ?? null;
    if (evidenceId !== null) {
      const evidence = this.evidence.get(evidenceId);
      if (!evidence || evidence.runId !== runId || evidence.userId !== charge.tenantId) {
        throw new RouteStorageIntegrityError('Intelligence Charge evidence link is invalid');
      }
      const parsedEvidence = parseEvidenceRecord(evidence.payload);
      if (charge.evidenceHash !== parsedEvidence.evidenceHash) {
        throw new RouteStorageIntegrityError(
          'Intelligence Charge evidence hash does not match link',
        );
      }
    }
    const next: StoredCharge = {
      id: charge.id,
      runId,
      userId: charge.tenantId,
      hash: charge.chargeHash,
      evidenceId,
      spendPermissionId: charge.spendPermissionId,
      x402ReceiptId: links.x402ReceiptId ?? null,
      payload: structuredClone(charge),
    };
    const existing =
      this.charges.get(charge.id) ?? this.findByRunHash(this.charges, runId, charge.chargeHash);
    if (existing) {
      if (
        immutableDuplicate(
          existing,
          next,
          existing.evidenceId === next.evidenceId &&
            existing.spendPermissionId === next.spendPermissionId &&
            existing.x402ReceiptId === next.x402ReceiptId,
        )
      )
        return;
      conflict('Intelligence Charge ID or run-scoped hash already has different content');
    }
    this.charges.set(next.id, next);
  }

  async listIntelligenceCharges(
    runId: string,
    userId: string,
  ): Promise<StoredIntelligenceChargeV1[]> {
    if (!this.isOwnedRun(runId, userId)) return [];
    return this.byRun(this.charges, runId).map((stored) => {
      const charge = parseIntelligenceCharge(stored.payload);
      this.assertEntityEnvelope(stored, charge.id, charge.tenantId, charge.chargeHash);
      return {
        charge,
        evidenceId: stored.evidenceId,
        spendPermissionId: stored.spendPermissionId,
        x402ReceiptId: stored.x402ReceiptId,
      };
    });
  }

  async listRecentIntelligenceCharges(
    userId: string,
    limit: number,
  ): Promise<StoredIntelligenceChargeV1[]> {
    // Same cap and same ordering as the Postgres implementation. Three T67E-era
    // production bugs came from this pair disagreeing, so the bound is applied
    // here too rather than left to the caller.
    const capped = Math.max(1, Math.min(100, Math.trunc(limit)));
    const owned = [...this.charges.values()]
      .filter((stored) => stored.userId === userId)
      .map((stored) => {
        const charge = parseIntelligenceCharge(stored.payload);
        this.assertEntityEnvelope(stored, charge.id, charge.tenantId, charge.chargeHash);
        return {
          charge,
          evidenceId: stored.evidenceId,
          spendPermissionId: stored.spendPermissionId,
          x402ReceiptId: stored.x402ReceiptId,
        };
      });
    // The entity's own createdAt, not an insertion counter: the row this fake
    // stands in for is ordered by the column, and a fake ordered by arrival
    // would disagree with Postgres the moment two charges were backdated.
    owned.sort(
      (left, right) =>
        Date.parse(right.charge.createdAt) - Date.parse(left.charge.createdAt) ||
        right.charge.id.localeCompare(left.charge.id),
    );
    return owned.slice(0, capped);
  }

  async updateIntelligenceCharge(
    runId: string,
    chargeId: string,
    userId: string,
    input: IntelligenceChargeV1,
    links: IntelligenceChargeStorageLinks = {},
  ): Promise<void> {
    const updated = parseIntelligenceCharge(input);
    if (updated.id !== chargeId || updated.tenantId !== userId) {
      throw new RouteStorageIntegrityError(
        'updateIntelligenceCharge payload does not match the requested charge',
      );
    }
    const stored = this.charges.get(chargeId);
    if (!stored || stored.runId !== runId || stored.userId !== userId) {
      throw new RouteStorageIntegrityError(
        'Intelligence Charge does not exist for this Route Run and tenant',
      );
    }
    const current = parseIntelligenceCharge(stored.payload);
    if (current.idempotencyKey !== updated.idempotencyKey) {
      throw new RouteStorageIntegrityError(
        'updateIntelligenceCharge cannot change the idempotency key of an existing charge',
      );
    }
    const nextEvidenceId = links.evidenceId !== undefined ? links.evidenceId : stored.evidenceId;
    const nextX402ReceiptId =
      links.x402ReceiptId !== undefined ? links.x402ReceiptId : stored.x402ReceiptId;

    if (
      current.chargeHash === updated.chargeHash &&
      stored.evidenceId === nextEvidenceId &&
      stored.x402ReceiptId === nextX402ReceiptId &&
      payloadEquals(current, updated)
    ) {
      return;
    }

    if (nextEvidenceId !== null) {
      const evidence = this.evidence.get(nextEvidenceId);
      if (!evidence || evidence.runId !== runId || evidence.userId !== userId) {
        throw new RouteStorageIntegrityError('Intelligence Charge evidence link is invalid');
      }
      const parsedEvidence = parseEvidenceRecord(evidence.payload);
      if (updated.evidenceHash !== parsedEvidence.evidenceHash) {
        throw new RouteStorageIntegrityError(
          'Intelligence Charge evidence hash does not match link',
        );
      }
    }

    if (updated.chargeHash !== current.chargeHash) {
      const conflictingHash = this.findByRunHash(this.charges, runId, updated.chargeHash);
      if (conflictingHash && conflictingHash.id !== chargeId) {
        conflict('Intelligence Charge run-scoped hash is already assigned to another charge');
      }
    }

    stored.payload = structuredClone(updated);
    stored.hash = updated.chargeHash;
    stored.evidenceId = nextEvidenceId;
    stored.x402ReceiptId = nextX402ReceiptId;
  }

  async findIntelligenceChargeByReceiptHash(
    userId: string,
    x402ReceiptHash: string,
  ): Promise<StoredIntelligenceChargeV1 | null> {
    const owned = [...this.charges.values()]
      .filter((stored) => stored.userId === userId)
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const stored of owned) {
      const charge = parseIntelligenceCharge(stored.payload);
      if (charge.x402ReceiptHash !== x402ReceiptHash) continue;
      this.assertEntityEnvelope(stored, charge.id, charge.tenantId, charge.chargeHash);
      return {
        charge,
        evidenceId: stored.evidenceId,
        spendPermissionId: stored.spendPermissionId,
        x402ReceiptId: stored.x402ReceiptId,
      };
    }
    return null;
  }

  // --- T60: Intelligence Budget + reservation CTE-equivalents ---------------
  // Single-threaded JS gives these the same atomicity the DB CTEs need Neon
  // HTTP's lack of multi-statement transactions for: no `await` ever appears
  // between a guard check and its matching mutation below, so no other call
  // can interleave mid-decision.

  async insertIntelligenceBudget(input: InsertIntelligenceBudgetInput): Promise<IntelligenceBudgetRecord> {
    if (this.intelligenceBudgets.has(input.id)) {
      conflict('Intelligence Budget ID already exists');
    }
    if (
      input.status === 'active' &&
      [...this.intelligenceBudgets.values()].some(
        (budget) =>
          budget.status === 'active' &&
          (budget.spendPermissionId === input.spendPermissionId ||
            (budget.userId === input.userId &&
              budget.walletAddress.toLowerCase() === input.walletAddress.toLowerCase() &&
              budget.chainId === input.chainId)),
      )
    ) {
      conflict('Wallet or Spend Permission already has an active Intelligence Budget');
    }
    const record: IntelligenceBudgetRecord = {
      id: input.id,
      schemaVersion: input.schemaVersion,
      userId: input.userId,
      walletAddress: input.walletAddress,
      chainId: input.chainId,
      spendPermissionId: input.spendPermissionId,
      status: input.status,
      periodType: input.periodType,
      periodLimitAtomic: input.periodLimitAtomic,
      periodSpentAtomic: '0',
      reservedAtomic: '0',
      maxPerCallAtomic: input.maxPerCallAtomic,
      allowedCategories: [...input.allowedCategories],
      periodStartedAt: input.periodStartedAt,
      periodEndsAt: input.periodEndsAt,
      revokedAt: null,
      budgetHash: input.budgetHash,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.intelligenceBudgets.set(record.id, record);
    return cloneBudget(record);
  }

  async getActiveIntelligenceBudget(
    userId: string,
    walletAddress: string,
    chainId: number,
  ): Promise<IntelligenceBudgetRecord | null> {
    const found = [...this.intelligenceBudgets.values()].find(
      (budget) =>
        budget.userId === userId &&
        budget.walletAddress.toLowerCase() === walletAddress.toLowerCase() &&
        budget.chainId === chainId &&
        budget.status === 'active',
    );
    return found ? cloneBudget(found) : null;
  }

  async getLatestIntelligenceBudget(
    userId: string,
    walletAddress: string,
    chainId: number,
  ): Promise<IntelligenceBudgetRecord | null> {
    // Same ordering as Postgres. A fake that returned insertion order would
    // pass here and disagree with production the first time somebody revoked
    // and granted again.
    const found = [...this.intelligenceBudgets.values()]
      .filter(
        (budget) =>
          budget.userId === userId &&
          budget.walletAddress.toLowerCase() === walletAddress.toLowerCase() &&
          budget.chainId === chainId,
      )
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? right.id.localeCompare(left.id)
          : right.createdAt.localeCompare(left.createdAt),
      )[0];
    return found ? cloneBudget(found) : null;
  }

  async getIntelligenceBudgetById(id: string, userId: string): Promise<IntelligenceBudgetRecord | null> {
    const found = this.intelligenceBudgets.get(id);
    if (!found || found.userId !== userId) return null;
    return cloneBudget(found);
  }

  async updateIntelligenceBudget(
    id: string,
    userId: string,
    updated: UpdateIntelligenceBudgetInput,
  ): Promise<IntelligenceBudgetRecord> {
    const stored = this.intelligenceBudgets.get(id);
    if (!stored || stored.userId !== userId) {
      throw new RouteStorageIntegrityError('Intelligence Budget does not exist for this tenant');
    }
    if (updated.status !== undefined) stored.status = updated.status;
    if (updated.periodLimitAtomic !== undefined) stored.periodLimitAtomic = updated.periodLimitAtomic;
    if (updated.maxPerCallAtomic !== undefined) stored.maxPerCallAtomic = updated.maxPerCallAtomic;
    if (updated.allowedCategories !== undefined) stored.allowedCategories = [...updated.allowedCategories];
    if (updated.periodStartedAt !== undefined) stored.periodStartedAt = updated.periodStartedAt;
    if (updated.periodEndsAt !== undefined) stored.periodEndsAt = updated.periodEndsAt;
    if (updated.revokedAt !== undefined) stored.revokedAt = updated.revokedAt;
    stored.budgetHash = updated.budgetHash;
    stored.updatedAt = updated.now;
    return cloneBudget(stored);
  }

  async listIntelligenceBudgetReservations(
    budgetId: string,
    userId: string,
  ): Promise<IntelligenceBudgetReservationRecord[]> {
    const budget = this.intelligenceBudgets.get(budgetId);
    if (!budget || budget.userId !== userId) return [];
    return [...this.intelligenceBudgetReservations.values()]
      .filter((reservation) => reservation.budgetId === budgetId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(cloneReservation);
  }

  async reserveIntelligenceBudget(input: ReserveIntelligenceBudgetInput): Promise<ReserveIntelligenceBudgetOutcome> {
    const existingByKey = [...this.intelligenceBudgetReservations.values()].find(
      (reservation) => reservation.idempotencyKey === input.idempotencyKey,
    );
    if (existingByKey) {
      const owningBudget = this.intelligenceBudgets.get(existingByKey.budgetId);
      if (!owningBudget) {
        throw new RouteStorageIntegrityError('Reserved Intelligence Budget reservation has no owning budget');
      }
      return { outcome: 'idempotent_replay', reservation: cloneReservation(existingByKey), budget: cloneBudget(owningBudget) };
    }

    const budget = this.intelligenceBudgets.get(input.budgetId);
    if (!budget || budget.userId !== input.userId) {
      return { outcome: 'inactive', reservation: null, budget: null };
    }
    const nowMs = Date.parse(input.now);
    const periodEndsMs = budget.periodEndsAt === null ? null : Date.parse(budget.periodEndsAt);
    if (
      budget.status !== 'active' ||
      budget.revokedAt !== null ||
      (periodEndsMs !== null && periodEndsMs <= nowMs)
    ) {
      return { outcome: 'inactive', reservation: null, budget: cloneBudget(budget) };
    }
    const amount = BigInt(input.amountAtomic);
    if (amount > BigInt(budget.maxPerCallAtomic)) {
      return { outcome: 'insufficient', reservation: null, budget: cloneBudget(budget) };
    }
    const projectedTotal = BigInt(budget.periodSpentAtomic) + BigInt(budget.reservedAtomic) + amount;
    if (projectedTotal > BigInt(budget.periodLimitAtomic)) {
      return { outcome: 'insufficient', reservation: null, budget: cloneBudget(budget) };
    }

    budget.reservedAtomic = (BigInt(budget.reservedAtomic) + amount).toString();
    budget.updatedAt = input.now;
    const reservation: IntelligenceBudgetReservationRecord = {
      id: input.reservationId,
      schemaVersion: INTELLIGENCE_BUDGET_RESERVATION_SCHEMA_VERSION,
      budgetId: input.budgetId,
      userId: input.userId,
      amountAtomic: input.amountAtomic,
      status: 'reserved',
      idempotencyKey: input.idempotencyKey,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.intelligenceBudgetReservations.set(reservation.id, reservation);
    return { outcome: 'reserved', reservation: cloneReservation(reservation), budget: cloneBudget(budget) };
  }

  async settleIntelligenceReservation(
    reservationId: string,
    userId: string,
    now: string,
  ): Promise<SettleIntelligenceReservationResult> {
    const reservation = this.intelligenceBudgetReservations.get(reservationId);
    if (!reservation || reservation.userId !== userId) return { reservation: null, budget: null };
    const budget = this.intelligenceBudgets.get(reservation.budgetId) ?? null;
    if (reservation.status !== 'reserved') {
      // Idempotent no-op: already settled (or released/expired) — report the
      // current state without a second application.
      return { reservation: cloneReservation(reservation), budget: budget ? cloneBudget(budget) : null };
    }
    if (budget) {
      budget.reservedAtomic = (BigInt(budget.reservedAtomic) - BigInt(reservation.amountAtomic)).toString();
      budget.periodSpentAtomic = (BigInt(budget.periodSpentAtomic) + BigInt(reservation.amountAtomic)).toString();
      budget.updatedAt = now;
    }
    reservation.status = 'settled';
    reservation.updatedAt = now;
    return { reservation: cloneReservation(reservation), budget: budget ? cloneBudget(budget) : null };
  }

  async renewIntelligenceReservation(
    reservationId: string,
    userId: string,
    now: string,
    expiresAt: string,
  ): Promise<IntelligenceBudgetReservationRecord | null> {
    const reservation = this.intelligenceBudgetReservations.get(reservationId);
    if (
      !reservation ||
      reservation.userId !== userId ||
      reservation.status !== 'reserved' ||
      Date.parse(reservation.expiresAt) <= Date.parse(now)
    ) {
      return null;
    }
    reservation.expiresAt = expiresAt;
    reservation.updatedAt = now;
    return cloneReservation(reservation);
  }

  async releaseIntelligenceReservation(
    reservationId: string,
    userId: string,
    now: string,
    _reason: string,
  ): Promise<ReleaseIntelligenceReservationResult> {
    const reservation = this.intelligenceBudgetReservations.get(reservationId);
    if (!reservation || reservation.userId !== userId) return { reservation: null, budget: null };
    const budget = this.intelligenceBudgets.get(reservation.budgetId) ?? null;
    if (reservation.status !== 'reserved') {
      return { reservation: cloneReservation(reservation), budget: budget ? cloneBudget(budget) : null };
    }
    if (budget) {
      budget.reservedAtomic = (BigInt(budget.reservedAtomic) - BigInt(reservation.amountAtomic)).toString();
      budget.updatedAt = now;
    }
    reservation.status = 'released';
    reservation.updatedAt = now;
    return { reservation: cloneReservation(reservation), budget: budget ? cloneBudget(budget) : null };
  }

  async expireStaleIntelligenceReservations(
    budgetId: string,
    now: string,
  ): Promise<IntelligenceBudgetRecord | null> {
    const budget = this.intelligenceBudgets.get(budgetId);
    if (!budget) return null;
    const nowMs = Date.parse(now);
    let expiredTotal = 0n;
    for (const reservation of this.intelligenceBudgetReservations.values()) {
      if (reservation.budgetId !== budgetId || reservation.status !== 'reserved') continue;
      if (Date.parse(reservation.expiresAt) >= nowMs) continue;
      const hasInFlightOrSettledCharge = [...this.charges.values()].some((stored) => {
        if (stored.userId !== reservation.userId) return false;
        const charge = parseIntelligenceCharge(stored.payload);
        return (
          charge.reservationId === reservation.id &&
          ['payment_pending', 'reconciliation_required', 'settled'].includes(charge.status)
        );
      });
      if (hasInFlightOrSettledCharge) continue;
      expiredTotal += BigInt(reservation.amountAtomic);
      reservation.status = 'expired';
      reservation.updatedAt = now;
    }
    if (expiredTotal > 0n) {
      budget.reservedAtomic = (BigInt(budget.reservedAtomic) - expiredTotal).toString();
      budget.updatedAt = now;
    }
    return cloneBudget(budget);
  }

  /** Test-only fault injection used to prove that repository reads fail closed. */
  unsafeCorruptPayloadForTests(kind: RouteStorageEntityKind, id: string, payload: unknown): void {
    const stores: Record<RouteStorageEntityKind, Map<string, { payload: unknown }>> = {
      routeRun: this.runs,
      candidate: this.candidates,
      evidence: this.evidence,
      evidenceSet: this.evidenceSets,
      score: this.scores,
      routeCard: this.cards,
      blueprint: this.blueprints,
      proof: this.proofs,
      proofEvent: this.proofEvents,
      intelligenceCharge: this.charges,
    };
    const stored = stores[kind].get(id);
    if (!stored) throw new RouteStorageIntegrityError(`Cannot corrupt missing ${kind} fixture`);
    stored.payload = structuredClone(payload);
  }

  private routeRunRecord(stored: StoredRun): RouteRunRecord {
    const intent = parseRouteIntent(stored.payload);
    if (
      intent.id !== stored.id ||
      intent.tenantId !== stored.userId ||
      intent.walletAddress !== stored.walletAddress ||
      intent.chainId !== stored.chainId ||
      intent.schemaVersion !== stored.schemaVersion ||
      intent.intentHash !== stored.intentHash ||
      intent.createdAt !== stored.createdAt ||
      intent.updatedAt !== stored.updatedAt
    ) {
      throw new RouteStorageIntegrityError('Stored Route Run envelope differs from its intent');
    }
    return {
      id: stored.id,
      userId: stored.userId,
      walletAddress: stored.walletAddress,
      chainId: stored.chainId,
      goal: stored.goal,
      schemaVersion: intent.schemaVersion,
      status: stored.status,
      intentHash: stored.intentHash,
      idempotencyKey: stored.idempotencyKey,
      intent,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      completedAt: stored.completedAt,
    };
  }

  private ownedRun(runId: string, userId: string): StoredRun {
    const run = this.runs.get(runId);
    if (!run) throw new RouteStorageIntegrityError('Route Run does not exist');
    if (run.userId !== userId)
      throw new RouteStorageTenantError('Route Run belongs to another tenant');
    // T62: validate the envelope with the goal-appropriate record builder, so
    // the goal-agnostic Blueprint/Proof methods (upsertProofProjection,
    // appendProofEvent, listBlueprints, …) can own an earn run too — parsing an
    // earn payload as a swap RouteIntentV1 would otherwise throw.
    if (run.goal === 'earn') this.earnRouteRunRecord(run);
    else this.routeRunRecord(run);
    return run;
  }

  private isOwnedRun(runId: string, userId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.userId !== userId) return false;
    if (run.goal === 'earn') this.earnRouteRunRecord(run);
    else this.routeRunRecord(run);
    return true;
  }

  private ownedCandidate(id: string, runId: string, userId: string): RouteCandidateV1 {
    const stored = this.candidates.get(id);
    if (!stored || stored.runId !== runId) {
      throw new RouteStorageIntegrityError('Route Candidate does not belong to the Route Run');
    }
    if (stored.userId !== userId) {
      throw new RouteStorageTenantError('Route Candidate belongs to another tenant');
    }
    const candidate = parseRouteCandidate(stored.payload);
    this.assertEntityEnvelope(stored, candidate.id, candidate.tenantId, candidate.candidateHash);
    return candidate;
  }

  private assertEntityEnvelope(
    stored: StoredEntity,
    id: string,
    tenantId: string,
    hash: string,
  ): void {
    assertTenant(tenantId, stored.userId);
    if (stored.id !== id || stored.hash !== hash) {
      throw new RouteStorageIntegrityError('Stored relational envelope differs from its payload');
    }
  }

  private findByRunHash<T extends StoredEntity>(
    store: Map<string, T>,
    runId: string,
    hash: string,
  ): T | undefined {
    return [...store.values()].find((stored) => stored.runId === runId && stored.hash === hash);
  }

  private byRun<T extends StoredEntity>(store: Map<string, T>, runId: string): T[] {
    return [...store.values()]
      .filter((stored) => stored.runId === runId)
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}
