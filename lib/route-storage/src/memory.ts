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
import {
  RouteStorageConflictError,
  RouteStorageIntegrityError,
  RouteStorageTenantError,
  type BlueprintStorageLinks,
  type IntelligenceChargeStorageLinks,
  type RouteRunRecord,
  type RouteStorageEntityKind,
  type RouteStorageRepository,
  type StoredBlueprintV1,
  type StoredIntelligenceChargeV1,
} from './types.js';
import {
  assertLinkedHash,
  assertTenant,
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

  async createRouteRun(input: RouteIntentV1, idempotencyKey: string): Promise<RouteRunRecord> {
    const intent = parseRouteIntent(input);
    if (idempotencyKey.trim().length === 0) {
      throw new RouteStorageIntegrityError('Route run idempotency key must not be empty');
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
    if (!stored || stored.userId !== userId) return null;
    return this.routeRunRecord(stored);
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
    this.routeRunRecord(run);
    return run;
  }

  private isOwnedRun(runId: string, userId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.userId !== userId) return false;
    this.routeRunRecord(run);
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
