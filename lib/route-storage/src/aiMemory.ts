import { RouteStorageConflictError, RouteStorageIntegrityError } from './types.js';
import {
  aiProofWriteEffectV1,
  assertAiProofMatchesCardV1,
  parseStoredAiCardV1,
  parseStoredAiIntentV1,
  parseStoredAiProofV1,
  type AiInferenceProofRecordV1,
  type AiRouteCardRecordV1,
  type AiRouteRunRecordV1,
  type AiRouteStorageRepositoryV1,
  type InsertAiProofInputV1,
  type InsertAiRouteCardInputV1,
} from './ai.js';

// ---------------------------------------------------------------------------
// In-memory AiRouteStorageRepositoryV1.
//
// It enforces exactly what migration 0020 enforces, and it is written that way
// deliberately: in T65 the in-memory fakes were repeatedly WEAKER than
// Postgres, and every divergence shipped a production bug that the full suite
// passed straight through.
//
// So the primary keys are global here, not per-run. The unique indexes are
// modelled. The foreign key from a proof to a card is modelled. If Postgres
// would refuse a write, this refuses it too, with the same error.
// ---------------------------------------------------------------------------

export function createMemoryAiRouteStorageRepository(
  clock: () => Date = () => new Date(),
): AiRouteStorageRepositoryV1 {
  const cards = new Map<string, AiRouteCardRecordV1>();
  /** route_run_id → card id. The `ai_route_cards_run_unique` index. */
  const cardsByRun = new Map<string, string>();
  const proofs = new Map<string, AiInferenceProofRecordV1>();
  /** route_card_id → proof id. The `ai_inference_proofs_card_unique` index. */
  const proofsByCard = new Map<string, string>();

  function nowIso(): string {
    return clock().toISOString();
  }

  const runs = new Map<string, AiRouteRunRecordV1>();
  const runsByIdempotency = new Map<string, string>();

  return {
    async createAiRouteRun(intent, idempotencyKey): Promise<AiRouteRunRecordV1> {
      if (idempotencyKey.trim().length === 0) {
        throw new RouteStorageIntegrityError('AI route run idempotency key must not be empty');
      }
      const parsed = parseStoredAiIntentV1(intent, intent.id);
      const existingId = runsByIdempotency.get(idempotencyKey) ?? (runs.has(parsed.id) ? parsed.id : undefined);
      if (existingId !== undefined) {
        const existing = runs.get(existingId);
        if (!existing || existing.userId !== parsed.tenantId) {
          throw new RouteStorageConflictError('AI route run ID is already owned by another tenant');
        }
        if (existing.intentHash !== parsed.intentHash) {
          throw new RouteStorageConflictError('AI idempotency key has different content');
        }
        return existing;
      }
      const record: AiRouteRunRecordV1 = {
        id: parsed.id,
        userId: parsed.tenantId,
        walletAddress: parsed.walletAddress,
        chainId: parsed.chainId,
        goal: 'private_ai',
        status: parsed.status,
        intentHash: parsed.intentHash,
        idempotencyKey,
        intent: parsed,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      };
      runs.set(record.id, record);
      runsByIdempotency.set(idempotencyKey, record.id);
      return record;
    },

    async getAiRouteRun(id, userId): Promise<AiRouteRunRecordV1 | null> {
      const record = runs.get(id);
      if (!record || record.userId !== userId) return null;
      return record;
    },

    async insertAiRouteCard(input: InsertAiRouteCardInputV1): Promise<void> {
      // The foreign key to route_runs.
      const run = runs.get(input.routeRunId);
      if (!run || run.userId !== input.userId) {
        throw new RouteStorageConflictError('This card names an AI route run that does not exist');
      }
      // PRIMARY KEY over the whole table, not scoped to the run. A per-run map
      // here is precisely the gap that let two runs collide in Postgres while
      // every test passed.
      if (cards.has(input.id)) {
        throw new RouteStorageConflictError('This AI route card id already exists');
      }
      if (cardsByRun.has(input.routeRunId)) {
        throw new RouteStorageConflictError('This run already has an AI route card');
      }
      // The card and intent must agree, or a later execution would run a model
      // chosen for a different request.
      if (input.card.intentHash !== input.intent.intentHash) {
        throw new RouteStorageConflictError('This card was built for a different intent');
      }
      // `ai_route_cards_ready_check`.
      if (input.card.status === 'ready' && input.card.selected === null) {
        throw new RouteStorageConflictError('A ready AI route card must name a model');
      }
      const createdAt = nowIso();
      const record: AiRouteCardRecordV1 = {
        id: input.id,
        routeRunId: input.routeRunId,
        userId: input.userId,
        walletAddress: input.walletAddress.toLowerCase(),
        // Re-parsed on the way in as well as the way out: a payload that
        // cannot be validated must never become a stored row.
        intent: parseStoredAiIntentV1(input.intent, input.id),
        card: parseStoredAiCardV1(input.card, input.id),
        createdAt,
        updatedAt: createdAt,
      };
      cards.set(record.id, record);
      cardsByRun.set(record.routeRunId, record.id);
    },

    async getAiRouteCard(routeRunId: string, userId: string): Promise<AiRouteCardRecordV1 | null> {
      const id = cardsByRun.get(routeRunId);
      if (id === undefined) return null;
      const record = cards.get(id);
      // Tenant isolation is a filter, never a post-hoc check the caller might
      // forget: another user's run reads as absent.
      if (!record || record.userId !== userId) return null;
      return record;
    },

    async insertAiProof(input: InsertAiProofInputV1): Promise<AiInferenceProofRecordV1> {
      const card = cards.get(input.routeCardId);
      // The foreign key. A proof naming a card that was never stored is
      // refused here exactly as Postgres refuses it.
      if (!card || card.userId !== input.userId) {
        throw new RouteStorageConflictError('This proof names an AI route card that does not exist');
      }
      assertAiProofMatchesCardV1(card, input.proof);

      const existingId = proofsByCard.get(input.routeCardId);
      const existing = existingId === undefined ? null : (proofs.get(existingId) ?? null);
      const effect = aiProofWriteEffectV1({ existing, next: input.proof });
      if (effect.kind === 'unchanged') return effect.record;

      if (proofs.has(input.id)) {
        throw new RouteStorageConflictError('This AI proof id already exists');
      }
      const createdAt = nowIso();
      const record: AiInferenceProofRecordV1 = {
        id: input.id,
        routeRunId: input.routeRunId,
        routeCardId: input.routeCardId,
        userId: input.userId,
        walletAddress: input.walletAddress.toLowerCase(),
        proof: parseStoredAiProofV1(input.proof, input.id),
        createdAt,
        updatedAt: createdAt,
      };
      proofs.set(record.id, record);
      proofsByCard.set(record.routeCardId, record.id);
      return record;
    },

    async getAiProofByCard(routeCardId: string, userId: string): Promise<AiInferenceProofRecordV1 | null> {
      const id = proofsByCard.get(routeCardId);
      if (id === undefined) return null;
      const record = proofs.get(id);
      if (!record || record.userId !== userId) return null;
      return record;
    },

    async listAiProofs(userId: string, limit: number): Promise<AiInferenceProofRecordV1[]> {
      return [...proofs.values()]
        .filter((record) => record.userId === userId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, Math.max(0, limit));
    },
  };
}
