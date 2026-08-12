import type { RouteProofEventV1, RouteProofV1 } from '@mioagent/route-domain';
import {
  assertB20EntryProofEventV1,
  assertB20EntryProofV1,
  assertB20ProofStorageBindingV1,
  type B20EntryRouteProofRepositoryV1,
} from './b20EntryProofs.js';
import { RouteStorageConflictError, RouteStorageIntegrityError } from './types.js';

const STICKY_FINAL_V1 = new Set(['completed', 'partial_failure', 'failed', 'cancelled']);

export class InMemoryB20EntryRouteProofRepositoryV1 implements B20EntryRouteProofRepositoryV1 {
  private readonly proofs = new Map<string, { planId: string; attemptId: string; proof: RouteProofV1 }>();
  private readonly events = new Map<string, RouteProofEventV1[]>();

  async upsertProof(input: Parameters<B20EntryRouteProofRepositoryV1['upsertProof']>[0]): Promise<RouteProofV1> {
    const proof = assertB20EntryProofV1(input.proof, 'write');
    assertB20ProofStorageBindingV1({ ...input, proof });
    const existing = this.proofs.get(proof.id);
    if (existing) {
      if (existing.planId !== input.plan.id || existing.attemptId !== input.attempt.id) {
        throw new RouteStorageConflictError('B20 Route Proof id is bound to a different plan or attempt');
      }
      if (
        (STICKY_FINAL_V1.has(existing.proof.finalStatus) || existing.proof.reconciliationState === 'manual_review') &&
        existing.proof.proofHash !== proof.proofHash
      ) {
        throw new RouteStorageConflictError('A finalized B20 Route Proof cannot be rewritten');
      }
    }
    this.proofs.set(proof.id, { planId: input.plan.id, attemptId: input.attempt.id, proof });
    return assertB20EntryProofV1(proof, 'read');
  }

  async getProofForPlan(input: { planId: string; tenantId: string; walletAddress: string }): Promise<RouteProofV1 | null> {
    const row = [...this.proofs.values()]
      .filter(
      (candidate) =>
        candidate.planId === input.planId &&
        candidate.proof.tenantId === input.tenantId &&
        candidate.proof.walletAddress === input.walletAddress.toLowerCase(),
      )
      .sort((left, right) => Date.parse(right.proof.createdAt) - Date.parse(left.proof.createdAt))[0];
    return row ? assertB20EntryProofV1(row.proof, 'read') : null;
  }

  async getProofForAttempt(input: { attemptId: string; tenantId: string }): Promise<RouteProofV1 | null> {
    const row = [...this.proofs.values()].find(
      (candidate) => candidate.attemptId === input.attemptId && candidate.proof.tenantId === input.tenantId,
    );
    return row ? assertB20EntryProofV1(row.proof, 'read') : null;
  }

  async appendEvent(proofId: string, input: RouteProofEventV1): Promise<void> {
    const event = assertB20EntryProofEventV1(input, 'write');
    const row = this.proofs.get(proofId);
    if (!row || event.routeProofId !== proofId || row.proof.tenantId !== event.tenantId) {
      throw new RouteStorageIntegrityError('B20 Route Proof event references an unknown proof');
    }
    if (
      event.intentHash !== row.proof.intentHash ||
      event.candidateHash !== row.proof.selectedCandidateHash ||
      event.evidenceSetHash !== row.proof.evidenceSetHash ||
      event.blueprintHash !== row.proof.blueprintHash ||
      event.approvedCallsHash !== row.proof.approvedCallsHash
    ) {
      throw new RouteStorageIntegrityError('B20 Route Proof event lineage does not match its proof');
    }
    const events = this.events.get(proofId) ?? [];
    const same = events.find((candidate) => candidate.id === event.id || candidate.eventIndex === event.eventIndex);
    if (same) {
      if (same.eventHash === event.eventHash) return;
      throw new RouteStorageConflictError('B20 Route Proof event sequence is append-only');
    }
    const previous = events[events.length - 1] ?? null;
    if (event.eventIndex !== events.length || event.previousEventHash !== (previous?.eventHash ?? null)) {
      throw new RouteStorageConflictError('B20 Route Proof event does not extend the current hash chain');
    }
    this.events.set(proofId, [...events, event]);
  }

  async listEvents(proofId: string, tenantId: string): Promise<RouteProofEventV1[]> {
    const row = this.proofs.get(proofId);
    if (!row || row.proof.tenantId !== tenantId) return [];
    return (this.events.get(proofId) ?? []).map((event) => assertB20EntryProofEventV1(event, 'read'));
  }
}
