import {
  CommerceRouteProofV1Schema,
  deriveCommerceProofFinalStatusV1,
  hashCommerceRouteProofV1,
  stableHashV1,
  ZERO_HASH_V1,
  type CommerceDeliveryLegV1,
  type CommerceOrderLegV1,
  type CommerceOrderV1,
  type CommercePaymentLegV1,
  type CommerceRouteProofV1,
  type HashV1,
} from '@mioagent/route-domain';
import type { CommerceFailureReasonV1, CommerceOrderStatusObservationV1 } from './types.js';

// ---------------------------------------------------------------------------
// T64 — the Commerce Route Proof.
//
// This is the file the task exists for. In Swap and Earn a settled transaction
// with a matching receipt IS the proof. In Commerce it is one third of it:
//
//     payment settled  ∧  provider order confirmed  ∧  digital good delivered
//
// Anything less is not a successful proof, and the most dangerous case has its
// own terminal state: `order_unconfirmed` means the wallet paid and the
// storefront has NOT acknowledged an order. That is a reconciliation event —
// it is never rendered, described, or stored as a completed purchase.
// ---------------------------------------------------------------------------

export interface BuildCommerceProofInputV1 {
  order: CommerceOrderV1;
  observation: CommerceOrderStatusObservationV1;
  evidenceSetHash: HashV1;
  now: Date;
}

export type CommerceProofResultV1 =
  | { ok: true; proof: CommerceRouteProofV1 }
  | { ok: false; reason: CommerceFailureReasonV1 };

export function commercePaymentLegV1(
  order: CommerceOrderV1,
  observation: CommerceOrderStatusObservationV1,
): CommercePaymentLegV1 {
  const settled = observation.paymentSettled && observation.paymentTransactionHash !== null;
  return {
    state: settled ? 'settled' : order.paymentState,
    transactionHash: observation.paymentTransactionHash ?? order.paymentTransactionHash,
    settledAt: settled ? (observation.settledAt ?? observation.observedAt) : null,
    amountAtomic: order.amount.amountAtomic,
    payTo: order.payTo,
  };
}

/**
 * The order leg. `confirmed` requires a provider order id for EVERY line —
 * a partially acknowledged invoice is `created`, not confirmed, because the
 * lines without an id are goods nobody has promised to deliver.
 */
export function commerceOrderLegV1(
  order: CommerceOrderV1,
  observation: CommerceOrderStatusObservationV1,
): CommerceOrderLegV1 {
  const orderIds = observation.orderIds.filter((id) => id.length > 0);
  const confirmed = observation.paymentSettled && orderIds.length >= order.items.length;
  if (confirmed) {
    return {
      state: 'confirmed',
      invoiceId: order.invoiceId,
      orderIds,
      confirmedAt: observation.observedAt,
    };
  }
  if (observation.deliveryState === 'failed') {
    return { state: 'failed', invoiceId: order.invoiceId, orderIds, confirmedAt: null };
  }
  if (orderIds.length > 0) {
    return { state: 'created', invoiceId: order.invoiceId, orderIds, confirmedAt: null };
  }
  // Paid, and the storefront has named no order at all: unknown, not "created".
  return {
    state: observation.paymentSettled ? 'unknown' : 'not_created',
    invoiceId: order.invoiceId,
    orderIds,
    confirmedAt: null,
  };
}

export function commerceDeliveryLegV1(
  order: CommerceOrderV1,
  observation: CommerceOrderStatusObservationV1,
): CommerceDeliveryLegV1 {
  const itemCount = order.items.length;
  const deliveredCount = Math.min(Math.max(observation.deliveredCount, 0), itemCount);
  const complete = observation.deliveryState === 'all_delivered' && deliveredCount === itemCount;
  return {
    state: observation.paymentSettled ? observation.deliveryState : 'not_started',
    itemCount,
    deliveredCount: observation.paymentSettled ? deliveredCount : 0,
    confirmedAt: complete ? observation.observedAt : null,
  };
}

/**
 * Composes the proof. The verdict is DERIVED from the legs by the contract's
 * own `deriveCommerceProofFinalStatusV1`, never chosen here — so the API, the
 * reconciler and the schema cannot drift into disagreeing about what counts as
 * delivered.
 */
export function buildCommerceRouteProofV1(input: BuildCommerceProofInputV1): CommerceProofResultV1 {
  const { order, observation, now } = input;
  if (observation.invoiceId !== order.invoiceId) return { ok: false, reason: 'order_not_confirmed' };

  const payment = commercePaymentLegV1(order, observation);
  const orderLeg = commerceOrderLegV1(order, observation);
  const delivery = commerceDeliveryLegV1(order, observation);
  const finalStatus = deriveCommerceProofFinalStatusV1({ payment, order: orderLeg, delivery });

  const nowIso = now.toISOString();
  const base = {
    schemaVersion: 'commerce-route-proof/v1' as const,
    id: `commerce-proof:${stableHashV1('commerce-proof-id', {
      orderHash: order.orderHash,
      invoiceId: order.invoiceId,
    }).slice(2, 26)}`,
    tenantId: order.tenantId,
    walletAddress: order.walletAddress,
    chainId: order.chainId,
    createdAt: order.createdAt,
    updatedAt: nowIso,
    status: finalStatus,
    intentHash: order.intentHash,
    candidateHash: order.candidateHash,
    evidenceSetHash: input.evidenceSetHash,
    orderHash: order.orderHash,
    proofHash: ZERO_HASH_V1,
    payment,
    order: orderLeg,
    delivery,
    finalStatus,
  };
  const parsed = CommerceRouteProofV1Schema.safeParse({
    ...base,
    proofHash: hashCommerceRouteProofV1(base as unknown as CommerceRouteProofV1),
  });
  if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };
  return { ok: true, proof: parsed.data };
}

/** True only for the one terminal state that means the user got what they
 * paid for. Exported so no surface has to re-derive the rule. */
export function isCommerceProofSuccessfulV1(proof: CommerceRouteProofV1): boolean {
  return proof.finalStatus === 'delivered';
}

/** States that must be escalated rather than displayed as an outcome. */
export function commerceProofNeedsReconciliationV1(proof: CommerceRouteProofV1): boolean {
  return proof.finalStatus === 'order_unconfirmed' || proof.finalStatus === 'reconciliation_required';
}

export const COMMERCE_PROOF_COPY_V1: Record<CommerceRouteProofV1['finalStatus'], string> = {
  pending: 'Waiting for the storefront to confirm this order.',
  delivered: 'Paid, order confirmed, and every item delivered.',
  partial_delivery: 'Paid and the order is confirmed, but not every item has been delivered yet.',
  order_unconfirmed:
    'The payment settled but the storefront has not confirmed an order. This is not a completed purchase — it is being reconciled.',
  payment_failed: 'The payment did not settle. No order was created and nothing was delivered.',
  failed: 'The storefront reported this order as failed.',
  reconciliation_required:
    'The storefront could not report the delivery state for this paid order. It is being reconciled.',
};
