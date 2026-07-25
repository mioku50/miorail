import type {
  CommerceCandidateV1,
  CommerceEvidenceV1,
  CommerceOrderEventV1,
  CommerceOrderV1,
  CommerceRouteCardV1,
  CommerceRouteIntentV1,
  CommerceRouteProofV1,
} from '@mioagent/route-domain';
import { RouteStorageConflictError, RouteStorageIntegrityError } from './types.js';
import {
  assertCommerceTenantV1,
  parseCommerceCandidateV1,
  parseCommerceEvidenceV1,
  parseCommerceIntentV1,
  parseCommerceOrderEventV1,
  parseCommerceOrderV1,
  parseCommerceProofV1,
  parseCommerceRouteCardV1,
  type CommerceHistoryItemV1,
  type CommerceOrderRecordV1,
  type CommerceRouteRunRecordV1,
  type CommerceStorageRepository,
  type ReserveCommerceOrderInputV1,
  type ReserveCommerceOrderResultV1,
} from './commerce.js';

// ---------------------------------------------------------------------------
// In-memory CommerceStorageRepository — the tests' repository, and the one the
// invariants are easiest to read in. It enforces the SAME rules as the
// database implementation: tenant isolation on every path, one order row per
// idempotency key, and no write that invents an invoice.
// ---------------------------------------------------------------------------

interface MemoryRun {
  record: CommerceRouteRunRecordV1;
  candidates: Map<string, CommerceCandidateV1>;
  evidence: Map<string, CommerceEvidenceV1>;
  cards: Map<string, CommerceRouteCardV1>;
}

export function createMemoryCommerceStorageRepository(): CommerceStorageRepository {
  const runs = new Map<string, MemoryRun>();
  const runsByIdempotency = new Map<string, string>();
  const orders = new Map<string, CommerceOrderRecordV1>();
  const ordersByIdempotency = new Map<string, string>();
  const events = new Map<string, CommerceOrderEventV1[]>();
  const proofs = new Map<string, CommerceRouteProofV1>();
  let sequence = 0;

  function requireRun(runId: string, userId: string): MemoryRun {
    const run = runs.get(runId);
    if (!run) throw new RouteStorageIntegrityError('Commerce route run not found');
    assertCommerceTenantV1(run.record.userId, userId);
    return run;
  }

  function requireOrder(orderId: string, userId: string): CommerceOrderRecordV1 {
    const record = orders.get(orderId);
    if (!record) throw new RouteStorageIntegrityError('Commerce order not found');
    assertCommerceTenantV1(record.userId, userId);
    return record;
  }

  return {
    async createCommerceRouteRun(input: CommerceRouteIntentV1, idempotencyKey: string) {
      const intent = parseCommerceIntentV1(input);
      if (idempotencyKey.trim().length === 0) {
        throw new RouteStorageIntegrityError('Commerce route run idempotency key must not be empty');
      }
      const scoped = `${intent.tenantId}|${idempotencyKey}`;
      const existingId = runsByIdempotency.get(scoped);
      if (existingId) {
        const existing = runs.get(existingId)!;
        if (existing.record.intentHash !== intent.intentHash) {
          throw new RouteStorageConflictError('Commerce idempotency key has different content');
        }
        return existing.record;
      }
      const existingById = runs.get(intent.id);
      if (existingById) {
        assertCommerceTenantV1(existingById.record.userId, intent.tenantId);
        return existingById.record;
      }
      const record: CommerceRouteRunRecordV1 = {
        id: intent.id,
        userId: intent.tenantId,
        walletAddress: intent.walletAddress,
        chainId: intent.chainId,
        goal: 'commerce',
        status: intent.status,
        intentHash: intent.intentHash,
        idempotencyKey,
        intent,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
      };
      runs.set(record.id, { record, candidates: new Map(), evidence: new Map(), cards: new Map() });
      runsByIdempotency.set(scoped, record.id);
      return record;
    },

    async getCommerceRouteRun(id: string, userId: string) {
      const run = runs.get(id);
      if (!run || run.record.userId !== userId) return null;
      return run.record;
    },

    async insertCommerceCandidate(runId: string, input: CommerceCandidateV1) {
      const candidate = parseCommerceCandidateV1(input);
      const run = requireRun(runId, candidate.tenantId);
      if (candidate.intentHash !== run.record.intentHash) {
        throw new RouteStorageIntegrityError('Commerce candidate intentHash does not match its run');
      }
      run.candidates.set(candidate.candidateHash, candidate);
    },

    async listCommerceCandidates(runId: string, userId: string) {
      return [...requireRun(runId, userId).candidates.values()];
    },

    async insertCommerceEvidence(runId: string, candidateHash: string | null, input: CommerceEvidenceV1) {
      const evidence = parseCommerceEvidenceV1(input);
      const run = requireRun(runId, evidence.tenantId);
      if (candidateHash !== null && !run.candidates.has(candidateHash)) {
        throw new RouteStorageIntegrityError('Commerce evidence references an unknown candidate');
      }
      run.evidence.set(evidence.evidenceHash, evidence);
    },

    async listCommerceEvidence(runId: string, userId: string) {
      return [...requireRun(runId, userId).evidence.values()];
    },

    async insertCommerceRouteCard(runId: string, input: CommerceRouteCardV1) {
      const card = parseCommerceRouteCardV1(input);
      const run = requireRun(runId, card.tenantId);
      if (card.intentHash !== run.record.intentHash) {
        throw new RouteStorageIntegrityError('Commerce route card intentHash does not match its run');
      }
      run.cards.set(card.routeCardHash, card);
    },

    async listCommerceRouteCards(runId: string, userId: string) {
      return [...requireRun(runId, userId).cards.values()];
    },

    async reserveCommerceOrder(input: ReserveCommerceOrderInputV1): Promise<ReserveCommerceOrderResultV1> {
      requireRun(input.routeRunId, input.userId);
      const scoped = `${input.userId}|${input.idempotencyKey}`;
      const existingId = ordersByIdempotency.get(scoped);
      if (existingId) {
        // The reservation already exists. The caller must not call the
        // provider again — that is what stops a second invoice.
        return { outcome: 'existing', record: orders.get(existingId)! };
      }
      sequence += 1;
      const now = new Date().toISOString();
      const record: CommerceOrderRecordV1 = {
        id: `commerce-order-row:${sequence}`,
        routeRunId: input.routeRunId,
        userId: input.userId,
        walletAddress: input.walletAddress.toLowerCase(),
        routeCardHash: input.routeCardHash,
        candidateHash: input.candidateHash,
        productId: input.productId,
        packageValue: input.packageValue,
        idempotencyKey: input.idempotencyKey,
        status: 'pending',
        providerStatus: 'unknown',
        invoiceId: null,
        exactAmountAtomic: null,
        estimatedAmountAtomic: input.estimatedAmountAtomic,
        payTo: null,
        refundAddress: input.refundAddress.toLowerCase(),
        order: null,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      };
      orders.set(record.id, record);
      ordersByIdempotency.set(scoped, record.id);
      return { outcome: 'reserved', record };
    },

    async confirmCommerceOrder(orderId: string, userId: string, input: CommerceOrderV1) {
      const record = requireOrder(orderId, userId);
      const order = parseCommerceOrderV1(input);
      if (record.invoiceId !== null && record.invoiceId !== order.invoiceId) {
        throw new RouteStorageConflictError('Commerce order already holds a different invoice');
      }
      if (order.candidateHash !== record.candidateHash) {
        throw new RouteStorageIntegrityError('Commerce order candidateHash does not match its reservation');
      }
      const next: CommerceOrderRecordV1 = {
        ...record,
        status: 'created',
        providerStatus: order.providerStatus,
        invoiceId: order.invoiceId,
        exactAmountAtomic: order.invoice?.amountAtomic ?? order.amount.amountAtomic,
        payTo: order.payTo,
        order,
        expiresAt: order.expiresAt,
        updatedAt: new Date().toISOString(),
      };
      orders.set(orderId, next);
      return next;
    },

    async markCommerceOrderUnknown(orderId: string, userId: string, detail: string) {
      const record = requireOrder(orderId, userId);
      if (record.invoiceId !== null) {
        // An invoice already exists; an uncertain later call cannot erase it.
        return record;
      }
      const next: CommerceOrderRecordV1 = {
        ...record,
        status: 'creation_unknown',
        providerStatus: 'unknown',
        updatedAt: new Date().toISOString(),
      };
      orders.set(orderId, next);
      void detail;
      return next;
    },

    async updateCommerceOrderStatus(input) {
      const record = requireOrder(input.orderId, input.userId);
      const order = parseCommerceOrderV1(input.order);
      if (record.invoiceId !== null && order.invoiceId !== record.invoiceId) {
        throw new RouteStorageConflictError('Commerce order status update targets another invoice');
      }
      const next: CommerceOrderRecordV1 = {
        ...record,
        status: input.status,
        providerStatus: input.providerStatus,
        order,
        exactAmountAtomic: order.invoice?.amountAtomic ?? record.exactAmountAtomic,
        updatedAt: new Date().toISOString(),
      };
      orders.set(input.orderId, next);
      return next;
    },

    async getCommerceOrder(orderId: string, userId: string) {
      const record = orders.get(orderId);
      if (!record || record.userId !== userId) return null;
      return record;
    },

    async getCommerceOrderByInvoice(invoiceId: string, userId: string) {
      for (const record of orders.values()) {
        if (record.invoiceId === invoiceId && record.userId === userId) return record;
      }
      return null;
    },

    async appendCommerceOrderEvent(orderId: string, userId: string, input: CommerceOrderEventV1) {
      requireOrder(orderId, userId);
      const event = parseCommerceOrderEventV1(input);
      events.set(orderId, [...(events.get(orderId) ?? []), event]);
    },

    async listCommerceOrderEvents(orderId: string, userId: string) {
      requireOrder(orderId, userId);
      return [...(events.get(orderId) ?? [])];
    },

    async upsertCommerceProof(orderId: string, userId: string, input: CommerceRouteProofV1) {
      const record = requireOrder(orderId, userId);
      const proof = parseCommerceProofV1(input);
      if (record.order && proof.orderHash !== record.order.orderHash) {
        throw new RouteStorageIntegrityError('Commerce proof is not bound to its order');
      }
      proofs.set(orderId, proof);
    },

    async getCommerceProof(orderId: string, userId: string) {
      requireOrder(orderId, userId);
      return proofs.get(orderId) ?? null;
    },

    async listCommerceHistory(userId: string, limit: number) {
      const items: CommerceHistoryItemV1[] = [];
      for (const record of orders.values()) {
        if (record.userId !== userId) continue;
        items.push({
          orderId: record.id,
          invoiceId: record.invoiceId,
          productId: record.productId,
          packageValue: record.packageValue,
          status: record.status,
          providerStatus: record.providerStatus,
          exactAmountAtomic: record.exactAmountAtomic,
          estimatedAmountAtomic: record.estimatedAmountAtomic,
          proofFinalStatus: proofs.get(record.id)?.finalStatus ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      }
      return items
        .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
        .slice(0, Math.max(1, Math.min(limit, 100)));
    },
  };
}
