import {
  RouteStorageConflictError,
  RouteStorageIntegrityError,
  type SqlTemplateExecutor,
} from './types.js';
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
// Postgres-backed AiRouteStorageRepositoryV1.
//
// The uniqueness guarantees are the DATABASE's, not this file's:
// `ai_route_cards_run_unique` means a second comparison for one run loses the
// race rather than overwriting a card the user is reading, and
// `ai_inference_proofs_card_unique` means a double-submitted execution is a
// conflict rather than a second recorded answer to one charge.
//
// No column, parameter or query in this file carries a prompt, a completion,
// or a commitment nonce. There is nowhere for them to go.
// ---------------------------------------------------------------------------

function jsonb(value: unknown): string {
  return JSON.stringify(value);
}

function timestamp(value: string): string {
  return new Date(value).toISOString();
}

function rowToCardV1(row: Record<string, unknown>): AiRouteCardRecordV1 {
  const id = String(row.id);
  return {
    id,
    routeRunId: String(row.route_run_id),
    userId: String(row.user_id),
    walletAddress: String(row.wallet_address),
    intent: parseStoredAiIntentV1(row.intent_payload, id),
    card: parseStoredAiCardV1(row.payload, id),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function rowToRunV1(row: Record<string, unknown>): AiRouteRunRecordV1 {
  const id = String(row.id);
  return {
    id,
    userId: String(row.user_id),
    walletAddress: String(row.wallet_address),
    chainId: Number(row.chain_id),
    goal: 'private_ai',
    status: String(row.status),
    intentHash: String(row.intent_hash),
    idempotencyKey: String(row.idempotency_key),
    intent: parseStoredAiIntentV1(row.intent_payload, id),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function rowToProofV1(row: Record<string, unknown>): AiInferenceProofRecordV1 {
  const id = String(row.id);
  return {
    id,
    routeRunId: String(row.route_run_id),
    routeCardId: String(row.route_card_id),
    userId: String(row.user_id),
    walletAddress: String(row.wallet_address),
    proof: parseStoredAiProofV1(row.payload, id),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function createDatabaseAiRouteStorageRepository(
  sql: SqlTemplateExecutor,
): AiRouteStorageRepositoryV1 {
  return {
    async createAiRouteRun(intent, idempotencyKey): Promise<AiRouteRunRecordV1> {
      const parsed = parseStoredAiIntentV1(intent, intent.id);
      if (idempotencyKey.trim().length === 0) {
        throw new RouteStorageIntegrityError('AI route run idempotency key must not be empty');
      }
      const inserted = await sql`
        INSERT INTO route_runs (
          id, user_id, wallet_address, chain_id, goal, schema_version, status,
          intent_hash, intent_payload, idempotency_key, created_at, updated_at
        ) VALUES (
          ${parsed.id}, ${parsed.tenantId}, ${parsed.walletAddress}, ${parsed.chainId},
          'private_ai', ${parsed.schemaVersion}, ${parsed.status}, ${parsed.intentHash},
          ${jsonb(parsed)}::jsonb, ${idempotencyKey},
          ${timestamp(parsed.createdAt)}, ${timestamp(parsed.updatedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id, user_id, wallet_address, chain_id, status, intent_hash, intent_payload,
                  idempotency_key, created_at, updated_at
      `;
      if (inserted[0]) return rowToRunV1(inserted[0] as Record<string, unknown>);
      const existing = await sql`
        SELECT id, user_id, wallet_address, chain_id, status, intent_hash, intent_payload,
               idempotency_key, created_at, updated_at
        FROM route_runs
        WHERE user_id = ${parsed.tenantId} AND goal = 'private_ai'
          AND (id = ${parsed.id} OR idempotency_key = ${idempotencyKey})
        ORDER BY id
        LIMIT 1
      `;
      if (!existing[0]) {
        throw new RouteStorageConflictError('AI route run ID is already owned by another tenant');
      }
      const record = rowToRunV1(existing[0] as Record<string, unknown>);
      if (record.intentHash !== parsed.intentHash) {
        throw new RouteStorageConflictError('AI idempotency key has different content');
      }
      return record;
    },

    async getAiRouteRun(id, userId): Promise<AiRouteRunRecordV1 | null> {
      const rows = await sql`
        SELECT id, user_id, wallet_address, chain_id, status, intent_hash, intent_payload,
               idempotency_key, created_at, updated_at
        FROM route_runs
        WHERE id = ${id} AND user_id = ${userId} AND goal = 'private_ai'
        LIMIT 1
      `;
      const row = rows[0];
      return row ? rowToRunV1(row as Record<string, unknown>) : null;
    },

    async insertAiRouteCard(input: InsertAiRouteCardInputV1): Promise<void> {
      if (input.card.intentHash !== input.intent.intentHash) {
        throw new RouteStorageConflictError('This card was built for a different intent');
      }
      if (input.card.status === 'ready' && input.card.selected === null) {
        throw new RouteStorageConflictError('A ready AI route card must name a model');
      }
      const selected = input.card.selected;
      const rows = await sql`
        INSERT INTO ai_route_cards (
          id, route_run_id, user_id, wallet_address, schema_version, status,
          route_card_hash, intent_hash, prompt_commitment, task_kind,
          selected_model_id, selected_candidate_hash, privacy_mode,
          estimated_cost_usd, max_spend_usd, x402_metered,
          intent_payload, payload, expires_at
        ) VALUES (
          ${input.id}, ${input.routeRunId}, ${input.userId}, ${input.walletAddress.toLowerCase()},
          ${input.card.schemaVersion}, ${input.card.status},
          ${input.card.routeCardHash}, ${input.card.intentHash},
          ${input.intent.prompt.commitment}, ${input.card.taskKind},
          ${selected?.modelId ?? null}, ${selected?.candidateHash ?? null},
          ${selected?.privacyMode ?? null},
          ${input.card.estimatedCostUsd}, ${input.card.maxSpendUsd}, ${input.card.x402Metered},
          ${jsonb(input.intent)}::jsonb, ${jsonb(input.card)}::jsonb,
          ${timestamp(input.card.expiresAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      // `ON CONFLICT DO NOTHING` converts a violated constraint into a silent
      // no-op, which is exactly how a T65 bug reached production. The insert
      // is therefore checked: no row back means a card already exists for this
      // run, and that is a conflict the caller must see.
      if (!rows[0]) {
        throw new RouteStorageConflictError('This run already has an AI route card');
      }
    },

    async getAiRouteCard(routeRunId: string, userId: string): Promise<AiRouteCardRecordV1 | null> {
      const rows = await sql`
        SELECT * FROM ai_route_cards
        WHERE route_run_id = ${routeRunId} AND user_id = ${userId}
        LIMIT 1
      `;
      const row = rows[0];
      return row ? rowToCardV1(row as Record<string, unknown>) : null;
    },

    async insertAiProof(input: InsertAiProofInputV1): Promise<AiInferenceProofRecordV1> {
      const cardRows = await sql`
        SELECT * FROM ai_route_cards
        WHERE id = ${input.routeCardId} AND user_id = ${input.userId}
        LIMIT 1
      `;
      const cardRow = cardRows[0];
      if (!cardRow) {
        throw new RouteStorageConflictError('This proof names an AI route card that does not exist');
      }
      const card = rowToCardV1(cardRow as Record<string, unknown>);
      assertAiProofMatchesCardV1(card, input.proof);

      const existingRows = await sql`
        SELECT * FROM ai_inference_proofs
        WHERE route_card_id = ${input.routeCardId} AND user_id = ${input.userId}
        LIMIT 1
      `;
      const existingRow = existingRows[0];
      const existing = existingRow ? rowToProofV1(existingRow as Record<string, unknown>) : null;
      const effect = aiProofWriteEffectV1({ existing, next: input.proof });
      if (effect.kind === 'unchanged') return effect.record;

      const proof = input.proof;
      const rows = await sql`
        INSERT INTO ai_inference_proofs (
          id, route_run_id, route_card_id, user_id, wallet_address, schema_version, status,
          proof_hash, intent_hash, route_card_hash, prompt_commitment,
          model_id, privacy_mode, response_hash, response_chars,
          finish_reason, schema_validation, prompt_tokens, completion_tokens,
          actual_cost_usd, estimated_cost_usd, latency_ms, x402_metered,
          final_status, payload, observed_at, finalized_at
        ) VALUES (
          ${input.id}, ${input.routeRunId}, ${input.routeCardId}, ${input.userId},
          ${input.walletAddress.toLowerCase()}, ${proof.schemaVersion}, ${proof.status},
          ${proof.proofHash}, ${proof.intentHash}, ${proof.routeCardHash}, ${proof.promptCommitment},
          ${proof.modelId}, ${proof.privacyMode}, ${proof.responseHash}, ${proof.responseChars},
          ${proof.finishReason}, ${proof.schemaValidation},
          ${proof.usage.promptTokens}, ${proof.usage.completionTokens},
          ${proof.usage.actualCostUsd}, ${proof.estimatedCostUsd}, ${proof.usage.latencyMs},
          ${proof.x402Metered}, ${proof.finalStatus},
          ${jsonb(proof)}::jsonb, ${timestamp(proof.observedAt)},
          ${proof.finalizedAt === null ? null : timestamp(proof.finalizedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `;
      const row = rows[0];
      if (!row) {
        // Lost the race against a concurrent execution. The winner's answer is
        // the recorded one — returning it is what makes a double click
        // idempotent instead of a second charge.
        const settledRows = await sql`
          SELECT * FROM ai_inference_proofs
          WHERE route_card_id = ${input.routeCardId} AND user_id = ${input.userId}
          LIMIT 1
        `;
        const settled = settledRows[0];
        if (!settled) throw new RouteStorageConflictError('This AI proof could not be recorded');
        const record = rowToProofV1(settled as Record<string, unknown>);
        if (record.proof.proofHash !== proof.proofHash) {
          throw new RouteStorageConflictError('This request already has a recorded answer');
        }
        return record;
      }
      return rowToProofV1(row as Record<string, unknown>);
    },

    async getAiProofByCard(routeCardId: string, userId: string): Promise<AiInferenceProofRecordV1 | null> {
      const rows = await sql`
        SELECT * FROM ai_inference_proofs
        WHERE route_card_id = ${routeCardId} AND user_id = ${userId}
        LIMIT 1
      `;
      const row = rows[0];
      return row ? rowToProofV1(row as Record<string, unknown>) : null;
    },

    async listAiProofs(userId: string, limit: number): Promise<AiInferenceProofRecordV1[]> {
      const rows = await sql`
        SELECT * FROM ai_inference_proofs
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${Math.max(0, limit)}
      `;
      return rows.map((row) => rowToProofV1(row as Record<string, unknown>));
    },
  };
}
