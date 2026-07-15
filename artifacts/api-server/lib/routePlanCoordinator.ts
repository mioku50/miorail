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

export interface RoutePlanCoordinatorDependencies {
  llm: LlmProvider;
  engine: SwapRouteEngine;
  adapters: SwapRouteAdapter[];
  repository: RouteStorageRepository;
  resolveIntent?: typeof resolveSwapIntentWithLlmV2;
}

export interface RoutePlanCoordinatorInput {
  tenantId: string;
  walletAddress: `0x${string}`;
  message: string;
  requestId: string;
  now: Date;
}

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
    const evaluation = await this.dependencies.engine.evaluate({
      intent,
      walletAddress: input.walletAddress,
      requestId: input.requestId,
      now: input.now,
      adapters: this.dependencies.adapters,
      repository: this.dependencies.repository,
    });
    const routeCard = buildRouteCardV1(evaluation);
    if (routeCard) {
      await this.dependencies.repository.insertRouteCard(routeRun.id, routeCard);
    }
    const projection = buildRoutePlanProjectionV1(evaluation, {
      routeCard,
      routeRunId: routeRun.id,
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
