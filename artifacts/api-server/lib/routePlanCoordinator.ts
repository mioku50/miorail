import { RoutePlanResponseV1Schema, type RoutePlanResponseV1 } from '@mioagent/api-spec';
import { logger } from '@mioagent/utils';
import { buildRouteCardV1, buildRoutePlanProjectionV1 } from '@mioagent/route-card';
import {
  routeEngineV1IdempotencyKey,
  type SwapRouteEngine,
} from '@mioagent/route-engine';
import type {
  RouteStorageRepository,
  SwapPendingIntentRepositoryV1,
  SwapPendingIntentRowV1,
} from '@mioagent/route-storage';
import type { SwapRouteAdapter } from '@mioagent/swap-adapters';
import {
  resolveSwapIntentWithLlmV2,
  type IntentResolutionV2,
  type PendingSwapIntentV2,
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
  /** Absent means no continuation: every request is read on its own, exactly as
   * before this existed. Supplied only where the table is present. */
  pendingIntents?: SwapPendingIntentRepositoryV1;
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

/** Row → engine. Only the schema tag is added; every field is already the
 * engine's own, and tsc is what keeps the two shapes from drifting apart. */
function toPendingSwapIntentV2(row: SwapPendingIntentRowV1): PendingSwapIntentV2 {
  return { schemaVersion: 'pending-swap-intent/v2', ...row };
}

/** Engine → row, dropping only the schema tag the table does not carry. */
function toPendingIntentRowV1(pending: PendingSwapIntentV2): SwapPendingIntentRowV1 {
  const { schemaVersion: _schemaVersion, ...row } = pending;
  return row;
}

export class RoutePlanCoordinator {
  constructor(private readonly dependencies: RoutePlanCoordinatorDependencies) {}

  /** A pending intent is a convenience, so losing one degrades the next turn
   * rather than failing this one. The failure is logged, never swallowed. */
  private async readPendingIntent(
    binding: { tenantId: string; walletAddress: string },
    now: Date,
  ): Promise<PendingSwapIntentV2 | null> {
    if (!this.dependencies.pendingIntents) return null;
    try {
      const row = await this.dependencies.pendingIntents.readPendingIntent(binding, now);
      return row ? toPendingSwapIntentV2(row) : null;
    } catch (error) {
      logger.warn('Pending swap intent could not be read', { reason: String(error) });
      return null;
    }
  }

  /** Kept only while its question stands. Anything else — ready, rejected, or a
   * clarification with nothing grounded — clears it, so a finished goal cannot
   * lend its constraints to an unrelated later one. */
  private async storePendingIntent(
    binding: { tenantId: string; walletAddress: string },
    resolution: IntentResolutionV2,
  ): Promise<void> {
    const repository = this.dependencies.pendingIntents;
    if (!repository) return;
    const pending =
      resolution.outcome === 'needs_clarification' ? resolution.pendingIntent : null;
    try {
      if (pending) await repository.upsertPendingIntent(toPendingIntentRowV1(pending));
      else await repository.clearPendingIntent(binding);
    } catch (error) {
      logger.warn('Pending swap intent could not be stored', { reason: String(error) });
    }
  }

  async evaluate(input: RoutePlanCoordinatorInput): Promise<RoutePlanResponseV1> {
    const resolveIntent = this.dependencies.resolveIntent ?? resolveSwapIntentWithLlmV2;
    const binding = { tenantId: input.tenantId, walletAddress: input.walletAddress };
    // Server-side only. The half-finished goal is looked up by the
    // AUTHENTICATED tenant and wallet and never travels through the client,
    // because a caller who could hand one back could state an amount and a pair
    // that appeared in no message — and grounding every field in the user's own
    // words is what the intent engine exists to do.
    const carried = await this.readPendingIntent(binding, input.now);
    const resolution: IntentResolutionV2 = await resolveIntent({
      llm: this.dependencies.llm,
      message: input.message,
      context: {
        tenantId: input.tenantId,
        walletAddress: input.walletAddress,
        runtimeChainId: 8453,
        requestId: input.requestId,
        requestedAt: input.now.toISOString(),
        pendingIntents: carried ? [carried] : [],
      },
    });
    await this.storePendingIntent(binding, resolution);
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

    // Why a comparison came out the way it did — the one line that was missing.
    //
    // Three separate investigations this week ended at the same wall: the UI
    // said "KyberSwap invalid schema" or "Uniswap HTTP error" and the server
    // said nothing at all, so every diagnosis had to be rebuilt by hand with
    // probes against live endpoints. A provider dropping out silently changes
    // the outcome four layers downstream — no ranking, no recommendation, no
    // Route Card, a dead Review button — and none of that is traceable to its
    // cause without this.
    //
    // Provider ids, typed refusal codes and scoring statuses only. No wallet,
    // no amounts, no hashes, no quotes, no endpoints, no credentials: which
    // provider refused and under which code is the whole diagnosis, and none
    // of the rest is needed to have it.
    logger.info('Route comparison outcome', {
      outcome: evaluation.outcome,
      reason: evaluation.reason,
      routeCard: routeCard ? 'built' : 'none',
      quoted: evaluation.candidates.map((candidate) => candidate.provider.id).sort(),
      refused: evaluation.adapterFailures.map(
        (failure) => `${failure.provider}:${failure.errorCode}`,
      ).sort(),
      // A quoted route that cannot be scored is invisible in `quoted` and is
      // exactly what stops a recommendation being made.
      unscored: evaluation.netResultMetrics
        .filter((metric) => metric.status !== 'computed')
        .map((metric) => metric.reason ?? 'not_scored')
        .sort(),
    });
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
