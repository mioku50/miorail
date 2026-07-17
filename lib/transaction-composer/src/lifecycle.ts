import type { ExecutionBlueprintV1, RouteProofEventV1, RouteProofV1 } from '@mioagent/route-domain';

// T57: a single, pure lifecycle model shared by the server (approve/submission
// responses) and the client UI. Never persisted as its own row — always
// derived fresh from the current ExecutionBlueprintV1 status plus the Route
// Proof projection and its append-only event history. `submitting` is
// deliberately NOT a member here: it is a client-only transient state between
// "approved" and the wallet returning a batch id, and the server has no way
// to observe it.
export type LifecycleStateV1 =
  | 'draft'
  | 'ready_for_review'
  | 'expired'
  | 'invalid'
  | 'approved'
  | 'submitted'
  | 'submitted_unknown'
  | 'confirmed'
  | 'failed'
  | 'cancelled';

export interface DeriveBlueprintLifecycleInput {
  blueprint: Pick<ExecutionBlueprintV1, 'status'>;
  proof: Pick<RouteProofV1, 'finalStatus' | 'receipts'> | null;
  events: readonly Pick<RouteProofEventV1, 'eventType' | 'payload'>[];
}

/**
 * Derives the current lifecycle state. Blueprint status drives everything
 * before approval (draft/ready_for_review/expired/invalid pass through
 * verbatim). Once approved, RouteProofV1.finalStatus alone can only
 * distinguish `cancelled` / `failed` / `pending` — by design, T57 never marks
 * a proof `completed` (T58 does), and `submitted` / `confirmed` /
 * `submitted_unknown` all intentionally collapse onto `pending`. To recover
 * the finer-grained state, we look at the receipts' onchain *status* (a
 * receipt whose status is literally `success` is the only true evidence of
 * `confirmed`; a `reverted` receipt means the batch failed onchain; a
 * placeholder `unknown` receipt — a hash observed without a parseable receipt
 * — is NOT evidence of success and must never read as confirmed) and, failing
 * that, at the most recent `submitted` event's own payload.status.
 */
export function deriveBlueprintLifecycleV1(input: DeriveBlueprintLifecycleInput): LifecycleStateV1 {
  const { blueprint, proof, events } = input;
  if (blueprint.status !== 'approved') return blueprint.status;
  if (!proof) return 'approved';
  if (proof.finalStatus === 'cancelled') return 'cancelled';
  if (proof.finalStatus === 'failed') return 'failed';
  // Confirmed requires REAL success evidence — never inferred from a client's
  // self-reported status, and never from a placeholder `unknown` receipt.
  if (proof.receipts.some((receipt) => receipt.status === 'success')) return 'confirmed';
  // A receipt that reverted onchain is an honest failure even if the proof's
  // finalStatus is still `pending` (T57 defers finalization to T58).
  if (proof.receipts.some((receipt) => receipt.status === 'reverted')) return 'failed';

  const submittedEvents = events.filter((event) => event.eventType === 'submitted');
  if (submittedEvents.length === 0) return 'approved';
  const last = submittedEvents[submittedEvents.length - 1]!;
  const lastStatus = typeof last.payload.status === 'string' ? last.payload.status : null;
  if (lastStatus === 'submitted_unknown') return 'submitted_unknown';
  return 'submitted';
}
