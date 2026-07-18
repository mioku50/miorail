import { ZERO_HASH_V1, stableHashV1, type HashV1 } from './hashing.js';
import {
  RouteProofEventV1Schema,
  hashRouteProofEventPayloadV1,
  hashRouteProofEventV1,
  type RouteProofEventV1,
  type RouteProofV1,
} from './execution-contracts.js';

// T58: hash-chained Route Proof event construction, factored out of
// transaction-composer so route-proof (receipt reconciliation) can build and
// check-before-append events without depending on transaction-composer (which
// would drag in swap-adapters/security). Both packages depend on
// route-storage for the actual `repository.appendProofEvent` I/O — this
// module stays repository-agnostic and pure.

export interface BuildRouteProofEventInputV1 {
  proof: RouteProofV1;
  eventIndex: number;
  previousEventHash: HashV1 | null;
  eventType: RouteProofEventV1['eventType'];
  payload: Record<string, unknown>;
  now: Date;
}

/** Builds a single, schema-valid, hash-chained Route Proof event. Pure. */
export function buildRouteProofEventV1(input: BuildRouteProofEventInputV1): RouteProofEventV1 {
  const { proof, eventIndex, previousEventHash, eventType, payload, now } = input;
  const nowIso = now.toISOString();
  const id = `route-proof-event:${stableHashV1('route-proof-event-id/v1', {
    routeProofId: proof.id,
    eventIndex,
    eventType,
  }).slice(2)}`;
  const draft: RouteProofEventV1 = {
    schemaVersion: 'route-proof-event/v1',
    id,
    tenantId: proof.tenantId,
    walletAddress: proof.walletAddress,
    chainId: proof.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'recorded',
    intentHash: proof.intentHash,
    candidateHash: proof.selectedCandidateHash,
    evidenceSetHash: proof.evidenceSetHash,
    blueprintHash: proof.blueprintHash,
    approvedCallsHash: proof.approvedCallsHash,
    routeProofId: proof.id,
    eventIndex,
    eventType,
    previousEventHash,
    payload: payload as RouteProofEventV1['payload'],
    payloadHash: hashRouteProofEventPayloadV1(payload as RouteProofEventV1['payload']),
    eventHash: ZERO_HASH_V1,
  };
  return RouteProofEventV1Schema.parse({ ...draft, eventHash: hashRouteProofEventV1(draft) });
}

/** Finds an existing event with the same eventType + payloadHash, if any —
 * the check-before-append rule that makes retries byte-identical no-ops. */
export function findDuplicateRouteProofEventV1(
  existingEvents: readonly RouteProofEventV1[],
  eventType: RouteProofEventV1['eventType'],
  payload: Record<string, unknown>,
): RouteProofEventV1 | null {
  const payloadHash = hashRouteProofEventPayloadV1(payload as RouteProofEventV1['payload']);
  return (
    existingEvents.find((event) => event.eventType === eventType && event.payloadHash === payloadHash) ?? null
  );
}

export interface NextRouteProofEventInputV1 {
  proof: RouteProofV1;
  existingEvents: readonly RouteProofEventV1[];
  eventType: RouteProofEventV1['eventType'];
  payload: Record<string, unknown>;
  now: Date;
}

/** Pure check-before-append core: returns the next event to persist, or null
 * when an identical (eventType, payloadHash) event already exists. Callers
 * own the actual repository write (this module has no I/O). */
export function nextRouteProofEventV1(input: NextRouteProofEventInputV1): RouteProofEventV1 | null {
  const { proof, existingEvents, eventType, payload, now } = input;
  if (findDuplicateRouteProofEventV1(existingEvents, eventType, payload)) return null;
  const previous = existingEvents.at(-1) ?? null;
  return buildRouteProofEventV1({
    proof,
    eventIndex: existingEvents.length,
    previousEventHash: previous?.eventHash ?? null,
    eventType,
    payload,
    now,
  });
}
