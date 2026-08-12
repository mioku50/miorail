import type { RouteProofEventV1, RouteProofV1 } from '@mioagent/route-domain';
import {
  assertB20EntryProofEventV1,
  assertB20EntryProofV1,
  assertB20ProofStorageBindingV1,
  type B20EntryRouteProofRepositoryV1,
} from './b20EntryProofs.js';
import type { SqlTemplateExecutor } from './types.js';
import { RouteStorageConflictError, RouteStorageIntegrityError } from './types.js';

function proofFromRowV1(row: Record<string, unknown>): RouteProofV1 {
  return assertB20EntryProofV1(row.payload, 'read');
}

function eventFromRowV1(row: Record<string, unknown>): RouteProofEventV1 {
  return assertB20EntryProofEventV1(row.payload, 'read');
}

const STICKY_FINAL_V1 = new Set(['completed', 'partial_failure', 'failed', 'cancelled']);

export function createDatabaseB20EntryRouteProofRepository(
  sql: SqlTemplateExecutor,
): B20EntryRouteProofRepositoryV1 {
  return {
    async upsertProof(input) {
      const proof = assertB20EntryProofV1(input.proof, 'write');
      assertB20ProofStorageBindingV1({ ...input, proof });
      const rows = await sql`
        SELECT proof.payload, proof.plan_id, proof.attempt_id
        FROM b20_entry_route_proofs proof
        WHERE proof.id = ${proof.id}
        LIMIT 1`;
      if (rows[0]) {
        const existing = proofFromRowV1(rows[0] as Record<string, unknown>);
        if (String(rows[0].plan_id) !== input.plan.id || String(rows[0].attempt_id) !== input.attempt.id) {
          throw new RouteStorageConflictError('B20 Route Proof id is bound to a different plan or attempt');
        }
        if (
          (STICKY_FINAL_V1.has(existing.finalStatus) || existing.reconciliationState === 'manual_review') &&
          existing.proofHash !== proof.proofHash
        ) {
          throw new RouteStorageConflictError('A finalized B20 Route Proof cannot be rewritten');
        }
      }
      const updated = await sql`
        INSERT INTO b20_entry_route_proofs (
          id, tenant_id, wallet_address, chain_id, plan_id, attempt_id,
          schema_version, status, proof_hash, intent_hash, candidate_hash,
          evidence_set_hash, blueprint_hash, approved_calls_hash, payload,
          created_at, updated_at, finalized_at
        ) VALUES (
          ${proof.id}, ${proof.tenantId}, ${proof.walletAddress}, ${proof.chainId},
          ${input.plan.id}, ${input.attempt.id}, ${proof.schemaVersion}, ${proof.finalStatus},
          ${proof.proofHash}, ${proof.intentHash}, ${proof.selectedCandidateHash},
          ${proof.evidenceSetHash}, ${proof.blueprintHash}, ${proof.approvedCallsHash},
          ${JSON.stringify(proof)}::jsonb, ${proof.createdAt}, ${proof.updatedAt},
          ${proof.finalStatus === 'pending' || proof.finalStatus === 'reconciliation_required' ? null : proof.updatedAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          proof_hash = EXCLUDED.proof_hash,
          payload = EXCLUDED.payload,
          updated_at = EXCLUDED.updated_at,
          finalized_at = EXCLUDED.finalized_at
        WHERE b20_entry_route_proofs.plan_id = EXCLUDED.plan_id
          AND b20_entry_route_proofs.attempt_id = EXCLUDED.attempt_id
          AND b20_entry_route_proofs.tenant_id = EXCLUDED.tenant_id
        RETURNING payload`;
      if (!updated[0]) throw new RouteStorageConflictError('B20 Route Proof update lost its lineage binding');
      return proofFromRowV1(updated[0] as Record<string, unknown>);
    },

    async getProofForPlan(input) {
      const rows = await sql`
        SELECT payload FROM b20_entry_route_proofs
        WHERE plan_id = ${input.planId}
          AND tenant_id = ${input.tenantId}
          AND wallet_address = ${input.walletAddress.toLowerCase()}
        ORDER BY created_at DESC, id DESC
        LIMIT 1`;
      return rows[0] ? proofFromRowV1(rows[0] as Record<string, unknown>) : null;
    },

    async getProofForAttempt(input) {
      const rows = await sql`
        SELECT payload FROM b20_entry_route_proofs
        WHERE attempt_id = ${input.attemptId} AND tenant_id = ${input.tenantId}
        LIMIT 1`;
      return rows[0] ? proofFromRowV1(rows[0] as Record<string, unknown>) : null;
    },

    async appendEvent(proofId, input) {
      const event = assertB20EntryProofEventV1(input, 'write');
      const proofs = await sql`
        SELECT payload FROM b20_entry_route_proofs
        WHERE id = ${proofId} AND tenant_id = ${event.tenantId}
        LIMIT 1`;
      if (!proofs[0] || event.routeProofId !== proofId) {
        throw new RouteStorageIntegrityError('B20 Route Proof event references an unknown proof');
      }
      const proof = proofFromRowV1(proofs[0] as Record<string, unknown>);
      if (
        event.intentHash !== proof.intentHash ||
        event.candidateHash !== proof.selectedCandidateHash ||
        event.evidenceSetHash !== proof.evidenceSetHash ||
        event.blueprintHash !== proof.blueprintHash ||
        event.approvedCallsHash !== proof.approvedCallsHash
      ) {
        throw new RouteStorageIntegrityError('B20 Route Proof event lineage does not match its proof');
      }
      const existing = await sql`
        SELECT payload FROM b20_entry_route_proof_events
        WHERE route_proof_id = ${proofId} AND sequence = ${event.eventIndex}
        LIMIT 1`;
      if (existing[0]) {
        const stored = eventFromRowV1(existing[0] as Record<string, unknown>);
        if (stored.eventHash === event.eventHash) return;
        throw new RouteStorageConflictError('B20 Route Proof event sequence is append-only');
      }
      const tail = await sql`
        SELECT event_hash FROM b20_entry_route_proof_events
        WHERE route_proof_id = ${proofId}
        ORDER BY sequence DESC LIMIT 1`;
      const previousHash = tail[0] ? String(tail[0].event_hash) : null;
      const expectedIndex = tail[0]
        ? Number((await sql`SELECT count(*)::int AS count FROM b20_entry_route_proof_events WHERE route_proof_id = ${proofId}`)[0]?.count ?? 0)
        : 0;
      if (event.eventIndex !== expectedIndex || event.previousEventHash !== previousHash) {
        throw new RouteStorageConflictError('B20 Route Proof event does not extend the current hash chain');
      }
      const inserted = await sql`
        INSERT INTO b20_entry_route_proof_events (
          id, route_proof_id, tenant_id, schema_version, event_type,
          event_hash, sequence, payload, created_at
        ) VALUES (
          ${event.id}, ${proofId}, ${event.tenantId}, ${event.schemaVersion},
          ${event.eventType}, ${event.eventHash}, ${event.eventIndex},
          ${JSON.stringify(event)}::jsonb, ${event.createdAt}
        )
        ON CONFLICT DO NOTHING RETURNING id`;
      if (!inserted[0]) {
        // A concurrent request may have appended the same deterministic event
        // after the read above. Re-read before classifying an idempotent retry
        // as an append-only conflict.
        const raced = await sql`
          SELECT payload FROM b20_entry_route_proof_events
          WHERE route_proof_id = ${proofId} AND sequence = ${event.eventIndex}
          LIMIT 1`;
        if (
          raced[0] &&
          eventFromRowV1(raced[0] as Record<string, unknown>).eventHash === event.eventHash
        ) return;
        throw new RouteStorageConflictError('B20 Route Proof event append conflicted');
      }
    },

    async listEvents(proofId, tenantId) {
      const rows = await sql`
        SELECT event.payload
        FROM b20_entry_route_proof_events event
        JOIN b20_entry_route_proofs proof ON proof.id = event.route_proof_id
        WHERE event.route_proof_id = ${proofId} AND proof.tenant_id = ${tenantId}
        ORDER BY event.sequence`;
      return rows.map((row) => eventFromRowV1(row as Record<string, unknown>));
    },
  };
}
