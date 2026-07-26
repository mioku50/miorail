import {
  hashNftPurchaseBlueprintV1,
  type NftEvidenceRecordV1,
  type NftListingCandidateV1,
  type NftProofEventV1,
  type NftPurchaseBlueprintV1,
  type NftPurchaseIntentV1,
  type NftPurchaseProofV1,
  type NftRouteCardV1,
} from '@mioagent/route-domain';
import { RouteStorageConflictError, RouteStorageIntegrityError, type SqlTemplateExecutor } from './types.js';
import {
  assertNftProofRewriteAllowedV1,
  assertNftTenantV1,
  nftSubmissionEffectV1,
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
// Postgres-backed NftStorageRepository.
//
// The uniqueness guarantees are the DATABASE's, not this file's:
// `nft_purchase_blueprints_card_unique` plus `INSERT … ON CONFLICT DO NOTHING`
// means two concurrent prepares race for one row and the loser is handed the
// winner's blueprint. `nft_proofs_blueprint_unique` does the same for proofs,
// and `nft_proof_events_proof_sequence_unique` makes the event log
// append-only. Application logic that agrees with them is a convenience; the
// indexes are the guarantee.
// ---------------------------------------------------------------------------

function jsonb(value: unknown): string {
  return JSON.stringify(value);
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function iso(value: unknown): string {
  return isoOrNull(value) ?? new Date(0).toISOString();
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function runFromRow(row: Record<string, unknown>): NftRouteRunRecordV1 {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    walletAddress: String(row.wallet_address),
    chainId: Number(row.chain_id),
    goal: 'nft',
    status: String(row.status),
    intentHash: String(row.intent_hash),
    idempotencyKey: String(row.idempotency_key),
    intent: parseNftIntentV1(row.intent_payload as NftPurchaseIntentV1),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function blueprintFromRow(row: Record<string, unknown>): NftPurchaseBlueprintRecordV1 {
  return {
    id: String(row.id),
    routeRunId: String(row.route_run_id),
    routeCardId: String(row.route_card_id),
    userId: String(row.user_id),
    walletAddress: String(row.wallet_address),
    blueprint: parseNftBlueprintV1(row.payload as NftPurchaseBlueprintV1),
    submissionBatchId: textOrNull(row.submission_batch_id),
    submittedTransactionHash: textOrNull(row.submitted_transaction_hash),
    submittedAt: isoOrNull(row.submitted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function proofFromRow(row: Record<string, unknown>): NftProofRecordV1 {
  return {
    id: String(row.id),
    routeRunId: String(row.route_run_id),
    blueprintId: String(row.blueprint_id),
    userId: String(row.user_id),
    walletAddress: String(row.wallet_address),
    proof: parseNftProofV1(row.payload as NftPurchaseProofV1),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function createDatabaseNftStorageRepository(sql: SqlTemplateExecutor): NftStorageRepository {
  async function requireRun(runId: string, userId: string): Promise<NftRouteRunRecordV1> {
    const rows = await sql`
      SELECT id, user_id, wallet_address, chain_id, status, intent_hash, intent_payload,
             idempotency_key, created_at, updated_at
      FROM route_runs
      WHERE id = ${runId} AND goal = 'nft'
      LIMIT 1
    `;
    if (!rows[0]) throw new RouteStorageIntegrityError('NFT route run not found');
    const record = runFromRow(rows[0]);
    assertNftTenantV1(record.userId, userId);
    return record;
  }

  async function readBlueprint(blueprintId: string, userId: string): Promise<NftPurchaseBlueprintRecordV1 | null> {
    const rows = await sql`
      SELECT id, route_run_id, route_card_id, user_id, wallet_address, payload,
             submission_batch_id, submitted_transaction_hash, submitted_at, created_at, updated_at
      FROM nft_purchase_blueprints
      WHERE id = ${blueprintId} AND user_id = ${userId}
      LIMIT 1
    `;
    return rows[0] ? blueprintFromRow(rows[0]) : null;
  }

  async function ownedBlueprint(blueprintId: string, userId: string): Promise<NftPurchaseBlueprintRecordV1> {
    const record = await readBlueprint(blueprintId, userId);
    if (!record) throw new RouteStorageIntegrityError('NFT purchase blueprint not found for this tenant');
    return record;
  }

  /** Re-stamps the stored blueprint. The calls are carried over untouched, and
   * the unchanged blueprintHash is the check that they were. */
  function rewriteBlueprint(
    record: NftPurchaseBlueprintRecordV1,
    changes: { status?: NftPurchaseBlueprintV1['status']; approvedCallsHash?: string | null },
  ): NftPurchaseBlueprintV1 {
    const next = {
      ...record.blueprint,
      status: changes.status ?? record.blueprint.status,
      approvedCallsHash:
        changes.approvedCallsHash === undefined ? record.blueprint.approvedCallsHash : changes.approvedCallsHash,
      updatedAt: nftUpdatedAtV1(record.blueprint.updatedAt, new Date()),
    } as NftPurchaseBlueprintV1;
    if (hashNftPurchaseBlueprintV1(next) !== record.blueprint.blueprintHash) {
      throw new RouteStorageIntegrityError('An NFT blueprint rewrite changed its financial content');
    }
    return parseNftBlueprintV1(next);
  }

  async function writeBlueprintPayload(
    record: NftPurchaseBlueprintRecordV1,
    blueprint: NftPurchaseBlueprintV1,
  ): Promise<NftPurchaseBlueprintRecordV1> {
    const rows = await sql`
      UPDATE nft_purchase_blueprints
      SET status = ${blueprint.status},
          approved_calls_hash = ${blueprint.approvedCallsHash},
          payload = CAST(${jsonb(blueprint)} AS jsonb),
          updated_at = now()
      WHERE id = ${record.id} AND user_id = ${record.userId}
      RETURNING id, route_run_id, route_card_id, user_id, wallet_address, payload,
                submission_batch_id, submitted_transaction_hash, submitted_at, created_at, updated_at
    `;
    if (!rows[0]) throw new RouteStorageIntegrityError('NFT purchase blueprint disappeared during update');
    return blueprintFromRow(rows[0]);
  }

  return {
    async createNftRouteRun(input: NftPurchaseIntentV1, idempotencyKey: string) {
      const intent = parseNftIntentV1(input);
      if (idempotencyKey.trim().length === 0) {
        throw new RouteStorageIntegrityError('NFT route run idempotency key must not be empty');
      }
      const inserted = await sql`
        INSERT INTO route_runs (
          id, user_id, wallet_address, chain_id, goal, schema_version, status,
          intent_hash, intent_payload, idempotency_key, created_at, updated_at
        ) VALUES (
          ${intent.id}, ${intent.tenantId}, ${intent.walletAddress}, ${intent.chainId},
          'nft', ${intent.schemaVersion}, ${intent.status}, ${intent.intentHash},
          CAST(${jsonb(intent)} AS jsonb), ${idempotencyKey},
          ${new Date(intent.createdAt)}, ${new Date(intent.updatedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id, user_id, wallet_address, chain_id, status, intent_hash, intent_payload,
                  idempotency_key, created_at, updated_at
      `;
      if (inserted[0]) return runFromRow(inserted[0]);
      const existing = await sql`
        SELECT id, user_id, wallet_address, chain_id, status, intent_hash, intent_payload,
               idempotency_key, created_at, updated_at
        FROM route_runs
        WHERE user_id = ${intent.tenantId} AND goal = 'nft'
          AND (id = ${intent.id} OR idempotency_key = ${idempotencyKey})
        ORDER BY id
        LIMIT 1
      `;
      if (!existing[0]) {
        throw new RouteStorageConflictError('NFT route run ID is already owned by another tenant');
      }
      const record = runFromRow(existing[0]);
      if (record.intentHash !== intent.intentHash) {
        throw new RouteStorageConflictError('NFT idempotency key has different content');
      }
      return record;
    },

    async getNftRouteRun(id: string, userId: string) {
      const rows = await sql`
        SELECT id, user_id, wallet_address, chain_id, status, intent_hash, intent_payload,
               idempotency_key, created_at, updated_at
        FROM route_runs
        WHERE id = ${id} AND user_id = ${userId} AND goal = 'nft'
        LIMIT 1
      `;
      return rows[0] ? runFromRow(rows[0]) : null;
    },

    async insertNftCandidate(runId: string, input: NftListingCandidateV1) {
      const candidate = parseNftCandidateV1(input);
      const run = await requireRun(runId, candidate.tenantId);
      if (candidate.intentHash !== run.intentHash) {
        throw new RouteStorageIntegrityError('NFT candidate intentHash does not match its run');
      }
      await sql`
        INSERT INTO nft_candidates (
          id, route_run_id, user_id, wallet_address, schema_version, status, candidate_hash,
          intent_hash, asset_hash, contract_address, token_id, order_hash, protocol_address,
          listing_price_wei, listing_status, payload, observed_at, listing_expires_at
        ) VALUES (
          ${candidate.id}, ${runId}, ${candidate.tenantId}, ${candidate.walletAddress},
          ${candidate.schemaVersion}, ${candidate.status}, ${candidate.candidateHash},
          ${candidate.intentHash}, ${candidate.asset.assetHash}, ${candidate.asset.contractAddress},
          ${candidate.asset.tokenId}, ${candidate.order.orderHash}, ${candidate.order.protocolAddress},
          ${candidate.listingPriceWei}, ${candidate.listingStatus}, CAST(${jsonb(candidate)} AS jsonb),
          ${new Date(candidate.observedAt)}, ${new Date(candidate.listingExpiresAt)}
        )
        ON CONFLICT DO NOTHING
      `;
    },

    async listNftCandidates(runId: string, userId: string) {
      await requireRun(runId, userId);
      const rows = await sql`
        SELECT payload FROM nft_candidates
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map((row) => parseNftCandidateV1(row.payload as NftListingCandidateV1));
    },

    async getNftCandidate(runId: string, candidateHash: string, userId: string) {
      await requireRun(runId, userId);
      const rows = await sql`
        SELECT payload FROM nft_candidates
        WHERE route_run_id = ${runId} AND user_id = ${userId} AND candidate_hash = ${candidateHash}
        LIMIT 1
      `;
      return rows[0] ? parseNftCandidateV1(rows[0].payload as NftListingCandidateV1) : null;
    },

    async insertNftEvidence(runId: string, input: NftEvidenceRecordV1) {
      const evidence = parseNftEvidenceV1(input);
      await requireRun(runId, evidence.tenantId);
      let candidateId: string | null = null;
      if (evidence.candidateHash !== null) {
        const rows = await sql`
          SELECT id FROM nft_candidates
          WHERE route_run_id = ${runId} AND candidate_hash = ${evidence.candidateHash}
          LIMIT 1
        `;
        if (!rows[0]) throw new RouteStorageIntegrityError('NFT evidence references an unknown candidate');
        candidateId = String(rows[0].id);
      }
      await sql`
        INSERT INTO nft_evidence (
          id, route_run_id, candidate_id, user_id, schema_version, status, evidence_hash,
          evidence_kind, asset_hash, provider_id, request_hash, response_hash, payload, observed_at
        ) VALUES (
          ${evidence.id}, ${runId}, ${candidateId}, ${evidence.tenantId}, ${evidence.schemaVersion},
          ${evidence.status}, ${evidence.evidenceHash}, ${evidence.evidenceKind}, ${evidence.assetHash},
          ${evidence.provider.id}, ${evidence.requestHash}, ${evidence.responseHash},
          CAST(${jsonb(evidence)} AS jsonb), ${new Date(evidence.observedAt)}
        )
        ON CONFLICT DO NOTHING
      `;
    },

    async listNftEvidence(runId: string, userId: string) {
      await requireRun(runId, userId);
      const rows = await sql`
        SELECT payload FROM nft_evidence
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map((row) => parseNftEvidenceV1(row.payload as NftEvidenceRecordV1));
    },

    async insertNftRouteCard(runId: string, input: NftRouteCardV1) {
      const card = parseNftRouteCardV1(input);
      const run = await requireRun(runId, card.tenantId);
      if (card.intentHash !== run.intentHash) {
        throw new RouteStorageIntegrityError('NFT route card intentHash does not match its run');
      }
      await sql`
        INSERT INTO nft_route_cards (
          id, route_run_id, user_id, wallet_address, schema_version, status, route_card_hash,
          intent_hash, candidate_hash, asset_hash, max_spend_wei, payload, expires_at
        ) VALUES (
          ${card.id}, ${runId}, ${card.tenantId}, ${card.walletAddress}, ${card.schemaVersion},
          ${card.status}, ${card.routeCardHash}, ${card.intentHash},
          ${card.candidate?.candidateHash ?? null}, ${card.asset.assetHash}, ${card.maxSpendWei},
          CAST(${jsonb(card)} AS jsonb), ${new Date(card.expiresAt)}
        )
        ON CONFLICT DO NOTHING
      `;
    },

    async listNftRouteCards(runId: string, userId: string) {
      await requireRun(runId, userId);
      const rows = await sql`
        SELECT payload FROM nft_route_cards
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map((row) => parseNftRouteCardV1(row.payload as NftRouteCardV1));
    },

    async getNftRouteCard(runId: string, routeCardHash: string, userId: string) {
      await requireRun(runId, userId);
      const rows = await sql`
        SELECT payload FROM nft_route_cards
        WHERE route_run_id = ${runId} AND user_id = ${userId} AND route_card_hash = ${routeCardHash}
        LIMIT 1
      `;
      return rows[0] ? parseNftRouteCardV1(rows[0].payload as NftRouteCardV1) : null;
    },

    async reserveNftPurchaseBlueprint(
      input: ReserveNftBlueprintInputV1,
    ): Promise<ReserveNftBlueprintResultV1> {
      const blueprint = parseNftBlueprintV1(input.blueprint);
      const run = await requireRun(input.routeRunId, input.userId);
      assertNftTenantV1(blueprint.tenantId, input.userId);
      if (blueprint.intentHash !== run.intentHash) {
        throw new RouteStorageIntegrityError('NFT blueprint intentHash does not match its run');
      }
      const cards = await sql`
        SELECT route_card_hash FROM nft_route_cards
        WHERE id = ${input.routeCardId} AND route_run_id = ${input.routeRunId} AND user_id = ${input.userId}
        LIMIT 1
      `;
      if (!cards[0]) throw new RouteStorageIntegrityError('NFT blueprint references an unstored Route Card');
      if (String(cards[0].route_card_hash) !== blueprint.routeCardHash) {
        throw new RouteStorageIntegrityError('NFT blueprint routeCardHash does not match its Route Card');
      }

      // The unique index on route_card_id does the work: a concurrent second
      // prepare inserts nothing and falls through to the SELECT below.
      const inserted = await sql`
        INSERT INTO nft_purchase_blueprints (
          id, route_run_id, route_card_id, user_id, wallet_address, schema_version, status,
          blueprint_hash, intent_hash, candidate_hash, route_card_hash, order_hash,
          protocol_address, asset_hash, contract_address, token_id, buyer, listing_price_wei,
          max_spend_wei, calls_hash, approved_calls_hash, fulfillment_response_hash, payload,
          expires_at, created_at, updated_at
        ) VALUES (
          ${blueprint.id}, ${input.routeRunId}, ${input.routeCardId}, ${input.userId},
          ${blueprint.walletAddress}, ${blueprint.schemaVersion}, ${blueprint.status},
          ${blueprint.blueprintHash}, ${blueprint.intentHash}, ${blueprint.candidateHash},
          ${blueprint.routeCardHash}, ${blueprint.orderHash}, ${blueprint.protocolAddress},
          ${blueprint.asset.assetHash}, ${blueprint.asset.contractAddress}, ${blueprint.asset.tokenId},
          ${blueprint.buyer}, ${blueprint.listingPriceWei}, ${blueprint.maxSpendWei},
          ${blueprint.callsHash}, ${blueprint.approvedCallsHash}, ${blueprint.fulfillmentResponseHash},
          CAST(${jsonb(blueprint)} AS jsonb), ${new Date(blueprint.expiresAt)},
          ${new Date(blueprint.createdAt)}, ${new Date(blueprint.updatedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id, route_run_id, route_card_id, user_id, wallet_address, payload,
                  submission_batch_id, submitted_transaction_hash, submitted_at, created_at, updated_at
      `;
      if (inserted[0]) return { outcome: 'created', record: blueprintFromRow(inserted[0]) };

      const existing = await sql`
        SELECT id, route_run_id, route_card_id, user_id, wallet_address, payload,
               submission_batch_id, submitted_transaction_hash, submitted_at, created_at, updated_at
        FROM nft_purchase_blueprints
        WHERE route_card_id = ${input.routeCardId}
        LIMIT 1
      `;
      if (!existing[0]) {
        throw new RouteStorageConflictError('NFT blueprint id is already owned by another tenant');
      }
      const record = blueprintFromRow(existing[0]);
      assertNftTenantV1(record.userId, input.userId);
      return { outcome: 'existing', record };
    },

    async getNftPurchaseBlueprint(blueprintId: string, userId: string) {
      return readBlueprint(blueprintId, userId);
    },

    async updateNftBlueprintStatus(input) {
      const record = await ownedBlueprint(input.blueprintId, input.userId);
      return writeBlueprintPayload(record, rewriteBlueprint(record, { status: input.status }));
    },

    async approveNftPurchaseBlueprint(input) {
      const record = await ownedBlueprint(input.blueprintId, input.userId);
      if (input.approvedCallsHash !== record.blueprint.callsHash) {
        throw new RouteStorageConflictError('The approved calls hash does not match this NFT blueprint');
      }
      if (record.blueprint.approvedCallsHash !== null) return record;
      return writeBlueprintPayload(
        record,
        rewriteBlueprint(record, { status: 'approved', approvedCallsHash: input.approvedCallsHash }),
      );
    },

    async recordNftSubmission(input: RecordNftSubmissionInputV1) {
      const record = await ownedBlueprint(input.blueprintId, input.userId);
      // The same shared decision the in-memory repository runs. Whatever it
      // permits, the WHERE clauses below still have to agree with — a lost race
      // returns the row that won, never a second submission.
      const effect = nftSubmissionEffectV1({
        existing: {
          approvedCallsHash: record.blueprint.approvedCallsHash,
          status: record.blueprint.status,
          submissionBatchId: record.submissionBatchId,
          submittedTransactionHash: record.submittedTransactionHash,
          submittedAt: record.submittedAt,
        },
        next: {
          status: input.status,
          submissionBatchId: input.submissionBatchId,
          transactionHash: input.transactionHash,
        },
      });
      if (effect.kind === 'unchanged') return record;

      const blueprint = rewriteBlueprint(record, { status: effect.status });
      if (effect.kind === 'cancel') {
        // Nothing was sent. The row records the refusal and stays free of a
        // batch id, a transaction hash and a submittedAt it does not have.
        const rows = await sql`
          UPDATE nft_purchase_blueprints
          SET status = ${blueprint.status},
              payload = CAST(${jsonb(blueprint)} AS jsonb),
              updated_at = now()
          WHERE id = ${record.id} AND user_id = ${record.userId} AND submitted_at IS NULL
          RETURNING id, route_run_id, route_card_id, user_id, wallet_address, payload,
                    submission_batch_id, submitted_transaction_hash, submitted_at, created_at, updated_at
        `;
        if (!rows[0]) return ownedBlueprint(input.blueprintId, input.userId);
        return blueprintFromRow(rows[0]);
      }
      if (effect.kind === 'advance') {
        const rows = await sql`
          UPDATE nft_purchase_blueprints
          SET status = ${blueprint.status},
              payload = CAST(${jsonb(blueprint)} AS jsonb),
              submitted_transaction_hash = COALESCE(submitted_transaction_hash, ${effect.learnTransactionHash}),
              updated_at = now()
          WHERE id = ${record.id} AND user_id = ${record.userId} AND submitted_at IS NOT NULL
          RETURNING id, route_run_id, route_card_id, user_id, wallet_address, payload,
                    submission_batch_id, submitted_transaction_hash, submitted_at, created_at, updated_at
        `;
        if (!rows[0]) return ownedBlueprint(input.blueprintId, input.userId);
        return blueprintFromRow(rows[0]);
      }
      const rows = await sql`
        UPDATE nft_purchase_blueprints
        SET status = ${blueprint.status},
            payload = CAST(${jsonb(blueprint)} AS jsonb),
            submission_batch_id = ${input.submissionBatchId},
            submitted_transaction_hash = ${input.transactionHash},
            submitted_at = ${new Date(input.submittedAt)},
            updated_at = now()
        WHERE id = ${record.id} AND user_id = ${record.userId} AND submitted_at IS NULL
        RETURNING id, route_run_id, route_card_id, user_id, wallet_address, payload,
                  submission_batch_id, submitted_transaction_hash, submitted_at, created_at, updated_at
      `;
      // Lost the race: another request recorded the submission first. Its row
      // is the answer — this one does not open a second transaction.
      if (!rows[0]) return ownedBlueprint(input.blueprintId, input.userId);
      return blueprintFromRow(rows[0]);
    },

    async upsertNftProof(input: UpsertNftProofInputV1) {
      const proof = parseNftProofV1(input.proof);
      assertNftTenantV1(proof.tenantId, input.userId);
      const blueprint = await ownedBlueprint(input.blueprintId, input.userId);
      if (proof.blueprintHash !== blueprint.blueprint.blueprintHash) {
        throw new RouteStorageIntegrityError('NFT proof does not belong to this blueprint');
      }
      const existingRows = await sql`
        SELECT id, route_run_id, blueprint_id, user_id, wallet_address, payload, created_at, updated_at
        FROM nft_proofs
        WHERE blueprint_id = ${input.blueprintId}
        LIMIT 1
      `;
      if (existingRows[0]) {
        const existing = proofFromRow(existingRows[0]);
        assertNftTenantV1(existing.userId, input.userId);
        assertNftProofRewriteAllowedV1(existing.proof, proof);
        const rows = await sql`
          UPDATE nft_proofs
          SET status = ${proof.status},
              proof_hash = ${proof.proofHash},
              final_status = ${proof.finalStatus},
              transaction_hash = ${proof.receipt.transactionHash},
              block_number = ${proof.receipt.blockNumber},
              gas_used = ${proof.receipt.gasUsed},
              actual_native_value_wei = ${proof.receipt.actualNativeValueWei},
              previous_owner = ${proof.transfer.fromAddress},
              new_owner = ${proof.ownership.owner},
              ownership_block_number = ${proof.ownership.blockNumber},
              payload = CAST(${jsonb(proof)} AS jsonb),
              finalized_at = ${proof.finalizedAt === null ? null : new Date(proof.finalizedAt)},
              updated_at = now()
          WHERE id = ${existing.id} AND user_id = ${input.userId}
          RETURNING id, route_run_id, blueprint_id, user_id, wallet_address, payload, created_at, updated_at
        `;
        if (!rows[0]) throw new RouteStorageIntegrityError('NFT proof disappeared during update');
        return proofFromRow(rows[0]);
      }

      const inserted = await sql`
        INSERT INTO nft_proofs (
          id, route_run_id, blueprint_id, user_id, wallet_address, schema_version, status,
          proof_hash, intent_hash, blueprint_hash, approved_calls_hash, order_hash, asset_hash,
          contract_address, token_id, buyer, seller, final_status, transaction_hash, block_number,
          gas_used, actual_native_value_wei, previous_owner, new_owner, ownership_block_number,
          payload, finalized_at, created_at, updated_at
        ) VALUES (
          ${proof.id}, ${input.routeRunId}, ${input.blueprintId}, ${input.userId},
          ${proof.walletAddress}, ${proof.schemaVersion}, ${proof.status}, ${proof.proofHash},
          ${proof.intentHash}, ${proof.blueprintHash}, ${proof.approvedCallsHash}, ${proof.orderHash},
          ${proof.asset.assetHash}, ${proof.asset.contractAddress}, ${proof.asset.tokenId},
          ${proof.buyer}, ${proof.seller}, ${proof.finalStatus}, ${proof.receipt.transactionHash},
          ${proof.receipt.blockNumber}, ${proof.receipt.gasUsed}, ${proof.receipt.actualNativeValueWei},
          ${proof.transfer.fromAddress}, ${proof.ownership.owner}, ${proof.ownership.blockNumber},
          CAST(${jsonb(proof)} AS jsonb),
          ${proof.finalizedAt === null ? null : new Date(proof.finalizedAt)},
          ${new Date(proof.createdAt)}, ${new Date(proof.updatedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id, route_run_id, blueprint_id, user_id, wallet_address, payload, created_at, updated_at
      `;
      if (inserted[0]) return proofFromRow(inserted[0]);
      // Either this blueprint or this order already has a proof. Both unique
      // indexes mean the same thing: the purchase already has an answer.
      const raced = await sql`
        SELECT id, route_run_id, blueprint_id, user_id, wallet_address, payload, created_at, updated_at
        FROM nft_proofs
        WHERE blueprint_id = ${input.blueprintId}
           OR (user_id = ${input.userId} AND order_hash = ${proof.orderHash})
        LIMIT 1
      `;
      if (!raced[0]) throw new RouteStorageConflictError('NFT proof id is already owned by another tenant');
      const record = proofFromRow(raced[0]);
      assertNftTenantV1(record.userId, input.userId);
      if (record.proof.proofHash !== proof.proofHash) {
        throw new RouteStorageConflictError('This purchase already has a different NFT proof');
      }
      return record;
    },

    async getNftProof(proofId: string, userId: string) {
      const rows = await sql`
        SELECT id, route_run_id, blueprint_id, user_id, wallet_address, payload, created_at, updated_at
        FROM nft_proofs
        WHERE id = ${proofId} AND user_id = ${userId}
        LIMIT 1
      `;
      return rows[0] ? proofFromRow(rows[0]) : null;
    },

    async getNftProofByBlueprint(blueprintId: string, userId: string) {
      const rows = await sql`
        SELECT id, route_run_id, blueprint_id, user_id, wallet_address, payload, created_at, updated_at
        FROM nft_proofs
        WHERE blueprint_id = ${blueprintId} AND user_id = ${userId}
        LIMIT 1
      `;
      return rows[0] ? proofFromRow(rows[0]) : null;
    },

    async listOpenNftProofs(limit: number) {
      const rows = await sql`
        SELECT id, route_run_id, blueprint_id, user_id, wallet_address, payload, created_at, updated_at
        FROM nft_proofs
        WHERE status = 'open'
        ORDER BY created_at, id
        LIMIT ${Math.max(0, limit)}
      `;
      return rows.map((row) => proofFromRow(row));
    },

    async appendNftProofEvent(proofId: string, userId: string, input: NftProofEventV1) {
      const event = parseNftProofEventV1(input);
      assertNftTenantV1(event.tenantId, userId);
      const proofRows = await sql`
        SELECT user_id, proof_hash FROM nft_proofs WHERE id = ${proofId} LIMIT 1
      `;
      if (!proofRows[0]) throw new RouteStorageIntegrityError('NFT proof not found');
      assertNftTenantV1(String(proofRows[0].user_id), userId);
      if (String(proofRows[0].proof_hash) !== event.proofHash) {
        throw new RouteStorageIntegrityError('NFT proof event does not describe this proof');
      }
      const inserted = await sql`
        INSERT INTO nft_proof_events (
          id, proof_id, user_id, schema_version, status, event_hash, proof_hash, sequence,
          event_kind, final_status, detail, payload, observed_at
        ) VALUES (
          ${event.id}, ${proofId}, ${userId}, ${event.schemaVersion}, ${event.status},
          ${event.eventHash}, ${event.proofHash}, ${event.sequence}, ${event.eventKind},
          ${event.finalStatus}, ${event.detail}, CAST(${jsonb(event)} AS jsonb),
          ${new Date(event.observedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) return;
      // The sequence was already claimed. Same content is a retry; different
      // content is an attempt to rewrite an append-only log.
      const claimed = await sql`
        SELECT event_hash FROM nft_proof_events
        WHERE proof_id = ${proofId} AND sequence = ${event.sequence}
        LIMIT 1
      `;
      if (claimed[0] && String(claimed[0].event_hash) !== event.eventHash) {
        throw new RouteStorageConflictError('An NFT proof event sequence cannot be rewritten');
      }
    },

    async listNftProofEvents(proofId: string, userId: string) {
      const proofRows = await sql`SELECT user_id FROM nft_proofs WHERE id = ${proofId} LIMIT 1`;
      if (!proofRows[0]) throw new RouteStorageIntegrityError('NFT proof not found');
      assertNftTenantV1(String(proofRows[0].user_id), userId);
      const rows = await sql`
        SELECT payload FROM nft_proof_events
        WHERE proof_id = ${proofId} AND user_id = ${userId}
        ORDER BY sequence
      `;
      return rows.map((row) => parseNftProofEventV1(row.payload as NftProofEventV1));
    },

    async listNftHistory(userId: string, limit: number) {
      const rows = await sql`
        SELECT b.id AS blueprint_id, b.route_run_id, b.contract_address, b.token_id, b.order_hash,
               b.listing_price_wei, b.status AS blueprint_status, b.submitted_transaction_hash,
               b.created_at, b.updated_at,
               p.id AS proof_id, p.final_status, p.transaction_hash
        FROM nft_purchase_blueprints b
        LEFT JOIN nft_proofs p ON p.blueprint_id = b.id
        WHERE b.user_id = ${userId}
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT ${Math.max(0, limit)}
      `;
      return rows.map((row): NftHistoryItemV1 => ({
        proofId: textOrNull(row.proof_id),
        blueprintId: String(row.blueprint_id),
        routeRunId: String(row.route_run_id),
        contractAddress: String(row.contract_address),
        tokenId: String(row.token_id),
        orderHash: String(row.order_hash),
        listingPriceWei: String(row.listing_price_wei),
        blueprintStatus: String(row.blueprint_status) as NftPurchaseBlueprintV1['status'],
        finalStatus: textOrNull(row.final_status) as NftHistoryItemV1['finalStatus'],
        transactionHash: textOrNull(row.transaction_hash) ?? textOrNull(row.submitted_transaction_hash),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      }));
    },
  };
}
