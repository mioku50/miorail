import {
  CommerceCandidateV1Schema,
  CommerceEvidenceV1Schema,
  CommerceOrderEventV1Schema,
  CommerceOrderV1Schema,
  CommerceRouteCardV1Schema,
  CommerceRouteIntentV1Schema,
  CommerceRouteProofV1Schema,
  type CommerceCandidateV1,
  type CommerceEvidenceV1,
  type CommerceOrderEventV1,
  type CommerceOrderV1,
  type CommerceProviderStatusV1,
  type CommerceRouteCardV1,
  type CommerceRouteIntentV1,
  type CommerceRouteProofV1,
} from '@mioagent/route-domain';
import { RouteStorageConflictError, RouteStorageIntegrityError, type SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// T64.2 — durable Commerce storage.
//
// A SEPARATE repository interface rather than more methods on
// RouteStorageRepository: commerce has no Execution Blueprint and no
// swap-shaped Route Proof, so bolting it onto that interface would force every
// implementation to carry shapes it cannot serve. The run itself still lives in
// route_runs (goal='commerce'), which is what the T64.2 spec allows.
//
// The single rule that governs writes here: an order row exists BEFORE the
// provider is called. That is what makes an uncertain network result a durable
// fact (`creation_unknown`) instead of a lost request, and what makes a retry
// return the same invoice instead of opening a second one.
// ---------------------------------------------------------------------------

/** The lifecycle of a durable order row. `pending` and `creation_unknown` have
 * no counterpart in CommerceOrderV1 — they describe the row before, and after
 * a failed attempt at, a confirmed invoice. */
export type CommerceOrderRowStatusV1 =
  | 'pending'
  | 'created'
  | 'payment_pending'
  | 'payment_confirmed'
  | 'fulfilling'
  | 'delivered'
  | 'failed'
  | 'expired'
  /** The provider call did not return a definite answer. NEVER auto-retried:
   * a retry could open a second invoice for money the user already owes. */
  | 'creation_unknown';

export interface CommerceOrderRecordV1 {
  id: string;
  routeRunId: string;
  userId: string;
  walletAddress: string;
  routeCardHash: string;
  candidateHash: string;
  productId: string;
  packageValue: string;
  idempotencyKey: string;
  status: CommerceOrderRowStatusV1;
  providerStatus: CommerceProviderStatusV1;
  invoiceId: string | null;
  exactAmountAtomic: string | null;
  estimatedAmountAtomic: string | null;
  payTo: string | null;
  refundAddress: string;
  /** The validated CommerceOrderV1 once an invoice exists; null while pending. */
  order: CommerceOrderV1 | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceRouteRunRecordV1 {
  id: string;
  userId: string;
  walletAddress: string;
  chainId: number;
  goal: 'commerce';
  status: string;
  intentHash: string;
  idempotencyKey: string;
  intent: CommerceRouteIntentV1;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceHistoryItemV1 {
  orderId: string;
  invoiceId: string | null;
  productId: string;
  packageValue: string;
  status: CommerceOrderRowStatusV1;
  providerStatus: CommerceProviderStatusV1;
  exactAmountAtomic: string | null;
  estimatedAmountAtomic: string | null;
  proofFinalStatus: CommerceRouteProofV1['finalStatus'] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveCommerceOrderInputV1 {
  routeRunId: string;
  userId: string;
  walletAddress: string;
  routeCardHash: string;
  candidateHash: string;
  productId: string;
  packageValue: string;
  idempotencyKey: string;
  estimatedAmountAtomic: string;
  refundAddress: string;
}

export type ReserveCommerceOrderResultV1 =
  /** This caller owns the reservation and is the one that may call the
   * provider exactly once. */
  | { outcome: 'reserved'; record: CommerceOrderRecordV1 }
  /** A row already existed for this idempotency key. The caller must NOT call
   * the provider; it returns whatever that row already holds. */
  | { outcome: 'existing'; record: CommerceOrderRecordV1 };

export interface CommerceStorageRepository {
  createCommerceRouteRun(
    intent: CommerceRouteIntentV1,
    idempotencyKey: string,
  ): Promise<CommerceRouteRunRecordV1>;
  getCommerceRouteRun(id: string, userId: string): Promise<CommerceRouteRunRecordV1 | null>;

  insertCommerceCandidate(runId: string, candidate: CommerceCandidateV1): Promise<void>;
  listCommerceCandidates(runId: string, userId: string): Promise<CommerceCandidateV1[]>;

  insertCommerceEvidence(
    runId: string,
    candidateHash: string | null,
    evidence: CommerceEvidenceV1,
  ): Promise<void>;
  listCommerceEvidence(runId: string, userId: string): Promise<CommerceEvidenceV1[]>;

  insertCommerceRouteCard(runId: string, card: CommerceRouteCardV1): Promise<void>;
  listCommerceRouteCards(runId: string, userId: string): Promise<CommerceRouteCardV1[]>;

  /** Reserves the single order row for an idempotency key. Never opens a
   * second one — the caller learns from `outcome` whether it may call the
   * provider. */
  reserveCommerceOrder(input: ReserveCommerceOrderInputV1): Promise<ReserveCommerceOrderResultV1>;
  /** Attaches a confirmed invoice to a reserved row. */
  confirmCommerceOrder(orderId: string, userId: string, order: CommerceOrderV1): Promise<CommerceOrderRecordV1>;
  /** Marks a reservation whose provider call did not return a definite answer. */
  markCommerceOrderUnknown(orderId: string, userId: string, detail: string): Promise<CommerceOrderRecordV1>;
  updateCommerceOrderStatus(input: {
    orderId: string;
    userId: string;
    status: CommerceOrderRowStatusV1;
    providerStatus: CommerceProviderStatusV1;
    order: CommerceOrderV1;
  }): Promise<CommerceOrderRecordV1>;

  getCommerceOrder(orderId: string, userId: string): Promise<CommerceOrderRecordV1 | null>;
  getCommerceOrderByInvoice(invoiceId: string, userId: string): Promise<CommerceOrderRecordV1 | null>;

  appendCommerceOrderEvent(orderId: string, userId: string, event: CommerceOrderEventV1): Promise<void>;
  listCommerceOrderEvents(orderId: string, userId: string): Promise<CommerceOrderEventV1[]>;

  upsertCommerceProof(orderId: string, userId: string, proof: CommerceRouteProofV1): Promise<void>;
  getCommerceProof(orderId: string, userId: string): Promise<CommerceRouteProofV1 | null>;

  listCommerceHistory(userId: string, limit: number): Promise<CommerceHistoryItemV1[]>;
}

// --- shared validation ------------------------------------------------------

export function parseCommerceIntentV1(value: CommerceRouteIntentV1): CommerceRouteIntentV1 {
  const parsed = CommerceRouteIntentV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('Commerce intent failed contract validation');
  return parsed.data;
}

export function parseCommerceCandidateV1(value: CommerceCandidateV1): CommerceCandidateV1 {
  const parsed = CommerceCandidateV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('Commerce candidate failed contract validation');
  return parsed.data;
}

export function parseCommerceEvidenceV1(value: CommerceEvidenceV1): CommerceEvidenceV1 {
  const parsed = CommerceEvidenceV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('Commerce evidence failed contract validation');
  return parsed.data;
}

export function parseCommerceRouteCardV1(value: CommerceRouteCardV1): CommerceRouteCardV1 {
  const parsed = CommerceRouteCardV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('Commerce route card failed contract validation');
  return parsed.data;
}

export function parseCommerceOrderV1(value: CommerceOrderV1): CommerceOrderV1 {
  const parsed = CommerceOrderV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('Commerce order failed contract validation');
  return parsed.data;
}

export function parseCommerceOrderEventV1(value: CommerceOrderEventV1): CommerceOrderEventV1 {
  const parsed = CommerceOrderEventV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('Commerce order event failed contract validation');
  return parsed.data;
}

export function parseCommerceProofV1(value: CommerceRouteProofV1): CommerceRouteProofV1 {
  const parsed = CommerceRouteProofV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError('Commerce proof failed contract validation');
  return parsed.data;
}

/** Guards the tenant boundary on every read/write path. */
export function assertCommerceTenantV1(recordUserId: string, userId: string): void {
  if (recordUserId !== userId) {
    throw new RouteStorageConflictError('Commerce record belongs to another tenant');
  }
}

/**
 * The idempotency key: tenant + wallet + routeCardHash + packageId + requestId.
 *
 * Built here rather than by each caller so the composition cannot drift, and
 * so the wallet is always part of it — one tenant's two wallets must not share
 * a checkout.
 */
export type { SqlTemplateExecutor };

export function commerceIdempotencyKeyV1(input: {
  tenantId: string;
  walletAddress: string;
  routeCardHash: string;
  productId: string;
  packageValue: string;
  requestId: string;
}): string {
  return [
    input.tenantId,
    input.walletAddress.toLowerCase(),
    input.routeCardHash,
    input.productId,
    input.packageValue,
    input.requestId,
  ].join('|');
}
