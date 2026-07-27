import { Router, type Request, type Response } from 'express';
import { logger } from '@mioagent/utils';
import {
  NftApproveRequestV1Schema,
  NftApproveResponseV1Schema,
  NftCompareRequestV1Schema,
  NftCompareResponseV1Schema,
  NftPrepareRequestV1Schema,
  NftPrepareResponseV1Schema,
  NftProofResponseV1Schema,
  NftSubmissionRequestV1Schema,
  NftSubmissionResponseV1Schema,
} from '@mioagent/api-zod';
import { resolveNftIntentV1 } from '@mioagent/intent-engine';
import {
  NFT_PROOF_COPY_V1,
  buildNftProofEventV1,
  buildNftPurchaseBlueprintV1,
  buildNftPurchaseProofV1,
  buildNftReceiptLegV1,
  buildNftOwnershipReadV1,
  compareNftRoutesV1,
  expectedFulfillmentFormV1,
  createOpenSeaGatewayV1,
  findNftTransferV1,
  nftComparisonCopyV1,
  nftProofNeedsReconciliationV1,
  nftPurchaseSafetyKernelV1,
  nftPurchaseSignableV1,
  readOpenSeaFulfillmentV1,
  reconcileNftProofV1,
  verifyNftListingUnchangedV1,
} from '@mioagent/nft-engine';
import {
  RouteStorageConflictError,
  RouteStorageIntegrityError,
  createDatabaseNftStorageRepository,
  createDatabaseSubmissionAttemptRepository,
  nftIdempotencyKeyV1,
  type NftProofRecordV1,
  type NftStorageRepository,
  type SubmissionAttemptRepositoryV1,
} from '@mioagent/route-storage';
import { client } from '@mioagent/db';
import {
  recordAttemptOutcomeV1,
  verifySubmissionAttemptV1,
} from '../lib/submissionAttemptLink.js';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import { simulateNftBlueprintV1 } from '../lib/nftSimulation.js';
import { createViemNftChainReaderV1 } from '../lib/nftChainReader.js';
import { resolveNftRouteConfigV1 } from '../lib/nftRouteConfig.js';

// ---------------------------------------------------------------------------
// T65.1 §2/§4/§5 — the NFT purchase rail.
//
// Its own module rather than another 500 lines in routeIntelligence.ts. The
// shape of every handler is the same and it is the point of the whole family:
//
//   the client sends a goal, a card hash, or the hash of the calls it
//   reviewed. It never sends calldata, a target, a value or a recipient, and
//   the server never signs or broadcasts anything.
// ---------------------------------------------------------------------------

export const nftRouteIntelligenceRouter = Router();

export const nftRouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  config: () => resolveNftRouteConfigV1(process.env),
  repository: (): NftStorageRepository => createDatabaseNftStorageRepository(client),
  gateway: () => {
    const config = resolveNftRouteConfigV1(process.env);
    // Production uses only the server-side key. There is no path here that
    // creates one, prompts for one, or runs an OpenSea CLI.
    return createOpenSeaGatewayV1({ apiKey: config.openSeaApiKey, timeoutMs: config.timeoutMs });
  },
  simulate: simulateNftBlueprintV1,
  chainReader: () => createViemNftChainReaderV1(process.env),
  migrationAvailable: nftStorageMigrationAvailable,
  // T67C.2: the SAME attempt store swap and earn use. NFT recovery is not a
  // second mechanism; it is this one with goal='nft'.
  attemptRepository: (): SubmissionAttemptRepositoryV1 => createDatabaseSubmissionAttemptRepository(client),
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

/** flag(routeIntelligenceV1 && nftRouteV1) + session + body + wallet + chain —
 * the shared head of every NFT route. */
function nftGuard<T>(
  req: Request,
  res: Response,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  invalidCode: string,
): { user: NonNullable<ReturnType<typeof sessionUser>>; body: T } | null {
  const flags = nftRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.nftRouteV1) {
    res.status(404).json({ error: 'nft_route_disabled', code: 'nft_route_disabled' });
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
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return null;
  }
  return { user, body: parsed.data };
}

/** NFT needs its own additive tables (0017/0018). Missing storage is a stable
 * 503, never a partial write. */
async function nftStorageMigrationAvailable(): Promise<boolean> {
  const rows = await client`
    SELECT
      to_regclass('public.nft_candidates') AS nft_candidates,
      to_regclass('public.nft_evidence') AS nft_evidence,
      to_regclass('public.nft_route_cards') AS nft_route_cards,
      to_regclass('public.nft_purchase_blueprints') AS nft_purchase_blueprints,
      to_regclass('public.nft_proofs') AS nft_proofs,
      to_regclass('public.nft_proof_events') AS nft_proof_events
  `;
  const row = rows[0];
  return Boolean(
    row &&
      row.nft_candidates &&
      row.nft_evidence &&
      row.nft_route_cards &&
      row.nft_purchase_blueprints &&
      row.nft_proofs &&
      row.nft_proof_events,
  );
}

async function storageReady(res: Response): Promise<boolean> {
  if (await nftRouteRuntime.migrationAvailable()) return true;
  res.status(503).json({ error: 'nft_storage_unavailable', code: 'nft_storage_unavailable' });
  return false;
}

function failed(res: Response, error: unknown, wallet: string, code: string): void {
  // T64.3.1's lesson: a bare catch made a 500 undiagnosable from either side.
  // The body stays a stable code; the cause goes to the log.
  logger.error(`NFT route failed: ${code}`, {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    wallet,
  });
  if (error instanceof RouteStorageConflictError || error instanceof RouteStorageIntegrityError) {
    res.status(409).json({ error: code, code, detail: error.message });
    return;
  }
  res.status(500).json({ error: code, code });
}

// --- §2 compare -------------------------------------------------------------

nftRouteIntelligenceRouter.post('/nft/compare', async (req, res) => {
  const guard = nftGuard(req, res, NftCompareRequestV1Schema, 'invalid_nft_compare_request');
  if (!guard) return;
  try {
    const now = nftRouteRuntime.now();
    const resolution = resolveNftIntentV1({
      message: guard.body.message,
      tenantId: guard.user.id,
      walletAddress: guard.user.address as `0x${string}`,
      now,
      // Each comparison is its own run. Without this the run id came from the
      // goal text alone, so comparing one NFT twice collided with its own
      // earlier run and failed permanently.
      requestId: guard.body.requestId,
    });
    if (resolution.status === 'unsupported') {
      res.json(NftCompareResponseV1Schema.parse({ outcome: 'unsupported', reason: resolution.issues[0] ?? 'unsupported_nft_request' }));
      return;
    }
    if (resolution.status === 'needs_clarification') {
      res.json(NftCompareResponseV1Schema.parse({ outcome: 'needs_clarification', issues: resolution.issues }));
      return;
    }

    // A ready intent without a ceiling cannot exist by design, and if one ever
    // did it must not become a purchase. Asked for, never defaulted.
    if (resolution.intent.maxSpendWei === null) {
      res.json(NftCompareResponseV1Schema.parse({ outcome: 'needs_clarification', issues: ['max_spend_required'] }));
      return;
    }
    const maxSpendWei = resolution.intent.maxSpendWei;

    const config = nftRouteRuntime.config();
    const comparison = await compareNftRoutesV1(
      { gateway: nftRouteRuntime.gateway() },
      { intent: resolution.intent, now, ttlMs: config.listingTtlMs, imageAllowed: config.imageAllowed },
    );
    if (!(await storageReady(res))) return;

    const repository = nftRouteRuntime.repository();
    const idempotencyKey = nftIdempotencyKeyV1({
      tenantId: guard.user.id,
      walletAddress: guard.user.address,
      contractAddress: resolution.intent.contractAddress ?? resolution.intent.collectionSlug ?? 'unresolved',
      tokenId: resolution.intent.tokenId,
      maxSpendWei,
      requestId: guard.body.requestId,
    });
    const run = await repository.createNftRouteRun(resolution.intent, idempotencyKey);

    // A comparison that found nothing still persists what it learned. The
    // evidence of a refusal is evidence.
    for (const record of comparison.evidence) {
      if (comparison.ok) continue;
      await repository.insertNftEvidence(run.id, record);
    }
    if (comparison.ok) {
      await repository.insertNftCandidate(run.id, comparison.candidate);
      for (const record of comparison.evidence) await repository.insertNftEvidence(run.id, record);
    }
    if (comparison.card) await repository.insertNftRouteCard(run.id, comparison.card);

    if (!comparison.ok) {
      if (!comparison.card) {
        res.json(NftCompareResponseV1Schema.parse({ outcome: 'unsupported', reason: nftComparisonCopyV1(comparison.reason) }));
        return;
      }
      res.json(
        NftCompareResponseV1Schema.parse({
          outcome: 'unavailable',
          routeRunId: run.id,
          routeCard: comparison.card,
          reason: comparison.reason,
          detail: nftComparisonCopyV1(comparison.reason),
        }),
      );
      return;
    }
    res.json(NftCompareResponseV1Schema.parse({ outcome: 'compared', routeRunId: run.id, routeCard: comparison.card }));
  } catch (error) {
    failed(res, error, guard.user.address, 'nft_compare_failed');
  }
});

// --- §2 prepare -------------------------------------------------------------

nftRouteIntelligenceRouter.post('/nft/prepare', async (req, res) => {
  const guard = nftGuard(req, res, NftPrepareRequestV1Schema, 'invalid_nft_prepare_request');
  if (!guard) return;
  if (!(await storageReady(res))) return;
  try {
    const now = nftRouteRuntime.now();
    const repository = nftRouteRuntime.repository();
    const run = await repository.getNftRouteRun(guard.body.routeRunId, guard.user.id);
    if (!run) {
      res.status(404).json({ error: 'nft_route_run_not_found', code: 'nft_route_run_not_found' });
      return;
    }
    // The card the user reviewed, loaded by hash. Not re-derived: a fresh
    // comparison here would price the purchase at whatever is current rather
    // than at what was on screen.
    const card = await repository.getNftRouteCard(run.id, guard.body.routeCardHash, guard.user.id);
    if (!card || card.candidate === null) {
      res.status(404).json({ error: 'nft_route_card_not_found', code: 'nft_route_card_not_found' });
      return;
    }
    const candidate = await repository.getNftCandidate(run.id, card.candidate.candidateHash, guard.user.id);
    if (!candidate) {
      res.status(404).json({ error: 'nft_candidate_not_found', code: 'nft_candidate_not_found' });
      return;
    }
    if (new Date(card.expiresAt).getTime() <= now.getTime()) {
      res.json(NftPrepareResponseV1Schema.parse({ outcome: 'rejected', reason: 'card_expired', detail: 'This Route Card has expired. Compare again for a current listing.' }));
      return;
    }

    // The listing, re-read RIGHT NOW through the same code that produced the
    // candidate. A price that moved in either direction ends the flow.
    const gateway = nftRouteRuntime.gateway();
    const fresh = await gateway.readOrder({
      protocolAddress: candidate.order.protocolAddress,
      orderHash: candidate.order.orderHash,
      now,
    });
    if (!fresh.ok) {
      res.json(NftPrepareResponseV1Schema.parse({ outcome: 'rejected', reason: fresh.reason, detail: nftComparisonCopyV1(fresh.reason) }));
      return;
    }
    const unchanged = verifyNftListingUnchangedV1({
      candidate,
      fresh: {
        orderHash: fresh.value.orderHash,
        protocolAddress: fresh.value.protocolAddress,
        listingStatus: fresh.value.listingStatus,
        listingPriceWei: fresh.value.totalWei,
        asset: candidate.asset,
        // The gateway refuses a listing whose consideration holds the NFT, so
        // a value that got this far names no private taker.
        restrictedTaker: null,
        listingExpiresAt: fresh.value.listingExpiresAt,
      },
      now,
    });
    if (!unchanged.ok) {
      res.json(NftPrepareResponseV1Schema.parse({ outcome: 'rejected', reason: unchanged.reason, detail: nftComparisonCopyV1(unchanged.reason) }));
      return;
    }

    const fulfillmentPayload = await gateway.readFulfillment({
      protocolAddress: candidate.order.protocolAddress,
      orderHash: candidate.order.orderHash,
      buyer: guard.user.address,
      now,
    });
    if (!fulfillmentPayload.ok) {
      res.json(NftPrepareResponseV1Schema.parse({ outcome: 'rejected', reason: fulfillmentPayload.reason, detail: nftComparisonCopyV1(fulfillmentPayload.reason) }));
      return;
    }
    const fulfillment = readOpenSeaFulfillmentV1({
      payload: fulfillmentPayload.value,
      candidate,
      buyer: guard.user.address as `0x${string}`,
      // Decided from the order Miorail just re-read, before the fulfilment is
      // requested. OpenSea is then held to this choice.
      expectedForm: expectedFulfillmentFormV1({ restrictedByZone: fresh.value.restrictedByZone }),
      now,
    });
    if (!fulfillment.ok) {
      res.json(NftPrepareResponseV1Schema.parse({ outcome: 'rejected', reason: fulfillment.reason, detail: 'OpenSea returned fulfilment data Miorail will not encode.' }));
      return;
    }

    const blueprint = buildNftPurchaseBlueprintV1({
      intent: run.intent,
      card,
      candidate,
      fulfillment: fulfillment.fulfillment,
      now,
    });
    const reserved = await repository.reserveNftPurchaseBlueprint({
      routeRunId: run.id,
      routeCardId: card.id,
      userId: guard.user.id,
      blueprint,
    });
    // A second prepare returns the FIRST blueprint. Two blueprints for one
    // card would be two wallet prompts for one NFT.
    const stored = reserved.record;

    const simulation = await nftRouteRuntime.simulate(stored.blueprint);
    if (simulation.status !== 'unavailable' && stored.blueprint.status === 'draft') {
      await repository.updateNftBlueprintStatus({ blueprintId: stored.id, userId: guard.user.id, status: 'simulated' });
    }

    const safety = nftPurchaseSafetyKernelV1({
      intent: run.intent,
      candidate,
      calls: stored.blueprint.calls,
      buyer: guard.user.address as `0x${string}`,
      fulfillmentResponseHash: fulfillment.fulfillment.responseHash,
      blueprintFulfillmentResponseHash: stored.blueprint.fulfillmentResponseHash,
      reviewedCreatorFeePolicy: candidate.creatorFeePolicy,
      now,
    });
    const signable = nftPurchaseSignableV1({
      safety,
      // Anything that is not a pass or a revert is an absence of information,
      // and absence never signs.
      simulationStatus:
        simulation.status === 'passed' || simulation.status === 'failed' ? simulation.status : 'unavailable',
      executionEnabled: nftRouteRuntime.flags(process.env).nftExecutionV1,
    });

    res.json(
      NftPrepareResponseV1Schema.parse({
        outcome: 'prepared',
        blueprintId: stored.id,
        blueprint: stored.blueprint,
        simulation,
        safety: { ok: safety.ok, violations: safety.violations },
        blockedReason: signable.reason,
        signable: signable.signable,
      }),
    );
  } catch (error) {
    failed(res, error, guard.user.address, 'nft_prepare_failed');
  }
});

// --- §4 approve -------------------------------------------------------------

nftRouteIntelligenceRouter.post('/nft/blueprints/:blueprintId/approve', async (req, res) => {
  const guard = nftGuard(req, res, NftApproveRequestV1Schema, 'invalid_nft_approve_request');
  if (!guard) return;
  if (!nftRouteRuntime.flags(process.env).nftExecutionV1) {
    res.status(404).json({ error: 'nft_execution_disabled', code: 'nft_execution_disabled' });
    return;
  }
  if (!(await storageReady(res))) return;
  const blocked = (reason: string, violation: string): void => {
    res.json(
      NftApproveResponseV1Schema.parse({
        outcome: 'blocked',
        reason,
        safety: { ok: false, violations: [violation] },
      }),
    );
  };
  try {
    const now = nftRouteRuntime.now();
    const repository = nftRouteRuntime.repository();
    const blueprintId = String(req.params.blueprintId);
    const existing = await repository.getNftPurchaseBlueprint(blueprintId, guard.user.id);
    if (!existing) {
      res.status(404).json({ error: 'nft_blueprint_not_found', code: 'nft_blueprint_not_found' });
      return;
    }
    if (existing.routeRunId !== guard.body.routeRunId) {
      res.status(404).json({ error: 'nft_route_run_not_found', code: 'nft_route_run_not_found' });
      return;
    }
    // The blueprint the client says it reviewed must be the blueprint on file.
    // blueprintHash is computed over callsHash, so this IS the check that the
    // calls about to open a wallet are the calls that were on the screen.
    if (existing.blueprint.blueprintHash !== guard.body.blueprintHash) {
      blocked('The blueprint you reviewed is not the one on file. Prepare it again.', 'blueprint_hash_mismatch');
      return;
    }
    if (existing.blueprint.buyer.toLowerCase() !== guard.user.address) {
      blocked('This purchase was prepared for a different wallet.', 'buyer_mismatch');
      return;
    }
    if (new Date(existing.blueprint.expiresAt).getTime() <= now.getTime()) {
      res.json(
        NftApproveResponseV1Schema.parse({
          outcome: 'expired',
          reason: 'This review has expired. Compare again for a current listing.',
        }),
      );
      return;
    }
    if (
      existing.blueprint.status === 'submitted' ||
      existing.blueprint.status === 'submitted_unknown' ||
      existing.blueprint.status === 'confirmed'
    ) {
      blocked('This purchase has already been sent to a wallet.', 'already_submitted');
      return;
    }

    // Re-run the kernel over the STORED calldata. It costs no network call and
    // it answers the only question that matters here: do the bytes about to be
    // signed still buy exactly this token, for exactly this price, from exactly
    // this Seaport?
    const run = await repository.getNftRouteRun(existing.routeRunId, guard.user.id);
    const candidate = run
      ? await repository.getNftCandidate(run.id, existing.blueprint.candidateHash, guard.user.id)
      : null;
    if (!run || !candidate) {
      res.status(404).json({ error: 'nft_candidate_not_found', code: 'nft_candidate_not_found' });
      return;
    }
    const safety = nftPurchaseSafetyKernelV1({
      intent: run.intent,
      candidate,
      calls: existing.blueprint.calls,
      buyer: guard.user.address as `0x${string}`,
      fulfillmentResponseHash: existing.blueprint.fulfillmentResponseHash,
      blueprintFulfillmentResponseHash: existing.blueprint.fulfillmentResponseHash,
      reviewedCreatorFeePolicy: candidate.creatorFeePolicy,
      now,
    });
    if (!safety.ok) {
      res.json(
        NftApproveResponseV1Schema.parse({
          outcome: 'blocked',
          reason: 'The Safety Kernel refused these calls.',
          safety: { ok: false, violations: safety.violations },
        }),
      );
      return;
    }

    // The server approves the calls hash IT holds. The client never names one.
    const approved = await repository.approveNftPurchaseBlueprint({
      blueprintId,
      userId: guard.user.id,
      approvedCallsHash: existing.blueprint.callsHash,
    });
    const call = approved.blueprint.calls[0];
    res.json(
      NftApproveResponseV1Schema.parse({
        outcome: 'approved',
        // The same payload shape swap and earn return. The server hands over
        // calls; it does not sign them and it does not broadcast them.
        payload: {
          goal: 'nft',
          blueprintId: approved.id,
          blueprintHash: approved.blueprint.blueprintHash,
          approvedCallsHash: approved.blueprint.approvedCallsHash ?? approved.blueprint.callsHash,
          chainId: '0x2105',
          from: approved.blueprint.buyer,
          calls: [{ to: call.to, value: `0x${BigInt(call.valueWei).toString(16)}`, data: call.data }],
          atomicRequired: true,
        },
        lifecycle: approved.blueprint.status,
      }),
    );
  } catch (error) {
    failed(res, error, guard.user.address, 'nft_approve_failed');
  }
});

// --- §4 submission ----------------------------------------------------------

nftRouteIntelligenceRouter.post('/nft/blueprints/:blueprintId/submission', async (req, res) => {
  const guard = nftGuard(req, res, NftSubmissionRequestV1Schema, 'invalid_nft_submission_request');
  if (!guard) return;
  if (!nftRouteRuntime.flags(process.env).nftExecutionV1) {
    res.status(404).json({ error: 'nft_execution_disabled', code: 'nft_execution_disabled' });
    return;
  }
  if (!(await storageReady(res))) return;
  try {
    const now = nftRouteRuntime.now();
    const repository = nftRouteRuntime.repository();
    const attempts = nftRouteRuntime.attemptRepository();
    const blueprintId = String(req.params.blueprintId);
    const existing = await repository.getNftPurchaseBlueprint(blueprintId, guard.user.id);
    if (!existing) {
      res.status(404).json({ error: 'nft_blueprint_not_found', code: 'nft_blueprint_not_found' });
      return;
    }
    if (existing.routeRunId !== guard.body.routeRunId) {
      res.status(404).json({ error: 'nft_route_run_not_found', code: 'nft_route_run_not_found' });
      return;
    }
    // A submission is recorded against the calls that were APPROVED. A record
    // naming a different hash is describing some other batch.
    if (existing.blueprint.approvedCallsHash !== guard.body.approvedCallsHash) {
      res.status(409).json({ error: 'nft_approved_calls_mismatch', code: 'nft_approved_calls_mismatch' });
      return;
    }
    // A recovery attempt id grants nothing on its own: it must be this tenant's
    // and must name this blueprint and these approved calls, or the whole
    // record is refused rather than allowed to ride along.
    const link = await verifySubmissionAttemptV1(attempts, {
      attemptId: guard.body.submissionAttemptId,
      tenantId: guard.user.id,
      blueprintId,
      approvedCallsHash: guard.body.approvedCallsHash,
    });
    if (!link.ok) {
      res.status(link.code === 'submission_attempt_mismatch' ? 409 : 404).json({ error: link.code, code: link.code });
      return;
    }

    // The wallet returns at most one hash here — the blueprint holds exactly
    // one call. `receipts` is deliberately ignored: a client-reported receipt
    // is a claim, and ownership is established only by the chain reads in
    // reconciliation.
    const transactionHash = guard.body.transactionHashes?.[0] ?? null;
    const record = await repository.recordNftSubmission({
      blueprintId,
      userId: guard.user.id,
      status: guard.body.status,
      submissionBatchId: guard.body.batchId ?? null,
      transactionHash,
      submittedAt: now.toISOString(),
    });

    if (guard.body.status === 'cancelled') {
      // Nothing was sent, so there is no ownership question and no proof to
      // open. Recording a `pending` proof here would put a purchase on the
      // screen that never happened.
      await recordAttemptOutcomeV1(attempts, {
        attempt: link.attempt,
        tenantId: guard.user.id,
        submissionStatus: guard.body.status,
        proofId: null,
        batchId: guard.body.batchId ?? null,
        errorCode: guard.body.error ? 'wallet_error' : null,
        now,
      });
      res.json(
        NftSubmissionResponseV1Schema.parse({
          outcome: 'recorded',
          lifecycle: record.blueprint.status,
          proofId: null,
          finalStatus: null,
        }),
      );
      return;
    }

    const openProof = await repository.getNftProofByBlueprint(record.id, guard.user.id);
    if (openProof && openProof.proof.status === 'finalized') {
      // Reconciliation already answered. A late submission record does not get
      // to reopen it.
      await recordAttemptOutcomeV1(attempts, {
        attempt: link.attempt,
        tenantId: guard.user.id,
        submissionStatus: guard.body.status,
        proofId: openProof.id,
        batchId: guard.body.batchId ?? null,
        errorCode: guard.body.error ? 'wallet_error' : null,
        now,
      });
      res.json(
        NftSubmissionResponseV1Schema.parse({
          outcome: 'recorded',
          lifecycle: record.blueprint.status,
          proofId: openProof.id,
          finalStatus: openProof.proof.finalStatus,
        }),
      );
      return;
    }

    // The proof opens HERE, at pending. Money has left a wallet and the
    // question "what did it buy?" now has a durable place to be answered.
    const proof = buildNftPurchaseProofV1({
      blueprint: record.blueprint,
      asset: record.blueprint.asset,
      seller: (await sellerFor(repository, record.routeRunId, guard.user.id, record.blueprint.candidateHash)) ?? record.blueprint.buyer,
      receipt: buildNftReceiptLegV1({
        receipt: null,
        actualNativeValueWei: null,
        submittedTransactionHash: record.submittedTransactionHash,
      }),
      transfer: findNftTransferV1({
        logs: [],
        contractAddress: record.blueprint.asset.contractAddress,
        tokenId: record.blueprint.asset.tokenId,
        buyer: record.blueprint.buyer,
      }),
      ownership: buildNftOwnershipReadV1({
        owner: null,
        buyer: record.blueprint.buyer,
        blockNumber: null,
        observedAt: null,
        unavailableReason: 'The transaction has not been confirmed yet.',
      }),
      now,
    });
    const stored = await repository.upsertNftProof({
      routeRunId: record.routeRunId,
      blueprintId: record.id,
      userId: guard.user.id,
      proof,
    });
    // A repeat of the same submission says nothing new. Appending another
    // event for it would grow the log without adding a fact.
    if (openProof?.proof.proofHash !== stored.proof.proofHash) {
      await appendEvent(repository, stored, guard.user.id, 'submission_recorded', record.submittedTransactionHash, now);
    }
    await recordAttemptOutcomeV1(attempts, {
      attempt: link.attempt,
      tenantId: guard.user.id,
      submissionStatus: guard.body.status,
      proofId: stored.id,
      batchId: guard.body.batchId ?? null,
      errorCode: guard.body.error ? 'wallet_error' : null,
      now,
    });
    res.json(
      NftSubmissionResponseV1Schema.parse({
        outcome: 'recorded',
        lifecycle: record.blueprint.status,
        proofId: stored.id,
        finalStatus: stored.proof.finalStatus,
      }),
    );
  } catch (error) {
    failed(res, error, guard.user.address, 'nft_submission_failed');
  }
});

// --- §5 reconcile -----------------------------------------------------------

nftRouteIntelligenceRouter.post('/nft/proofs/:proofId/reconcile', async (req, res) => {
  const flags = nftRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.nftRouteV1) {
    res.status(404).json({ error: 'nft_route_disabled', code: 'nft_route_disabled' });
    return;
  }
  const user = sessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  if (!(await storageReady(res))) return;
  try {
    const now = nftRouteRuntime.now();
    const repository = nftRouteRuntime.repository();
    const record = await repository.getNftProof(String(req.params.proofId), user.id);
    if (!record) {
      res.status(404).json({ error: 'nft_proof_not_found', code: 'nft_proof_not_found' });
      return;
    }
    const blueprint = await repository.getNftPurchaseBlueprint(record.blueprintId, user.id);
    if (!blueprint) {
      res.status(404).json({ error: 'nft_blueprint_not_found', code: 'nft_blueprint_not_found' });
      return;
    }
    const events = await repository.listNftProofEvents(record.id, user.id);

    const result = await reconcileNftProofV1(
      { chainReader: nftRouteRuntime.chainReader() },
      {
        blueprint: blueprint.blueprint,
        current: record.proof,
        seller: record.proof.seller,
        transactionHash: blueprint.submittedTransactionHash,
        existingEventCount: events.length,
        now,
      },
    );

    if (!result.changed) {
      // Nothing moved. Recording another identical answer would grow the log
      // without adding a fact.
      res.json(proofResponse(record));
      return;
    }
    // The proof is stored BEFORE its events: an event is validated against the
    // proof hash it describes, so the order is not a preference.
    const stored = await repository.upsertNftProof({
      routeRunId: record.routeRunId,
      blueprintId: record.blueprintId,
      userId: user.id,
      proof: result.proof,
    });
    for (const event of result.events) {
      await repository.appendNftProofEvent(stored.id, user.id, event);
    }
    res.json(proofResponse(stored));
  } catch (error) {
    failed(res, error, user.address, 'nft_reconcile_failed');
  }
});

// --- §5 proof reads ---------------------------------------------------------

nftRouteIntelligenceRouter.get('/nft/proofs/:proofId', async (req, res) => {
  const flags = nftRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.nftRouteV1) {
    res.status(404).json({ error: 'nft_route_disabled', code: 'nft_route_disabled' });
    return;
  }
  const user = sessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  if (!(await storageReady(res))) return;
  try {
    const repository = nftRouteRuntime.repository();
    const record = await repository.getNftProof(String(req.params.proofId), user.id);
    if (!record) {
      res.status(404).json({ error: 'nft_proof_not_found', code: 'nft_proof_not_found' });
      return;
    }
    res.json(proofResponse(record));
  } catch (error) {
    failed(res, error, user.address, 'nft_proof_read_failed');
  }
});

// --- helpers ----------------------------------------------------------------

async function sellerFor(
  repository: NftStorageRepository,
  runId: string,
  userId: string,
  candidateHash: string,
): Promise<`0x${string}` | null> {
  const candidate = await repository.getNftCandidate(runId, candidateHash, userId);
  return candidate?.order.seller ?? null;
}

async function appendEvent(
  repository: NftStorageRepository,
  record: NftProofRecordV1,
  userId: string,
  eventKind: Parameters<typeof buildNftProofEventV1>[0]['eventKind'],
  detail: string | null,
  now: Date,
): Promise<void> {
  const existing = await repository.listNftProofEvents(record.id, userId);
  const event = buildNftProofEventV1({
    proof: record.proof,
    sequence: existing.length,
    eventKind,
    detail,
    now,
  });
  await repository.appendNftProofEvent(record.id, userId, event);
}

function proofResponse(record: NftProofRecordV1) {
  return NftProofResponseV1Schema.parse({
    proofId: record.id,
    proof: record.proof,
    copy: NFT_PROOF_COPY_V1[record.proof.finalStatus],
    needsReconciliation: nftProofNeedsReconciliationV1(record.proof.finalStatus),
  });
}
