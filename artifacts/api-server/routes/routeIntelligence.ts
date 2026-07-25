import { AsyncLocalStorage } from 'node:async_hooks';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  CreateIntelligenceBudgetRequestV1Schema,
  EarnBlueprintApproveRequestV1Schema,
  EarnBlueprintApproveResponseV1Schema,
  EarnCompareRequestV1Schema,
  EarnCompareResponseV1Schema,
  EarnPrepareRequestV1Schema,
  EarnPrepareResponseV1Schema,
  IntelligenceBudgetProjectionV1Schema,
  IntelligenceBudgetResponseV1Schema,
  RevokeIntelligenceBudgetRequestV1Schema,
  RouteHistoryRequestV1Schema,
  RouteHistoryResponseV1Schema,
  RoutePlanRequestV1Schema,
  RoutePlanResponseV1Schema,
  RouteProofGetResponseV1Schema,
  RouteProofReconcileRequestV1Schema,
  RouteProofReconcileResponseV1Schema,
  SimulateBlueprintRequestV1Schema,
  SimulateBlueprintResponseV1Schema,
  SimulateWithBudgetRequestV1Schema,
  SimulateWithBudgetResponseV1Schema,
  SwapBlueprintApproveRequestV1Schema,
  SwapBlueprintApproveResponseV1Schema,
  SwapBlueprintSubmissionRequestV1Schema,
  SwapBlueprintSubmissionResponseV1Schema,
  SwapPrepareRequestV1Schema,
  SwapPrepareResponseV1Schema,
  UpdateIntelligenceBudgetRequestV1Schema,
} from '@mioagent/api-zod';
import { createLlmProvider } from '@mioagent/llm';
import { createSwapRouteEngine } from '@mioagent/route-engine';
import {
  RouteStorageConflictError,
  RouteStorageIntegrityError,
  createDatabaseRouteStorageRepository,
  type IntelligenceBudgetRecord,
  type RouteStorageRepository,
  type StoredBlueprintV1,
} from '@mioagent/route-storage';
import {
  RouteProofReconcileBindingError,
  createEarnRouteProofReconciler,
  createRouteProofReconciler,
  summarizeRouteProofEventsV1,
  toRouteProofProjectionV1,
  type ReconcileRouteProofInput,
} from '@mioagent/route-proof';
import { KyberSwapRouteAdapter, UniswapSwapRouteAdapter } from '@mioagent/swap-adapters';
import {
  BlueprintSubmissionConflictError,
  KyberSwapBuildAdapter,
  UniswapSwapBuildAdapter,
  approveEarnBlueprintV1,
  approveExecutionBlueprintV1,
  createTransactionComposer,
  deriveBlueprintLifecycleV1,
  prepareEarnDepositV1,
  recordBlueprintSubmissionV1,
  reviewStoredBlueprintV1,
  type ApproveEarnBlueprintInputV1,
  type ApproveExecutionBlueprintInput,
  type PrepareEarnDepositInputV1,
  type RecordBlueprintSubmissionInput,
  type TransactionComposerPrepareInput,
} from '@mioagent/transaction-composer';
import {
  PaidSimulationBindingError,
  buildPendingSimulationChargeV1,
  createHttpSimulationProvider,
  resolvePaidSimulationIdempotencyV1,
  runPaidSimulationV1,
  type PaidSimulationSettlementV1,
  type RunPaidSimulationResultV1,
} from '@mioagent/paid-intelligence';
import {
  createX402MiddlewareFromEnv,
  type X402SettlementRecord,
} from '@mioagent/x402-gateway';
import {
  BudgetSimulationBindingError,
  DEFAULT_INTELLIGENCE_BUDGET_RESERVATION_TTL_MS,
  hashIntelligenceBudgetV1,
  intelligenceBudgetV1FromRecord,
  runBudgetSimulationV1,
  IntelligenceBudgetV1Schema,
  type IntelligenceBudgetV1,
  type RunBudgetSimulationResultV1,
  type SpendPermissionCharger,
  type SpendPermissionSourceV1,
} from '@mioagent/intelligence-budget';
import { createDatabaseSpendPermissionRepository } from '@mioagent/autonomy';
import { resolveEarnIntentV1, type ResolveEarnIntentInputV1 } from '@mioagent/intent-engine';
import {
  compareEarnRoutesV1,
  resolveEarnRouteEnablementV1,
  type CompareEarnRoutesInputV1,
  type EarnComparisonResultV1,
  type PinnedEarnVerificationV1,
} from '@mioagent/earn-engine';
import { stableHashV1, ZERO_HASH_V1 } from '@mioagent/route-domain';
import type {
  EarnRouteCardV1,
  EarnRouteIntentV1,
  EvidenceRecordV1,
  ExecutionBlueprintV1,
  ProviderRefV1,
  SimulationStateV1,
} from '@mioagent/route-domain';
import { client } from '@mioagent/db';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import { RoutePlanCoordinator, type RoutePlanCoordinatorInput } from '../lib/routePlanCoordinator.js';
import { loadTokenSecurityContext } from '../lib/executionSecurity.js';
import { createViemBaseReceiptReader } from '../lib/baseReceiptReader.js';
import { resolveEarnContractPreflightV1 } from '../lib/earnPreflight.js';
import { resolveEarnDataSourceV1 } from '../lib/earnLiveData.js';
import {
  atomicUsdcToDecimalV1,
  decimalUsdcToAtomicV1,
  resolvePaidSimulationPricingV1,
  resolvePaidSimulationProviderV1,
  simulationPriceUsdcForPrepareResponseV1,
  usdcAssetRefV1,
} from '../lib/paidIntelligenceConfig.js';
import { createIntelligenceBudgetCharger } from '../lib/intelligenceBudgetCharger.js';

function signedRoutePlanUser(req: Request) {
  const user = req.session?.user;
  if (
    !user ||
    user.chainId !== 8453 ||
    !/^0x[0-9a-f]{40}$/.test(user.address) ||
    user.id !== `eip155:8453:${user.address}`
  ) return null;
  return user;
}

async function routeStorageMigrationAvailable(): Promise<boolean> {
  const rows = await client`
    SELECT
      to_regclass('public.route_runs') AS route_runs,
      to_regclass('public.route_candidates') AS route_candidates,
      to_regclass('public.route_evidence') AS route_evidence,
      to_regclass('public.route_evidence_sets') AS route_evidence_sets,
      to_regclass('public.route_score_snapshots') AS route_score_snapshots,
      to_regclass('public.route_cards') AS route_cards
  `;
  const row = rows[0];
  return Boolean(
    row &&
    row.route_runs &&
    row.route_candidates &&
    row.route_evidence &&
    row.route_evidence_sets &&
    row.route_score_snapshots &&
    row.route_cards
  );
}

// T57: the blueprint approve/submission routes additionally persist to
// execution_blueprints / route_proofs / route_proof_events, so their storage
// readiness check covers those tables on top of the base route-storage set.
// The evaluate/prepare routes keep the original narrower check unchanged.
async function blueprintMigrationAvailable(): Promise<boolean> {
  if (!(await routeStorageMigrationAvailable())) return false;
  const rows = await client`
    SELECT
      to_regclass('public.execution_blueprints') AS execution_blueprints,
      to_regclass('public.route_proofs') AS route_proofs,
      to_regclass('public.route_proof_events') AS route_proof_events
  `;
  const row = rows[0];
  return Boolean(row && row.execution_blueprints && row.route_proofs && row.route_proof_events);
}

// T62: the earn execution routes reuse the goal-agnostic Blueprint/Proof tables
// (blueprintMigrationAvailable) AND require the additive T62 earn tables
// (migration 0014). Kept separate from the swap check so the earn surface is
// only reported ready when its own storage is present.
async function earnStorageMigrationAvailable(): Promise<boolean> {
  if (!(await blueprintMigrationAvailable())) return false;
  const rows = await client`
    SELECT
      to_regclass('public.earn_route_candidates') AS earn_route_candidates,
      to_regclass('public.earn_route_evidence') AS earn_route_evidence,
      to_regclass('public.earn_score_snapshots') AS earn_score_snapshots,
      to_regclass('public.earn_route_cards') AS earn_route_cards
  `;
  const row = rows[0];
  return Boolean(
    row &&
    row.earn_route_candidates &&
    row.earn_route_evidence &&
    row.earn_score_snapshots &&
    row.earn_route_cards,
  );
}

// T62.1 §1 — the earn production gate. The earn surface is live ONLY when the
// feature flag is on (the 404 flag guard, checked earlier per route) AND the
// additive earn storage migration (0014) is present AND the pinned Base
// contracts pass the on-chain preflight. Any miss is a stable 503 with NO
// partial execution. The preflight is cached (see lib/earnPreflight.ts) so this
// consults an in-memory result, not the RPC, per request. Every field is a seam
// so tests inject a canned migration/preflight result and never touch the DB or
// a live RPC.
export const earnExecutionGateRuntime = {
  migrationAvailable: earnStorageMigrationAvailable,
  preflight: (): Promise<PinnedEarnVerificationV1> => resolveEarnContractPreflightV1(),
};

/** migration + preflight gate shared by EVERY earn route (the flag 404 guard
 * runs before this). Responds with a stable 503 and returns false on any miss;
 * returns true only when the whole gate is green. */
async function earnGateReady(res: Response): Promise<boolean> {
  if (!(await earnExecutionGateRuntime.migrationAvailable())) {
    res.status(503).json({ error: 'earn_storage_unavailable', code: 'earn_storage_unavailable' });
    return false;
  }
  const verification = await earnExecutionGateRuntime.preflight();
  // The flag is already enforced by the per-route 404 guard; here the gate only
  // evaluates the on-chain preflight (flagEnabled:true so a failed preflight is
  // the sole reason surfaced).
  const enablement = resolveEarnRouteEnablementV1({ flagEnabled: true, verification });
  if (!enablement.enabled) {
    res.status(503).json({ error: 'earn_gate_unavailable', code: 'earn_gate_unavailable' });
    return false;
  }
  return true;
}

export const routePlanRouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  migrationAvailable: routeStorageMigrationAvailable,
  coordinate: async (input: RoutePlanCoordinatorInput) => {
    const coordinator = new RoutePlanCoordinator({
      llm: createLlmProvider(),
      engine: createSwapRouteEngine(),
      adapters: [new UniswapSwapRouteAdapter(), new KyberSwapRouteAdapter()],
      repository: createDatabaseRouteStorageRepository(client),
    });
    return coordinator.evaluate(input);
  },
  now: () => new Date(),
};

export const routeIntelligenceRouter = Router();

routeIntelligenceRouter.post('/swap/evaluate', async (req, res) => {
  const flags = routePlanRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1) {
    res.status(404).json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const parsed = RoutePlanRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_route_plan_request', code: 'invalid_route_plan_request' });
    return;
  }
  if (parsed.data.walletAddress !== user.address) {
    res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
    return;
  }
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return;
  }
  try {
    if (!(await routePlanRouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'route_storage_unavailable', code: 'route_storage_unavailable' });
      return;
    }
    const response = await routePlanRouteRuntime.coordinate({
      tenantId: user.id,
      walletAddress: user.address,
      message: parsed.data.message,
      requestId: parsed.data.requestId,
      now: routePlanRouteRuntime.now(),
    });
    res.json(RoutePlanResponseV1Schema.parse(response));
  } catch {
    res.status(500).json({ error: 'route_plan_evaluation_failed', code: 'route_plan_evaluation_failed' });
  }
});

// T61/T62: earn comparison -> PERSISTED Earn Route Card. Same guard prefix as
// /swap/evaluate (flag, session, body, wallet, chain) but gated on BOTH
// routeIntelligenceV1 and earnRouteV1. T62 adds durable persistence: when the
// flags are on and the earn storage migration is present, the compared run is
// persisted (route run + Moonwell/Morpho candidates + evidence + scores + Earn
// Route Card) and the response carries the routeRunId the client later prepares
// against. Persistence is idempotent on the deterministic earn intent id
// (tenant + wallet + amount + optimizationMode + constraint): a repeat returns
// the SAME run and the ALREADY-persisted card (never a second card, never a
// silent swap-payload mutation). The 200 body stays a closed 3-outcome union —
// compared / needs_clarification / unsupported. The server never signs,
// broadcasts, or invents yield/risk data.
export interface EarnComparePersistInputV1 {
  intent: EarnRouteIntentV1;
  comparison: Extract<EarnComparisonResultV1, { ok: true }>;
  requestId: string;
}

/** Get-or-create the persisted earn comparison. Returns the routeRunId and the
 * authoritative (persisted) Earn Route Card. Idempotent on the deterministic
 * earn intent id — a retry reads the stored card back rather than writing a
 * second one. */
async function persistEarnComparisonV1(
  input: EarnComparePersistInputV1,
): Promise<{ routeRunId: string; routeCard: EarnRouteCardV1 }> {
  const repository = createDatabaseRouteStorageRepository(client);
  const existing = await repository.getEarnRouteRun(input.intent.id, input.intent.tenantId);
  if (existing) {
    const cards = await repository.listEarnRouteCards(existing.id, input.intent.tenantId);
    const persisted = cards[cards.length - 1];
    if (persisted) return { routeRunId: existing.id, routeCard: persisted };
    // A run with no card is anomalous; (re)persist the card idempotently below.
    await repository.insertEarnRouteCard(existing.id, input.comparison.routeCard);
    return { routeRunId: existing.id, routeCard: input.comparison.routeCard };
  }
  const run = await repository.createEarnRouteRun(input.intent, input.requestId);
  for (const entry of input.comparison.entries) {
    await repository.insertEarnCandidate(run.id, entry.candidate);
    await repository.insertEarnEvidence(run.id, entry.candidate.id, entry.evidence);
    await repository.insertEarnScore(run.id, entry.candidate.id, entry.score);
  }
  await repository.insertEarnRouteCard(run.id, input.comparison.routeCard);
  return { routeRunId: run.id, routeCard: input.comparison.routeCard };
}

export const earnCompareRouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  resolveIntent: (input: ResolveEarnIntentInputV1) => resolveEarnIntentV1(input),
  // T63A: the comparison runs on LIVE Moonwell + Morpho readings. The source is
  // a process-wide singleton so its short cache and single-flight coalescing are
  // shared across requests.
  compare: (input: CompareEarnRoutesInputV1) =>
    compareEarnRoutesV1({ dataSource: resolveEarnDataSourceV1() }, input),
  persist: (input: EarnComparePersistInputV1) => persistEarnComparisonV1(input),
  now: () => new Date(),
};

routeIntelligenceRouter.post('/earn/compare', async (req, res) => {
  const flags = earnCompareRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.earnRouteV1) {
    res.status(404).json({ error: 'earn_route_disabled', code: 'earn_route_disabled' });
    return;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const parsed = EarnCompareRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_earn_compare_request', code: 'invalid_earn_compare_request' });
    return;
  }
  if (parsed.data.walletAddress !== user.address) {
    res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
    return;
  }
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return;
  }
  try {
    const now = earnCompareRouteRuntime.now();
    const resolution = earnCompareRouteRuntime.resolveIntent({
      message: parsed.data.message,
      tenantId: user.id,
      walletAddress: user.address as `0x${string}`,
      now,
    });
    if (resolution.status === 'unsupported') {
      res.json(
        EarnCompareResponseV1Schema.parse({
          outcome: 'unsupported',
          reason: resolution.issues[0] ?? 'unsupported_earn_request',
        }),
      );
      return;
    }
    if (resolution.status === 'needs_clarification') {
      res.json(EarnCompareResponseV1Schema.parse({ outcome: 'needs_clarification', issues: resolution.issues }));
      return;
    }
    const comparison = await earnCompareRouteRuntime.compare({ intent: resolution.intent, now });
    if (!comparison.ok) {
      res.json(EarnCompareResponseV1Schema.parse({ outcome: 'unsupported', reason: comparison.reason }));
      return;
    }
    // Persist the comparison so the client can prepare/approve against a durable
    // run. Gate on the full earn production gate (migration 0014 + pinned
    // contract preflight): if the earn execution surface isn't ready, fail
    // closed with a stable 503 rather than return a card the client can never
    // prepare against.
    if (!(await earnGateReady(res))) return;
    const persisted = await earnCompareRouteRuntime.persist({
      intent: resolution.intent,
      comparison,
      requestId: parsed.data.requestId,
    });
    res.json(
      EarnCompareResponseV1Schema.parse({
        outcome: 'compared',
        routeRunId: persisted.routeRunId,
        routeCard: persisted.routeCard,
      }),
    );
  } catch {
    res.status(500).json({ error: 'earn_compare_failed', code: 'earn_compare_failed' });
  }
});

// ===========================================================================
// T62 — Persisted Earn Execution routes. Same guard sequence as the swap
// routes (flag, session, body, wallet, chain, storage) but gated ALSO on
// earnRouteV1 and using the earn storage migration. The server never signs,
// broadcasts, or calls send_calls; the client supplies NO calldata. Each 200
// body is a closed outcome union; non-2xx statuses are the standard
// flag/auth/wallet/chain/storage/failed codes and never leak internals.
// ===========================================================================

/** flag(routeIntelligenceV1 && earnRouteV1) + session + body + wallet + chain,
 * the shared head of every earn execution route. Responds and returns null on
 * failure; returns {user, data} on success. */
function earnRouteGuard<T>(
  req: Request,
  res: Response,
  schema: { safeParse: (body: unknown) => { success: true; data: T } | { success: false } },
  invalidCode: string,
): { user: NonNullable<ReturnType<typeof signedRoutePlanUser>>; data: T } | null {
  const flags = getMiorailProductMigrationFlags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.earnRouteV1) {
    res.status(404).json({ error: 'earn_route_disabled', code: 'earn_route_disabled' });
    return null;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return null;
  }
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: invalidCode, code: invalidCode });
    return null;
  }
  const data = parsed.data;
  if ((data as { walletAddress?: string }).walletAddress !== user.address) {
    res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
    return null;
  }
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return null;
  }
  return { user, data };
}

// POST /route-intelligence/earn/prepare — load the persisted Earn Route Card +
// selected candidate and build the exact deposit Blueprint. The client passes
// only run/card/candidate hashes; the server owns the calldata.
export const earnPrepareRouteRuntime = {
  prepare: async (input: PrepareEarnDepositInputV1) =>
    prepareEarnDepositV1({ repository: createDatabaseRouteStorageRepository(client) }, input),
  now: () => new Date(),
};

routeIntelligenceRouter.post('/earn/prepare', async (req, res) => {
  const guard = earnRouteGuard(req, res, EarnPrepareRequestV1Schema, 'invalid_earn_prepare_request');
  if (!guard) return;
  const { user, data } = guard;
  try {
    if (!(await earnGateReady(res))) return;
    const result = await earnPrepareRouteRuntime.prepare({
      tenantId: user.id,
      walletAddress: user.address as `0x${string}`,
      routeRunId: data.routeRunId,
      routeCardHash: data.routeCardHash,
      selectedCandidateHash: data.selectedCandidateHash,
      requestId: data.requestId,
      now: earnPrepareRouteRuntime.now(),
    });
    res.json(EarnPrepareResponseV1Schema.parse(result));
  } catch {
    res.status(500).json({ error: 'earn_prepare_failed', code: 'earn_prepare_failed' });
  }
});

// POST /route-intelligence/earn/blueprints/:blueprintId/approve — re-validate
// the STORED earn Blueprint through the EARN Safety Kernel and return the exact
// unsigned batch payload. POST .../submission records what the wallet reported
// (the recorder is goal-aware: it binds an earn run and mutates only the
// goal-agnostic proof tables). Both fail closed and never leak internals.
export const earnBlueprintRouteRuntime = {
  approve: async (input: ApproveEarnBlueprintInputV1) =>
    approveEarnBlueprintV1({ repository: createDatabaseRouteStorageRepository(client) }, input),
  recordSubmission: async (input: RecordBlueprintSubmissionInput) =>
    recordBlueprintSubmissionV1({ repository: createDatabaseRouteStorageRepository(client) }, input),
  now: () => new Date(),
};

routeIntelligenceRouter.post('/earn/blueprints/:blueprintId/approve', async (req, res) => {
  const guard = earnRouteGuard(req, res, EarnBlueprintApproveRequestV1Schema, 'invalid_blueprint_approve_request');
  if (!guard) return;
  const { user, data } = guard;
  try {
    if (!(await earnGateReady(res))) return;
    const result = await earnBlueprintRouteRuntime.approve({
      tenantId: user.id,
      walletAddress: user.address as `0x${string}`,
      routeRunId: data.routeRunId,
      blueprintId: req.params.blueprintId,
      blueprintHash: data.blueprintHash,
      now: earnBlueprintRouteRuntime.now(),
    });
    res.json(EarnBlueprintApproveResponseV1Schema.parse(result));
  } catch {
    res.status(500).json({ error: 'blueprint_approve_failed', code: 'blueprint_approve_failed' });
  }
});

routeIntelligenceRouter.post('/earn/blueprints/:blueprintId/submission', async (req, res) => {
  const guard = earnRouteGuard(req, res, SwapBlueprintSubmissionRequestV1Schema, 'invalid_blueprint_submission_request');
  if (!guard) return;
  const { user, data } = guard;
  try {
    if (!(await earnGateReady(res))) return;
    const result = await earnBlueprintRouteRuntime.recordSubmission({
      tenantId: user.id,
      walletAddress: user.address as `0x${string}`,
      routeRunId: data.routeRunId,
      blueprintId: req.params.blueprintId,
      approvedCallsHash: data.approvedCallsHash,
      status: data.status,
      batchId: data.batchId,
      transactionHashes: data.transactionHashes,
      receipts: data.receipts,
      error: data.error,
      now: earnBlueprintRouteRuntime.now(),
    });
    res.json(SwapBlueprintSubmissionResponseV1Schema.parse(result));
  } catch (cause) {
    if (cause instanceof BlueprintSubmissionConflictError) {
      res.status(409).json({ error: 'blueprint_submission_conflict', code: 'blueprint_submission_conflict' });
      return;
    }
    res.status(500).json({ error: 'blueprint_submission_failed', code: 'blueprint_submission_failed' });
  }
});

// POST /route-intelligence/earn/route-proofs/:proofId/reconcile — verify the
// deposit against Base and honestly finalize the earn Route Proof. Reuses the
// same env-configured receipt reader as the swap reconciler; the earn reconciler
// proves the position (USDC debit + position credit) — a success receipt with
// no observable position routes to reconciliation_required.
export const earnReconcileRouteRuntime = {
  reconcile: async (input: ReconcileRouteProofInput) =>
    createEarnRouteProofReconciler({
      repository: createDatabaseRouteStorageRepository(client),
      receiptReader: createViemBaseReceiptReader(),
    }).reconcile(input),
  now: () => new Date(),
};

routeIntelligenceRouter.post('/earn/route-proofs/:proofId/reconcile', async (req, res) => {
  const guard = earnRouteGuard(req, res, RouteProofReconcileRequestV1Schema, 'invalid_route_proof_reconcile_request');
  if (!guard) return;
  const { user, data } = guard;
  try {
    if (!(await earnGateReady(res))) return;
    const result = await earnReconcileRouteRuntime.reconcile({
      tenantId: user.id,
      walletAddress: user.address as `0x${string}`,
      routeRunId: data.routeRunId,
      routeProofId: req.params.proofId,
      now: earnReconcileRouteRuntime.now(),
    });
    res.json(RouteProofReconcileResponseV1Schema.parse(result));
  } catch (cause) {
    if (cause instanceof RouteProofReconcileBindingError) {
      if (cause.code === 'route_proof_not_found') {
        res.status(404).json({ error: 'route_proof_not_found', code: 'route_proof_not_found' });
        return;
      }
      if (cause.code === 'wallet_mismatch') {
        res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
        return;
      }
      res.status(409).json({ error: 'route_proof_conflict', code: 'route_proof_conflict' });
      return;
    }
    res.status(500).json({ error: 'route_proof_reconcile_failed', code: 'route_proof_reconcile_failed' });
  }
});

// T56: candidate selection -> Transaction Composer. Same guard sequence as
// /swap/evaluate (flag, session, body, wallet, chain, storage). The server
// never signs, broadcasts, or calls send_calls — the 200 response body is a
// closed 4-outcome union (prepared/refresh_required/unsupported/blocked);
// non-2xx statuses are the flag/auth/wallet/chain/storage/prepare-failed
// codes only, and prepare-failed never leaks the underlying error message.
export const swapPrepareRouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  migrationAvailable: routeStorageMigrationAvailable,
  prepare: async (input: TransactionComposerPrepareInput) => {
    const composer = createTransactionComposer({
      repository: createDatabaseRouteStorageRepository(client),
      buildAdapters: [new UniswapSwapBuildAdapter(), new KyberSwapBuildAdapter()],
      quoteAdapters: [new UniswapSwapRouteAdapter(), new KyberSwapRouteAdapter()],
      contractSecurity: async ({ chainId, addresses }) =>
        (await loadTokenSecurityContext(chainId, addresses)).tokenSecurity,
    });
    return composer.prepare(input);
  },
  now: () => new Date(),
};

routeIntelligenceRouter.post('/swap/prepare', async (req, res) => {
  const flags = swapPrepareRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1) {
    res.status(404).json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const parsed = SwapPrepareRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_swap_prepare_request', code: 'invalid_swap_prepare_request' });
    return;
  }
  if (parsed.data.walletAddress !== user.address) {
    res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
    return;
  }
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return;
  }
  try {
    if (!(await swapPrepareRouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'route_storage_unavailable', code: 'route_storage_unavailable' });
      return;
    }
    const result = await swapPrepareRouteRuntime.prepare({
      tenantId: user.id,
      walletAddress: user.address,
      routeRunId: parsed.data.routeRunId,
      routeCardHash: parsed.data.routeCardHash,
      selectedCandidateHash: parsed.data.selectedCandidateHash,
      requestId: parsed.data.requestId,
      now: swapPrepareRouteRuntime.now(),
    });
    // T59: the ONLY change to this route — surface the paid-simulation price
    // label (null when the feature is unavailable/disabled) alongside the
    // review, so the client can render "Pay & simulate ($0.01)" before the
    // user ever clicks (the x402 402-challenge is the source of truth for
    // the ACTUAL charge; this is a display-only convenience).
    const withSimulationPrice =
      result.outcome === 'prepared'
        ? { ...result, simulationPriceUsdc: simulationPriceUsdcForPrepareResponseV1(process.env) }
        : result;
    res.json(SwapPrepareResponseV1Schema.parse(withSimulationPrice));
  } catch {
    res.status(500).json({ error: 'swap_prepare_failed', code: 'swap_prepare_failed' });
  }
});

// T57: blueprint approval + Base Account submission record. Same guard order
// as prepare (flag, session, body, wallet, chain, storage). The approve route
// re-validates the STORED blueprint through the Safety Kernel and returns the
// exact unsigned EIP-5792 batch payload; the submission route idempotently
// records what the client's wallet reported. The server never signs,
// broadcasts, or resends — and 500s never leak the underlying error.
export const swapBlueprintRouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  migrationAvailable: blueprintMigrationAvailable,
  approve: async (input: ApproveExecutionBlueprintInput) =>
    approveExecutionBlueprintV1(
      {
        repository: createDatabaseRouteStorageRepository(client),
        contractSecurity: async ({ chainId, addresses }) =>
          (await loadTokenSecurityContext(chainId, addresses)).tokenSecurity,
      },
      input,
    ),
  recordSubmission: async (input: RecordBlueprintSubmissionInput) =>
    recordBlueprintSubmissionV1({ repository: createDatabaseRouteStorageRepository(client) }, input),
  now: () => new Date(),
};

routeIntelligenceRouter.post('/swap/blueprints/:blueprintId/approve', async (req, res) => {
  const flags = swapBlueprintRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1) {
    res.status(404).json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const parsed = SwapBlueprintApproveRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_blueprint_approve_request', code: 'invalid_blueprint_approve_request' });
    return;
  }
  if (parsed.data.walletAddress !== user.address) {
    res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
    return;
  }
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return;
  }
  try {
    if (!(await swapBlueprintRouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'route_storage_unavailable', code: 'route_storage_unavailable' });
      return;
    }
    const result = await swapBlueprintRouteRuntime.approve({
      tenantId: user.id,
      walletAddress: user.address,
      routeRunId: parsed.data.routeRunId,
      blueprintId: req.params.blueprintId,
      blueprintHash: parsed.data.blueprintHash,
      now: swapBlueprintRouteRuntime.now(),
    });
    res.json(SwapBlueprintApproveResponseV1Schema.parse(result));
  } catch {
    res.status(500).json({ error: 'blueprint_approve_failed', code: 'blueprint_approve_failed' });
  }
});

routeIntelligenceRouter.post('/swap/blueprints/:blueprintId/submission', async (req, res) => {
  const flags = swapBlueprintRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1) {
    res.status(404).json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const parsed = SwapBlueprintSubmissionRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_blueprint_submission_request',
      code: 'invalid_blueprint_submission_request',
    });
    return;
  }
  if (parsed.data.walletAddress !== user.address) {
    res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
    return;
  }
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return;
  }
  try {
    if (!(await swapBlueprintRouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'route_storage_unavailable', code: 'route_storage_unavailable' });
      return;
    }
    const result = await swapBlueprintRouteRuntime.recordSubmission({
      tenantId: user.id,
      walletAddress: user.address,
      routeRunId: parsed.data.routeRunId,
      blueprintId: req.params.blueprintId,
      approvedCallsHash: parsed.data.approvedCallsHash,
      status: parsed.data.status,
      batchId: parsed.data.batchId,
      transactionHashes: parsed.data.transactionHashes,
      receipts: parsed.data.receipts,
      error: parsed.data.error,
      now: swapBlueprintRouteRuntime.now(),
    });
    res.json(SwapBlueprintSubmissionResponseV1Schema.parse(result));
  } catch (cause) {
    if (cause instanceof BlueprintSubmissionConflictError) {
      res.status(409).json({ error: 'blueprint_submission_conflict', code: 'blueprint_submission_conflict' });
      return;
    }
    res.status(500).json({ error: 'blueprint_submission_failed', code: 'blueprint_submission_failed' });
  }
});

// T58: Route Proof reconciliation + read projections + tenant history. The
// reconcile route verifies receipts against Base through the env-configured
// viem public client (injected as a reader; NEVER built from request data),
// bounded to a single pass — no server-side polling or provider retries.
// GET routes are pure reads (no reconciliation side effects). The server
// never signs or broadcasts; a missing/foreign proof is a stable 404 with no
// existence leak; 500s never leak the underlying error.

export interface RouteProofGetInput {
  tenantId: string;
  walletAddress: string;
  proofId: string;
}

export interface RouteHistoryListInput {
  tenantId: string;
  limit: number;
  cursor?: string;
}

async function reconcileRouteProof(input: ReconcileRouteProofInput) {
  const repository = createDatabaseRouteStorageRepository(client);
  const reconciler = createRouteProofReconciler({
    repository,
    receiptReader: createViemBaseReceiptReader(),
  });
  return reconciler.reconcile(input);
}

async function getRouteProofProjection(input: RouteProofGetInput) {
  const repository = createDatabaseRouteStorageRepository(client);
  // The proof row itself carries its run/blueprint lineage columns; the
  // repository's RouteProofV1 payload does not, so resolve them here with a
  // single tenant-scoped query before the validated payload reads.
  const rows = await client`
    SELECT route_run_id, blueprint_id
    FROM route_proofs
    WHERE id = ${input.proofId} AND user_id = ${input.tenantId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const routeRunId = String(row.route_run_id);
  const blueprintId = String(row.blueprint_id);

  const proof = await repository.getProofProjection(input.proofId, input.tenantId);
  if (!proof) return null;
  if (proof.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) return null;

  const events = await repository.listProofEvents(input.proofId, input.tenantId);
  const blueprints = await repository.listBlueprints(routeRunId, input.tenantId);
  const stored = blueprints.find((entry) => entry.blueprint.id === blueprintId);
  if (!stored) return null;
  const candidates = await repository.listCandidates(routeRunId, input.tenantId);
  const provider =
    candidates.find((candidate) => candidate.candidateHash === proof.selectedCandidateHash)?.provider.id ?? null;

  return {
    proof: toRouteProofProjectionV1(proof, { blueprintId, provider }),
    lifecycle: deriveBlueprintLifecycleV1({ blueprint: stored.blueprint, proof, events }),
    events: summarizeRouteProofEventsV1(events),
  };
}

async function listRouteHistory(input: RouteHistoryListInput) {
  const repository = createDatabaseRouteStorageRepository(client);
  return repository.listRouteRunHistory(input.tenantId, { limit: input.limit, cursor: input.cursor ?? null });
}

export const routeProofRouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  migrationAvailable: blueprintMigrationAvailable,
  reconcile: reconcileRouteProof,
  getProof: getRouteProofProjection,
  listHistory: listRouteHistory,
  now: () => new Date(),
};

routeIntelligenceRouter.post('/route-proofs/:proofId/reconcile', async (req, res) => {
  const flags = routeProofRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1) {
    res.status(404).json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const parsed = RouteProofReconcileRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_route_proof_reconcile_request',
      code: 'invalid_route_proof_reconcile_request',
    });
    return;
  }
  if (parsed.data.walletAddress !== user.address) {
    res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
    return;
  }
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return;
  }
  try {
    if (!(await routeProofRouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'route_storage_unavailable', code: 'route_storage_unavailable' });
      return;
    }
    const result = await routeProofRouteRuntime.reconcile({
      tenantId: user.id,
      walletAddress: user.address as `0x${string}`,
      routeRunId: parsed.data.routeRunId,
      routeProofId: req.params.proofId,
      now: routeProofRouteRuntime.now(),
    });
    res.json(RouteProofReconcileResponseV1Schema.parse(result));
  } catch (cause) {
    if (cause instanceof RouteProofReconcileBindingError) {
      if (cause.code === 'route_proof_not_found') {
        res.status(404).json({ error: 'route_proof_not_found', code: 'route_proof_not_found' });
        return;
      }
      if (cause.code === 'wallet_mismatch') {
        res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
        return;
      }
      res.status(409).json({ error: 'route_proof_conflict', code: 'route_proof_conflict' });
      return;
    }
    res.status(500).json({ error: 'route_proof_reconcile_failed', code: 'route_proof_reconcile_failed' });
  }
});

routeIntelligenceRouter.get('/route-proofs/:proofId', async (req, res) => {
  const flags = routeProofRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1) {
    res.status(404).json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return;
  }
  try {
    if (!(await routeProofRouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'route_storage_unavailable', code: 'route_storage_unavailable' });
      return;
    }
    const result = await routeProofRouteRuntime.getProof({
      tenantId: user.id,
      walletAddress: user.address,
      proofId: req.params.proofId,
    });
    if (!result) {
      // Stable, existence-hiding 404 — a foreign proof id looks identical to
      // a missing one.
      res.status(404).json({ error: 'route_proof_not_found', code: 'route_proof_not_found' });
      return;
    }
    res.json(RouteProofGetResponseV1Schema.parse(result));
  } catch {
    res.status(500).json({ error: 'route_proof_reconcile_failed', code: 'route_proof_reconcile_failed' });
  }
});

routeIntelligenceRouter.get('/history', async (req, res) => {
  const flags = routeProofRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1) {
    res.status(404).json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const parsed = RouteHistoryRequestV1Schema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_history_request', code: 'invalid_history_request' });
    return;
  }
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return;
  }
  try {
    if (!(await routeProofRouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'route_storage_unavailable', code: 'route_storage_unavailable' });
      return;
    }
    const result = await routeProofRouteRuntime.listHistory({
      tenantId: user.id,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });
    res.json(RouteHistoryResponseV1Schema.parse(result));
  } catch (cause) {
    // An undecodable cursor is a client error, not a server fault.
    if (cause instanceof RouteStorageIntegrityError) {
      res.status(400).json({ error: 'invalid_history_request', code: 'invalid_history_request' });
      return;
    }
    res.status(500).json({ error: 'history_failed', code: 'history_failed' });
  }
});

// T59 — First Paid x402 Simulation Enrichment. The first tenant-facing paid
// product route: [guard chain] -> [idempotency short-circuit, BEFORE any
// x402 challenge] -> [x402 payment middleware] -> [paid handler]. The server
// never signs/broadcasts; the paid provider only ever receives
// {chainId:8453, from, calls, blockTag:'latest'} (no chat history, email,
// tenantId, or secrets — enforced in @mioagent/paid-intelligence). Safety
// Score is never invented: transaction_safety is always the literal
// 'not_scored' (scoreNote), matching "No data — no score".
//
// HTTP status convention (matches T56-T58's existing routes in this file):
// every member of SimulateBlueprintResponseV1Schema's outcome union
// (simulated/cached/paid_service_failed/invalid_response/blueprint_expired/
// blocked) is a 200 response — outcome, not status code, carries the
// business result. Every OTHER failure (guard/auth/binding/payment-plumbing
// codes below, none of which are outcome-union members) is a real 4xx/5xx
// with the standard {error, code} envelope, never leaking internals.

async function paidIntelligenceMigrationAvailable(): Promise<boolean> {
  if (!(await blueprintMigrationAvailable())) return false;
  const rows = await client`
    SELECT to_regclass('public.intelligence_charges') AS intelligence_charges
  `;
  const row = rows[0];
  return Boolean(row && row.intelligence_charges);
}

interface SimulateSettlementContext {
  settlement?: PaidSimulationSettlementV1;
}
// Exported ONLY so tests can inject a stub settlement from within their own
// `simulateRouteRuntime.paymentMiddleware` override (the standard
// middlewareFactory no-op bypass pattern, routes/x402/index.test.ts) without
// standing up a real x402 facilitator.
export const simulateSettlementStorage = new AsyncLocalStorage<SimulateSettlementContext>();

function settlementFromX402Record(record: X402SettlementRecord): PaidSimulationSettlementV1 {
  return {
    txHash: record.txHash,
    payer: record.payer,
    network: record.network,
    amount: record.amount,
    status: record.status,
  };
}

/** Built once at module load (mirrors routes/x402/index.ts's `smokeGateway`)
 * — env is read once at process start, not per request. Fails closed to a
 * 503 the instant the feature isn't configured, so a real x402 challenge is
 * NEVER issued (and no money is ever at risk) for a misconfigured price or
 * an unlisted/missing simulation provider. */
function buildSimulatePaymentMiddleware(env: NodeJS.ProcessEnv = process.env) {
  const pricing = resolvePaidSimulationPricingV1(env);
  const providerConfig = resolvePaidSimulationProviderV1(env);
  if (!pricing || !providerConfig.configured) {
    return (_req: Request, res: Response) => {
      res.status(503).json({ error: 'simulation_provider_unavailable', code: 'simulation_provider_unavailable' });
    };
  }
  return createX402MiddlewareFromEnv(
    {
      routePath: '/route-intelligence/blueprints/:blueprintId/simulate',
      serviceName: 'Miorail Transaction Simulation',
      amountAtomicOverride: pricing.amountAtomic,
      onSettlement: (record) => {
        const ctx = simulateSettlementStorage.getStore();
        if (ctx) ctx.settlement = settlementFromX402Record(record);
      },
    },
    env,
  );
}

export const simulateRouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  migrationAvailable: paidIntelligenceMigrationAvailable,
  now: () => new Date(),
  pricing: resolvePaidSimulationPricingV1,
  providerConfig: resolvePaidSimulationProviderV1,
  repository: (): RouteStorageRepository => createDatabaseRouteStorageRepository(client),
  contractSecurity: async ({ chainId, addresses }: { chainId: number; addresses: `0x${string}`[] }) =>
    (await loadTokenSecurityContext(chainId, addresses)).tokenSecurity,
  // Overridable so tests inject a stub SimulationProvider instead of hitting
  // a real network URL — mirrors decision 2's "facilitator и provider —
  // ТОЛЬКО стабы" test requirement.
  createProvider: (config: { url: string; providerId: string }) => createHttpSimulationProvider(config),
  // Overridable so tests can bypass the REAL Safety Kernel / contract-security
  // re-run (already unit-tested in @mioagent/transaction-composer) and
  // return a canned review — the exact same seam pattern every OTHER route
  // in this file uses by stubbing its whole *RouteRuntime.prepare/coordinate.
  buildReview: (
    repository: RouteStorageRepository,
    routeRunId: string,
    blueprint: ExecutionBlueprintV1,
    walletAddress: `0x${string}`,
    simulationStateOverride: RunPaidSimulationResultV1['simulation'],
  ) => buildSimulateReview(repository, routeRunId, blueprint, walletAddress, simulationStateOverride),
  // Reassigned in tests to the standard no-op `(_req,_res,next) => next()`
  // bypass (routes/x402/index.test.ts's `middlewareFactory` pattern) — a
  // plain function value, not a factory, so tests can swap it per-case the
  // same way every other *RouteRuntime object in this file is overridden.
  paymentMiddleware: buildSimulatePaymentMiddleware(),
};

interface SimulateLocals {
  user: NonNullable<ReturnType<typeof signedRoutePlanUser>>;
  body: { routeRunId: string; walletAddress: string; blueprintHash: string; idempotencyKey: string };
  blueprint: ExecutionBlueprintV1;
  pricing: NonNullable<ReturnType<typeof resolvePaidSimulationPricingV1>>;
  chargeProvider: ProviderRefV1;
  pendingCharge?: ReturnType<typeof buildPendingSimulationChargeV1>;
}

function simulationProviderRefV1(providerId: string): ProviderRefV1 {
  return {
    id: providerId,
    displayName: providerId,
    kind: 'simulation',
    operator: 'external',
  };
}

async function simulateGuardMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const flags = simulateRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.paidIntelligence) {
    res.status(404).json({ error: 'paid_intelligence_disabled', code: 'paid_intelligence_disabled' });
    return;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const parsed = SimulateBlueprintRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_simulation_request', code: 'invalid_simulation_request' });
    return;
  }
  if (parsed.data.walletAddress !== user.address) {
    res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
    return;
  }
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return;
  }
  try {
    if (!(await simulateRouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'paid_intelligence_unavailable', code: 'paid_intelligence_unavailable' });
      return;
    }
    const pricing = simulateRouteRuntime.pricing(process.env);
    const providerConfig = simulateRouteRuntime.providerConfig(process.env);
    if (!pricing || !providerConfig.configured) {
      res.status(503).json({ error: 'simulation_provider_unavailable', code: 'simulation_provider_unavailable' });
      return;
    }

    const repository = simulateRouteRuntime.repository();
    const blueprints = await repository.listBlueprints(parsed.data.routeRunId, user.id);
    const stored: StoredBlueprintV1 | undefined = blueprints.find(
      (entry) => entry.blueprint.id === req.params.blueprintId,
    );
    if (!stored) {
      res.status(404).json({ error: 'blueprint_not_found', code: 'blueprint_not_found' });
      return;
    }
    const blueprint = stored.blueprint;
    if (blueprint.status !== 'ready_for_review' && blueprint.status !== 'approved') {
      res.status(409).json({ error: 'blueprint_not_reviewable', code: 'blueprint_not_reviewable' });
      return;
    }
    if (blueprint.blueprintHash !== parsed.data.blueprintHash) {
      res.status(409).json({ error: 'blueprint_hash_mismatch', code: 'blueprint_hash_mismatch' });
      return;
    }
    if (Date.parse(blueprint.quoteExpiry) <= simulateRouteRuntime.now().getTime()) {
      res.json(
        SimulateBlueprintResponseV1Schema.parse({
          outcome: 'blueprint_expired',
          reason: 'Blueprint quote has expired and can never be simulated.',
        }),
      );
      return;
    }

    (res.locals as SimulateLocals).user = user;
    (res.locals as SimulateLocals).body = parsed.data;
    (res.locals as SimulateLocals).blueprint = blueprint;
    (res.locals as SimulateLocals).pricing = pricing;
    (res.locals as SimulateLocals).chargeProvider = simulationProviderRefV1(providerConfig.providerId);
    next();
  } catch {
    res.status(500).json({ error: 'simulation_failed', code: 'simulation_failed' });
  }
}

function evidenceSummaryFromResult(input: {
  evidence: { evidenceHash: string; blockNumber: string | null; cost: { amountDecimal: string } | null };
  evidenceSetHash: string;
  provider: ProviderRefV1;
  x402TxHash: string | null;
  gasUsed: string | null;
  stateChanges: Array<{ address: string; kind: 'balance' | 'storage' | 'token'; summary: string }>;
}) {
  return {
    evidenceHash: input.evidence.evidenceHash,
    evidenceSetHash: input.evidenceSetHash,
    blockNumber: input.evidence.blockNumber,
    gasUsed: input.gasUsed,
    stateChanges: input.stateChanges,
    provider: input.provider,
    paidCostUsdc: input.evidence.cost?.amountDecimal ?? '0',
    x402TxHash: input.x402TxHash,
  };
}

function chargeSummaryFromChargeV1(charge: {
  id: string;
  status: string;
  paymentState: string;
  serviceState: string;
}) {
  return {
    chargeId: charge.id,
    status: charge.status,
    paymentState: charge.paymentState,
    serviceState: charge.serviceState,
  } as const;
}

/** Re-derives the SAME honest review projection `swap/prepare` would show
 * for this (already stored, immutable) Blueprint — decision 9 — with
 * simulationState overridden to the JUST-observed (or cached) result. Runs
 * the Safety Kernel + a fresh contract-security lookup again (never cached
 * from prepare time); a fresh 'blocked' verdict here is surfaced as its own
 * response outcome even though payment already happened, per decision 12
 * ("честное" — the user must see the real state, never a fabricated one). */
async function buildSimulateReview(
  repository: RouteStorageRepository,
  routeRunId: string,
  blueprint: ExecutionBlueprintV1,
  walletAddress: `0x${string}`,
  simulationStateOverride: RunPaidSimulationResultV1['simulation'],
): Promise<
  | { outcome: 'ready'; review: import('@mioagent/route-card').TransactionReviewProjectionV1 }
  | { outcome: 'blocked'; safety: import('@mioagent/route-domain').SafetyKernelResultV1 }
> {
  const run = await repository.getRouteRun(routeRunId, blueprint.tenantId);
  if (!run) throw new Error('paid_simulation_review_run_not_found');
  const candidates = await repository.listCandidates(routeRunId, blueprint.tenantId);
  const selected = candidates.find((candidate) => candidate.candidateHash === blueprint.selectedCandidateHash);
  if (!selected) throw new Error('paid_simulation_review_candidate_not_found');

  const result = await reviewStoredBlueprintV1(
    { contractSecurity: simulateRouteRuntime.contractSecurity },
    { routeRunId, walletAddress },
    run.intent,
    selected,
    blueprint,
    simulateRouteRuntime.now(),
    simulationStateOverride,
  );
  if (result.outcome === 'blocked') {
    return { outcome: 'blocked', safety: result.safety };
  }
  if (result.outcome !== 'prepared') {
    // reviewStoredBlueprintV1 only ever returns 'prepared' or 'blocked' —
    // 'refresh_required'/'unsupported' belong to the fresh-quote path this
    // function never takes. Treated as an internal integrity failure.
    throw new Error(`paid_simulation_review_unexpected_outcome:${result.outcome}`);
  }
  return { outcome: 'ready', review: result.review };
}

routeIntelligenceRouter.post(
  '/blueprints/:blueprintId/simulate',
  (req, res, next) => simulateSettlementStorage.run({}, () => next()),
  simulateGuardMiddleware,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { user, body, blueprint } = res.locals as SimulateLocals;
    try {
      const repository = simulateRouteRuntime.repository();
      const existing = await repository.listIntelligenceCharges(body.routeRunId, user.id);
      const decision = resolvePaidSimulationIdempotencyV1({
        existingCharges: existing.map((entry) => entry.charge),
        candidateHash: blueprint.selectedCandidateHash,
        idempotencyKey: body.idempotencyKey,
      });

      if (decision.kind === 'conflict') {
        res.status(409).json({ error: 'charge_conflict', code: 'charge_conflict' });
        return;
      }

      if (decision.kind === 'cached') {
        await respondWithCachedSimulation(
          res,
          repository,
          body.routeRunId,
          blueprint,
          user.address as `0x${string}`,
          decision.charge,
        );
        return;
      }

      if (decision.kind === 'retry_service') {
        const retryProviderConfig = simulateRouteRuntime.providerConfig(process.env);
        const result = await runPaidSimulationV1(
          {
            repository,
            provider: simulateRouteRuntime.createProvider({
              url: retryProviderConfig.url!,
              providerId: retryProviderConfig.providerId,
            }),
            now: simulateRouteRuntime.now,
            price: (res.locals as SimulateLocals).pricing.price,
            chargeProvider: (res.locals as SimulateLocals).chargeProvider,
          },
          {
            tenantId: user.id,
            walletAddress: user.address as `0x${string}`,
            routeRunId: body.routeRunId,
            blueprintId: blueprint.id,
            settlement: null,
            existingCharge: decision.charge,
          },
        );
        await respondWithPaidSimulationResult(
          res,
          repository,
          body.routeRunId,
          blueprint,
          user.address as `0x${string}`,
          result,
          null,
        );
        return;
      }

      // decision.kind === 'pay' — create/reset the pending charge BEFORE the
      // x402 challenge (decision 5): a payment_failed outcome is always
      // attributable to a durable row.
      const now = simulateRouteRuntime.now();
      const pendingCharge = buildPendingSimulationChargeV1({
        routeRunId: body.routeRunId,
        blueprintId: blueprint.id,
        tenantId: user.id,
        walletAddress: user.address as `0x${string}`,
        intentHash: blueprint.intentHash,
        candidateHash: blueprint.selectedCandidateHash,
        idempotencyKey: body.idempotencyKey,
        price: (res.locals as SimulateLocals).pricing.price,
        provider: (res.locals as SimulateLocals).chargeProvider,
        now: now.toISOString(),
      });
      if (decision.existingFailedCharge) {
        await repository.updateIntelligenceCharge(body.routeRunId, pendingCharge.id, user.id, pendingCharge);
      } else {
        await repository.insertIntelligenceCharge(body.routeRunId, pendingCharge);
      }
      (res.locals as SimulateLocals).pendingCharge = pendingCharge;
      next();
    } catch {
      res.status(500).json({ error: 'simulation_failed', code: 'simulation_failed' });
    }
  },
  (req: Request, res: Response, next: NextFunction) => simulateRouteRuntime.paymentMiddleware(req, res, next),
  async (req: Request, res: Response): Promise<void> => {
    const { user, body, blueprint, pendingCharge } = res.locals as SimulateLocals;
    if (!pendingCharge) {
      res.status(500).json({ error: 'simulation_failed', code: 'simulation_failed' });
      return;
    }
    try {
      const repository = simulateRouteRuntime.repository();
      const settlement = simulateSettlementStorage.getStore()?.settlement ?? null;
      const providerConfig = simulateRouteRuntime.providerConfig(process.env);
      const result = await runPaidSimulationV1(
        {
          repository,
          provider: simulateRouteRuntime.createProvider({
            url: providerConfig.url!,
            providerId: providerConfig.providerId,
          }),
          now: simulateRouteRuntime.now,
          price: (res.locals as SimulateLocals).pricing.price,
          chargeProvider: (res.locals as SimulateLocals).chargeProvider,
        },
        {
          tenantId: user.id,
          walletAddress: user.address as `0x${string}`,
          routeRunId: body.routeRunId,
          blueprintId: blueprint.id,
          settlement,
          existingCharge: pendingCharge,
        },
      );
      await respondWithPaidSimulationResult(
        res,
        repository,
        body.routeRunId,
        blueprint,
        user.address as `0x${string}`,
        result,
        settlement?.txHash ?? null,
      );
    } catch (cause) {
      if (cause instanceof PaidSimulationBindingError) {
        if (cause.code === 'payment_missing') {
          res.status(402).json({ error: 'payment_missing', code: 'payment_missing' });
          return;
        }
        if (cause.code === 'payment_replayed') {
          res.status(409).json({ error: 'payment_replayed', code: 'payment_replayed' });
          return;
        }
      }
      res.status(500).json({ error: 'simulation_failed', code: 'simulation_failed' });
    }
  },
);

async function respondWithPaidSimulationResult(
  res: Response,
  repository: RouteStorageRepository,
  routeRunId: string,
  blueprint: ExecutionBlueprintV1,
  walletAddress: `0x${string}`,
  result: RunPaidSimulationResultV1,
  x402TxHash: string | null,
): Promise<void> {
  if (result.outcome === 'paid_service_failed' || result.outcome === 'invalid_response') {
    res.json(
      SimulateBlueprintResponseV1Schema.parse({
        outcome: result.outcome,
        charge: chargeSummaryFromChargeV1(result.charge),
        reason: result.reason,
      }),
    );
    return;
  }

  const reviewResult = await simulateRouteRuntime.buildReview(repository, routeRunId, blueprint, walletAddress, result.simulation);
  if (reviewResult.outcome === 'blocked') {
    res.json(
      SimulateBlueprintResponseV1Schema.parse({
        outcome: 'blocked',
        reason: reviewResult.safety.blockedReason ?? 'Safety Kernel blocked this transaction.',
        safety: reviewResult.safety,
      }),
    );
    return;
  }

  res.json(
    SimulateBlueprintResponseV1Schema.parse({
      outcome: result.outcome,
      simulation: result.simulation,
      evidence: evidenceSummaryFromResult({
        evidence: result.evidence,
        evidenceSetHash: result.evidenceSet.evidenceSetHash,
        provider: result.evidence.provider,
        x402TxHash,
        // Ephemeral provider-response details (gasUsed/stateChanges) are not
        // part of EvidenceRecordV1 — only the audit-critical
        // blockNumber/requestHash/responseHash/evidenceHash are durably
        // persisted. A fresh outcome always has them; see
        // respondWithCachedSimulation for the documented replay limitation.
        gasUsed: null,
        stateChanges: [],
      }),
      charge: chargeSummaryFromChargeV1(result.charge),
      review: reviewResult.review,
      scoreNote: { transactionSafety: 'not_scored', missingEvidence: result.evidenceSet.missingEvidence },
    }),
  );
}

/**
 * decision 3 step 2, first branch: serviceState already 'delivered' — replay
 * the ALREADY-persisted result with no provider call and no new payment.
 * KNOWN LIMITATION (documented, not a DB-migration workaround): gasUsed and
 * stateChanges are provider-response details that EvidenceRecordV1 has no
 * field for, and the raw x402 txHash is likewise not persisted (only its
 * hash, for replay-protection) — a cached replay honestly reports both as
 * null/[] rather than fabricating them. blockNumber/requestHash/responseHash/
 * evidenceHash (the audit-critical fields) round-trip exactly.
 */
async function respondWithCachedSimulation(
  res: Response,
  repository: RouteStorageRepository,
  routeRunId: string,
  blueprint: ExecutionBlueprintV1,
  walletAddress: `0x${string}`,
  charge: import('@mioagent/route-domain').IntelligenceChargeV1,
): Promise<void> {
  const evidenceRecords = await repository.listEvidence(routeRunId, charge.tenantId);
  const evidence = charge.evidenceHash
    ? evidenceRecords.find((record) => record.evidenceHash === charge.evidenceHash)
    : undefined;
  if (!evidence || !charge.evidenceSetHash) {
    // Rework B1 defense-in-depth: the idempotency layer should never route a
    // charge without durable evidence here anymore, but if it ever does the
    // user must see an honest paid-service state — never an opaque 500 loop
    // on a deterministic idempotency key.
    res.json(
      SimulateBlueprintResponseV1Schema.parse({
        outcome: 'paid_service_failed',
        charge: chargeSummaryFromChargeV1(charge),
        reason: 'evidence_missing',
      }),
    );
    return;
  }
  const reverted = evidence.validationErrors.includes('simulation_reverted');
  const simulation: RunPaidSimulationResultV1['simulation'] = reverted
    ? {
        status: 'failed',
        observedAt: evidence.observedAt,
        blockNumber: evidence.blockNumber,
        requestHash: evidence.requestHash,
        responseHash: evidence.responseHash,
        errorCode: 'reverted',
      }
    : {
        status: 'passed',
        observedAt: evidence.observedAt,
        blockNumber: evidence.blockNumber,
        requestHash: evidence.requestHash,
        responseHash: evidence.responseHash,
        errorCode: null,
      };

  const reviewResult = await simulateRouteRuntime.buildReview(repository, routeRunId, blueprint, walletAddress, simulation);
  if (reviewResult.outcome === 'blocked') {
    res.json(
      SimulateBlueprintResponseV1Schema.parse({
        outcome: 'blocked',
        reason: reviewResult.safety.blockedReason ?? 'Safety Kernel blocked this transaction.',
        safety: reviewResult.safety,
      }),
    );
    return;
  }

  const evidenceSets = await repository.listEvidenceSets(routeRunId, charge.tenantId);
  const evidenceSet = evidenceSets.find((set) => set.evidenceSetHash === charge.evidenceSetHash);
  if (!evidenceSet) {
    // Same B1 defense-in-depth as above: honest paid-service state, not 500.
    res.json(
      SimulateBlueprintResponseV1Schema.parse({
        outcome: 'paid_service_failed',
        charge: chargeSummaryFromChargeV1(charge),
        reason: 'evidence_missing',
      }),
    );
    return;
  }

  res.json(
    SimulateBlueprintResponseV1Schema.parse({
      outcome: 'cached',
      simulation,
      evidence: evidenceSummaryFromResult({
        evidence,
        evidenceSetHash: evidenceSet.evidenceSetHash,
        provider: evidence.provider,
        x402TxHash: null,
        gasUsed: null,
        stateChanges: [],
      }),
      charge: chargeSummaryFromChargeV1(charge),
      review: reviewResult.review,
      scoreNote: { transactionSafety: 'not_scored', missingEvidence: evidenceSet.missingEvidence },
    }),
  );
}

// ===========================================================================
// T60 — Intelligence Budget + Spend Permission payments (decisions 5/9/10)
//
// Five routes, the SAME guard chain and seam pattern as the T59 simulate
// route above, gated on the SAME `routeIntelligenceV1 && paidIntelligence`
// flags (NO new flag). The auto-flow route (`simulate-with-budget`) is a
// PLAIN authenticated POST — there is NO x402 challenge and NO
// paymentMiddleware in its chain: the whole point of T60 is that the user
// pays via their ALREADY-existing Spend Permission WITHOUT signing again.
// The server never signs/broadcasts; the on-chain charge is executed by the
// injected `SpendPermissionCharger` (lib/intelligenceBudgetCharger.ts), which
// only ever spends the user's Spend Permission into the fixed,
// server-configured recoup recipient — never a client- or blueprint-supplied
// address, and never a user asset movement.
//
// HTTP status convention (matches the rest of this file): every member of
// SimulateWithBudgetResponseV1Schema's outcome union
// (charged/reconciliation_required/provider_failed/limit_exceeded/blocked) is
// a 200 — outcome, not status code, carries the business result. Every guard/
// binding failure is a real 4xx/5xx with the standard {error, code} envelope.
// ===========================================================================

async function intelligenceBudgetMigrationAvailable(): Promise<boolean> {
  // Additive on top of the paid-intelligence set (decision 9): the budget
  // routes read/write both new T60 tables plus everything the paid flow needs.
  if (!(await paidIntelligenceMigrationAvailable())) return false;
  const rows = await client`
    SELECT
      to_regclass('public.intelligence_budgets') AS intelligence_budgets,
      to_regclass('public.intelligence_budget_reservations') AS intelligence_budget_reservations
  `;
  const row = rows[0];
  return Boolean(row && row.intelligence_budgets && row.intelligence_budget_reservations);
}

/** Reservation TTL from env (decision 4/5) — NEVER client-supplied. Default
 * 900s; an unset/invalid value falls back to the package default. */
export function resolveBudgetReservationTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MIORAIL_BUDGET_RESERVATION_TTL_SECONDS?.trim();
  if (!raw) return DEFAULT_INTELLIGENCE_BUDGET_RESERVATION_TTL_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_INTELLIGENCE_BUDGET_RESERVATION_TTL_MS;
  return Math.floor(seconds) * 1000;
}

// Seam object mirroring `simulateRouteRuntime` — every field is overridable so
// tests inject a stub SimulationProvider / SpendPermissionCharger /
// SpendPermissionSource / repository and a canned buildReview, WITHOUT any
// live network, CDP, or base.subscription call (decision 13).
export const budgetRouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  migrationAvailable: intelligenceBudgetMigrationAvailable,
  now: () => new Date(),
  pricing: resolvePaidSimulationPricingV1,
  providerConfig: resolvePaidSimulationProviderV1,
  repository: (): RouteStorageRepository => createDatabaseRouteStorageRepository(client),
  // The SAME database SpendPermissionRepository the Agent Fuel flow uses —
  // wired as the coordinator's SpendPermissionSourceV1 (getById for preflight,
  // incrementSpent after a real charge). createDatabaseSpendPermissionRepository
  // returns a structural superset of SpendPermissionSourceV1.
  spendPermissionRepository: (): SpendPermissionSourceV1 =>
    createDatabaseSpendPermissionRepository(client) as unknown as SpendPermissionSourceV1,
  charger: (): SpendPermissionCharger => createIntelligenceBudgetCharger(),
  createProvider: (config: { url: string; providerId: string }) => createHttpSimulationProvider(config),
  // Reuses the EXACT same honest review projection the T59 simulate route
  // builds (fresh Safety Kernel + contract-security re-run); tests override it.
  buildReview: (
    repository: RouteStorageRepository,
    routeRunId: string,
    blueprint: ExecutionBlueprintV1,
    walletAddress: `0x${string}`,
    simulationStateOverride: RunPaidSimulationResultV1['simulation'],
  ) => buildSimulateReview(repository, routeRunId, blueprint, walletAddress, simulationStateOverride),
  reservationTtlMs: resolveBudgetReservationTtlMs,
};

function budgetProjectionFromRecord(record: IntelligenceBudgetRecord) {
  const remainingAtomic =
    BigInt(record.periodLimitAtomic) - BigInt(record.periodSpentAtomic) - BigInt(record.reservedAtomic);
  const remaining = remainingAtomic > 0n ? remainingAtomic.toString() : '0';
  return IntelligenceBudgetProjectionV1Schema.parse({
    budgetId: record.id,
    status: record.status,
    periodType: 'monthly',
    monthlyLimitUsdc: atomicUsdcToDecimalV1(record.periodLimitAtomic),
    spentUsdc: atomicUsdcToDecimalV1(record.periodSpentAtomic),
    reservedUsdc: atomicUsdcToDecimalV1(record.reservedAtomic),
    remainingUsdc: atomicUsdcToDecimalV1(remaining),
    maxPerRequestUsdc: atomicUsdcToDecimalV1(record.maxPerCallAtomic),
    allowedCategories: record.allowedCategories,
    linkedSpendPermissionId: record.spendPermissionId,
    periodStartedAt: record.periodStartedAt,
    periodEndsAt: record.periodEndsAt,
    chainId: 8453,
    walletAddress: record.walletAddress,
  });
}

function budgetChargeSummaryV1(charge: { id: string; status: string }) {
  return { chargeId: charge.id, status: charge.status } as const;
}

function simulationStateFromBudgetEvidenceV1(evidence: EvidenceRecordV1): SimulationStateV1 {
  const reverted = evidence.validationErrors.includes('simulation_reverted');
  return reverted
    ? {
        status: 'failed',
        observedAt: evidence.observedAt,
        blockNumber: evidence.blockNumber,
        requestHash: evidence.requestHash,
        responseHash: evidence.responseHash,
        errorCode: 'reverted',
      }
    : {
        status: 'passed',
        observedAt: evidence.observedAt,
        blockNumber: evidence.blockNumber,
        requestHash: evidence.requestHash,
        responseHash: evidence.responseHash,
        errorCode: null,
      };
}

/** flag + session — the common head of all five routes. Responds and returns
 * null on failure; returns the signed user otherwise. */
function budgetFlagSessionGuard(req: Request, res: Response): ReturnType<typeof signedRoutePlanUser> {
  const flags = budgetRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.paidIntelligence) {
    res.status(404).json({ error: 'intelligence_budget_disabled', code: 'intelligence_budget_disabled' });
    return null;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return null;
  }
  return user;
}

function budgetChainEnvOk(res: Response): boolean {
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return false;
  }
  return true;
}

async function budgetMigrationOk(res: Response): Promise<boolean> {
  if (!(await budgetRouteRuntime.migrationAvailable())) {
    // The T60 tables are additive on the paid-intelligence set, so the same
    // 503 code is honest here (the paid-intelligence surface isn't ready).
    res.status(503).json({ error: 'paid_intelligence_unavailable', code: 'paid_intelligence_unavailable' });
    return false;
  }
  return true;
}

// GET /route-intelligence/intelligence-budget — the caller's active budget
// (projection) or null. No body; wallet comes from the session.
routeIntelligenceRouter.get('/intelligence-budget', async (req: Request, res: Response): Promise<void> => {
  const user = budgetFlagSessionGuard(req, res);
  if (!user) return;
  if (!budgetChainEnvOk(res)) return;
  try {
    if (!(await budgetMigrationOk(res))) return;
    const repository = budgetRouteRuntime.repository();
    const record = await repository.getActiveIntelligenceBudget(user.id, user.address, 8453);
    res.json(
      IntelligenceBudgetResponseV1Schema.parse({
        budget: record ? budgetProjectionFromRecord(record) : null,
      }),
    );
  } catch {
    res.status(500).json({ error: 'budget_simulation_failed', code: 'budget_simulation_failed' });
  }
});

// POST /route-intelligence/intelligence-budget — create. Requires an existing
// active Spend Permission owned by the caller; one active budget per
// wallet/permission.
routeIntelligenceRouter.post('/intelligence-budget', async (req: Request, res: Response): Promise<void> => {
  const user = budgetFlagSessionGuard(req, res);
  if (!user) return;
  const parsed = CreateIntelligenceBudgetRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
    return;
  }
  if (parsed.data.walletAddress !== user.address) {
    res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
    return;
  }
  if (!budgetChainEnvOk(res)) return;
  try {
    if (!(await budgetMigrationOk(res))) return;
    const repository = budgetRouteRuntime.repository();

    // The Spend Permission MUST already exist, be active, unexpired, and owned
    // by the caller (decision 9) — T60 never CREATES a permission.
    const permission = await budgetRouteRuntime.spendPermissionRepository().getById(parsed.data.spendPermissionId);
    const nowMs = budgetRouteRuntime.now().getTime();
    if (
      !permission ||
      permission.userId !== user.id ||
      !permission.isActive ||
      permission.expiresAt <= nowMs ||
      (permission.chainId !== undefined && permission.chainId !== 8453)
    ) {
      res.status(409).json({ error: 'spend_permission_required', code: 'spend_permission_required' });
      return;
    }

    // One active budget per wallet (the coordinator resolves the active budget
    // by wallet, so a second would be ambiguous). The partial unique index on
    // (spend_permission_id) WHERE status='active' is the authoritative
    // per-permission guard; this pre-check is the per-wallet half.
    const existingActive = await repository.getActiveIntelligenceBudget(user.id, user.address, 8453);
    if (existingActive) {
      res.status(409).json({ error: 'intelligence_budget_exists', code: 'intelligence_budget_exists' });
      return;
    }

    const periodLimitAtomic = decimalUsdcToAtomicV1(parsed.data.periodLimitUsdc);
    const maxPerCallAtomic = decimalUsdcToAtomicV1(parsed.data.maxPerCallUsdc);
    if (!periodLimitAtomic || !maxPerCallAtomic) {
      res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
      return;
    }

    const now = budgetRouteRuntime.now();
    const nowIso = now.toISOString();
    const periodEnds = new Date(now);
    periodEnds.setUTCMonth(periodEnds.getUTCMonth() + 1);
    const periodEndsAt = periodEnds.toISOString();
    const budgetId = `intelligence-budget:${stableHashV1('intelligence-budget-id/v1', {
      tenantId: user.id,
      spendPermissionId: parsed.data.spendPermissionId,
      createdAt: nowIso,
    }).slice(2)}`;

    const draft: IntelligenceBudgetV1 = {
      schemaVersion: 'intelligence-budget/v1',
      id: budgetId,
      tenantId: user.id,
      walletAddress: parsed.data.walletAddress,
      chainId: 8453,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: 'active',
      spendPermissionId: parsed.data.spendPermissionId,
      periodType: 'monthly',
      asset: usdcAssetRefV1(),
      periodLimitAtomic,
      periodSpentAtomic: '0',
      reservedAtomic: '0',
      maxPerCallAtomic,
      allowedCategories: parsed.data.allowedCategories,
      periodStartedAt: nowIso,
      periodEndsAt,
      revokedAt: null,
      budgetHash: ZERO_HASH_V1,
    };
    let validated: IntelligenceBudgetV1;
    try {
      validated = IntelligenceBudgetV1Schema.parse({ ...draft, budgetHash: hashIntelligenceBudgetV1(draft) });
    } catch {
      // e.g. maxPerCall > periodLimit — a client policy error, not a 500.
      res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
      return;
    }

    try {
      const record = await repository.insertIntelligenceBudget({
        id: validated.id,
        schemaVersion: validated.schemaVersion,
        userId: user.id,
        walletAddress: validated.walletAddress,
        chainId: 8453,
        spendPermissionId: validated.spendPermissionId,
        status: 'active',
        periodType: 'monthly',
        periodLimitAtomic: validated.periodLimitAtomic,
        maxPerCallAtomic: validated.maxPerCallAtomic,
        allowedCategories: validated.allowedCategories,
        periodStartedAt: validated.periodStartedAt,
        periodEndsAt: validated.periodEndsAt,
        budgetHash: validated.budgetHash,
        now: nowIso,
      });
      res.status(201).json(IntelligenceBudgetResponseV1Schema.parse({ budget: budgetProjectionFromRecord(record) }));
    } catch (cause) {
      if (cause instanceof RouteStorageConflictError) {
        res.status(409).json({ error: 'intelligence_budget_exists', code: 'intelligence_budget_exists' });
        return;
      }
      throw cause;
    }
  } catch {
    res.status(500).json({ error: 'budget_simulation_failed', code: 'budget_simulation_failed' });
  }
});

// PATCH /route-intelligence/intelligence-budget — update limits/categories on
// the caller's active budget (NEVER the Spend Permission binding).
routeIntelligenceRouter.patch('/intelligence-budget', async (req: Request, res: Response): Promise<void> => {
  const user = budgetFlagSessionGuard(req, res);
  if (!user) return;
  const parsed = UpdateIntelligenceBudgetRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
    return;
  }
  if (!budgetChainEnvOk(res)) return;
  try {
    if (!(await budgetMigrationOk(res))) return;
    const repository = budgetRouteRuntime.repository();
    const record = await repository.getActiveIntelligenceBudget(user.id, user.address, 8453);
    if (!record) {
      res.status(404).json({ error: 'intelligence_budget_not_found', code: 'intelligence_budget_not_found' });
      return;
    }

    const nextPeriodLimitAtomic =
      parsed.data.periodLimitUsdc !== undefined ? decimalUsdcToAtomicV1(parsed.data.periodLimitUsdc) : record.periodLimitAtomic;
    const nextMaxPerCallAtomic =
      parsed.data.maxPerCallUsdc !== undefined ? decimalUsdcToAtomicV1(parsed.data.maxPerCallUsdc) : record.maxPerCallAtomic;
    const nextAllowedCategories = parsed.data.allowedCategories ?? record.allowedCategories;
    if (!nextPeriodLimitAtomic || !nextMaxPerCallAtomic) {
      res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
      return;
    }

    const current = intelligenceBudgetV1FromRecord(record, usdcAssetRefV1());
    const nowIso = budgetRouteRuntime.now().toISOString();
    const draft: IntelligenceBudgetV1 = {
      ...current,
      periodLimitAtomic: nextPeriodLimitAtomic,
      maxPerCallAtomic: nextMaxPerCallAtomic,
      allowedCategories: nextAllowedCategories as IntelligenceBudgetV1['allowedCategories'],
      updatedAt: nowIso,
      budgetHash: ZERO_HASH_V1,
    };
    let validated: IntelligenceBudgetV1;
    try {
      validated = IntelligenceBudgetV1Schema.parse({ ...draft, budgetHash: hashIntelligenceBudgetV1(draft) });
    } catch {
      res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
      return;
    }

    const updated = await repository.updateIntelligenceBudget(record.id, user.id, {
      periodLimitAtomic: validated.periodLimitAtomic,
      maxPerCallAtomic: validated.maxPerCallAtomic,
      allowedCategories: validated.allowedCategories,
      budgetHash: validated.budgetHash,
      now: nowIso,
    });
    res.json(IntelligenceBudgetResponseV1Schema.parse({ budget: budgetProjectionFromRecord(updated) }));
  } catch {
    res.status(500).json({ error: 'budget_simulation_failed', code: 'budget_simulation_failed' });
  }
});

// POST /route-intelligence/intelligence-budget/revoke — status='revoked'.
routeIntelligenceRouter.post('/intelligence-budget/revoke', async (req: Request, res: Response): Promise<void> => {
  const user = budgetFlagSessionGuard(req, res);
  if (!user) return;
  const parsed = RevokeIntelligenceBudgetRequestV1Schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
    return;
  }
  if (!budgetChainEnvOk(res)) return;
  try {
    if (!(await budgetMigrationOk(res))) return;
    const repository = budgetRouteRuntime.repository();
    const record = await repository.getActiveIntelligenceBudget(user.id, user.address, 8453);
    if (!record) {
      res.status(404).json({ error: 'intelligence_budget_not_found', code: 'intelligence_budget_not_found' });
      return;
    }
    const nowIso = budgetRouteRuntime.now().toISOString();
    const current = intelligenceBudgetV1FromRecord(record, usdcAssetRefV1());
    const draft: IntelligenceBudgetV1 = {
      ...current,
      status: 'revoked',
      revokedAt: nowIso,
      updatedAt: nowIso,
      budgetHash: ZERO_HASH_V1,
    };
    const budgetHash = hashIntelligenceBudgetV1(draft);
    const revoked = await repository.updateIntelligenceBudget(record.id, user.id, {
      status: 'revoked',
      revokedAt: nowIso,
      budgetHash,
      now: nowIso,
    });
    res.json(IntelligenceBudgetResponseV1Schema.parse({ budget: budgetProjectionFromRecord(revoked) }));
  } catch {
    res.status(500).json({ error: 'budget_simulation_failed', code: 'budget_simulation_failed' });
  }
});

// POST /route-intelligence/blueprints/:blueprintId/simulate-with-budget — the
// auto-flow (decision 5). A PLAIN authenticated POST: no x402 challenge, no
// payment middleware, no wallet signature. The client supplies only
// {routeRunId, walletAddress, blueprintHash, requestId}; provider URL,
// calldata, price, spender, and recipient all come from server config + the
// persisted Blueprint.
routeIntelligenceRouter.post(
  '/blueprints/:blueprintId/simulate-with-budget',
  async (req: Request, res: Response): Promise<void> => {
    const user = budgetFlagSessionGuard(req, res);
    if (!user) return;
    const parsed = SimulateWithBudgetRequestV1Schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
      return;
    }
    if (parsed.data.walletAddress !== user.address) {
      res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
      return;
    }
    if (!budgetChainEnvOk(res)) return;
    try {
      if (!(await budgetMigrationOk(res))) return;
      const pricing = budgetRouteRuntime.pricing(process.env);
      const providerConfig = budgetRouteRuntime.providerConfig(process.env);
      if (!pricing || !providerConfig.configured) {
        res.status(503).json({ error: 'simulation_provider_unavailable', code: 'simulation_provider_unavailable' });
        return;
      }

      const repository = budgetRouteRuntime.repository();
      const walletAddress = user.address as `0x${string}`;
      const blueprintId = String(req.params.blueprintId);
      let result: RunBudgetSimulationResultV1;
      try {
        result = await runBudgetSimulationV1(
          {
            repository,
            provider: budgetRouteRuntime.createProvider({ url: providerConfig.url!, providerId: providerConfig.providerId }),
            charger: budgetRouteRuntime.charger(),
            spendPermissionRepository: budgetRouteRuntime.spendPermissionRepository(),
            now: budgetRouteRuntime.now,
            price: pricing.price,
            providerId: providerConfig.providerId,
            reservationTtlMs: budgetRouteRuntime.reservationTtlMs(process.env),
          },
          {
            tenantId: user.id,
            walletAddress,
            routeRunId: parsed.data.routeRunId,
            blueprintId,
            blueprintHash: parsed.data.blueprintHash,
            category: 'simulation',
            requestId: parsed.data.requestId,
          },
        );
      } catch (cause) {
        if (cause instanceof BudgetSimulationBindingError) {
          if (cause.code === 'blueprint_not_found') {
            res.status(404).json({ error: 'blueprint_not_found', code: 'blueprint_not_found' });
            return;
          }
          if (cause.code === 'blueprint_not_reviewable') {
            res.status(409).json({ error: 'blueprint_not_reviewable', code: 'blueprint_not_reviewable' });
            return;
          }
          if (cause.code === 'blueprint_hash_mismatch') {
            res.status(409).json({ error: 'blueprint_hash_mismatch', code: 'blueprint_hash_mismatch' });
            return;
          }
          // blueprint_expired / changed_calls: nothing was reserved or
          // charged, so it is an honest pre-charge 'blocked' outcome (the
          // budget response union has no dedicated blueprint-expired member).
          res.json(SimulateWithBudgetResponseV1Schema.parse({ outcome: 'blocked', reason: cause.code }));
          return;
        }
        throw cause;
      }

      if (result.outcome === 'limit_exceeded' || result.outcome === 'blocked') {
        res.json(SimulateWithBudgetResponseV1Schema.parse({ outcome: result.outcome, reason: result.reason }));
        return;
      }
      if (result.outcome === 'provider_failed') {
        res.json(
          SimulateWithBudgetResponseV1Schema.parse({
            outcome: 'provider_failed',
            charge: budgetChargeSummaryV1(result.charge),
            reason: result.reason,
          }),
        );
        return;
      }
      if (result.outcome === 'reconciliation_required') {
        res.json(
          SimulateWithBudgetResponseV1Schema.parse({
            outcome: 'reconciliation_required',
            charge: budgetChargeSummaryV1(result.charge),
            budget: budgetProjectionFromRecord(result.budget),
            reason: result.reason,
          }),
        );
        return;
      }

      // result.outcome === 'charged' — build the SAME honest review the T59
      // simulate route builds (fresh Safety Kernel re-run), then the response.
      const blueprints = await repository.listBlueprints(parsed.data.routeRunId, user.id);
      const storedBlueprint = blueprints.find((entry) => entry.blueprint.id === blueprintId);
      if (!storedBlueprint) {
        res.status(500).json({ error: 'budget_simulation_failed', code: 'budget_simulation_failed' });
        return;
      }
      const simulation = simulationStateFromBudgetEvidenceV1(result.evidence);
      const reviewResult = await budgetRouteRuntime.buildReview(
        repository,
        parsed.data.routeRunId,
        storedBlueprint.blueprint,
        walletAddress,
        simulation,
      );
      if (reviewResult.outcome === 'blocked') {
        // A fresh safety re-run blocked an already-delivered+charged result:
        // surface the real state honestly (the charge stays durably 'settled'
        // in the DB). The budget 'blocked' member carries only a reason.
        res.json(
          SimulateWithBudgetResponseV1Schema.parse({
            outcome: 'blocked',
            reason: reviewResult.safety.blockedReason ?? 'Safety Kernel blocked this transaction.',
          }),
        );
        return;
      }

      res.json(
        SimulateWithBudgetResponseV1Schema.parse({
          outcome: 'charged',
          simulation,
          review: reviewResult.review,
          evidence: evidenceSummaryFromResult({
            evidence: result.evidence,
            evidenceSetHash: result.evidenceSet.evidenceSetHash,
            provider: result.evidence.provider,
            // The Spend-Permission settlement's raw on-chain txHash is not
            // surfaced in the coordinator result (only a hash of the proof is
            // stored) — honestly null here, like T59's cached-replay case.
            x402TxHash: null,
            gasUsed: null,
            stateChanges: [],
          }),
          charge: budgetChargeSummaryV1(result.charge),
          scoreNote: { transactionSafety: 'not_scored', missingEvidence: result.evidenceSet.missingEvidence },
          budget: budgetProjectionFromRecord(result.budget),
        }),
      );
    } catch {
      res.status(500).json({ error: 'budget_simulation_failed', code: 'budget_simulation_failed' });
    }
  },
);
