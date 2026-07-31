import type { RouteCandidateV1, RouteProofEventV1, RouteProofV1 } from '@mioagent/route-domain';
import {
  deriveRouteProviderOutcomeV1,
  routeProviderOutcomeIdV1,
  type OutcomeSkipReasonV1,
} from './deriveOutcome.js';
import type { RouteProviderOutcomeV1 } from './contracts.js';

// ---------------------------------------------------------------------------
// T67C.1 §3 — the projector.
//
// Called once a Route Proof has been written in a terminal state. It reads the
// proof and its persisted candidate and writes at most one outcome row.
//
// Two properties matter more than anything else this does:
//
//   * It NEVER throws into its caller. The proof is already final and already
//     stored; a statistics table failing to accept a row is not a reason to
//     unwind somebody's settled trade, and an exception here would propagate
//     into a reconcile response that has nothing to do with reliability.
//     Failures come back as a value and are repaired by `outcomes:backfill`.
//   * It fails CLOSED on disagreement. If an outcome already exists for this
//     proof under a different proof hash, the proof changed after it was
//     final. That is either a bug or tampering; overwriting the row would
//     erase the evidence of it.
//
// Storage arrives as a port so this package stays a leaf on route-domain —
// route-storage cannot depend on route-outcomes without a cycle.
// ---------------------------------------------------------------------------

export interface OutcomeProjectionPortV1 {
  /** The persisted candidate the proof was built from, by candidate hash. The
   * provider is read from here and never from anything a client supplied. */
  findCandidateByHash(input: {
    tenantId: string;
    routeRunId: string;
    candidateHash: string;
  }): Promise<RouteCandidateV1 | null>;
  getOutcomeByProofId(input: {
    tenantId: string;
    proofId: string;
  }): Promise<RouteProviderOutcomeV1 | null>;
  /** Must be a no-op when an identical row already exists, and must reject a
   * second row for the same proof. The unique index is the real guarantee. */
  insertOutcome(outcome: RouteProviderOutcomeV1): Promise<void>;
}

export type OutcomeProjectionResultV1 =
  | { status: 'recorded'; outcome: RouteProviderOutcomeV1 }
  | { status: 'already_recorded'; outcome: RouteProviderOutcomeV1 }
  | { status: 'skipped'; reason: OutcomeSkipReasonV1 | 'candidate_not_found' }
  | { status: 'conflict'; detail: string }
  | { status: 'failed'; detail: string };

export interface ProjectFinalizedProofInputV1 {
  proof: RouteProofV1;
  events: readonly RouteProofEventV1[];
  routeRunId: string;
  now: Date;
}

export interface RouteOutcomeProjectorV1 {
  projectFinalizedProof(input: ProjectFinalizedProofInputV1): Promise<OutcomeProjectionResultV1>;
}

export function createRouteOutcomeProjectorV1(
  port: OutcomeProjectionPortV1,
): RouteOutcomeProjectorV1 {
  return {
    async projectFinalizedProof(
      input: ProjectFinalizedProofInputV1,
    ): Promise<OutcomeProjectionResultV1> {
      try {
        const { proof } = input;

        // Checked before any read: a repeat finalization of the same proof must
        // cost one lookup, not a full derivation and a failed insert.
        const existing = await port.getOutcomeByProofId({
          tenantId: proof.tenantId,
          proofId: proof.id,
        });
        if (existing) {
          if (existing.proofHash !== proof.proofHash) {
            return {
              status: 'conflict',
              detail: `outcome ${existing.id} was derived from a different proof hash`,
            };
          }
          return { status: 'already_recorded', outcome: existing };
        }

        const candidate = await port.findCandidateByHash({
          tenantId: proof.tenantId,
          routeRunId: input.routeRunId,
          candidateHash: proof.selectedCandidateHash,
        });
        if (!candidate) return { status: 'skipped', reason: 'candidate_not_found' };

        const derived = deriveRouteProviderOutcomeV1({
          proof,
          candidate,
          events: input.events,
          derivedAt: input.now,
        });
        if (!derived.derived) return { status: 'skipped', reason: derived.reason };

        await port.insertOutcome(derived.outcome);
        return { status: 'recorded', outcome: derived.outcome };
      } catch (error) {
        // Deliberately swallowed into a value. See the header: the proof is
        // already terminal and already stored.
        return {
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export { routeProviderOutcomeIdV1 };
