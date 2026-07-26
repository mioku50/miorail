import {
  hashNftPurchaseBlueprintV1,
  type NftEvidenceRecordV1,
  type NftListingCandidateV1,
  type NftProofEventV1,
  type NftPurchaseBlueprintV1,
  type NftPurchaseIntentV1,
  type NftRouteCardV1,
} from '@mioagent/route-domain';
import { RouteStorageConflictError, RouteStorageIntegrityError } from './types.js';
import {
  assertNftProofRewriteAllowedV1,
  assertNftTenantV1,
  nftUpdatedAtV1,
  parseNftBlueprintV1,
  parseNftCandidateV1,
  parseNftEvidenceV1,
  parseNftIntentV1,
  parseNftProofEventV1,
  parseNftProofV1,
  parseNftRouteCardV1,
  type NftHistoryItemV1,
  type NftProofRecordV1,
  type NftPurchaseBlueprintRecordV1,
  type NftRouteRunRecordV1,
  type NftStorageRepository,
  type RecordNftSubmissionInputV1,
  type ReserveNftBlueprintInputV1,
  type ReserveNftBlueprintResultV1,
  type UpsertNftProofInputV1,
} from './nft.js';

// ---------------------------------------------------------------------------
// In-memory NftStorageRepository.
//
// The tests' repository, and the one the invariants are easiest to read in. It
// enforces exactly what the database enforces — tenant isolation everywhere,
// one blueprint per Route Card, one proof per blueprint, an append-only event
// log, and no rewrite of a finalized answer.
// ---------------------------------------------------------------------------

interface MemoryNftRun {
  record: NftRouteRunRecordV1;
  candidates: Map<string, NftListingCandidateV1>;
  candidateOrders: Map<string, string>;
  evidence: Map<string, NftEvidenceRecordV1>;
  cards: Map<string, NftRouteCardV1>;
  /** Card id → card, so a blueprint naming a card id that was never stored is
   * refused here exactly as the foreign key refuses it in Postgres. */
  cardsById: Map<string, NftRouteCardV1>;
}

export function createMemoryNftStorageRepository(
  clock: () => Date = () => new Date(),
): NftStorageRepository {
  const runs = new Map<string, MemoryNftRun>();
  const runsByIdempotency = new Map<string, string>();
  const blueprints = new Map<string, NftPurchaseBlueprintRecordV1>();
  const blueprintsByCard = new Map<string, string>();
  const proofs = new Map<string, NftProofRecordV1>();
  const proofsByBlueprint = new Map<string, string>();
  const proofsByOrder = new Map<string, string>();
  const events = new Map<string, NftProofEventV1[]>();

  function requireRun(runId: string, userId: string): MemoryNftRun {
    const run = runs.get(runId);
    if (!run) throw new RouteStorageIntegrityError('NFT route run not found');
    assertNftTenantV1(run.record.userId, userId);
    return run;
  }

  function requireBlueprint(blueprintId: string, userId: string): NftPurchaseBlueprintRecordV1 {
    const record = blueprints.get(blueprintId);
    if (!record) throw new RouteStorageIntegrityError('NFT purchase blueprint not found');
    assertNftTenantV1(record.userId, userId);
    return record;
  }

  function requireProof(proofId: string, userId: string): NftProofRecordV1 {
    const record = proofs.get(proofId);
    if (!record) throw new RouteStorageIntegrityError('NFT proof not found');
    assertNftTenantV1(record.userId, userId);
    return record;
  }

  /** Re-stamps a blueprint through its own schema. The calls are carried over
   * untouched — this function has no way to replace them. */
  function rewriteBlueprint(
    record: NftPurchaseBlueprintRecordV1,
    changes: { status?: NftPurchaseBlueprintV1['status']; approvedCallsHash?: string | null },
  ): NftPurchaseBlueprintV1 {
    const next = {
      ...record.blueprint,
      status: changes.status ?? record.blueprint.status,
      approvedCallsHash:
        changes.approvedCallsHash === undefined ? record.blueprint.approvedCallsHash : changes.approvedCallsHash,
      updatedAt: nftUpdatedAtV1(record.blueprint.updatedAt, clock()),
    } as NftPurchaseBlueprintV1;
    // blueprintHash excludes status, updatedAt and approvedCallsHash, so it
    // must come out identical. If it does not, the calls moved.
    if (hashNftPurchaseBlueprintV1(next) !== record.blueprint.blueprintHash) {
      throw new RouteStorageIntegrityError('An NFT blueprint rewrite changed its financial content');
    }
    return parseNftBlueprintV1(next);
  }

  return {
    async createNftRouteRun(input: NftPurchaseIntentV1, idempotencyKey: string) {
      const intent = parseNftIntentV1(input);
      if (idempotencyKey.trim().length === 0) {
        throw new RouteStorageIntegrityError('NFT route run idempotency key must not be empty');
      }
      const scoped = `${intent.tenantId}|${idempotencyKey}`;
      const existingId = runsByIdempotency.get(scoped);
      if (existingId) {
        const existing = runs.get(existingId)!;
        if (existing.record.intentHash !== intent.intentHash) {
          throw new RouteStorageConflictError('NFT idempotency key has different content');
        }
        return existing.record;
      }
      const existingById = runs.get(intent.id);
      if (existingById) {
        assertNftTenantV1(existingById.record.userId, intent.tenantId);
        return existingById.record;
      }
      const record: NftRouteRunRecordV1 = {
        id: intent.id,
        userId: intent.tenantId,
        walletAddress: intent.walletAddress,
        chainId: intent.chainId,
        goal: 'nft',
        status: intent.status,
        intentHash: intent.intentHash,
        idempotencyKey,
        intent,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
      };
      runs.set(record.id, {
        record,
        candidates: new Map(),
        candidateOrders: new Map(),
        evidence: new Map(),
        cards: new Map(),
        cardsById: new Map(),
      });
      runsByIdempotency.set(scoped, record.id);
      return record;
    },

    async getNftRouteRun(id: string, userId: string) {
      const run = runs.get(id);
      if (!run || run.record.userId !== userId) return null;
      return run.record;
    },

    async insertNftCandidate(runId: string, input: NftListingCandidateV1) {
      const candidate = parseNftCandidateV1(input);
      const run = requireRun(runId, candidate.tenantId);
      if (candidate.intentHash !== run.record.intentHash) {
        throw new RouteStorageIntegrityError('NFT candidate intentHash does not match its run');
      }
      const claimed = run.candidateOrders.get(candidate.order.orderHash);
      if (claimed !== undefined && claimed !== candidate.candidateHash) {
        throw new RouteStorageConflictError('This listing already has a different candidate in this run');
      }
      if (run.candidates.has(candidate.candidateHash)) return;
      run.candidates.set(candidate.candidateHash, candidate);
      run.candidateOrders.set(candidate.order.orderHash, candidate.candidateHash);
    },

    async listNftCandidates(runId: string, userId: string) {
      const run = requireRun(runId, userId);
      return [...run.candidates.values()];
    },

    async getNftCandidate(runId: string, candidateHash: string, userId: string) {
      const run = requireRun(runId, userId);
      return run.candidates.get(candidateHash) ?? null;
    },

    async insertNftEvidence(runId: string, input: NftEvidenceRecordV1) {
      const evidence = parseNftEvidenceV1(input);
      const run = requireRun(runId, evidence.tenantId);
      if (evidence.candidateHash !== null && !run.candidates.has(evidence.candidateHash)) {
        throw new RouteStorageIntegrityError('NFT evidence references an unknown candidate');
      }
      if (run.evidence.has(evidence.evidenceHash)) return;
      run.evidence.set(evidence.evidenceHash, evidence);
    },

    async listNftEvidence(runId: string, userId: string) {
      const run = requireRun(runId, userId);
      return [...run.evidence.values()];
    },

    async insertNftRouteCard(runId: string, input: NftRouteCardV1) {
      const card = parseNftRouteCardV1(input);
      const run = requireRun(runId, card.tenantId);
      if (card.intentHash !== run.record.intentHash) {
        throw new RouteStorageIntegrityError('NFT route card intentHash does not match its run');
      }
      if (run.cards.has(card.routeCardHash)) return;
      run.cards.set(card.routeCardHash, card);
      run.cardsById.set(card.id, card);
    },

    async listNftRouteCards(runId: string, userId: string) {
      const run = requireRun(runId, userId);
      return [...run.cards.values()];
    },

    async getNftRouteCard(runId: string, routeCardHash: string, userId: string) {
      const run = requireRun(runId, userId);
      return run.cards.get(routeCardHash) ?? null;
    },

    async reserveNftPurchaseBlueprint(
      input: ReserveNftBlueprintInputV1,
    ): Promise<ReserveNftBlueprintResultV1> {
      const blueprint = parseNftBlueprintV1(input.blueprint);
      const run = requireRun(input.routeRunId, input.userId);
      assertNftTenantV1(blueprint.tenantId, input.userId);
      if (blueprint.intentHash !== run.record.intentHash) {
        throw new RouteStorageIntegrityError('NFT blueprint intentHash does not match its run');
      }
      const card = run.cardsById.get(input.routeCardId);
      if (!card) throw new RouteStorageIntegrityError('NFT blueprint references an unstored Route Card');
      if (card.routeCardHash !== blueprint.routeCardHash) {
        throw new RouteStorageIntegrityError('NFT blueprint routeCardHash does not match its Route Card');
      }

      const existingId = blueprintsByCard.get(input.routeCardId);
      if (existingId) {
        // A second prepare returns the first. It does NOT mint another wallet
        // prompt for the same token.
        return { outcome: 'existing', record: blueprints.get(existingId)! };
      }
      const record: NftPurchaseBlueprintRecordV1 = {
        id: blueprint.id,
        routeRunId: input.routeRunId,
        routeCardId: input.routeCardId,
        userId: input.userId,
        walletAddress: blueprint.walletAddress,
        blueprint,
        submissionBatchId: null,
        submittedTransactionHash: null,
        submittedAt: null,
        createdAt: blueprint.createdAt,
        updatedAt: blueprint.updatedAt,
      };
      blueprints.set(record.id, record);
      blueprintsByCard.set(input.routeCardId, record.id);
      return { outcome: 'created', record };
    },

    async getNftPurchaseBlueprint(blueprintId: string, userId: string) {
      const record = blueprints.get(blueprintId);
      if (!record || record.userId !== userId) return null;
      return record;
    },

    async updateNftBlueprintStatus(input) {
      const record = requireBlueprint(input.blueprintId, input.userId);
      const next: NftPurchaseBlueprintRecordV1 = {
        ...record,
        blueprint: rewriteBlueprint(record, { status: input.status }),
        updatedAt: nftUpdatedAtV1(record.updatedAt, clock()),
      };
      blueprints.set(next.id, next);
      return next;
    },

    async approveNftPurchaseBlueprint(input) {
      const record = requireBlueprint(input.blueprintId, input.userId);
      if (input.approvedCallsHash !== record.blueprint.callsHash) {
        // The client approved something other than what is stored here.
        throw new RouteStorageConflictError('The approved calls hash does not match this NFT blueprint');
      }
      if (record.blueprint.approvedCallsHash !== null) return record;
      const next: NftPurchaseBlueprintRecordV1 = {
        ...record,
        blueprint: rewriteBlueprint(record, {
          status: 'approved',
          approvedCallsHash: input.approvedCallsHash,
        }),
        updatedAt: nftUpdatedAtV1(record.updatedAt, clock()),
      };
      blueprints.set(next.id, next);
      return next;
    },

    async recordNftSubmission(input: RecordNftSubmissionInputV1) {
      const record = requireBlueprint(input.blueprintId, input.userId);
      if (record.blueprint.approvedCallsHash === null) {
        throw new RouteStorageConflictError('An NFT submission requires an approved blueprint');
      }
      if (record.submittedAt !== null) {
        const sameBatch = record.submissionBatchId === input.submissionBatchId;
        const sameTx = record.submittedTransactionHash === input.transactionHash;
        if (sameBatch && sameTx) return record;
        if (record.submittedTransactionHash !== null && input.transactionHash !== null && !sameTx) {
          throw new RouteStorageConflictError('This NFT blueprint already recorded a different transaction');
        }
        // The batch is known and the hash arrived later. That is the same
        // submission learning its own transaction, not a second one.
        if (record.submittedTransactionHash === null && input.transactionHash !== null && sameBatch) {
          const learned: NftPurchaseBlueprintRecordV1 = {
            ...record,
            submittedTransactionHash: input.transactionHash,
            updatedAt: nftUpdatedAtV1(record.updatedAt, clock()),
          };
          blueprints.set(learned.id, learned);
          return learned;
        }
        return record;
      }
      const next: NftPurchaseBlueprintRecordV1 = {
        ...record,
        blueprint: rewriteBlueprint(record, { status: 'submitted' }),
        submissionBatchId: input.submissionBatchId,
        submittedTransactionHash: input.transactionHash,
        submittedAt: input.submittedAt,
        updatedAt: nftUpdatedAtV1(record.updatedAt, clock()),
      };
      blueprints.set(next.id, next);
      return next;
    },

    async upsertNftProof(input: UpsertNftProofInputV1) {
      const proof = parseNftProofV1(input.proof);
      assertNftTenantV1(proof.tenantId, input.userId);
      const blueprint = requireBlueprint(input.blueprintId, input.userId);
      if (proof.blueprintHash !== blueprint.blueprint.blueprintHash) {
        throw new RouteStorageIntegrityError('NFT proof does not belong to this blueprint');
      }
      const claimedByOrder = proofsByOrder.get(`${input.userId}|${proof.orderHash}`);
      if (claimedByOrder !== undefined && claimedByOrder !== proof.id) {
        throw new RouteStorageConflictError('This order already has a different NFT proof');
      }
      const existing = proofs.get(proof.id);
      if (existing) {
        assertNftTenantV1(existing.userId, input.userId);
        assertNftProofRewriteAllowedV1(existing.proof, proof);
        const next: NftProofRecordV1 = {
          ...existing,
          proof,
          updatedAt: nftUpdatedAtV1(existing.updatedAt, clock()),
        };
        proofs.set(next.id, next);
        return next;
      }
      const claimedByBlueprint = proofsByBlueprint.get(input.blueprintId);
      if (claimedByBlueprint !== undefined && claimedByBlueprint !== proof.id) {
        throw new RouteStorageConflictError('This blueprint already has a different NFT proof');
      }
      const record: NftProofRecordV1 = {
        id: proof.id,
        routeRunId: input.routeRunId,
        blueprintId: input.blueprintId,
        userId: input.userId,
        walletAddress: proof.walletAddress,
        proof,
        createdAt: proof.createdAt,
        updatedAt: proof.updatedAt,
      };
      proofs.set(record.id, record);
      proofsByBlueprint.set(input.blueprintId, record.id);
      proofsByOrder.set(`${input.userId}|${proof.orderHash}`, record.id);
      return record;
    },

    async getNftProof(proofId: string, userId: string) {
      const record = proofs.get(proofId);
      if (!record || record.userId !== userId) return null;
      return record;
    },

    async getNftProofByBlueprint(blueprintId: string, userId: string) {
      const id = proofsByBlueprint.get(blueprintId);
      if (!id) return null;
      const record = proofs.get(id);
      if (!record || record.userId !== userId) return null;
      return record;
    },

    async listOpenNftProofs(limit: number) {
      return [...proofs.values()]
        .filter((record) => record.proof.status === 'open')
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .slice(0, Math.max(0, limit));
    },

    async appendNftProofEvent(proofId: string, userId: string, input: NftProofEventV1) {
      const event = parseNftProofEventV1(input);
      const record = requireProof(proofId, userId);
      assertNftTenantV1(event.tenantId, userId);
      if (event.proofHash !== record.proof.proofHash) {
        throw new RouteStorageIntegrityError('NFT proof event does not describe this proof');
      }
      const log = events.get(proofId) ?? [];
      const claimed = log.find((entry) => entry.sequence === event.sequence);
      if (claimed) {
        // Append-only: a sequence number is claimed once. Repeating it with
        // the same content is a retry; with different content it is a rewrite.
        if (claimed.eventHash !== event.eventHash) {
          throw new RouteStorageConflictError('An NFT proof event sequence cannot be rewritten');
        }
        return;
      }
      log.push(event);
      events.set(proofId, log);
    },

    async listNftProofEvents(proofId: string, userId: string) {
      requireProof(proofId, userId);
      return [...(events.get(proofId) ?? [])].sort((left, right) => left.sequence - right.sequence);
    },

    async listNftHistory(userId: string, limit: number) {
      const items: NftHistoryItemV1[] = [];
      for (const record of blueprints.values()) {
        if (record.userId !== userId) continue;
        const proofId = proofsByBlueprint.get(record.id) ?? null;
        const proof = proofId ? proofs.get(proofId) ?? null : null;
        items.push({
          proofId,
          blueprintId: record.id,
          routeRunId: record.routeRunId,
          contractAddress: record.blueprint.asset.contractAddress,
          tokenId: record.blueprint.asset.tokenId,
          orderHash: record.blueprint.orderHash,
          listingPriceWei: record.blueprint.listingPriceWei,
          blueprintStatus: record.blueprint.status,
          finalStatus: proof?.proof.finalStatus ?? null,
          // The hash the server observed, not the one the client reported.
          transactionHash: proof?.proof.receipt.transactionHash ?? record.submittedTransactionHash,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      }
      return items
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.blueprintId.localeCompare(left.blueprintId))
        .slice(0, Math.max(0, limit));
    },
  };
}
