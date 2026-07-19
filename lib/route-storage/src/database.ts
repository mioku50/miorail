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
  type RouteStorageRepository,
  type SqlTemplateExecutor,
  type StoredBlueprintV1,
  type StoredIntelligenceChargeV1,
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
  databaseNullableString,
  databaseNullableTimestamp,
  databaseNumber,
  databaseString,
  databaseTimestamp,
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
  payloadFromDatabase,
} from './validation.js';

function conflict(message: string): never {
  throw new RouteStorageConflictError(message);
}

function jsonb(value: unknown): string {
  return JSON.stringify(value);
}

function rowCore(
  row: Record<string, unknown>,
  payload: {
    id: string;
    tenantId: string;
    schemaVersion: string;
    status: string;
  },
  hashColumn: string,
  hash: string,
): void {
  assertTenant(payload.tenantId, databaseString(row.user_id, 'user_id'));
  if (
    databaseString(row.id, 'id') !== payload.id ||
    databaseString(row.schema_version, 'schema_version') !== payload.schemaVersion ||
    databaseString(row.status, 'status') !== payload.status ||
    databaseString(row[hashColumn], hashColumn) !== hash
  ) {
    throw new RouteStorageIntegrityError('Stored relational envelope differs from its payload');
  }
}

function candidateFromRow(row: Record<string, unknown>): RouteCandidateV1 {
  const candidate = parseRouteCandidate(payloadFromDatabase(row.payload));
  rowCore(row, candidate, 'candidate_hash', candidate.candidateHash);
  if (
    databaseString(row.provider_id, 'provider_id') !== candidate.provider.id ||
    databaseTimestamp(row.observed_at, 'observed_at') !== candidate.quoteObservedAt ||
    databaseNullableTimestamp(row.expires_at, 'expires_at') !== candidate.quoteExpiresAt ||
    databaseTimestamp(row.created_at, 'created_at') !== candidate.createdAt ||
    databaseTimestamp(row.updated_at, 'updated_at') !== candidate.updatedAt
  ) {
    throw new RouteStorageIntegrityError('Stored candidate provider differs from payload');
  }
  return candidate;
}

function evidenceFromRow(row: Record<string, unknown>): EvidenceRecordV1 {
  const evidence = parseEvidenceRecord(payloadFromDatabase(row.payload));
  rowCore(row, evidence, 'evidence_hash', evidence.evidenceHash);
  if (
    databaseString(row.evidence_type, 'evidence_type') !== evidence.evidenceType ||
    databaseString(row.provider_id, 'provider_id') !== evidence.provider.id ||
    databaseString(row.validation_status, 'validation_status') !== evidence.validationStatus ||
    databaseTimestamp(row.observed_at, 'observed_at') !== evidence.observedAt ||
    databaseNullableTimestamp(row.expires_at, 'expires_at') !== evidence.expiresAt ||
    databaseTimestamp(row.created_at, 'created_at') !== evidence.createdAt ||
    databaseTimestamp(row.updated_at, 'updated_at') !== evidence.updatedAt
  ) {
    throw new RouteStorageIntegrityError('Stored evidence envelope differs from payload');
  }
  return evidence;
}

function evidenceSetFromRow(row: Record<string, unknown>): EvidenceSetV1 {
  const evidenceSet = parseEvidenceSet(payloadFromDatabase(row.payload));
  rowCore(row, evidenceSet, 'evidence_set_hash', evidenceSet.evidenceSetHash);
  if (
    databaseTimestamp(row.created_at, 'created_at') !== evidenceSet.createdAt ||
    databaseTimestamp(row.updated_at, 'updated_at') !== evidenceSet.updatedAt
  ) {
    throw new RouteStorageIntegrityError('Stored Evidence Set timestamps differ from payload');
  }
  return evidenceSet;
}

function scoreFromRow(row: Record<string, unknown>): PathScoreV1 {
  const score = parsePathScore(payloadFromDatabase(row.payload));
  rowCore(row, score, 'score_hash', score.pathScoreHash);
  if (
    databaseString(row.scoring_version, 'scoring_version') !== score.scoringVersion ||
    databaseTimestamp(row.created_at, 'created_at') !== score.createdAt
  ) {
    throw new RouteStorageIntegrityError('Stored scoring version differs from payload');
  }
  return score;
}

function cardFromRow(row: Record<string, unknown>): RouteCardV1 {
  const card = parseRouteCard(payloadFromDatabase(row.payload));
  rowCore(row, card, 'route_card_hash', card.routeCardHash);
  if (
    databaseTimestamp(row.created_at, 'created_at') !== card.createdAt ||
    databaseTimestamp(row.updated_at, 'updated_at') !== card.updatedAt
  ) {
    throw new RouteStorageIntegrityError('Stored Route Card timestamps differ from payload');
  }
  return card;
}

function blueprintFromRow(row: Record<string, unknown>): StoredBlueprintV1 {
  const blueprint = parseExecutionBlueprint(payloadFromDatabase(row.payload));
  rowCore(row, blueprint, 'blueprint_hash', blueprint.blueprintHash);
  if (
    databaseString(row.wallet_address, 'wallet_address') !== blueprint.walletAddress ||
    databaseNumber(row.chain_id, 'chain_id') !== blueprint.chainId ||
    databaseString(row.intent_hash, 'intent_hash') !== blueprint.intentHash ||
    databaseString(row.selected_candidate_hash, 'selected_candidate_hash') !==
      blueprint.selectedCandidateHash ||
    databaseString(row.evidence_set_hash, 'evidence_set_hash') !== blueprint.evidenceSetHash ||
    databaseString(row.calls_hash, 'calls_hash') !== blueprint.callsHash ||
    databaseNullableString(row.approved_calls_hash, 'approved_calls_hash') !==
      blueprint.approvedCallsHash ||
    databaseTimestamp(row.expires_at, 'expires_at') !== blueprint.quoteExpiry ||
    databaseTimestamp(row.created_at, 'created_at') !== blueprint.createdAt ||
    databaseTimestamp(row.updated_at, 'updated_at') !== blueprint.updatedAt
  ) {
    throw new RouteStorageIntegrityError('Stored Blueprint envelope differs from payload');
  }
  return {
    blueprint,
    preparedTransactionActionId: databaseNullableString(
      row.prepared_transaction_action_id,
      'prepared_transaction_action_id',
    ),
  };
}

function proofFromRow(row: Record<string, unknown>): RouteProofV1 {
  const proof = parseRouteProof(payloadFromDatabase(row.payload));
  rowCore(row, proof, 'proof_hash', proof.proofHash);
  if (
    databaseString(row.approved_calls_hash, 'approved_calls_hash') !== proof.approvedCallsHash ||
    databaseTimestamp(row.created_at, 'created_at') !== proof.createdAt ||
    databaseTimestamp(row.updated_at, 'updated_at') !== proof.updatedAt
  ) {
    throw new RouteStorageIntegrityError('Stored approved calls hash differs from Route Proof');
  }
  return proof;
}

function eventFromRow(row: Record<string, unknown>): RouteProofEventV1 {
  const event = parseRouteProofEvent(payloadFromDatabase(row.payload));
  rowCore(row, event, 'event_hash', event.eventHash);
  if (
    databaseString(row.event_type, 'event_type') !== event.eventType ||
    databaseNumber(row.sequence, 'sequence') !== event.eventIndex ||
    databaseString(row.route_proof_id, 'route_proof_id') !== event.routeProofId ||
    databaseTimestamp(row.created_at, 'created_at') !== event.createdAt
  ) {
    throw new RouteStorageIntegrityError('Stored proof event envelope differs from payload');
  }
  return event;
}

function chargeFromRow(row: Record<string, unknown>): StoredIntelligenceChargeV1 {
  const charge = parseIntelligenceCharge(payloadFromDatabase(row.payload));
  rowCore(row, charge, 'charge_hash', charge.chargeHash);
  const spendPermissionId = databaseNullableString(row.spend_permission_id, 'spend_permission_id');
  if (spendPermissionId !== charge.spendPermissionId) {
    throw new RouteStorageIntegrityError(
      'Stored Spend Permission link differs from charge payload',
    );
  }
  if (
    databaseTimestamp(row.created_at, 'created_at') !== charge.createdAt ||
    databaseTimestamp(row.updated_at, 'updated_at') !== charge.updatedAt
  ) {
    throw new RouteStorageIntegrityError('Stored charge timestamps differ from payload');
  }
  return {
    charge,
    evidenceId: databaseNullableString(row.evidence_id, 'evidence_id'),
    spendPermissionId,
    x402ReceiptId: databaseNullableString(row.x402_receipt_id, 'x402_receipt_id'),
  };
}

function routeRunFromRow(row: Record<string, unknown>): RouteRunRecord {
  const intent = parseRouteIntent(payloadFromDatabase(row.intent_payload));
  const createdAt = databaseTimestamp(row.created_at, 'created_at');
  const updatedAt = databaseTimestamp(row.updated_at, 'updated_at');
  const userId = databaseString(row.user_id, 'user_id');
  assertTenant(intent.tenantId, userId);
  if (
    databaseString(row.id, 'id') !== intent.id ||
    databaseString(row.wallet_address, 'wallet_address') !== intent.walletAddress ||
    databaseNumber(row.chain_id, 'chain_id') !== intent.chainId ||
    databaseString(row.schema_version, 'schema_version') !== intent.schemaVersion ||
    databaseString(row.intent_hash, 'intent_hash') !== intent.intentHash ||
    createdAt !== intent.createdAt ||
    updatedAt !== intent.updatedAt
  ) {
    throw new RouteStorageIntegrityError('Stored Route Run envelope differs from its intent');
  }
  return {
    id: intent.id,
    userId,
    walletAddress: intent.walletAddress,
    chainId: intent.chainId,
    schemaVersion: intent.schemaVersion,
    status: databaseString(row.status, 'status'),
    intentHash: intent.intentHash,
    idempotencyKey: databaseString(row.idempotency_key, 'idempotency_key'),
    intent,
    createdAt,
    updatedAt,
    completedAt:
      row.completed_at === null || row.completed_at === undefined
        ? null
        : databaseTimestamp(row.completed_at, 'completed_at'),
  };
}

async function requireOwnedRun(
  sql: SqlTemplateExecutor,
  runId: string,
  userId: string,
): Promise<RouteRunRecord> {
  const rows = await sql`
    SELECT id, user_id, wallet_address, chain_id, schema_version, status,
           intent_hash, intent_payload, idempotency_key, created_at, updated_at, completed_at
    FROM route_runs
    WHERE id = ${runId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new RouteStorageTenantError('Route Run is missing or belongs to another tenant');
  }
  return routeRunFromRow(rows[0]);
}

async function candidateById(
  sql: SqlTemplateExecutor,
  runId: string,
  userId: string,
  candidateId: string,
): Promise<RouteCandidateV1> {
  const rows = await sql`
    SELECT id, route_run_id, user_id, provider_id, schema_version, status,
           candidate_hash, payload, observed_at, expires_at, created_at, updated_at
    FROM route_candidates
    WHERE id = ${candidateId} AND route_run_id = ${runId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!rows[0]) throw new RouteStorageIntegrityError('Route Candidate link is missing');
  return candidateFromRow(rows[0]);
}

async function candidateIdByHash(
  sql: SqlTemplateExecutor,
  runId: string,
  userId: string,
  candidateHash: string,
): Promise<string | null> {
  const rows = await sql`
    SELECT id, route_run_id, user_id, provider_id, schema_version, status,
           candidate_hash, payload, observed_at, expires_at, created_at, updated_at
    FROM route_candidates
    WHERE route_run_id = ${runId} AND user_id = ${userId} AND candidate_hash = ${candidateHash}
    LIMIT 1
  `;
  if (!rows[0]) return null;
  candidateFromRow(rows[0]);
  return databaseString(rows[0].id, 'candidate.id');
}

export function createDatabaseRouteStorageRepository(
  sql: SqlTemplateExecutor,
): RouteStorageRepository {
  return {
    async createRouteRun(input: RouteIntentV1, idempotencyKey: string): Promise<RouteRunRecord> {
      const intent = parseRouteIntent(input);
      if (idempotencyKey.trim().length === 0) {
        throw new RouteStorageIntegrityError('Route run idempotency key must not be empty');
      }
      const inserted = await sql`
        INSERT INTO route_runs (
          id, user_id, wallet_address, chain_id, schema_version, status,
          intent_hash, intent_payload, idempotency_key, created_at, updated_at
        ) VALUES (
          ${intent.id}, ${intent.tenantId}, ${intent.walletAddress}, ${intent.chainId},
          ${intent.schemaVersion}, ${intent.status}, ${intent.intentHash},
          CAST(${jsonb(intent)} AS jsonb), ${idempotencyKey},
          ${new Date(intent.createdAt)}, ${new Date(intent.updatedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id, user_id, wallet_address, chain_id, schema_version, status,
                  intent_hash, intent_payload, idempotency_key, created_at, updated_at, completed_at
      `;
      if (inserted[0]) return routeRunFromRow(inserted[0]);
      const existing = await sql`
        SELECT id, user_id, wallet_address, chain_id, schema_version, status,
               intent_hash, intent_payload, idempotency_key, created_at, updated_at, completed_at
        FROM route_runs
        WHERE user_id = ${intent.tenantId}
          AND (id = ${intent.id} OR idempotency_key = ${idempotencyKey})
        ORDER BY id
        LIMIT 1
      `;
      if (!existing[0]) conflict('Route run ID is already owned by another tenant');
      const record = routeRunFromRow(existing[0]);
      if (
        record.id !== intent.id ||
        record.idempotencyKey !== idempotencyKey ||
        !payloadEquals(record.intent, intent)
      ) {
        conflict('Route run ID or user-scoped idempotency key has different content');
      }
      return record;
    },

    async getRouteRun(id: string, userId: string): Promise<RouteRunRecord | null> {
      const rows = await sql`
        SELECT id, user_id, wallet_address, chain_id, schema_version, status,
               intent_hash, intent_payload, idempotency_key, created_at, updated_at, completed_at
        FROM route_runs
        WHERE id = ${id} AND user_id = ${userId}
        LIMIT 1
      `;
      return rows[0] ? routeRunFromRow(rows[0]) : null;
    },

    async insertCandidate(runId: string, input: RouteCandidateV1): Promise<void> {
      const candidate = parseRouteCandidate(input);
      const run = await requireOwnedRun(sql, runId, candidate.tenantId);
      assertLinkedHash(candidate.intentHash, run.intentHash, 'candidate.intentHash');
      const inserted = await sql`
        INSERT INTO route_candidates (
          id, route_run_id, user_id, provider_id, schema_version, status,
          candidate_hash, payload, observed_at, expires_at, created_at, updated_at
        ) VALUES (
          ${candidate.id}, ${runId}, ${candidate.tenantId}, ${candidate.provider.id},
          ${candidate.schemaVersion}, ${candidate.status}, ${candidate.candidateHash},
          CAST(${jsonb(candidate)} AS jsonb), ${new Date(candidate.quoteObservedAt)},
          ${new Date(candidate.quoteExpiresAt)}, ${new Date(candidate.createdAt)},
          ${new Date(candidate.updatedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) return;
      const existing = await sql`
        SELECT id, route_run_id, user_id, provider_id, schema_version, status,
               candidate_hash, payload, observed_at, expires_at, created_at, updated_at
        FROM route_candidates
        WHERE user_id = ${candidate.tenantId}
          AND (id = ${candidate.id} OR (route_run_id = ${runId} AND candidate_hash = ${candidate.candidateHash}))
        ORDER BY id
        LIMIT 1
      `;
      if (!existing[0]) conflict('Candidate ID is already owned by another tenant');
      const stored = candidateFromRow(existing[0]);
      if (
        databaseString(existing[0].route_run_id, 'route_run_id') !== runId ||
        !payloadEquals(stored, candidate)
      ) {
        conflict('Candidate ID or run-scoped candidate hash has different content');
      }
    },

    async listCandidates(runId: string, userId: string): Promise<RouteCandidateV1[]> {
      const rows = await sql`
        SELECT id, route_run_id, user_id, provider_id, schema_version, status,
               candidate_hash, payload, observed_at, expires_at, created_at, updated_at
        FROM route_candidates
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map(candidateFromRow);
    },

    async insertEvidence(
      runId: string,
      candidateId: string | null,
      input: EvidenceRecordV1,
    ): Promise<void> {
      const evidence = parseEvidenceRecord(input);
      const run = await requireOwnedRun(sql, runId, evidence.tenantId);
      assertLinkedHash(evidence.intentHash, run.intentHash, 'evidence.intentHash');
      if (candidateId !== null) {
        const candidate = await candidateById(sql, runId, evidence.tenantId, candidateId);
        assertLinkedHash(evidence.candidateHash, candidate.candidateHash, 'evidence.candidateHash');
      }
      const inserted = await sql`
        INSERT INTO route_evidence (
          id, route_run_id, candidate_id, user_id, schema_version, status,
          evidence_type, provider_id, evidence_hash, payload, observed_at,
          expires_at, validation_status, created_at, updated_at
        ) VALUES (
          ${evidence.id}, ${runId}, ${candidateId}, ${evidence.tenantId},
          ${evidence.schemaVersion}, ${evidence.status}, ${evidence.evidenceType},
          ${evidence.provider.id}, ${evidence.evidenceHash}, CAST(${jsonb(evidence)} AS jsonb),
          ${new Date(evidence.observedAt)},
          ${evidence.expiresAt ? new Date(evidence.expiresAt) : null},
          ${evidence.validationStatus}, ${new Date(evidence.createdAt)},
          ${new Date(evidence.updatedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) return;
      const existing = await sql`
        SELECT id, route_run_id, candidate_id, user_id, schema_version, status,
               evidence_type, provider_id, evidence_hash, payload, observed_at,
               expires_at, validation_status, created_at, updated_at
        FROM route_evidence
        WHERE user_id = ${evidence.tenantId}
          AND (id = ${evidence.id} OR (route_run_id = ${runId} AND evidence_hash = ${evidence.evidenceHash}))
        ORDER BY id
        LIMIT 1
      `;
      if (!existing[0]) conflict('Evidence ID is already owned by another tenant');
      const stored = evidenceFromRow(existing[0]);
      if (
        databaseString(existing[0].route_run_id, 'route_run_id') !== runId ||
        databaseNullableString(existing[0].candidate_id, 'candidate_id') !== candidateId ||
        !payloadEquals(stored, evidence)
      ) {
        conflict('Evidence ID or run-scoped evidence hash has different content');
      }
    },

    async listEvidence(runId: string, userId: string): Promise<EvidenceRecordV1[]> {
      const rows = await sql`
        SELECT id, route_run_id, candidate_id, user_id, schema_version, status,
               evidence_type, provider_id, evidence_hash, payload, observed_at,
               expires_at, validation_status, created_at, updated_at
        FROM route_evidence
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map(evidenceFromRow);
    },

    async insertEvidenceSet(
      runId: string,
      candidateId: string,
      input: EvidenceSetV1,
    ): Promise<void> {
      const evidenceSet = parseEvidenceSet(input);
      const run = await requireOwnedRun(sql, runId, evidenceSet.tenantId);
      assertLinkedHash(evidenceSet.intentHash, run.intentHash, 'evidenceSet.intentHash');
      const candidate = await candidateById(sql, runId, evidenceSet.tenantId, candidateId);
      assertLinkedHash(
        evidenceSet.candidateHash,
        candidate.candidateHash,
        'evidenceSet.candidateHash',
      );
      const evidenceRows = await sql`
        SELECT id, route_run_id, candidate_id, user_id, schema_version, status,
               evidence_type, provider_id, evidence_hash, payload, observed_at,
               expires_at, validation_status, created_at, updated_at
        FROM route_evidence
        WHERE route_run_id = ${runId} AND user_id = ${evidenceSet.tenantId}
      `;
      const storedHashes = new Set(evidenceRows.map((row) => evidenceFromRow(row).evidenceHash));
      if (evidenceSet.records.some((record) => !storedHashes.has(record.evidenceHash))) {
        throw new RouteStorageIntegrityError('Evidence Set references an unstored evidence record');
      }
      const inserted = await sql`
        INSERT INTO route_evidence_sets (
          id, route_run_id, candidate_id, user_id, schema_version, status,
          evidence_set_hash, payload, created_at, updated_at
        ) VALUES (
          ${evidenceSet.id}, ${runId}, ${candidateId}, ${evidenceSet.tenantId},
          ${evidenceSet.schemaVersion}, ${evidenceSet.status}, ${evidenceSet.evidenceSetHash},
          CAST(${jsonb(evidenceSet)} AS jsonb), ${new Date(evidenceSet.createdAt)},
          ${new Date(evidenceSet.updatedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) return;
      const existing = await sql`
        SELECT id, route_run_id, candidate_id, user_id, schema_version, status,
               evidence_set_hash, payload, created_at, updated_at
        FROM route_evidence_sets
        WHERE user_id = ${evidenceSet.tenantId}
          AND (id = ${evidenceSet.id} OR (route_run_id = ${runId} AND evidence_set_hash = ${evidenceSet.evidenceSetHash}))
        ORDER BY id
        LIMIT 1
      `;
      if (!existing[0]) conflict('Evidence Set ID is already owned by another tenant');
      const stored = evidenceSetFromRow(existing[0]);
      if (
        databaseString(existing[0].route_run_id, 'route_run_id') !== runId ||
        databaseString(existing[0].candidate_id, 'candidate_id') !== candidateId ||
        !payloadEquals(stored, evidenceSet)
      ) {
        conflict('Evidence Set ID or run-scoped hash has different content');
      }
    },

    async listEvidenceSets(runId: string, userId: string): Promise<EvidenceSetV1[]> {
      const rows = await sql`
        SELECT id, route_run_id, candidate_id, user_id, schema_version, status,
               evidence_set_hash, payload, created_at, updated_at
        FROM route_evidence_sets
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map(evidenceSetFromRow);
    },

    async insertScoreSnapshot(
      runId: string,
      candidateId: string,
      input: PathScoreV1,
    ): Promise<void> {
      const score = parsePathScore(input);
      const run = await requireOwnedRun(sql, runId, score.tenantId);
      assertLinkedHash(score.intentHash, run.intentHash, 'score.intentHash');
      const candidate = await candidateById(sql, runId, score.tenantId, candidateId);
      assertLinkedHash(score.candidateHash, candidate.candidateHash, 'score.candidateHash');
      const evidenceSets = await sql`
        SELECT id, route_run_id, candidate_id, user_id, schema_version, status,
               evidence_set_hash, payload, created_at, updated_at
        FROM route_evidence_sets
        WHERE route_run_id = ${runId} AND user_id = ${score.tenantId}
          AND evidence_set_hash = ${score.evidenceSetHash}
        LIMIT 1
      `;
      if (!evidenceSets[0]) {
        throw new RouteStorageIntegrityError('Path Score references an unstored Evidence Set');
      }
      const evidenceSet = evidenceSetFromRow(evidenceSets[0]);
      assertLinkedHash(evidenceSet.intentHash, run.intentHash, 'score.evidenceSet.intentHash');
      assertLinkedHash(
        evidenceSet.candidateHash,
        candidate.candidateHash,
        'score.evidenceSet.candidateHash',
      );
      if (databaseString(evidenceSets[0].candidate_id, 'candidate_id') !== candidateId) {
        throw new RouteStorageIntegrityError('Path Score Evidence Set has different lineage');
      }
      const inserted = await sql`
        INSERT INTO route_score_snapshots (
          id, route_run_id, candidate_id, user_id, schema_version, status,
          score_hash, scoring_version, payload, created_at
        ) VALUES (
          ${score.id}, ${runId}, ${candidateId}, ${score.tenantId}, ${score.schemaVersion},
          ${score.status}, ${score.pathScoreHash}, ${score.scoringVersion},
          CAST(${jsonb(score)} AS jsonb), ${new Date(score.createdAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) return;
      const existing = await sql`
        SELECT id, route_run_id, candidate_id, user_id, schema_version, status,
               score_hash, scoring_version, payload, created_at
        FROM route_score_snapshots
        WHERE user_id = ${score.tenantId}
          AND (id = ${score.id} OR (candidate_id = ${candidateId} AND score_hash = ${score.pathScoreHash}))
        ORDER BY id
        LIMIT 1
      `;
      if (!existing[0]) conflict('Path Score ID is already owned by another tenant');
      const stored = scoreFromRow(existing[0]);
      if (
        databaseString(existing[0].route_run_id, 'route_run_id') !== runId ||
        databaseString(existing[0].candidate_id, 'candidate_id') !== candidateId ||
        !payloadEquals(stored, score)
      ) {
        conflict('Immutable Path Score snapshot conflicts with existing content');
      }
    },

    async listScoreSnapshots(runId: string, userId: string): Promise<PathScoreV1[]> {
      const rows = await sql`
        SELECT id, route_run_id, candidate_id, user_id, schema_version, status,
               score_hash, scoring_version, payload, created_at
        FROM route_score_snapshots
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map(scoreFromRow);
    },

    async insertRouteCard(runId: string, input: RouteCardV1): Promise<void> {
      const card = parseRouteCard(input);
      const run = await requireOwnedRun(sql, runId, card.tenantId);
      assertLinkedHash(card.intentHash, run.intentHash, 'routeCard.intentHash');
      const selectedCandidateId = await candidateIdByHash(
        sql,
        runId,
        card.tenantId,
        card.selectedCandidateHash,
      );
      const inserted = await sql`
        INSERT INTO route_cards (
          id, route_run_id, user_id, schema_version, status, route_card_hash,
          selected_candidate_id, payload, created_at, updated_at
        ) VALUES (
          ${card.id}, ${runId}, ${card.tenantId}, ${card.schemaVersion}, ${card.status},
          ${card.routeCardHash}, ${selectedCandidateId}, CAST(${jsonb(card)} AS jsonb),
          ${new Date(card.createdAt)}, ${new Date(card.updatedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) return;
      const existing = await sql`
        SELECT id, route_run_id, user_id, schema_version, status, route_card_hash,
               selected_candidate_id, payload, created_at, updated_at
        FROM route_cards
        WHERE user_id = ${card.tenantId}
          AND (id = ${card.id} OR (route_run_id = ${runId} AND route_card_hash = ${card.routeCardHash}))
        ORDER BY id
        LIMIT 1
      `;
      if (!existing[0]) conflict('Route Card ID is already owned by another tenant');
      const stored = cardFromRow(existing[0]);
      if (
        databaseString(existing[0].route_run_id, 'route_run_id') !== runId ||
        databaseNullableString(existing[0].selected_candidate_id, 'selected_candidate_id') !==
          selectedCandidateId ||
        !payloadEquals(stored, card)
      ) {
        conflict('Route Card versions cannot silently mutate historical content');
      }
    },

    async listRouteCards(runId: string, userId: string): Promise<RouteCardV1[]> {
      const rows = await sql`
        SELECT id, route_run_id, user_id, schema_version, status, route_card_hash,
               selected_candidate_id, payload, created_at, updated_at
        FROM route_cards
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map(cardFromRow);
    },

    async insertBlueprint(
      runId: string,
      input: ExecutionBlueprintV1,
      links: BlueprintStorageLinks = {},
    ): Promise<void> {
      const blueprint = parseExecutionBlueprint(input);
      const run = await requireOwnedRun(sql, runId, blueprint.tenantId);
      assertLinkedHash(blueprint.intentHash, run.intentHash, 'blueprint.intentHash');
      const candidateId = await candidateIdByHash(
        sql,
        runId,
        blueprint.tenantId,
        blueprint.selectedCandidateHash,
      );
      const evidenceSets = await sql`
        SELECT id, route_run_id, candidate_id, user_id, schema_version, status,
               evidence_set_hash, payload, created_at, updated_at
        FROM route_evidence_sets
        WHERE route_run_id = ${runId} AND user_id = ${blueprint.tenantId}
          AND evidence_set_hash = ${blueprint.evidenceSetHash}
        LIMIT 1
      `;
      if (!candidateId || !evidenceSets[0]) {
        throw new RouteStorageIntegrityError(
          'Blueprint references an unstored candidate or Evidence Set',
        );
      }
      const evidenceSet = evidenceSetFromRow(evidenceSets[0]);
      assertLinkedHash(evidenceSet.intentHash, run.intentHash, 'blueprint.evidenceSet.intentHash');
      assertLinkedHash(
        evidenceSet.candidateHash,
        blueprint.selectedCandidateHash,
        'blueprint.evidenceSet.candidateHash',
      );
      if (databaseString(evidenceSets[0].candidate_id, 'candidate_id') !== candidateId) {
        throw new RouteStorageIntegrityError('Blueprint Evidence Set has different lineage');
      }
      const preparedTransactionActionId = links.preparedTransactionActionId ?? null;
      if (preparedTransactionActionId !== null) {
        const prepared = await sql`
          SELECT action_id
          FROM prepared_transaction_intents
          WHERE action_id = ${preparedTransactionActionId} AND user_id = ${blueprint.tenantId}
          LIMIT 1
        `;
        if (!prepared[0]) {
          throw new RouteStorageIntegrityError(
            'Prepared transaction link is missing or belongs to another tenant',
          );
        }
      }
      const inserted = await sql`
        INSERT INTO execution_blueprints (
          id, route_run_id, user_id, wallet_address, chain_id, schema_version,
          status, blueprint_hash, intent_hash, selected_candidate_hash,
          evidence_set_hash, calls_hash, approved_calls_hash,
          prepared_transaction_action_id, payload, expires_at, created_at, updated_at
        ) VALUES (
          ${blueprint.id}, ${runId}, ${blueprint.tenantId}, ${blueprint.walletAddress},
          ${blueprint.chainId}, ${blueprint.schemaVersion}, ${blueprint.status},
          ${blueprint.blueprintHash}, ${blueprint.intentHash},
          ${blueprint.selectedCandidateHash}, ${blueprint.evidenceSetHash},
          ${blueprint.callsHash}, ${blueprint.approvedCallsHash},
          ${preparedTransactionActionId}, CAST(${jsonb(blueprint)} AS jsonb),
          ${new Date(blueprint.quoteExpiry)}, ${new Date(blueprint.createdAt)},
          ${new Date(blueprint.updatedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) return;
      const existing = await sql`
        SELECT id, route_run_id, user_id, wallet_address, chain_id, schema_version,
               status, blueprint_hash, intent_hash, selected_candidate_hash,
               evidence_set_hash, calls_hash, approved_calls_hash,
               prepared_transaction_action_id, payload, expires_at, created_at, updated_at
        FROM execution_blueprints
        WHERE user_id = ${blueprint.tenantId}
          AND (id = ${blueprint.id} OR (route_run_id = ${runId} AND blueprint_hash = ${blueprint.blueprintHash}))
        ORDER BY id
        LIMIT 1
      `;
      if (!existing[0]) conflict('Blueprint ID is already owned by another tenant');
      const stored = blueprintFromRow(existing[0]);
      if (
        databaseString(existing[0].route_run_id, 'route_run_id') !== runId ||
        stored.preparedTransactionActionId !== preparedTransactionActionId ||
        !payloadEquals(stored.blueprint, blueprint)
      ) {
        conflict('Blueprint ID or run-scoped hash has different content');
      }
    },

    async listBlueprints(runId: string, userId: string): Promise<StoredBlueprintV1[]> {
      const rows = await sql`
        SELECT id, route_run_id, user_id, wallet_address, chain_id, schema_version,
               status, blueprint_hash, intent_hash, selected_candidate_hash,
               evidence_set_hash, calls_hash, approved_calls_hash,
               prepared_transaction_action_id, payload, expires_at, created_at, updated_at
        FROM execution_blueprints
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map(blueprintFromRow);
    },

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
      const rows = await sql`
        SELECT id, route_run_id, user_id, wallet_address, chain_id, schema_version,
               status, blueprint_hash, intent_hash, selected_candidate_hash,
               evidence_set_hash, calls_hash, approved_calls_hash,
               prepared_transaction_action_id, payload, expires_at, created_at, updated_at
        FROM execution_blueprints
        WHERE id = ${blueprintId} AND route_run_id = ${runId} AND user_id = ${userId}
        LIMIT 1
      `;
      if (!rows[0]) {
        throw new RouteStorageIntegrityError('Blueprint does not exist for this Route Run and tenant');
      }
      const current = blueprintFromRow(rows[0]).blueprint;
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
      await sql`
        UPDATE execution_blueprints
        SET status = ${approved.status},
            approved_calls_hash = ${approved.approvedCallsHash},
            payload = CAST(${jsonb(approved)} AS jsonb),
            updated_at = ${new Date(approved.updatedAt)}
        WHERE id = ${blueprintId} AND route_run_id = ${runId} AND user_id = ${userId}
      `;
      return approved;
    },

    async upsertProofProjection(runId: string, input: RouteProofV1): Promise<void> {
      const proof = parseRouteProof(input);
      const run = await requireOwnedRun(sql, runId, proof.tenantId);
      assertLinkedHash(proof.intentHash, run.intentHash, 'proof.intentHash');
      const blueprintRows = await sql`
        SELECT id, route_run_id, user_id, wallet_address, chain_id, schema_version,
               status, blueprint_hash, intent_hash, selected_candidate_hash,
               evidence_set_hash, calls_hash, approved_calls_hash,
               prepared_transaction_action_id, payload, expires_at, created_at, updated_at
        FROM execution_blueprints
        WHERE route_run_id = ${runId} AND user_id = ${proof.tenantId}
          AND blueprint_hash = ${proof.blueprintHash}
        LIMIT 1
      `;
      if (!blueprintRows[0]) {
        throw new RouteStorageIntegrityError('Route Proof references an unstored Blueprint');
      }
      const storedBlueprint = blueprintFromRow(blueprintRows[0]);
      assertLinkedHash(
        proof.selectedCandidateHash,
        storedBlueprint.blueprint.selectedCandidateHash,
        'proof.selectedCandidateHash',
      );
      assertLinkedHash(
        proof.evidenceSetHash,
        storedBlueprint.blueprint.evidenceSetHash,
        'proof.evidenceSetHash',
      );
      assertLinkedHash(
        proof.approvedCallsHash,
        storedBlueprint.blueprint.callsHash,
        'proof.approvedCallsHash',
      );
      const blueprintId = databaseString(blueprintRows[0].id, 'blueprint_id');
      const conflictingHash = await sql`
        SELECT id
        FROM route_proofs
        WHERE route_run_id = ${runId} AND user_id = ${proof.tenantId}
          AND proof_hash = ${proof.proofHash} AND id <> ${proof.id}
        LIMIT 1
      `;
      if (conflictingHash[0]) conflict('Route Proof hash belongs to another projection');
      const existing = await sql`
        SELECT id, route_run_id, blueprint_id, user_id, schema_version, status,
               proof_hash, approved_calls_hash, payload, created_at, updated_at, finalized_at
        FROM route_proofs
        WHERE id = ${proof.id}
        LIMIT 1
      `;
      if (
        existing[0] &&
        (databaseString(existing[0].route_run_id, 'route_run_id') !== runId ||
          databaseString(existing[0].user_id, 'user_id') !== proof.tenantId ||
          databaseString(existing[0].blueprint_id, 'blueprint_id') !== blueprintId)
      ) {
        conflict('Route Proof projection ID is bound to different lineage');
      }
      await sql`
        INSERT INTO route_proofs (
          id, route_run_id, blueprint_id, user_id, schema_version, status,
          proof_hash, approved_calls_hash, payload, created_at, updated_at, finalized_at
        ) VALUES (
          ${proof.id}, ${runId}, ${blueprintId}, ${proof.tenantId}, ${proof.schemaVersion},
          ${proof.status}, ${proof.proofHash}, ${proof.approvedCallsHash},
          CAST(${jsonb(proof)} AS jsonb), ${new Date(proof.createdAt)},
          ${new Date(proof.updatedAt)},
          ${['completed', 'partial_failure', 'failed', 'cancelled'].includes(proof.finalStatus) ? new Date(proof.updatedAt) : null}
        )
        ON CONFLICT (id) DO UPDATE SET
          schema_version = EXCLUDED.schema_version,
          status = EXCLUDED.status,
          proof_hash = EXCLUDED.proof_hash,
          approved_calls_hash = EXCLUDED.approved_calls_hash,
          payload = EXCLUDED.payload,
          updated_at = EXCLUDED.updated_at,
          finalized_at = EXCLUDED.finalized_at
        WHERE route_proofs.route_run_id = EXCLUDED.route_run_id
          AND route_proofs.blueprint_id = EXCLUDED.blueprint_id
          AND route_proofs.user_id = EXCLUDED.user_id
      `;
    },

    async getProofProjection(id: string, userId: string): Promise<RouteProofV1 | null> {
      const rows = await sql`
        SELECT id, route_run_id, blueprint_id, user_id, schema_version, status,
               proof_hash, approved_calls_hash, payload, created_at, updated_at, finalized_at
        FROM route_proofs
        WHERE id = ${id} AND user_id = ${userId}
        LIMIT 1
      `;
      return rows[0] ? proofFromRow(rows[0]) : null;
    },

    async appendProofEvent(proofId: string, input: RouteProofEventV1): Promise<void> {
      const event = parseRouteProofEvent(input);
      const proofs = await sql`
        SELECT id, route_run_id, blueprint_id, user_id, schema_version, status,
               proof_hash, approved_calls_hash, payload, created_at, updated_at, finalized_at
        FROM route_proofs
        WHERE id = ${proofId} AND user_id = ${event.tenantId}
        LIMIT 1
      `;
      if (!proofs[0]) {
        throw new RouteStorageIntegrityError('Route Proof event references an unknown proof');
      }
      const proof = proofFromRow(proofs[0]);
      if (event.routeProofId !== proofId) {
        throw new RouteStorageIntegrityError('Route Proof event ID does not match its proof');
      }
      assertLinkedHash(event.intentHash, proof.intentHash, 'event.intentHash');
      assertLinkedHash(event.candidateHash, proof.selectedCandidateHash, 'event.candidateHash');
      assertLinkedHash(event.blueprintHash, proof.blueprintHash, 'event.blueprintHash');
      const inserted = await sql`
        INSERT INTO route_proof_events (
          id, route_proof_id, route_run_id, user_id, schema_version, status,
          event_type, event_hash, sequence, payload, created_at
        ) VALUES (
          ${event.id}, ${proofId}, ${databaseString(proofs[0].route_run_id, 'route_run_id')},
          ${event.tenantId}, ${event.schemaVersion}, ${event.status}, ${event.eventType},
          ${event.eventHash}, ${event.eventIndex}, CAST(${jsonb(event)} AS jsonb),
          ${new Date(event.createdAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (!inserted[0]) {
        conflict('Append-only Route Proof event sequence, hash, or ID already exists');
      }
    },

    async listProofEvents(proofId: string, userId: string): Promise<RouteProofEventV1[]> {
      const rows = await sql`
        SELECT id, route_proof_id, route_run_id, user_id, schema_version, status,
               event_type, event_hash, sequence, payload, created_at
        FROM route_proof_events
        WHERE route_proof_id = ${proofId} AND user_id = ${userId}
        ORDER BY sequence, id
      `;
      return rows.map(eventFromRow);
    },

    async listRouteRunHistory(
      userId: string,
      params: RouteRunHistoryParamsV1,
    ): Promise<RouteRunHistoryPageV1> {
      const cursor = params.cursor ? decodeRouteHistoryCursorV1(params.cursor) : null;
      // Page query leans on the existing (user_id, status, created_at) index
      // prefix — NO new DDL. Keyset (created_at, id) cursor, newest first.
      const runRows = cursor
        ? await sql`
            SELECT id, user_id, wallet_address, chain_id, schema_version, status,
                   intent_hash, intent_payload, idempotency_key, created_at, updated_at, completed_at
            FROM route_runs
            WHERE user_id = ${userId}
              AND (created_at, id) < (${new Date(cursor.createdAt)}, ${cursor.id})
            ORDER BY created_at DESC, id DESC
            LIMIT ${params.limit + 1}
          `
        : await sql`
            SELECT id, user_id, wallet_address, chain_id, schema_version, status,
                   intent_hash, intent_payload, idempotency_key, created_at, updated_at, completed_at
            FROM route_runs
            WHERE user_id = ${userId}
            ORDER BY created_at DESC, id DESC
            LIMIT ${params.limit + 1}
          `;
      const hasMore = runRows.length > params.limit;
      const pageRows = runRows.slice(0, params.limit);
      const runs = pageRows.map(routeRunFromRow);
      const runIds = runs.map((run) => run.id);

      // Two batched joins for the whole page (never N-per-item round trips).
      const blueprintRows = runIds.length
        ? await sql`
            SELECT id, route_run_id, user_id, wallet_address, chain_id, schema_version,
                   status, blueprint_hash, intent_hash, selected_candidate_hash,
                   evidence_set_hash, calls_hash, approved_calls_hash,
                   prepared_transaction_action_id, payload, expires_at, created_at, updated_at
            FROM execution_blueprints
            WHERE user_id = ${userId} AND route_run_id = ANY(${runIds})
            ORDER BY created_at, id
          `
        : [];
      const proofRows = runIds.length
        ? await sql`
            SELECT id, route_run_id, blueprint_id, user_id, schema_version, status,
                   proof_hash, approved_calls_hash, payload, created_at, updated_at, finalized_at
            FROM route_proofs
            WHERE user_id = ${userId} AND route_run_id = ANY(${runIds})
            ORDER BY created_at, id
          `
        : [];

      const latestBlueprintByRun = new Map<string, { id: string; status: string }>();
      const blueprintById = new Map<string, { id: string; status: string; runId: string }>();
      for (const row of blueprintRows) {
        const stored = blueprintFromRow(row);
        const runId = databaseString(row.route_run_id, 'route_run_id');
        const entry = { id: stored.blueprint.id, status: stored.blueprint.status, runId };
        blueprintById.set(entry.id, entry);
        latestBlueprintByRun.set(runId, entry);
      }
      const latestProofByRun = new Map<
        string,
        { id: string; blueprintId: string; finalStatus: string; reconciliationState: string }
      >();
      for (const row of proofRows) {
        const proof = proofFromRow(row);
        latestProofByRun.set(databaseString(row.route_run_id, 'route_run_id'), {
          id: proof.id,
          blueprintId: databaseString(row.blueprint_id, 'blueprint_id'),
          finalStatus: proof.finalStatus,
          reconciliationState: proof.reconciliationState,
        });
      }

      const items: RouteRunHistoryItemV1[] = runs.map((run) => {
        const proof = latestProofByRun.get(run.id) ?? null;
        const blueprint =
          (proof ? blueprintById.get(proof.blueprintId) : undefined) ?? latestBlueprintByRun.get(run.id) ?? null;
        return {
          routeRunId: run.id,
          createdAt: run.createdAt,
          runStatus: run.status,
          intentHash: run.intentHash,
          intentSummary: summarizeRouteIntentV1({
            goal: run.intent.goal,
            fromAsset: run.intent.fromAsset,
            toAsset: run.intent.toAsset,
            amount: run.intent.amount,
            intentHash: run.intentHash,
          }),
          blueprintId: blueprint?.id ?? null,
          blueprintStatus: blueprint?.status ?? null,
          proofId: proof?.id ?? null,
          proofFinalStatus: proof?.finalStatus ?? null,
          reconciliationState: proof?.reconciliationState ?? null,
          provider: null,
        };
      });

      const last = runs.at(-1);
      const nextCursor =
        hasMore && last ? encodeRouteHistoryCursorV1({ createdAt: last.createdAt, id: last.id }) : null;
      return { items, nextCursor };
    },

    async insertIntelligenceCharge(
      runId: string,
      input: IntelligenceChargeV1,
      links: IntelligenceChargeStorageLinks = {},
    ): Promise<void> {
      const charge = parseIntelligenceCharge(input);
      const run = await requireOwnedRun(sql, runId, charge.tenantId);
      assertLinkedHash(charge.intentHash, run.intentHash, 'charge.intentHash');
      const evidenceId = links.evidenceId ?? null;
      if (evidenceId !== null) {
        const evidenceRows = await sql`
          SELECT id, route_run_id, candidate_id, user_id, schema_version, status,
                 evidence_type, provider_id, evidence_hash, payload, observed_at,
                 expires_at, validation_status, created_at, updated_at
          FROM route_evidence
          WHERE id = ${evidenceId} AND route_run_id = ${runId}
            AND user_id = ${charge.tenantId}
          LIMIT 1
        `;
        if (!evidenceRows[0]) {
          throw new RouteStorageIntegrityError('Intelligence Charge evidence link is invalid');
        }
        const evidence = evidenceFromRow(evidenceRows[0]);
        if (charge.evidenceHash !== evidence.evidenceHash) {
          throw new RouteStorageIntegrityError(
            'Intelligence Charge evidence hash does not match link',
          );
        }
      }
      if (charge.spendPermissionId !== null) {
        const permissions = await sql`
          SELECT id
          FROM spend_permissions
          WHERE id = ${charge.spendPermissionId} AND user_id = ${charge.tenantId}
          LIMIT 1
        `;
        if (!permissions[0]) {
          throw new RouteStorageIntegrityError(
            'Spend Permission link is missing or belongs to another tenant',
          );
        }
      }
      const x402ReceiptId = links.x402ReceiptId ?? null;
      if (x402ReceiptId !== null) {
        const receipts = await sql`
          SELECT id
          FROM x402_receipts
          WHERE id = ${x402ReceiptId} AND user_id = ${charge.tenantId}
          LIMIT 1
        `;
        if (!receipts[0]) {
          throw new RouteStorageIntegrityError(
            'x402 receipt link is missing or belongs to another tenant',
          );
        }
      }
      const inserted = await sql`
        INSERT INTO intelligence_charges (
          id, route_run_id, evidence_id, user_id, schema_version, status,
          charge_hash, spend_permission_id, x402_receipt_id, payload, created_at, updated_at
        ) VALUES (
          ${charge.id}, ${runId}, ${evidenceId}, ${charge.tenantId},
          ${charge.schemaVersion}, ${charge.status}, ${charge.chargeHash},
          ${charge.spendPermissionId}, ${x402ReceiptId}, CAST(${jsonb(charge)} AS jsonb),
          ${new Date(charge.createdAt)}, ${new Date(charge.updatedAt)}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) return;
      const existing = await sql`
        SELECT id, route_run_id, evidence_id, user_id, schema_version, status,
               charge_hash, spend_permission_id, x402_receipt_id, payload, created_at, updated_at
        FROM intelligence_charges
        WHERE user_id = ${charge.tenantId}
          AND (id = ${charge.id} OR (route_run_id = ${runId} AND charge_hash = ${charge.chargeHash}))
        ORDER BY id
        LIMIT 1
      `;
      if (!existing[0]) conflict('Intelligence Charge ID is already owned by another tenant');
      const stored = chargeFromRow(existing[0]);
      if (
        databaseString(existing[0].route_run_id, 'route_run_id') !== runId ||
        stored.evidenceId !== evidenceId ||
        stored.x402ReceiptId !== x402ReceiptId ||
        !payloadEquals(stored.charge, charge)
      ) {
        conflict('Intelligence Charge ID or run-scoped hash has different content');
      }
    },

    async listIntelligenceCharges(
      runId: string,
      userId: string,
    ): Promise<StoredIntelligenceChargeV1[]> {
      const rows = await sql`
        SELECT id, route_run_id, evidence_id, user_id, schema_version, status,
               charge_hash, spend_permission_id, x402_receipt_id, payload, created_at, updated_at
        FROM intelligence_charges
        WHERE route_run_id = ${runId} AND user_id = ${userId}
        ORDER BY created_at, id
      `;
      return rows.map(chargeFromRow);
    },

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
      const rows = await sql`
        SELECT id, route_run_id, evidence_id, user_id, schema_version, status,
               charge_hash, spend_permission_id, x402_receipt_id, payload, created_at, updated_at
        FROM intelligence_charges
        WHERE id = ${chargeId} AND route_run_id = ${runId} AND user_id = ${userId}
        LIMIT 1
      `;
      if (!rows[0]) {
        throw new RouteStorageIntegrityError(
          'Intelligence Charge does not exist for this Route Run and tenant',
        );
      }
      const stored = chargeFromRow(rows[0]);
      const current = stored.charge;
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
        const evidenceRows = await sql`
          SELECT id, route_run_id, candidate_id, user_id, schema_version, status,
                 evidence_type, provider_id, evidence_hash, payload, observed_at,
                 expires_at, validation_status, created_at, updated_at
          FROM route_evidence
          WHERE id = ${nextEvidenceId} AND route_run_id = ${runId}
            AND user_id = ${userId}
          LIMIT 1
        `;
        if (!evidenceRows[0]) {
          throw new RouteStorageIntegrityError('Intelligence Charge evidence link is invalid');
        }
        const evidence = evidenceFromRow(evidenceRows[0]);
        if (updated.evidenceHash !== evidence.evidenceHash) {
          throw new RouteStorageIntegrityError(
            'Intelligence Charge evidence hash does not match link',
          );
        }
      }

      if (updated.chargeHash !== current.chargeHash) {
        const conflictingHash = await sql`
          SELECT id
          FROM intelligence_charges
          WHERE route_run_id = ${runId} AND charge_hash = ${updated.chargeHash} AND id <> ${chargeId}
          LIMIT 1
        `;
        if (conflictingHash[0]) {
          conflict('Intelligence Charge run-scoped hash is already assigned to another charge');
        }
      }

      await sql`
        UPDATE intelligence_charges
        SET status = ${updated.status},
            charge_hash = ${updated.chargeHash},
            evidence_id = ${nextEvidenceId},
            x402_receipt_id = ${nextX402ReceiptId},
            payload = CAST(${jsonb(updated)} AS jsonb),
            updated_at = ${new Date(updated.updatedAt)}
        WHERE id = ${chargeId} AND route_run_id = ${runId} AND user_id = ${userId}
      `;
    },

    async findIntelligenceChargeByReceiptHash(
      userId: string,
      x402ReceiptHash: string,
    ): Promise<StoredIntelligenceChargeV1 | null> {
      // T59 rework M2: tenant-wide payload-field scan — deliberately no new
      // index/DDL (per-tenant charge volumes are small).
      const rows = await sql`
        SELECT id, route_run_id, evidence_id, user_id, schema_version, status,
               charge_hash, spend_permission_id, x402_receipt_id, payload, created_at, updated_at
        FROM intelligence_charges
        WHERE user_id = ${userId} AND payload->>'x402ReceiptHash' = ${x402ReceiptHash}
        ORDER BY created_at, id
        LIMIT 1
      `;
      return rows[0] ? chargeFromRow(rows[0]) : null;
    },
  };
}
