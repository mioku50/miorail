import { Router, type Request, type Response } from 'express';
import { logger } from '@mioagent/utils';
import {
  RecoverableSubmissionAttemptsResponseV1Schema,
  SubmissionAttemptBatchRequestV1Schema,
  SubmissionAttemptCreateRequestV1Schema,
  SubmissionAttemptResponseV1Schema,
} from '@mioagent/api-zod';
import type { SubmissionAttemptV1, SubmissionGoalV1 } from '@mioagent/route-domain';
import {
  RouteStorageConflictError,
  RouteStorageIntegrityError,
  createDatabaseRouteStorageRepository,
  createDatabaseNftStorageRepository,
  createDatabaseSubmissionAttemptRepository,
  type NftStorageRepository,
  type RouteStorageRepository,
  type SubmissionAttemptRepositoryV1,
} from '@mioagent/route-storage';
import { routeProofIdV1 } from '@mioagent/transaction-composer';
import { client } from '@mioagent/db';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';

// ---------------------------------------------------------------------------
// T67C.2 — submission recovery.
//
// What this router can do: read an attempt, write down a batch id the wallet
// already returned, and mark an attempt as no longer worth showing.
//
// What it cannot do, and what no amount of client input can make it do: send a
// transaction, re-send one, approve a blueprint, re-quote a route, or accept
// calls, calldata or a receipt from the caller. There is no code path here to
// any of those — the recovery request carries handles, and every fact behind
// them is re-read from this server's own records.
//
// The rule this exists to keep: a user who reloads after their wallet already
// broadcast a batch gets to FINISH CHECKING that batch. They never get a second
// one. Miorail has exactly one submission path (T57's useSubmitApprovedBlueprint
// → wallet_sendCalls) and recovery is not a second one.
// ---------------------------------------------------------------------------

export const submissionRecoveryRouter = Router();

export const submissionRecoveryRuntime = {
  flags: getMiorailProductMigrationFlags,
  repository: (): SubmissionAttemptRepositoryV1 => createDatabaseSubmissionAttemptRepository(client),
  routeRepository: (): RouteStorageRepository => createDatabaseRouteStorageRepository(client),
  nftRepository: (): NftStorageRepository => createDatabaseNftStorageRepository(client),
  migrationAvailable: async (): Promise<boolean> => {
    const rows = await client`SELECT to_regclass('public.submission_attempts') AS attempts`;
    const row = rows[0];
    return Boolean(row && row.attempts);
  },
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

function recoveryGuard(
  req: Request,
  res: Response,
): { user: NonNullable<ReturnType<typeof sessionUser>> } | null {
  const flags = submissionRecoveryRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.submissionRecoveryV1) {
    res.status(404).json({ error: 'submission_recovery_disabled', code: 'submission_recovery_disabled' });
    return null;
  }
  const user = sessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return null;
  }
  return { user };
}

/** The wire projection. `tenantId` is not on it: the caller already proved who
 * they are, and echoing the tenant back adds nothing but a leak surface. */
function attemptWireV1(attempt: SubmissionAttemptV1) {
  return {
    id: attempt.id,
    walletAddress: attempt.walletAddress,
    chainId: attempt.chainId as 8453,
    goal: attempt.goal,
    routeRunId: attempt.routeRunId,
    blueprintId: attempt.blueprintId,
    proofId: attempt.proofId,
    approvedCallsHash: attempt.approvedCallsHash,
    batchId: attempt.batchId,
    status: attempt.status,
    errorCode: attempt.errorCode,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    completedAt: attempt.completedAt,
  };
}

function storageFailure(res: Response, error: unknown, where: string): void {
  if (error instanceof RouteStorageConflictError) {
    res.status(409).json({
      error: 'submission_attempt_conflict',
      code: 'submission_attempt_conflict',
      detail: error.message,
    });
    return;
  }
  if (error instanceof RouteStorageIntegrityError) {
    res.status(500).json({ error: 'storage_integrity', code: 'storage_integrity' });
    return;
  }
  logger.error('Submission recovery storage failed', {
    where,
    name: error instanceof Error ? error.name : 'unknown',
  });
  res.status(500).json({ error: 'storage_unavailable', code: 'storage_unavailable' });
}

export interface AttemptBindingV1 {
  ok: boolean;
  code?: string;
  proofId?: string | null;
}

/**
 * Re-verifies the whole chain behind a create request, from this server's
 * records only.
 *
 * The client sends four handles and a hash. Everything that matters — that the
 * run exists and belongs to this tenant, that the blueprint belongs to that
 * run, that it was approved, that the approved calls are byte-for-byte the ones
 * named, that a proof is open for it — is read here. A forged or replayed
 * request therefore cannot create an attempt bound to a blueprint the caller
 * does not own.
 */
export async function verifyAttemptBindingV1(
  deps: { route: RouteStorageRepository; nft: NftStorageRepository },
  input: {
    tenantId: string;
    walletAddress: string;
    goal: SubmissionGoalV1;
    routeRunId: string;
    blueprintId: string;
    approvedCallsHash: string;
  },
): Promise<AttemptBindingV1> {
  if (input.goal === 'nft') {
    const stored = await deps.nft.getNftPurchaseBlueprint(input.blueprintId, input.tenantId);
    if (!stored || stored.routeRunId !== input.routeRunId) return { ok: false, code: 'blueprint_not_found' };
    if (stored.blueprint.buyer.toLowerCase() !== input.walletAddress.toLowerCase()) {
      return { ok: false, code: 'wallet_binding_mismatch' };
    }
    if (stored.blueprint.status !== 'approved' && stored.blueprint.status !== 'submitted') {
      return { ok: false, code: 'blueprint_not_approved' };
    }
    if (stored.blueprint.approvedCallsHash !== input.approvedCallsHash) {
      return { ok: false, code: 'approved_calls_hash_mismatch' };
    }
    // The NFT proof opens at submission rather than at approve, so requiring a
    // pending proof here would make an attempt impossible before the wallet is
    // even opened. The equivalent honest check is that nothing has already
    // finished answering for this blueprint.
    const proof = await deps.nft.getNftProofByBlueprint(input.blueprintId, input.tenantId);
    if (proof && proof.proof.status === 'finalized') return { ok: false, code: 'proof_already_final' };
    return { ok: true, proofId: proof?.id ?? null };
  }

  const run =
    (await deps.route.getRouteRun(input.routeRunId, input.tenantId)) ??
    (await deps.route.getEarnRouteRun(input.routeRunId, input.tenantId));
  if (!run) return { ok: false, code: 'route_run_not_found' };
  if (run.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    return { ok: false, code: 'wallet_binding_mismatch' };
  }
  if (run.chainId !== 8453) return { ok: false, code: 'unsupported_chain' };

  const blueprints = await deps.route.listBlueprints(input.routeRunId, input.tenantId);
  const stored = blueprints.find((entry) => entry.blueprint.id === input.blueprintId);
  if (!stored) return { ok: false, code: 'blueprint_not_found' };
  if (stored.blueprint.status !== 'approved') return { ok: false, code: 'blueprint_not_approved' };
  if (stored.blueprint.approvedCallsHash !== input.approvedCallsHash) {
    return { ok: false, code: 'approved_calls_hash_mismatch' };
  }

  const proofId = routeProofIdV1(stored.blueprint.id);
  const proof = await deps.route.getProofProjection(proofId, input.tenantId);
  if (!proof) return { ok: false, code: 'route_proof_missing' };
  return { ok: true, proofId };
}

submissionRecoveryRouter.post('/submission-attempts', async (req: Request, res: Response) => {
  const guard = recoveryGuard(req, res);
  if (!guard) return;

  const parsed = SubmissionAttemptCreateRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_submission_attempt_request', code: 'invalid_submission_attempt_request' });
    return;
  }
  // The signed session is the authority on which wallet this is. A body naming
  // a different wallet is refused rather than trusted.
  if (parsed.data.walletAddress.toLowerCase() !== guard.user.address) {
    res.status(403).json({ error: 'wallet_binding_mismatch', code: 'wallet_binding_mismatch' });
    return;
  }

  try {
    if (!(await submissionRecoveryRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'submission_recovery_unavailable', code: 'submission_recovery_unavailable' });
      return;
    }
    const binding = await verifyAttemptBindingV1(
      { route: submissionRecoveryRuntime.routeRepository(), nft: submissionRecoveryRuntime.nftRepository() },
      {
        tenantId: guard.user.id,
        walletAddress: guard.user.address,
        goal: parsed.data.goal,
        routeRunId: parsed.data.routeRunId,
        blueprintId: parsed.data.blueprintId,
        approvedCallsHash: parsed.data.approvedCallsHash.toLowerCase(),
      },
    );
    if (!binding.ok) {
      const code = binding.code ?? 'submission_attempt_rejected';
      res.status(code === 'approved_calls_hash_mismatch' ? 409 : 404).json({ error: code, code });
      return;
    }

    const attempt = await submissionRecoveryRuntime.repository().createAttempt({
      tenantId: guard.user.id,
      walletAddress: guard.user.address,
      goal: parsed.data.goal,
      routeRunId: parsed.data.routeRunId,
      blueprintId: parsed.data.blueprintId,
      approvedCallsHash: parsed.data.approvedCallsHash.toLowerCase(),
      proofId: binding.proofId ?? null,
      now: submissionRecoveryRuntime.now(),
    });
    res.json(SubmissionAttemptResponseV1Schema.parse({ attempt: attemptWireV1(attempt) }));
  } catch (error) {
    storageFailure(res, error, 'create');
  }
});

submissionRecoveryRouter.post('/submission-attempts/:attemptId/batch', async (req: Request, res: Response) => {
  const guard = recoveryGuard(req, res);
  if (!guard) return;

  const parsed = SubmissionAttemptBatchRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_submission_batch_request', code: 'invalid_submission_batch_request' });
    return;
  }

  try {
    if (!(await submissionRecoveryRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'submission_recovery_unavailable', code: 'submission_recovery_unavailable' });
      return;
    }
    const attempt = await submissionRecoveryRuntime.repository().bindBatch({
      attemptId: String(req.params.attemptId),
      tenantId: guard.user.id,
      batchId: parsed.data.batchId,
      now: submissionRecoveryRuntime.now(),
    });
    // Another tenant's attempt and a nonexistent one are the same 404, so a
    // caller cannot probe for which attempt ids exist.
    if (!attempt) {
      res.status(404).json({ error: 'submission_attempt_not_found', code: 'submission_attempt_not_found' });
      return;
    }
    res.json(SubmissionAttemptResponseV1Schema.parse({ attempt: attemptWireV1(attempt) }));
  } catch (error) {
    storageFailure(res, error, 'bind');
  }
});

submissionRecoveryRouter.get('/submission-attempts/recoverable', async (req: Request, res: Response) => {
  const guard = recoveryGuard(req, res);
  if (!guard) return;

  try {
    if (!(await submissionRecoveryRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'submission_recovery_unavailable', code: 'submission_recovery_unavailable' });
      return;
    }
    // The wallet comes from the SESSION, never from the query string. A wallet
    // parameter would be an authorization decision made by the caller.
    const attempts = await submissionRecoveryRuntime
      .repository()
      .listRecoverable(guard.user.id, guard.user.address);
    res.json(
      RecoverableSubmissionAttemptsResponseV1Schema.parse({ attempts: attempts.map(attemptWireV1) }),
    );
  } catch (error) {
    storageFailure(res, error, 'list');
  }
});

submissionRecoveryRouter.post('/submission-attempts/:attemptId/abandon', async (req: Request, res: Response) => {
  const guard = recoveryGuard(req, res);
  if (!guard) return;

  try {
    if (!(await submissionRecoveryRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'submission_recovery_unavailable', code: 'submission_recovery_unavailable' });
      return;
    }
    // `abandoned` means one thing: stop showing me this card. It writes no
    // proof, no receipt and no onchain claim — the batch, if there was one, is
    // exactly where it was.
    const attempt = await submissionRecoveryRuntime.repository().updateAttempt({
      attemptId: String(req.params.attemptId),
      tenantId: guard.user.id,
      status: 'abandoned',
      now: submissionRecoveryRuntime.now(),
    });
    if (!attempt) {
      res.status(404).json({ error: 'submission_attempt_not_found', code: 'submission_attempt_not_found' });
      return;
    }
    res.json(SubmissionAttemptResponseV1Schema.parse({ attempt: attemptWireV1(attempt) }));
  } catch (error) {
    storageFailure(res, error, 'abandon');
  }
});
