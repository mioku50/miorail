import {
  createRouteOutcomeProjectorV1,
  type OutcomeProjectionPortV1,
  type RouteOutcomeProjectorV1,
} from '@mioagent/route-outcomes';
import {
  createDatabaseProviderOutcomeRepository,
  type RouteStorageRepository,
} from '@mioagent/route-storage';
import type { SqlTemplateExecutor } from '@mioagent/route-storage';
import { logger } from '@mioagent/utils';

// ---------------------------------------------------------------------------
// T67C.1 — the adapter that joins the reconciler's port to real storage.
//
// It lives here rather than in either package because it is the only place
// that knows about both: route-proof declares the seam, route-outcomes
// implements the derivation, and route-storage holds the rows. Wiring them in
// the api-server keeps route-outcomes a leaf and stops route-proof from
// depending on the scoring vocabulary.
//
// Returns null when the feature is off. The reconciler then installs no
// projector at all, so "off" means no outcome is recorded — not an outcome
// recorded and ignored.
// ---------------------------------------------------------------------------

export function createRouteOutcomeProjectorForServerV1(input: {
  enabled: boolean;
  sql: SqlTemplateExecutor;
  repository: RouteStorageRepository;
}): RouteOutcomeProjectorV1 | undefined {
  if (!input.enabled) return undefined;
  const outcomes = createDatabaseProviderOutcomeRepository(input.sql);

  const port: OutcomeProjectionPortV1 = {
    async findCandidateByHash({ tenantId, routeRunId, candidateHash }) {
      // Read from the PERSISTED candidates of this run. The provider a
      // statistic is attributed to must come from what the server stored when
      // it quoted, never from anything supplied later.
      const candidates = await input.repository.listCandidates(routeRunId, tenantId);
      return candidates.find((candidate) => candidate.candidateHash === candidateHash) ?? null;
    },
    getOutcomeByProofId: (query) => outcomes.getProviderOutcomeByProofId(query),
    async insertOutcome(outcome) {
      const effect = await outcomes.insertProviderOutcome(outcome);
      if (effect.kind === 'conflict') {
        // Surfaced as a throw so the projector reports it as `failed` rather
        // than silently claiming success. The stored row is never overwritten:
        // a disagreement about a finalized proof is a finding, and repairing it
        // is a deliberate act, not a side effect of the next reconcile.
        throw new Error(`outcome write conflict: ${effect.reason}`);
      }
    },
  };

  const projector = createRouteOutcomeProjectorV1(port);
  return {
    async projectFinalizedProof(projectionInput) {
      const result = await projector.projectFinalizedProof(projectionInput);
      // Logged, never thrown. `outcomes:backfill` is the repair path, and it
      // needs an operator to know there is something to repair.
      if (result.status === 'failed' || result.status === 'conflict') {
        logger.error('Route outcome projection did not record', {
          proofId: projectionInput.proof.id,
          status: result.status,
          detail: 'detail' in result ? result.detail : undefined,
        });
      }
      return result;
    },
  };
}
