import { RoutePlanResponseV1Schema, type RoutePlanResponseV1 } from '@mioagent/api-spec';
import { buildRouteCardV1, buildRoutePlanProjectionV1 } from '@mioagent/route-card';
import {
  routeEngineV1IdempotencyKey,
  type SwapRouteEngine,
} from '@mioagent/route-engine';
import type { RouteStorageRepository } from '@mioagent/route-storage';
import type { SwapRouteAdapter } from '@mioagent/swap-adapters';
import {
  resolveSwapIntentWithLlmV2,
  type IntentResolutionV2,
} from '@mioagent/intent-engine';
import type { LlmProvider } from '@mioagent/llm';
import type { ProviderReliabilityAssessmentV1 } from '@mioagent/route-outcomes';
import type { RouteCandidateV1 } from '@mioagent/route-domain';

export type ReliabilityLoaderV1 = (
  candidates: readonly RouteCandidateV1[],
) => Promise<ReadonlyMap<string, ProviderReliabilityAssessmentV1>>;

export interface RoutePlanCoordinatorDependencies {
  llm: LlmProvider;
  engine: SwapRouteEngine;
  adapters: SwapRouteAdapter[];
  repository: RouteStorageRepository;
  resolveIntent?: typeof resolveSwapIntentWithLlmV2;
  /** T67C.1 Part 2. Absent means swap-path-score/v1 end to end: the reader is
   * never called, no reliability evidence is created, and the evaluation
   * canonicalises exactly as it did before this task. */
  reliabilityLoaderFactory?: ReliabilityLoaderFactoryV1;
}

export interface RoutePlanCoordinatorInput {
  tenantId: string;
  walletAddress: `0x${string}`;
  message: string;
  requestId: string;
  now: Date;
}

/** Built per run, because the snapshot bound depends on when THAT run started. */
export type ReliabilityLoaderFactoryV1 = (context: {
  tenantId: string;
  walletAddress: string;
  runStartedAt: Date;
}) => ReliabilityLoaderV1;

export class RoutePlanCoordinator {
  constructor(private readonly dependencies: RoutePlanCoordinatorDependencies) {}

  async evaluate(input: RoutePlanCoordinatorInput): Promise<RoutePlanResponseV1> {
    const resolveIntent = this.dependencies.resolveIntent ?? resolveSwapIntentWithLlmV2;
    const resolution: IntentResolutionV2 = await resolveIntent({
      llm: this.dependencies.llm,
      message: input.message,
      context: {
        tenantId: input.tenantId,
        walletAddress: input.walletAddress,
        runtimeChainId: 8453,
        requestId: input.requestId,
        requestedAt: input.now.toISOString(),
      },
    });
    if (resolution.outcome === 'needs_clarification') {
      return RoutePlanResponseV1Schema.parse({
        outcome: 'needs_clarification',
        clarification: resolution.clarification,
      });
    }
    if (resolution.outcome === 'rejected') {
      return RoutePlanResponseV1Schema.parse({
        outcome: 'rejected',
        issues: resolution.issues,
      });
    }

    const intent = resolution.routeIntent;
    const routeRun = await this.dependencies.repository.createRouteRun(
      intent,
      routeEngineV1IdempotencyKey(intent, input.requestId),
    );
    const reliabilityByCandidate = new Map<string, ProviderReliabilityAssessmentV1>();
    const loader = this.dependencies.reliabilityLoaderFactory?.({
      tenantId: input.tenantId,
      walletAddress: input.walletAddress,
      // The run's own creation time, which createRouteRun returns unchanged on
      // a repeat of the same idempotency key.
      runStartedAt: new Date(routeRun.createdAt),
    });
    const evaluation = await this.dependencies.engine.evaluate({
      intent,
      walletAddress: input.walletAddress,
      requestId: input.requestId,
      now: input.now,
      adapters: this.dependencies.adapters,
      repository: this.dependencies.repository,
      loadReliability: loader
        ? async (candidates) => {
            // T67C.1 Part 2 §6 — the run's ORIGINAL creation time bounds the
            // lookup, not `now`. createRouteRun is idempotent on the request's
            // key, so a repeat of the same request re-reads with the same
            // bound and selects the same snapshot: a snapshot sealed in the
            // meantime cannot change a comparison the user already made.
            // Making the guarantee structural beats a special-case branch that
            // returns a stored card while claiming a fresh evaluation produced it.
            const loaded = await loader(candidates);
            // Kept so the projection can render the same assessments the
            // ranking used, without a second read that could disagree.
            for (const [hash, assessment] of loaded) reliabilityByCandidate.set(hash, assessment);
            return loaded;
          }
        : undefined,
    });
    const routeCard = buildRouteCardV1(evaluation);
    if (routeCard) {
      await this.dependencies.repository.insertRouteCard(routeRun.id, routeCard);
    }
    const projection = buildRoutePlanProjectionV1(evaluation, {
      routeCard,
      routeRunId: routeRun.id,
      providerHistory: loader ? reliabilityByCandidate : undefined,
    });
    return RoutePlanResponseV1Schema.parse({
      outcome: 'evaluated',
      routeRunId: routeRun.id,
      intent,
      evaluation,
      routeCard,
      projection,
    });
  }
}
