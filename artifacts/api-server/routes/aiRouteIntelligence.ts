import { Router, type Request, type Response } from 'express';
import { logger } from '@mioagent/utils';
import {
  AiCompareRequestV1Schema,
  AiCompareResponseV1Schema,
  AiExecuteRequestV1Schema,
  AiExecuteResponseV1Schema,
  AiProofResponseV1Schema,
} from '@mioagent/api-zod';
import { AI_PROOF_HEADLINE_V1 } from '@mioagent/route-domain';
import {
  aiComparisonCopyV1,
  aiExecutionCopyV1,
  compareAiRoutesV1,
  createVeniceGatewayV1,
  resolveAiIntentV1,
  runAiInferenceV1,
  type VeniceGatewayV1,
} from '@mioagent/ai-engine';
import {
  RouteStorageConflictError,
  RouteStorageIntegrityError,
  aiIdempotencyKeyV1,
  createDatabaseAiRouteStorageRepository,
  type AiRouteStorageRepositoryV1,
} from '@mioagent/route-storage';
import { client } from '@mioagent/db';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import { resolveAiRouteConfigV1 } from '../lib/aiRouteConfig.js';

// ---------------------------------------------------------------------------
// T66C/T66D — the Private AI rail.
//
// Its own module, like the NFT rail, and the shape of every handler is the
// point of the family:
//
//   compare  takes the prompt, returns a card and a NONCE, and stores neither
//            the prompt nor the nonce.
//   execute  takes the prompt AGAIN plus the nonce, proves it is the reviewed
//            request by recomputing the commitment, calls exactly the model on
//            the card, and stores a proof that contains neither.
//
// NOTHING IN THIS FILE LOGS A PROMPT OR A COMPLETION. The log lines carry
// hashes, model ids, token counts and reasons. That is a rule the reviewer
// should check on every future edit, because it is the one an ordinary
// debugging session is most likely to break.
// ---------------------------------------------------------------------------

export const aiRouteIntelligenceRouter = Router();

export const aiRouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  config: () => resolveAiRouteConfigV1(process.env),
  repository: (): AiRouteStorageRepositoryV1 => createDatabaseAiRouteStorageRepository(client),
  gateway: (): VeniceGatewayV1 => {
    const config = resolveAiRouteConfigV1(process.env);
    // Production uses only the server-side key. No path here accepts one from
    // a client or writes one anywhere.
    return createVeniceGatewayV1({ apiKey: config.veniceApiKey, timeoutMs: config.timeoutMs });
  },
  migrationAvailable: aiStorageMigrationAvailable,
  now: () => new Date(),
};

function sessionUser(req: Request) {
  const user = req.session?.user;
  if (
    !user ||
    user.chainId !== 8453 ||
    !/^0x[0-9a-f]{40}$/.test(user.address) ||
    user.id !== `eip155:8453:${user.address}`
  ) return null;
  return user;
}

/** flag(routeIntelligenceV1 && privateAiRouteV1) + session + body + wallet —
 * the shared head of every Private AI route. */
function aiGuard<T>(
  req: Request,
  res: Response,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  invalidCode: string,
): { user: NonNullable<ReturnType<typeof sessionUser>>; body: T } | null {
  const flags = aiRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.privateAiRouteV1) {
    res.status(404).json({ error: 'private_ai_route_disabled', code: 'private_ai_route_disabled' });
    return null;
  }
  const user = sessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return null;
  }
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: invalidCode, code: invalidCode });
    return null;
  }
  const body = parsed.data as T & { walletAddress?: string };
  if (body.walletAddress !== undefined && body.walletAddress !== user.address) {
    res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
    return null;
  }
  return { user, body: parsed.data };
}

/** Private AI needs its own additive tables (0020). Missing storage is a
 * stable 503, never a partial write. */
async function aiStorageMigrationAvailable(): Promise<boolean> {
  const rows = await client`
    SELECT
      to_regclass('public.ai_route_cards') AS ai_route_cards,
      to_regclass('public.ai_inference_proofs') AS ai_inference_proofs
  `;
  const row = rows[0];
  return Boolean(row && row.ai_route_cards && row.ai_inference_proofs);
}

function storageFailure(res: Response, error: unknown, where: string): void {
  if (error instanceof RouteStorageConflictError) {
    res.status(409).json({ error: 'conflict', code: 'conflict', detail: error.message });
    return;
  }
  if (error instanceof RouteStorageIntegrityError) {
    res.status(500).json({ error: 'storage_integrity', code: 'storage_integrity' });
    return;
  }
  // The message is NOT echoed to the client and the prompt is not in scope
  // here — only the failure site and the error name reach the log.
  logger.error('Private AI storage failed', {
    where,
    name: error instanceof Error ? error.name : 'unknown',
  });
  res.status(500).json({ error: 'storage_unavailable', code: 'storage_unavailable' });
}

// --- compare ----------------------------------------------------------------

aiRouteIntelligenceRouter.post('/ai/compare', async (req: Request, res: Response) => {
  const guard = aiGuard(req, res, AiCompareRequestV1Schema, 'invalid_ai_compare_request');
  if (!guard) return;

  const config = aiRouteRuntime.config();
  if (!config.configured) {
    res.status(503).json({ error: 'venice_not_configured', code: 'venice_not_configured' });
    return;
  }
  if (!(await aiRouteRuntime.migrationAvailable())) {
    res.status(503).json({ error: 'storage_unavailable', code: 'storage_unavailable' });
    return;
  }

  const now = aiRouteRuntime.now();
  const runId = `${guard.user.id}:ai:${guard.body.requestId}`;
  const resolution = resolveAiIntentV1({
    runId,
    tenantId: guard.user.id,
    walletAddress: guard.user.address as `0x${string}`,
    chainId: 8453,
    systemText: guard.body.systemText ?? null,
    messages: guard.body.messages,
    privacyRequirement: guard.body.privacyRequirement,
    maxSpendUsd: guard.body.maxSpendUsd ?? null,
    maxCompletionTokens: guard.body.maxCompletionTokens,
    preferredModelId: guard.body.preferredModelId ?? null,
    requiresToolCalling: guard.body.requiresToolCalling,
    requiresResponseSchema: guard.body.requiresResponseSchema,
    requiresWebSearch: guard.body.requiresWebSearch,
    now,
  });

  if (resolution.status !== 'ready') {
    res.json(
      AiCompareResponseV1Schema.parse(
        resolution.status === 'needs_clarification'
          ? { outcome: 'needs_clarification', issues: [resolution.reason] }
          : { outcome: 'unsupported', reason: resolution.reason },
      ),
    );
    return;
  }

  // A draft intent has no spend ceiling. The surface must ask before anything
  // is compared against a budget that does not exist.
  if (resolution.intent.status === 'draft') {
    res.json(
      AiCompareResponseV1Schema.parse({
        outcome: 'needs_clarification',
        issues: ['Set the most you are willing to spend on this one request, in USD.'],
      }),
    );
    return;
  }

  const comparison = await compareAiRoutesV1(
    { gateway: aiRouteRuntime.gateway() },
    {
      runId,
      tenantId: guard.user.id,
      walletAddress: guard.user.address as `0x${string}`,
      chainId: 8453,
      intent: resolution.intent,
      allowlist: config.modelAllowlist,
      retentionClaim: config.retentionClaim,
      x402Metered: config.x402Metered,
      now,
      ttlMs: config.cardTtlMs,
      catalogueTtlMs: config.catalogueTtlMs,
    },
  );

  const repository = aiRouteRuntime.repository();
  const idempotencyKey = aiIdempotencyKeyV1({
    tenantId: guard.user.id,
    walletAddress: guard.user.address,
    requestId: guard.body.requestId,
    promptCommitment: resolution.intent.prompt.commitment,
  });

  if (!comparison.ok && comparison.card === null) {
    // Nothing was established at all, so nothing is stored. The run would have
    // no card to point at.
    res.json(
      AiCompareResponseV1Schema.parse({
        outcome: 'unavailable',
        routeRunId: runId,
        routeCard: null,
        reason: comparison.reason,
        detail: aiComparisonCopyV1(comparison.reason),
      }),
    );
    return;
  }

  const card = comparison.ok ? comparison.card : comparison.card;
  if (card === null) return;

  try {
    const run = await repository.createAiRouteRun(resolution.intent, idempotencyKey);
    const cardId = `${run.id}:card`;
    const stored = await repository.getAiRouteCard(run.id, guard.user.id);
    if (stored === null) {
      await repository.insertAiRouteCard({
        id: cardId,
        routeRunId: run.id,
        userId: guard.user.id,
        walletAddress: guard.user.address,
        intent: resolution.intent,
        card,
      });
    }

    if (!comparison.ok) {
      res.json(
        AiCompareResponseV1Schema.parse({
          outcome: 'unavailable',
          routeRunId: run.id,
          routeCard: stored?.card ?? card,
          reason: comparison.reason,
          detail: aiComparisonCopyV1(comparison.reason),
        }),
      );
      return;
    }

    logger.info('Private AI comparison', {
      routeRunId: run.id,
      // The commitment, not the prompt. This is the identifier a support
      // conversation can use without either side quoting the request.
      promptCommitment: resolution.intent.prompt.commitment,
      selectedModelId: comparison.selected.modelId,
      privacyMode: comparison.selected.privacyMode,
      candidates: comparison.candidates.length,
      cardStatus: card.status,
    });

    res.json(
      AiCompareResponseV1Schema.parse({
        outcome: 'compared',
        routeRunId: run.id,
        routeCardId: stored?.id ?? cardId,
        routeCard: stored?.card ?? card,
        promptCommitment: resolution.intent.prompt.commitment,
        // Handed over ONCE. From here the server cannot open its own
        // commitment, which is the property the whole family rests on.
        promptNonce: resolution.promptNonce,
        executionEnabled: aiRouteRuntime.flags(process.env).privateAiExecutionV1,
      }),
    );
  } catch (error) {
    storageFailure(res, error, 'compare');
  }
});

// --- execute ----------------------------------------------------------------

aiRouteIntelligenceRouter.post('/ai/execute', async (req: Request, res: Response) => {
  const guard = aiGuard(req, res, AiExecuteRequestV1Schema, 'invalid_ai_execute_request');
  if (!guard) return;

  const flags = aiRouteRuntime.flags(process.env);
  if (!flags.privateAiExecutionV1) {
    // Comparison being on does not imply execution is. Comparing sends nothing
    // anywhere; running a model sends the user's prompt to a third party.
    res.status(403).json({
      error: 'private_ai_execution_disabled',
      code: 'private_ai_execution_disabled',
      detail: aiExecutionCopyV1('execution_disabled'),
    });
    return;
  }

  const config = aiRouteRuntime.config();
  if (!config.configured) {
    res.status(503).json({ error: 'venice_not_configured', code: 'venice_not_configured' });
    return;
  }
  if (!(await aiRouteRuntime.migrationAvailable())) {
    res.status(503).json({ error: 'storage_unavailable', code: 'storage_unavailable' });
    return;
  }

  const repository = aiRouteRuntime.repository();
  try {
    const stored = await repository.getAiRouteCard(guard.body.routeRunId, guard.user.id);
    if (!stored) {
      res.status(404).json({ error: 'route_run_not_found', code: 'route_run_not_found' });
      return;
    }
    // The card is named by HASH. A stale or substituted hash is refused rather
    // than silently re-run against whatever is stored now.
    if (stored.card.routeCardHash !== guard.body.routeCardHash) {
      res.status(409).json({
        error: 'route_card_mismatch',
        code: 'route_card_mismatch',
        detail: 'This is not the Route Card that was reviewed.',
      });
      return;
    }

    // A recorded answer short-circuits before the provider is called again.
    // Refreshing the page must not buy a second completion.
    const settled = await repository.getAiProofByCard(stored.id, guard.user.id);
    if (settled) {
      res.json(
        AiExecuteResponseV1Schema.parse({
          outcome: settled.proof.finalStatus === 'refused' ? 'refused' : 'completed',
          proofId: settled.id,
          proof: settled.proof,
          ...(settled.proof.finalStatus === 'refused'
            ? {}
            : {
                // The ANSWER is gone. It was returned once, to the caller that
                // ran it, and this server did not keep a copy — so a repeat
                // request gets the proof and an honest empty body.
                text: '',
              }),
          copy: AI_PROOF_HEADLINE_V1[settled.proof.finalStatus],
        }),
      );
      return;
    }

    const result = await runAiInferenceV1(
      { gateway: aiRouteRuntime.gateway() },
      {
        runId: stored.routeRunId,
        tenantId: guard.user.id,
        walletAddress: guard.user.address as `0x${string}`,
        chainId: 8453,
        intent: stored.intent,
        card: stored.card,
        systemText: guard.body.systemText ?? null,
        messages: guard.body.messages,
        promptNonce: guard.body.promptNonce,
        allowlist: config.modelAllowlist,
        responseSchema: (guard.body.responseSchema ?? null) as Record<string, unknown> | null,
        temperature: guard.body.temperature ?? null,
        x402Metered: config.x402Metered,
        now: aiRouteRuntime.now(),
      },
    );

    if (!result.ok && result.proof === null) {
      logger.warn('Private AI execution refused', {
        routeRunId: stored.routeRunId,
        reason: result.reason,
        promptCommitment: stored.intent.prompt.commitment,
      });
      res.status(result.reason === 'prompt_commitment_mismatch' ? 409 : 502).json(
        AiExecuteResponseV1Schema.parse({
          outcome: 'blocked',
          reason: result.reason,
          detail: aiExecutionCopyV1(result.reason),
        }),
      );
      return;
    }

    const proof = result.ok ? result.proof : result.proof;
    if (proof === null) return;
    const record = await repository.insertAiProof({
      id: `${stored.routeRunId}:proof`,
      routeRunId: stored.routeRunId,
      routeCardId: stored.id,
      userId: guard.user.id,
      walletAddress: guard.user.address,
      proof,
    });

    logger.info('Private AI execution recorded', {
      routeRunId: stored.routeRunId,
      proofId: record.id,
      modelId: proof.modelId,
      finalStatus: proof.finalStatus,
      finishReason: proof.finishReason,
      promptTokens: proof.usage.promptTokens,
      completionTokens: proof.usage.completionTokens,
      actualCostUsd: proof.usage.actualCostUsd,
      latencyMs: proof.usage.latencyMs,
    });

    res.json(
      AiExecuteResponseV1Schema.parse(
        result.ok
          ? {
              outcome: 'completed',
              proofId: record.id,
              proof: record.proof,
              text: result.text,
              copy: AI_PROOF_HEADLINE_V1[record.proof.finalStatus],
            }
          : {
              outcome: 'refused',
              proofId: record.id,
              proof: record.proof,
              copy: AI_PROOF_HEADLINE_V1[record.proof.finalStatus],
            },
      ),
    );
  } catch (error) {
    storageFailure(res, error, 'execute');
  }
});

// --- proof ------------------------------------------------------------------

aiRouteIntelligenceRouter.get('/ai/proof/:routeRunId', async (req: Request, res: Response) => {
  const flags = aiRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.privateAiRouteV1) {
    res.status(404).json({ error: 'private_ai_route_disabled', code: 'private_ai_route_disabled' });
    return;
  }
  const user = sessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  if (!(await aiRouteRuntime.migrationAvailable())) {
    res.status(503).json({ error: 'storage_unavailable', code: 'storage_unavailable' });
    return;
  }

  const repository = aiRouteRuntime.repository();
  try {
    const stored = await repository.getAiRouteCard(String(req.params.routeRunId), user.id);
    if (!stored) {
      res.status(404).json({ error: 'route_run_not_found', code: 'route_run_not_found' });
      return;
    }
    const record = await repository.getAiProofByCard(stored.id, user.id);
    if (!record) {
      res.status(404).json({ error: 'proof_not_found', code: 'proof_not_found' });
      return;
    }
    res.json(
      AiProofResponseV1Schema.parse({
        proofId: record.id,
        proof: record.proof,
        copy: AI_PROOF_HEADLINE_V1[record.proof.finalStatus],
      }),
    );
  } catch (error) {
    storageFailure(res, error, 'proof');
  }
});
