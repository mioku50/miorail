import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '@mioagent/utils';
import { firstOwnFrameV1, safeErrorMessageV1, safeFailureMetaV1 } from '../lib/safeZodIssues.js';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  ConfirmSpendPermissionRequestV1Schema,
  ConfirmSpendPermissionResponseV1Schema,
  PauseIntelligenceBudgetRequestV1Schema,
  PrepareSpendPermissionRequestV1Schema,
  PrepareSpendPermissionResponseV1Schema,
  CommerceCompareRequestV1Schema,
  CommerceCompareResponseV1Schema,
  CommerceOrderCreateRequestV1Schema,
  CommerceOrderCreateResponseV1Schema,
  CommerceDeliveryResponseV1Schema,
  CommerceHistoryResponseV1Schema,
  CommerceOrderStatusResponseV1Schema,
  CommercePaymentApproveRequestV1Schema,
  CommercePaymentApproveResponseV1Schema,
  CommercePaymentPrepareRequestV1Schema,
  CommercePaymentPrepareResponseV1Schema,
  CommercePaymentSubmissionRequestV1Schema,
  CommercePaymentSubmissionResponseV1Schema,
  CreateIntelligenceBudgetRequestV1Schema,
  EarnBlueprintApproveRequestV1Schema,
  EarnBlueprintApproveResponseV1Schema,
  EarnCompareRequestV1Schema,
  EarnCompareResponseV1Schema,
  EarnPrepareRequestV1Schema,
  EarnPrepareResponseV1Schema,
  IntelligenceBudgetProjectionV1Schema,
  IntelligenceBudgetResponseV1Schema,
  IntelligenceChargesResponseV1Schema,
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
import { createStructuredLlmProvider } from '@mioagent/llm';
import { createSwapRouteEngine } from '@mioagent/route-engine';
import { createChainTokenIdentityReaderV1 } from '@mioagent/intent-core';
import {
  RouteStorageConflictError,
  RouteStorageIntegrityError,
  createDatabaseRouteStorageRepository,
  createDatabaseSubmissionAttemptRepository,
  createDatabaseSwapPendingIntentRepository,
  type IntelligenceBudgetRecord,
  type RouteStorageRepository,
  createDatabaseProviderOutcomeRepository,
  type StoredBlueprintV1,
} from '@mioagent/route-storage';
import { createRouteOutcomeProjectorForServerV1 } from '../lib/routeOutcomeProjector.js';
import { createReliabilityLookupV1 } from '../lib/reliabilityLookup.js';
import {
  RouteProofReconcileBindingError,
  createEarnRouteProofReconciler,
  createRouteProofReconciler,
  summarizeRouteProofEventsV1,
  toRouteProofProjectionV1,
  type ReconcileRouteProofInput,
} from '@mioagent/route-proof';
import {
  AerodromeSwapRouteAdapter,
  KyberSwapRouteAdapter,
  O1SwapRouteAdapter,
  HydrexSwapRouteAdapter,
  BalancerSwapRouteAdapter,
  UniswapSwapRouteAdapter,
  createO1RouterPinReaderV1,
  createHydrexRouterPinReaderV1,
} from '@mioagent/swap-adapters';
import {
  BlueprintSubmissionConflictError,
  KyberSwapBuildAdapter,
  UniswapSwapBuildAdapter,
  AerodromeSwapBuildAdapter,
  O1SwapBuildAdapter,
  HydrexSwapBuildAdapter,
  BalancerSwapBuildAdapter,
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
  createSimulationProviderFromConfigV1,
  type SimulationProviderConfigV1,
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
import {
  createDatabaseSpendPermissionRepository,
  type SpendPermissionRepository,
} from '@mioagent/autonomy';
import {
  createSpendPermissionVerifierV1,
  type SpendPermissionVerifierV1,
} from '../lib/spendPermissionVerifier.js';
import {
  confirmSpendPermissionV1,
  prepareSpendPermissionV1,
} from '../lib/spendPermissionOnboarding.js';
import {
  resolveCommerceIntentV1,
  resolveEarnIntentV1,
  type ResolveCommerceIntentInputV1,
  type ResolveEarnIntentInputV1,
} from '@mioagent/intent-engine';
import {
  COMMERCE_DELIVERY_HEADERS_V1,
  applyCommerceOrderStatusV1,
  buildCommerceOrderV1,
  buildCommercePaymentBlueprintV1,
  commercePaymentSafetyKernelV1,
  commercePaymentSignableV1,
  readCommerceDeliveryV1,
  revalidateCommerceInvoiceV1,
  type CommerceReceiptReaderV1,
  buildCommerceRouteProofV1,
  commerceAmountReviewV1,
  compareCommerceRoutesV1,
  validateCommerceInvoiceV1,
  type CommerceOrderGatewayV1,
  type CompareCommerceRoutesInputV1,
} from '@mioagent/commerce-engine';
import {
  commerceIdempotencyKeyV1,
  createDatabaseCommerceStorageRepository,
  type CommerceOrderRecordV1,
  type CommerceStorageRepository,
} from '@mioagent/route-storage';
import {
  resolveCommerceCatalogSourceV1,
  resolveCommerceOrderGatewayV1,
  resolveCommerceReceiptReaderV1,
} from '../lib/commerceRouteConfig.js';
import {
  compareEarnRoutesV1,
  resolveEarnRouteEnablementV1,
  type CompareEarnRoutesInputV1,
  type EarnComparisonResultV1,
  type PinnedEarnVerificationV1,
} from '@mioagent/earn-engine';
import { stableHashV1, ZERO_HASH_V1 } from '@mioagent/route-domain';
import type {
  CommerceOrderV1,
  CommerceProviderStatusV1,
  CommerceRouteProofV1,
  EarnRouteCardV1,
  EarnRouteIntentV1,
  EvidenceRecordV1,
  ExecutionBlueprintV1,
  ProviderRefV1,
  SimulationStateV1,
} from '@mioagent/route-domain';
import { client } from '@mioagent/db';
import { nftRouteIntelligenceRouter } from './nftRouteIntelligence.js';
import { aiRouteIntelligenceRouter } from './aiRouteIntelligence.js';
import { b20ControlRouter } from './b20Control.js';
import { rwaDiscoverRouter } from './rwaDiscover.js';
import { rwaInvestigateRouter } from './rwaInvestigate.js';
import { rwaDossierRouter } from './rwaDossier.js';
import { submissionRecoveryRouter } from './submissionRecovery.js';
import { publicProofOwnerRouter } from './publicProof.js';
import {
  recordAttemptOutcomeV1,
  verifySubmissionAttemptV1,
} from '../lib/submissionAttemptLink.js';
import {
  getMiorailProductMigrationFlags,
  getMiorailReliabilityThresholds,
} from '../lib/productMigrationConfig.js';
import {
  RoutePlanCoordinator,
  type RoutePlanCoordinatorDependencies,
  type RoutePlanCoordinatorInput,
} from '../lib/routePlanCoordinator.js';
import type { RouteIntentV1 } from '@mioagent/route-domain';
import type { TransactionPreparationResultV1 } from '@mioagent/transaction-composer';
import { loadTokenSecurityContext } from '../lib/executionSecurity.js';
import { createViemBaseReceiptReader } from '../lib/baseReceiptReader.js';
import { resolveEarnContractPreflightV1 } from '../lib/earnPreflight.js';
import { resolveEarnDataSourceV1 } from '../lib/earnLiveData.js';
import {
  atomicUsdcToDecimalV1,
  decimalUsdcToAtomicV1,
  paidSwapSimulationEnabledV1,
  resolvePaidSimulationPricingV1,
  resolvePaidSimulationProviderV1,
  simulationPriceUsdcForPrepareResponseV1,
  usdcAssetRefV1,
} from '../lib/paidIntelligenceConfig.js';
import { simulateSwapCallsV1 } from '../lib/swapSimulation.js';
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

/**
 * Deliberately NOT part of `routeStorageMigrationAvailable`. A deployment whose
 * 0036 has not run should keep planning routes, one message at a time, rather
 * than answer 503 — so the table's absence removes the continuation and nothing
 * else. It is checked rather than assumed because a silently missing table is
 * how an earlier cache spent a day doing nothing at all.
 */
async function pendingIntentStorageAvailable(): Promise<boolean> {
  const rows = await client`SELECT to_regclass('public.swap_pending_intents') AS pending_intents`;
  return Boolean(rows[0]?.pending_intents);
}

export const routePlanRouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  migrationAvailable: routeStorageMigrationAvailable,
  pendingIntentStorageAvailable,
  /**
   * Plan a route.
   *
   * `resolveIntent` is a seam, not a feature: Connected Intelligence 2 passes a
   * resolver that returns an intent BUILT FROM AN ADDRESS, so a confirmed stock
   * action never passes through the natural-language extractor. A typed
   * identity that survived a review boundary must not be re-derived from
   * words — that is exactly where a ticker could get back in.
   *
   * Everything after the resolver is unchanged and shared: the same route run,
   * the same adapters, the same engine, the same card.
   */
  coordinate: async (
    input: RoutePlanCoordinatorInput,
    resolveIntent?: RoutePlanCoordinatorDependencies['resolveIntent'],
  ) => {
    const flags = getMiorailProductMigrationFlags(process.env);
    const repository = createDatabaseRouteStorageRepository(client);
    const continuationAvailable = await routePlanRouteRuntime
      .pendingIntentStorageAvailable()
      .catch((error: unknown) => {
        logger.warn('Pending swap intent table could not be checked', { reason: String(error) });
        return false;
      });
    const coordinator = new RoutePlanCoordinator({
      ...(resolveIntent ? { resolveIntent } : {}),
      // RouteIntentV2 extraction is a short, closed JSON contract. Keep it on
      // the structured lane; the primary lane remains the narrator/reasoner.
      llm: createStructuredLlmProvider(),
      // T67C.1 Part 2: supplied ONLY when the flag is on. Absent means the
      // snapshot reader is never called, no reliability evidence is created,
      // and scoring stays byte-compatible with swap-path-score/v1.
      reliabilityLoaderFactory: flags.routeOutcomeFeedbackV1
        ? (context) =>
            createReliabilityLookupV1({
              outcomes: createDatabaseProviderOutcomeRepository(client),
              thresholds: getMiorailReliabilityThresholds(process.env),
              ...context,
            })
        : undefined,
      engine: createSwapRouteEngine(),
      // T67B: Aerodrome quotes over the Base RPC this deployment already has,
      // so it needs no key of its own — but with no RPC URL configured it
      // reports `not_configured` rather than pretending to have asked.
      // Comparison is ungated: it neither spends nor signs. Whether an
      // Aerodrome candidate can then be PREPARED is a separate decision, made
      // by MIORAIL_AERODROME_EXECUTION_V1 at the composer below.
      adapters: [
        new UniswapSwapRouteAdapter(),
        new KyberSwapRouteAdapter(),
        new AerodromeSwapRouteAdapter({ rpcUrl: baseMainnetRpcUrlV1() }),
        new O1SwapRouteAdapter({ rpcUrl: baseMainnetRpcUrlV1() }),
        new HydrexSwapRouteAdapter({ rpcUrl: baseMainnetRpcUrlV1() }),
        new BalancerSwapRouteAdapter(),
      ],
      repository,
      // T74: naming a token by address. Two conditions, both necessary — the
      // flag, and an endpoint to read the contract from. With either missing
      // the reader is absent, and an address outside the trusted three is
      // refused exactly as before.
      identifyToken:
        flags.tokenIdentityV1 && baseMainnetRpcUrlV1()
          ? createChainTokenIdentityReaderV1({ rpcUrl: baseMainnetRpcUrlV1() })
          : undefined,
      // Server-side continuation: the half-finished goal is keyed by the
      // authenticated tenant and wallet and never passes through the client.
      pendingIntents: continuationAvailable
        ? createDatabaseSwapPendingIntentRepository(client)
        : undefined,
    });
    return coordinator.evaluate(input);
  },
  now: () => new Date(),
};

/** The Base mainnet endpoint, resolved the same way every other on-chain read
 * in this server resolves it. Empty means the Aerodrome adapter reports
 * `not_configured` instead of quoting. */
function baseMainnetRpcUrlV1(): string {
  return (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
}

/** Upgradeable provider boundaries are re-pinned before both review and
 * approval. A missing RPC or any changed proxy/admin/implementation fails
 * closed without exposing endpoint details. */
async function providerContractPinVerifiedV1(provider: string): Promise<boolean> {
  const rpcUrl = baseMainnetRpcUrlV1();
  if (provider === 'o1-exchange') {
    return Boolean(rpcUrl) && (await createO1RouterPinReaderV1({ rpcUrl }).verify()).ok;
  }
  if (provider === 'hydrex') {
    return Boolean(rpcUrl) && (await createHydrexRouterPinReaderV1({ rpcUrl }).verifyAll()).ok;
  }
  return true;
}

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
  } catch (error) {
    // Same reasoning as the Commerce compare below: a bare `catch {}` made an
    // LLM misconfiguration indistinguishable from an adapter fault. An LLM
    // router whose key had run out of credits answered 500 here for a week,
    // and neither side of the wire said why. Provider messages are redacted by
    // the client that produced them, so a key cannot reach this log.
    logger.error('Route plan evaluation failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      wallet: user.address,
    });
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
      requestId: parsed.data.requestId,
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
  } catch (cause) {
    logger.error('Earn compare failed', safeFailureMetaV1(cause));
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
  } catch (cause) {
    logger.error('Earn prepare failed', safeFailureMetaV1(cause));
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
  attemptRepository: () => createDatabaseSubmissionAttemptRepository(client),
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
  } catch (cause) {
    logger.error('Blueprint approve failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'blueprint_approve_failed', code: 'blueprint_approve_failed' });
  }
});

routeIntelligenceRouter.post('/earn/blueprints/:blueprintId/submission', async (req, res) => {
  const guard = earnRouteGuard(req, res, SwapBlueprintSubmissionRequestV1Schema, 'invalid_blueprint_submission_request');
  if (!guard) return;
  const { user, data } = guard;
  try {
    if (!(await earnGateReady(res))) return;
    const attempts = earnBlueprintRouteRuntime.attemptRepository();
    const link = await verifySubmissionAttemptV1(attempts, {
      attemptId: data.submissionAttemptId,
      tenantId: user.id,
      blueprintId: String(req.params.blueprintId),
      approvedCallsHash: data.approvedCallsHash,
    });
    if (!link.ok) {
      res.status(link.code === 'submission_attempt_mismatch' ? 409 : 404).json({ error: link.code, code: link.code });
      return;
    }
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
    await recordAttemptOutcomeV1(attempts, {
      attempt: link.attempt,
      tenantId: user.id,
      submissionStatus: data.status,
      proofId: result.proofId,
      batchId: data.batchId ?? null,
      errorCode: data.error ? 'wallet_error' : null,
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
    const rpcUrl = baseMainnetRpcUrlV1();
    // T67B.1: Aerodrome may be PREPARED only behind its own flag. The list is
    // what the composer checks, so a server with the flag off answers
    // `unsupported_provider` — a normal outcome the client already renders —
    // rather than throwing on a missing adapter.
    const flags = getMiorailProductMigrationFlags(process.env);
    const aerodromeEnabled = flags.aerodromeExecutionV1;
    const o1Enabled = flags.o1ExecutionV1;
    const hydrexEnabled = flags.hydrexExecutionV1;
    const balancerEnabled = flags.balancerExecutionV1;
    const composer = createTransactionComposer({
      repository: createDatabaseRouteStorageRepository(client),
      buildAdapters: [
        new UniswapSwapBuildAdapter(),
        new KyberSwapBuildAdapter(),
        new AerodromeSwapBuildAdapter({ rpcUrl }),
        new O1SwapBuildAdapter({ rpcUrl }),
        new HydrexSwapBuildAdapter({ rpcUrl }),
        new BalancerSwapBuildAdapter({ rpcUrl }),
      ],
      quoteAdapters: [
        new UniswapSwapRouteAdapter(),
        new KyberSwapRouteAdapter(),
        new AerodromeSwapRouteAdapter({ rpcUrl }),
        new O1SwapRouteAdapter({ rpcUrl }),
        new HydrexSwapRouteAdapter({ rpcUrl }),
        new BalancerSwapRouteAdapter(),
      ],
      supportedProviders: [
        'uniswap',
        'kyberswap',
        ...(aerodromeEnabled ? (['aerodrome'] as const) : []),
        ...(o1Enabled ? (['o1-exchange'] as const) : []),
        ...(hydrexEnabled ? (['hydrex'] as const) : []),
        ...(balancerEnabled ? (['balancer'] as const) : []),
      ],
      // Aerodrome, o1 and Hydrex must survive a fork simulation before
      // signing. Both advanced providers cross upgradeable contract
      // boundaries, so a decoded call is never enough on its own.
      // No provider configured means BLOCKED, never "signed anyway".
      simulate: simulateSwapCallsV1,
      contractSecurity: async ({ chainId, addresses }) =>
        (await loadTokenSecurityContext(chainId, addresses)).tokenSecurity,
      providerContractPin: providerContractPinVerifiedV1,
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
  } catch (cause) {
    logger.error('Swap prepare failed', safeFailureMetaV1(cause));
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
        providerContractPin: providerContractPinVerifiedV1,
      },
      input,
    ),
  recordSubmission: async (input: RecordBlueprintSubmissionInput) =>
    recordBlueprintSubmissionV1({ repository: createDatabaseRouteStorageRepository(client) }, input),
  attemptRepository: () => createDatabaseSubmissionAttemptRepository(client),
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
  } catch (cause) {
    logger.error('Blueprint approve failed', safeFailureMetaV1(cause));
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
    const attempts = swapBlueprintRouteRuntime.attemptRepository();
    const link = await verifySubmissionAttemptV1(attempts, {
      attemptId: parsed.data.submissionAttemptId,
      tenantId: user.id,
      blueprintId: String(req.params.blueprintId),
      approvedCallsHash: parsed.data.approvedCallsHash,
    });
    if (!link.ok) {
      res.status(link.code === 'submission_attempt_mismatch' ? 409 : 404).json({ error: link.code, code: link.code });
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
    await recordAttemptOutcomeV1(attempts, {
      attempt: link.attempt,
      tenantId: user.id,
      submissionStatus: parsed.data.status,
      proofId: result.proofId,
      batchId: parsed.data.batchId ?? null,
      errorCode: parsed.data.error ? 'wallet_error' : null,
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
    // T67C.1: the loop closes here. `undefined` when the flag is off, so the
    // reconciler behaves exactly as it did before this task — no outcome is
    // derived, not one derived and discarded.
    outcomeProjector: createRouteOutcomeProjectorForServerV1({
      enabled: getMiorailProductMigrationFlags(process.env).routeOutcomeFeedbackV1,
      sql: client,
      repository,
    }),
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
  } catch (cause) {
    logger.error('Route proof reconcile failed', safeFailureMetaV1(cause));
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
  // Paid swap simulation is no longer a surface this product sells. Refused
  // with its own code, not `simulation_provider_unavailable`: "we do not
  // charge for this" and "the provider is down" are different facts, and only
  // the second is worth retrying. The swap review keeps its free checks.
  if (!paidSwapSimulationEnabledV1(env)) {
    return (_req: Request, res: Response) => {
      res.status(404).json({ error: 'simulation_not_offered', code: 'simulation_not_offered' });
    };
  }
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
  // Overridable so the existing paid-path tests keep exercising the paid path
  // rather than every one of them asserting the new refusal.
  paidSurfaceEnabled: paidSwapSimulationEnabledV1,
  repository: (): RouteStorageRepository => createDatabaseRouteStorageRepository(client),
  contractSecurity: async ({ chainId, addresses }: { chainId: number; addresses: `0x${string}`[] }) =>
    (await loadTokenSecurityContext(chainId, addresses)).tokenSecurity,
  // Overridable so tests inject a stub SimulationProvider instead of hitting
  // a real network URL — mirrors decision 2's "facilitator и provider —
  // ТОЛЬКО стабы" test requirement.
  createProvider: (config: SimulationProviderConfigV1) => createSimulationProviderFromConfigV1(config),
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
  } catch (cause) {
    logger.error('Simulation failed', safeFailureMetaV1(cause));
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
  (_req, _res, next) => simulateSettlementStorage.run({}, () => next()),
  // BEFORE the guard and before anything is written. The payment middleware
  // sits further down the chain, after a pending IntelligenceCharge has been
  // inserted — refusing there would leave a charge record for an operation
  // that never ran and never could.
  (_req: Request, res: Response, next: NextFunction) => {
    if (!simulateRouteRuntime.paidSurfaceEnabled(process.env)) {
      res.status(404).json({ error: 'simulation_not_offered', code: 'simulation_not_offered' });
      return;
    }
    next();
  },
  simulateGuardMiddleware,
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        // T63B: the configured adapter (generic HTTP or Alchemy RPC) — never a
        // fallback to another provider once money has moved.
        const retryProvider = simulateRouteRuntime.createProvider(retryProviderConfig);
        if (!retryProvider) {
          res.status(503).json({ error: 'simulation_provider_unavailable', code: 'simulation_provider_unavailable' });
          return;
        }
        const result = await runPaidSimulationV1(
          {
            repository,
            provider: retryProvider,
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
    } catch (cause) {
      logger.error('Simulation failed', safeFailureMetaV1(cause));
      res.status(500).json({ error: 'simulation_failed', code: 'simulation_failed' });
    }
  },
  (req: Request, res: Response, next: NextFunction) => simulateRouteRuntime.paymentMiddleware(req, res, next),
  async (_req: Request, res: Response): Promise<void> => {
    const { user, body, blueprint, pendingCharge } = res.locals as SimulateLocals;
    if (!pendingCharge) {
      res.status(500).json({ error: 'simulation_failed', code: 'simulation_failed' });
      return;
    }
    try {
      const repository = simulateRouteRuntime.repository();
      const settlement = simulateSettlementStorage.getStore()?.settlement ?? null;
      const providerConfig = simulateRouteRuntime.providerConfig(process.env);
      const provider = simulateRouteRuntime.createProvider(providerConfig);
      if (!provider) {
        res.status(503).json({ error: 'simulation_provider_unavailable', code: 'simulation_provider_unavailable' });
        return;
      }
      const result = await runPaidSimulationV1(
        {
          repository,
          provider,
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
        // T63B: gasUsed and the proven state changes come from the VALIDATED
        // provider response the evidence's responseHash was computed over.
        // They stay ephemeral (EvidenceRecordV1 persists only the audit-critical
        // blockNumber/requestHash/responseHash/evidenceHash) — see
        // respondWithCachedSimulation for the documented replay limitation.
        gasUsed: result.response.gasUsed,
        stateChanges: result.response.stateChanges,
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
  createProvider: (config: SimulationProviderConfigV1) => createSimulationProviderFromConfigV1(config),
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

/**
 * T71 — what a budget created through the onboarding flow may buy.
 *
 * Every intelligence category, because the user is choosing to enable paid
 * evidence rather than to enable one provider: a default that silently excluded
 * a category would show up as a paid check that never happens, with no
 * explanation anywhere. The Settings panel lists what is allowed, and the
 * PATCH route narrows it.
 */
export const DEFAULT_PAID_EVIDENCE_CATEGORIES_V1 = [
  'route_quote',
  'liquidity',
  'risk',
  'simulation',
  'inference',
] as const;

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
    // T71 — the LATEST budget, whatever its status. The active lookup answers
    // "may this wallet spend?", which is right for a charge and wrong for
    // Settings: a paused budget came back null, and a screen reading null
    // renders "not configured" and offers to create a second permission for a
    // wallet that already granted one.
    const record = await repository.getLatestIntelligenceBudget(user.id, user.address, 8453);
    res.json(
      IntelligenceBudgetResponseV1Schema.parse({
        budget: record ? budgetProjectionFromRecord(record) : null,
      }),
    );
  } catch (cause) {
    logger.error('Budget simulation failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'budget_simulation_failed', code: 'budget_simulation_failed' });
  }
});

// GET /route-intelligence/intelligence-charges — the caller's recent charges,
// newest first. T67E §2.2.
//
// Behind the same guard chain as the budget routes, and read-only: it creates
// no charge, settles nothing and touches no permission. The projection drops
// every payment artefact — no authorization payload, no facilitator response,
// no receipt body, no provider answer — so this endpoint cannot become a way to
// read a payment envelope back out of the server.
routeIntelligenceRouter.get('/intelligence-charges', async (req: Request, res: Response): Promise<void> => {
  const user = budgetFlagSessionGuard(req, res);
  if (!user) return;
  if (!budgetChainEnvOk(res)) return;
  const rawLimit = Number.parseInt(String(req.query.limit ?? '20'), 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 20;
  try {
    if (!(await budgetMigrationOk(res))) return;
    const stored = await budgetRouteRuntime.repository().listRecentIntelligenceCharges(user.id, limit);
    res.json(
      IntelligenceChargesResponseV1Schema.parse({
        charges: stored.map(({ charge }) => ({
          chargeId: charge.id,
          status: charge.status,
          service: charge.service,
          providerName: charge.provider.displayName,
          category: charge.category,
          quotedUsdc: charge.quotedCost.amountDecimal,
          chargedUsdc: charge.chargedCost?.amountDecimal ?? null,
          fundingMode: charge.fundingMode,
          createdAt: charge.createdAt,
        })),
      }),
    );
  } catch (cause) {
    logger.error('Intelligence charges failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'intelligence_charges_failed', code: 'intelligence_charges_failed' });
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
  } catch (cause) {
    logger.error('Budget simulation failed', safeFailureMetaV1(cause));
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
  } catch (cause) {
    logger.error('Budget simulation failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'budget_simulation_failed', code: 'budget_simulation_failed' });
  }
});

// ===========================================================================
// T71 — Base Spend Permission onboarding.
//
// Three routes, and one of them writes: prepare says what to ask the wallet
// for, confirm verifies what came back ON CHAIN before anything exists, and
// pause/resume move a budget between the two states that stop and start paid
// checks without touching the wallet at all.
//
// The client never names a spender, a token, a chain, a wallet or a permission
// hash. Prepare resolves all five; confirm re-resolves them and compares. A
// client that lies produces a refusal, not a budget.
// ===========================================================================

/** Both onboarding routes share one guard chain with the rest of the budget
 * surface, plus a verifier that can actually reach Base. */
export const spendPermissionRouteRuntime = {
  verifier: (): SpendPermissionVerifierV1 => createSpendPermissionVerifierV1(process.env),
  permissions: (): SpendPermissionRepository => createDatabaseSpendPermissionRepository(client),
  prepare: prepareSpendPermissionV1,
  confirm: confirmSpendPermissionV1,
};

// POST /route-intelligence/intelligence-budget/permission/prepare
routeIntelligenceRouter.post(
  '/intelligence-budget/permission/prepare',
  async (req: Request, res: Response): Promise<void> => {
    const user = budgetFlagSessionGuard(req, res);
    if (!user) return;
    const parsed = PrepareSpendPermissionRequestV1Schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
      return;
    }
    if (!budgetChainEnvOk(res)) return;
    const periodLimitAtomic = decimalUsdcToAtomicV1(parsed.data.periodLimitUsdc);
    const maxPerCallAtomic = decimalUsdcToAtomicV1(parsed.data.maxPerCallUsdc);
    if (!periodLimitAtomic || !maxPerCallAtomic) {
      res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
      return;
    }
    // Checked before a wallet is ever opened: a permission that allows less
    // than a single request could never buy one.
    if (BigInt(maxPerCallAtomic) > BigInt(periodLimitAtomic)) {
      res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
      return;
    }
    try {
      if (!(await budgetMigrationOk(res))) return;
      const prepared = await spendPermissionRouteRuntime.prepare({
        walletAddress: user.address,
        periodLimitAtomic,
        periodLimitUsdc: parsed.data.periodLimitUsdc,
        maxPerCallUsdc: parsed.data.maxPerCallUsdc,
        verifier: spendPermissionRouteRuntime.verifier(),
      });
      res.json(PrepareSpendPermissionResponseV1Schema.parse(prepared));
    } catch {
      // The spender could not be resolved. Never the cause: it is read from
      // operator configuration that may name a wallet or a key.
      res.status(503).json({ error: 'spend_permission_unavailable', code: 'spend_permission_unavailable' });
    }
  },
);

// POST /route-intelligence/intelligence-budget/permission/confirm
routeIntelligenceRouter.post(
  '/intelligence-budget/permission/confirm',
  async (req: Request, res: Response): Promise<void> => {
    const user = budgetFlagSessionGuard(req, res);
    if (!user) return;
    const parsed = ConfirmSpendPermissionRequestV1Schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
      return;
    }
    if (!budgetChainEnvOk(res)) return;
    const periodLimitAtomic = decimalUsdcToAtomicV1(parsed.data.periodLimitUsdc);
    const maxPerCallAtomic = decimalUsdcToAtomicV1(parsed.data.maxPerCallUsdc);
    if (!periodLimitAtomic || !maxPerCallAtomic) {
      res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
      return;
    }

    try {
      if (!(await budgetMigrationOk(res))) return;
      const repository = budgetRouteRuntime.repository();
      const now = budgetRouteRuntime.now();

      const confirmed = await spendPermissionRouteRuntime.confirm({
        tenantId: user.id,
        // From the session. The body's `account` is checked against this by the
        // verifier and is never read as the answer.
        walletAddress: user.address,
        claim: parsed.data.permission,
        periodLimitAtomic,
        now,
        verifier: spendPermissionRouteRuntime.verifier(),
        permissions: spendPermissionRouteRuntime.permissions(),
      });

      // T71.1 §1 — say what happened, in three fields.
      //
      // A confirmation that did not activate answers 200, because it is a typed
      // result and not an error. That made it invisible: the access log showed
      // `200`, the client rendered "Not configured", and the reason the chain
      // gave existed nowhere at all. An operator could not tell a wallet that
      // signed the wrong thing from a chain that had not caught up yet.
      //
      // Three fields, and deliberately no fourth. Not the permission, not the
      // signature, not the salt, not the hash, not the wallet: a refusal is
      // worth knowing about, and none of those are needed to know it.
      logger.info('Spend permission confirmation', {
        outcome: confirmed.outcome,
        refusal: confirmed.outcome === 'refused' ? confirmed.refusal : null,
        retryable: confirmed.outcome === 'activated' ? false : confirmed.retryable,
      });

      if (confirmed.outcome !== 'activated') {
        res.json(
          ConfirmSpendPermissionResponseV1Schema.parse({
            outcome: confirmed.outcome,
            refusal: confirmed.outcome === 'refused' ? confirmed.refusal : null,
            detail: confirmed.detail,
            retryable: confirmed.retryable,
            budget: null,
          }),
        );
        return;
      }

      // §4 — the budget is created only now, from a permission the chain has
      // confirmed. An existing budget for the SAME permission is returned as-is:
      // a repeated confirmation is a retry, not a second authorisation.
      const existing = await repository.getLatestIntelligenceBudget(user.id, user.address, 8453);
      if (existing && existing.status === 'active') {
        if (existing.spendPermissionId !== confirmed.permissionId) {
          res.status(409).json({ error: 'intelligence_budget_exists', code: 'intelligence_budget_exists' });
          return;
        }
        res.json(
          ConfirmSpendPermissionResponseV1Schema.parse({
            outcome: 'activated',
            refusal: null,
            detail: 'Paid evidence is already active for this wallet.',
            retryable: false,
            budget: budgetProjectionFromRecord(existing),
          }),
        );
        return;
      }

      const nowIso = now.toISOString();
      const periodEnds = new Date(now);
      periodEnds.setUTCMonth(periodEnds.getUTCMonth() + 1);
      const allowedCategories =
        parsed.data.allowedCategories ?? DEFAULT_PAID_EVIDENCE_CATEGORIES_V1;
      const budgetId = `intelligence-budget:${stableHashV1('intelligence-budget-id/v1', {
        tenantId: user.id,
        spendPermissionId: confirmed.permissionId,
        createdAt: nowIso,
      }).slice(2)}`;
      const draft: IntelligenceBudgetV1 = {
        schemaVersion: 'intelligence-budget/v1',
        id: budgetId,
        tenantId: user.id,
        walletAddress: user.address as IntelligenceBudgetV1['walletAddress'],
        chainId: 8453,
        createdAt: nowIso,
        updatedAt: nowIso,
        status: 'active',
        spendPermissionId: confirmed.permissionId,
        periodType: 'monthly',
        asset: usdcAssetRefV1(),
        periodLimitAtomic,
        periodSpentAtomic: '0',
        reservedAtomic: '0',
        maxPerCallAtomic,
        allowedCategories: allowedCategories as IntelligenceBudgetV1['allowedCategories'],
        periodStartedAt: nowIso,
        periodEndsAt: periodEnds.toISOString(),
        revokedAt: null,
        budgetHash: ZERO_HASH_V1,
      };
      let validated: IntelligenceBudgetV1;
      try {
        validated = IntelligenceBudgetV1Schema.parse({ ...draft, budgetHash: hashIntelligenceBudgetV1(draft) });
      } catch {
        res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
        return;
      }

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
      res.status(201).json(
        ConfirmSpendPermissionResponseV1Schema.parse({
          outcome: 'activated',
          refusal: null,
          detail: 'Paid evidence is active. Miorail can now buy evidence within the limits you set.',
          retryable: false,
          budget: budgetProjectionFromRecord(record),
        }),
      );
    } catch (cause) {
      if (cause instanceof RouteStorageConflictError) {
        res.status(409).json({ error: 'intelligence_budget_exists', code: 'intelligence_budget_exists' });
        return;
      }
      // T71-LIVE-2 — this catch used to swallow the error whole. A real wallet
      // hit a 500 here and the entire record of why was one access-log line
      // saying `500`; the outcome log above never runs, because the throw
      // happened before it. That cost a full round trip through a user's
      // wallet to learn nothing.
      //
      // Name and message only, and a bounded stack of FRAME LOCATIONS. A viem
      // error's message can carry the permission's own fields, so it is
      // reported by category — never the value, same rule as safeZodIssuesV1.
      logger.error('Spend permission confirmation failed', {
        name: cause instanceof Error ? cause.name : typeof cause,
        // `detail`, not `message`: the logger flattens meta onto the entry, so
        // a `message` key here silently replaced the log's own title and the
        // line came out unlabelled — which is how the first one was missed.
        detail: cause instanceof Error ? safeErrorMessageV1(cause.message) : null,
        at: cause instanceof Error ? firstOwnFrameV1(cause.stack) : null,
      });
      res.status(500).json({ error: 'budget_simulation_failed', code: 'budget_simulation_failed' });
    }
  },
);

/** Pause and resume, which are the same operation with different words and
 * different starting states. Neither touches the wallet: the permission stays
 * exactly as granted, and only Miorail's willingness to draw on it changes. */
async function setBudgetPausedV1(
  req: Request,
  res: Response,
  next: 'paused' | 'active',
): Promise<void> {
  const user = budgetFlagSessionGuard(req, res);
  if (!user) return;
  const parsed = PauseIntelligenceBudgetRequestV1Schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_intelligence_budget_request', code: 'invalid_intelligence_budget_request' });
    return;
  }
  if (!budgetChainEnvOk(res)) return;
  try {
    if (!(await budgetMigrationOk(res))) return;
    const repository = budgetRouteRuntime.repository();
    // The LATEST budget, not the active one: resume exists precisely to act on
    // a budget the active lookup cannot see.
    const record = await repository.getLatestIntelligenceBudget(user.id, user.address, 8453);
    if (!record) {
      res.status(404).json({ error: 'intelligence_budget_not_found', code: 'intelligence_budget_not_found' });
      return;
    }
    // Revoked is final here. Resuming one would be Miorail deciding a user's
    // withdrawal of consent was temporary; the way back is a new permission.
    if (record.status === 'revoked' || record.status === 'expired') {
      res.status(409).json({ error: 'intelligence_budget_not_resumable', code: 'intelligence_budget_not_resumable' });
      return;
    }
    if (record.status === next) {
      // Idempotent: pausing twice is one pause, and a double-click is not an
      // error worth showing anybody.
      res.json(IntelligenceBudgetResponseV1Schema.parse({ budget: budgetProjectionFromRecord(record) }));
      return;
    }

    const nowIso = budgetRouteRuntime.now().toISOString();
    const current = intelligenceBudgetV1FromRecord(record, usdcAssetRefV1());
    const draft: IntelligenceBudgetV1 = {
      ...current,
      status: next,
      updatedAt: nowIso,
      budgetHash: ZERO_HASH_V1,
    };
    const updated = await repository.updateIntelligenceBudget(record.id, user.id, {
      status: next,
      budgetHash: hashIntelligenceBudgetV1(draft),
      now: nowIso,
    });
    res.json(IntelligenceBudgetResponseV1Schema.parse({ budget: budgetProjectionFromRecord(updated) }));
  } catch (cause) {
    logger.error('Budget simulation failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'budget_simulation_failed', code: 'budget_simulation_failed' });
  }
}

// POST /route-intelligence/intelligence-budget/pause — stop paid checks. The
// permission is untouched and free route comparison is unaffected.
routeIntelligenceRouter.post('/intelligence-budget/pause', (req: Request, res: Response) =>
  setBudgetPausedV1(req, res, 'paused'),
);

// POST /route-intelligence/intelligence-budget/resume — start them again. No
// wallet action: the permission was never withdrawn.
routeIntelligenceRouter.post('/intelligence-budget/resume', (req: Request, res: Response) =>
  setBudgetPausedV1(req, res, 'active'),
);

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
    // The latest, so a PAUSED budget can be revoked too. Requiring a user to
    // resume before they can revoke would be asking them to turn spending back
    // on in order to turn it off.
    const record = await repository.getLatestIntelligenceBudget(user.id, user.address, 8453);
    if (!record || record.status === 'revoked') {
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
    // T71 — and stop Miorail drawing on the permission itself. The budget's
    // status is what the coordinator gates on, so this is belt and braces; it
    // is worth having because the two records outlive each other and a spender
    // that is still marked active is a fact somebody will eventually trust.
    //
    // It does NOT revoke the permission on chain. Only the user's wallet can do
    // that, and claiming otherwise would be the most consequential lie this
    // surface could tell — so the response says so instead.
    try {
      await spendPermissionRouteRuntime.permissions().setActive(record.spendPermissionId, false);
    } catch {
      // Best effort. The budget is already revoked, which is what blocks paid
      // checks; failing the request here would leave the user unsure whether
      // their revocation took.
    }
    res.json(IntelligenceBudgetResponseV1Schema.parse({ budget: budgetProjectionFromRecord(revoked) }));
  } catch (cause) {
    logger.error('Budget simulation failed', safeFailureMetaV1(cause));
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

      // T63B: the configured adapter, resolved from server config only.
      const budgetProvider = budgetRouteRuntime.createProvider(providerConfig);
      if (!budgetProvider) {
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
            provider: budgetProvider,
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
            // T63B: from the validated provider response; null/[] only on an
            // idempotent replay, where the body was never persisted.
            gasUsed: result.response?.gasUsed ?? null,
            stateChanges: result.response?.stateChanges ?? [],
          }),
          charge: budgetChargeSummaryV1(result.charge),
          scoreNote: { transactionSafety: 'not_scored', missingEvidence: result.evidenceSet.missingEvidence },
          budget: budgetProjectionFromRecord(result.budget),
        }),
      );
    } catch (cause) {
      logger.error('Budget simulation failed', safeFailureMetaV1(cause));
      res.status(500).json({ error: 'budget_simulation_failed', code: 'budget_simulation_failed' });
    }
  },
);


// ===========================================================================
// T64 / T64.2 — Commerce Route (Bitrefill), durably persisted.
//
// Three independently gated surfaces:
//
//   compare   — read-only catalogue reads, scored and PERSISTED as a run +
//               candidates + evidence + Route Card.
//   orders    — opens ONE price-locked invoice per idempotency key and returns
//               the exact payment review. It signs nothing and pays nothing.
//   reconcile — folds confirmed provider states into the durable order.
//
// The rule that shapes the order route: the order ROW exists before the
// provider is called. A repeat returns the row that already exists, and a call
// whose outcome the network did not make clear becomes a durable
// `creation_unknown` rather than a lost request or a silent second invoice.
// ===========================================================================

export const commerceRouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  resolveIntent: (input: ResolveCommerceIntentInputV1) => resolveCommerceIntentV1(input),
  compare: (input: CompareCommerceRoutesInputV1) =>
    compareCommerceRoutesV1({ catalog: resolveCommerceCatalogSourceV1() }, input),
  createOrder: (input: Parameters<CommerceOrderGatewayV1['createOrder']>[0]) =>
    resolveCommerceOrderGatewayV1().createOrder(input),
  readOrderStatus: (input: { invoiceId: string; now: Date }) =>
    resolveCommerceOrderGatewayV1().readOrderStatus(input),
  repository: (): CommerceStorageRepository => createDatabaseCommerceStorageRepository(client),
  migrationAvailable: commerceStorageMigrationAvailable,
  now: () => new Date(),
};

/** flag(routeIntelligenceV1 && commerceRouteV1) + session + body + wallet +
 * chain — the shared head of every commerce route. */
function commerceRouteGuard<T>(
  req: Request,
  res: Response,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  invalidCode: string,
): { user: NonNullable<ReturnType<typeof signedRoutePlanUser>>; body: T } | null {
  const flags = commerceRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.commerceRouteV1) {
    res.status(404).json({ error: 'commerce_route_disabled', code: 'commerce_route_disabled' });
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

/** Commerce needs its own additive tables (migration 0015) on top of the base
 * route-storage set. Missing storage is a stable 503, never a partial write. */
async function commerceStorageMigrationAvailable(): Promise<boolean> {
  if (!(await routeStorageMigrationAvailable())) return false;
  const rows = await client`
    SELECT
      to_regclass('public.commerce_candidates') AS commerce_candidates,
      to_regclass('public.commerce_evidence') AS commerce_evidence,
      to_regclass('public.commerce_route_cards') AS commerce_route_cards,
      to_regclass('public.commerce_orders') AS commerce_orders,
      to_regclass('public.commerce_order_events') AS commerce_order_events,
      to_regclass('public.commerce_proofs') AS commerce_proofs
  `;
  const row = rows[0];
  return Boolean(
    row &&
    row.commerce_candidates &&
    row.commerce_evidence &&
    row.commerce_route_cards &&
    row.commerce_orders &&
    row.commerce_order_events &&
    row.commerce_proofs,
  );
}

async function commerceStorageReady(res: Response): Promise<boolean> {
  if (await commerceRouteRuntime.migrationAvailable()) return true;
  res.status(503).json({ error: 'commerce_storage_unavailable', code: 'commerce_storage_unavailable' });
  return false;
}

routeIntelligenceRouter.post('/commerce/compare', async (req, res) => {
  const guard = commerceRouteGuard(req, res, CommerceCompareRequestV1Schema, 'invalid_commerce_compare_request');
  if (!guard) return;
  try {
    const now = commerceRouteRuntime.now();
    const resolution = commerceRouteRuntime.resolveIntent({
      message: guard.body.message,
      tenantId: guard.user.id,
      walletAddress: guard.user.address as `0x${string}`,
      now,
      // Each comparison is its own run. Without this the run id came from the
      // goal text alone, so comparing one gift card twice collided with its
      // own earlier run and failed permanently.
      requestId: guard.body.requestId,
    });
    if (resolution.status === 'unsupported') {
      res.json(
        CommerceCompareResponseV1Schema.parse({
          outcome: 'unsupported',
          reason: resolution.issues[0] ?? 'unsupported_commerce_request',
          catalogueStatus: 'not_reached',
        }),
      );
      return;
    }
    if (resolution.status === 'needs_clarification') {
      res.json(
        CommerceCompareResponseV1Schema.parse({ outcome: 'needs_clarification', issues: resolution.issues }),
      );
      return;
    }
    const comparison = await commerceRouteRuntime.compare({ intent: resolution.intent, now });
    if (!comparison.ok) {
      const catalogueStatus =
        comparison.reason === 'product_not_found'
          ? 'reached_no_match'
          : comparison.reason.startsWith('provider_')
            ? 'request_failed'
            : [
                  'unsupported_kind',
                  'unsupported_country',
                  'unsupported_currency',
                  'pinned_chain_mismatch',
                  'pinned_asset_mismatch',
                  'spend_ceiling_exceeded',
                  'price_out_of_range',
                ].includes(comparison.reason)
              ? 'not_reached'
              : 'reached';
      res.json(
        CommerceCompareResponseV1Schema.parse({
          outcome: 'unsupported',
          reason: comparison.reason,
          catalogueStatus,
        }),
      );
      return;
    }
    if (!(await commerceStorageReady(res))) return;

    // Persist the whole comparison so the order route can load the exact card
    // the user reviewed instead of re-deriving one at a possibly newer price.
    const repository = commerceRouteRuntime.repository();
    const run = await repository.createCommerceRouteRun(resolution.intent, guard.body.requestId);
    for (const entry of comparison.entries) {
      await repository.insertCommerceCandidate(run.id, entry.candidate);
      await repository.insertCommerceEvidence(run.id, entry.candidate.candidateHash, entry.evidence);
    }
    await repository.insertCommerceRouteCard(run.id, comparison.routeCard);

    res.json(
      CommerceCompareResponseV1Schema.parse({
        outcome: 'compared',
        routeRunId: run.id,
        routeCard: comparison.routeCard,
        countryInferred: resolution.extraction.countryInferred,
        excluded: [...new Set(comparison.skipped)],
      }),
    );
  } catch (error) {
    // T64.3.1: this used to be a bare `catch {}`. A 500 with no log made the
    // failure undiagnosable from either side — the console could only say
    // "the server did not answer", and the server said nothing at all. The
    // response body stays a stable code; the cause goes to the log.
    logger.error('Commerce compare failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      wallet: guard.user.address,
    });
    res.status(500).json({ error: 'commerce_compare_failed', code: 'commerce_compare_failed' });
  }
});

routeIntelligenceRouter.post('/commerce/orders', async (req, res) => {
  const guard = commerceRouteGuard(req, res, CommerceOrderCreateRequestV1Schema, 'invalid_commerce_order_request');
  if (!guard) return;
  // Comparing a gift card is repeatable; opening a checkout is not, so it has
  // its own gate.
  if (!commerceRouteRuntime.flags(process.env).commerceExecutionV1) {
    res.status(404).json({ error: 'commerce_execution_disabled', code: 'commerce_execution_disabled' });
    return;
  }
  if (!(await commerceStorageReady(res))) return;

  try {
    const now = commerceRouteRuntime.now();
    const repository = commerceRouteRuntime.repository();
    const run = await repository.getCommerceRouteRun(guard.body.routeRunId, guard.user.id);
    if (!run) {
      res.json(
        CommerceOrderCreateResponseV1Schema.parse({
          outcome: 'refresh_required',
          reason: 'That comparison is not available for this wallet. Compare again before ordering.',
        }),
      );
      return;
    }

    const cards = await repository.listCommerceRouteCards(run.id, guard.user.id);
    const card = cards.find((entry) => entry.routeCardHash === guard.body.routeCardHash);
    if (!card) {
      res.json(
        CommerceOrderCreateResponseV1Schema.parse({
          outcome: 'refresh_required',
          reason: 'The stored comparison does not contain that Route Card. Compare again before ordering.',
        }),
      );
      return;
    }
    // A price-locked invoice may not be opened against an expired comparison.
    if (Date.parse(card.expiresAt) <= now.getTime()) {
      res.json(
        CommerceOrderCreateResponseV1Schema.parse({
          outcome: 'refresh_required',
          reason: 'That comparison has expired. Compare again to get a current price.',
        }),
      );
      return;
    }

    const candidates = await repository.listCommerceCandidates(run.id, guard.user.id);
    const candidate = candidates.find((entry) => entry.candidateHash === guard.body.selectedCandidateHash);
    if (!candidate) {
      res.json(
        CommerceOrderCreateResponseV1Schema.parse({
          outcome: 'refresh_required',
          reason: 'The selected option is not part of the stored comparison.',
        }),
      );
      return;
    }
    if (candidate.availability !== 'in_stock') {
      res.json(
        CommerceOrderCreateResponseV1Schema.parse({
          outcome: 'blocked',
          reason: 'The storefront does not report this option as in stock.',
        }),
      );
      return;
    }
    if (Date.parse(candidate.expiresAt) <= now.getTime()) {
      res.json(
        CommerceOrderCreateResponseV1Schema.parse({
          outcome: 'refresh_required',
          reason: 'The price for this option is no longer current. Compare again before ordering.',
        }),
      );
      return;
    }

    // Reserve the ONE row for this idempotency key BEFORE touching the
    // provider. A repeat lands on `existing` and never opens a second invoice.
    const idempotencyKey = commerceIdempotencyKeyV1({
      tenantId: guard.user.id,
      walletAddress: guard.user.address,
      routeCardHash: card.routeCardHash,
      productId: candidate.product.productId,
      packageValue: candidate.product.packageValue,
      requestId: guard.body.requestId,
    });
    const reservation = await repository.reserveCommerceOrder({
      routeRunId: run.id,
      userId: guard.user.id,
      walletAddress: guard.user.address,
      routeCardHash: card.routeCardHash,
      candidateHash: candidate.candidateHash,
      productId: candidate.product.productId,
      packageValue: candidate.product.packageValue,
      idempotencyKey,
      estimatedAmountAtomic: candidate.fees.totalAtomic,
      refundAddress: guard.user.address,
    });

    if (reservation.outcome === 'existing') {
      const record = reservation.record;
      if (record.order && record.order.invoice) {
        res.json(
          CommerceOrderCreateResponseV1Schema.parse({
            outcome: 'created',
            orderId: record.id,
            order: record.order,
            invoice: record.order.invoice,
            amounts: commerceAmountReviewV1({ candidate, invoice: record.order.invoice }),
          }),
        );
        return;
      }
      // Reserved but never confirmed. Reconcile — do NOT call the provider
      // again, because that is exactly how a duplicate invoice is created.
      res.json(
        CommerceOrderCreateResponseV1Schema.parse({
          outcome: 'invoice_creation_unknown',
          orderId: record.id,
          reason:
            'A checkout for this selection was already started and never confirmed. Check its status instead of ordering again.',
        }),
      );
      return;
    }

    const orderRowId = reservation.record.id;
    const created = await commerceRouteRuntime.createOrder({
      productId: candidate.product.productId,
      packageValue: candidate.product.packageValue,
      // A fixed denomination is ordered by its package id when the catalogue
      // published one; `packageValue` is the range-product field.
      packageId: candidate.product.packageId,
      recipientInput: run.intent.recipientInput,
      maxSpendAtomic: run.intent.maxSpendAtomic,
      // A failed crypto payment returns to the wallet that authorized it.
      refundAddress: guard.user.address,
      now,
    });

    if (!created.ok) {
      if (created.reason === 'invoice_creation_unknown') {
        const record = await repository.markCommerceOrderUnknown(orderRowId, guard.user.id, created.detail);
        res.json(
          CommerceOrderCreateResponseV1Schema.parse({
            outcome: 'invoice_creation_unknown',
            orderId: record.id,
            reason: `${created.detail} An invoice may exist — reconcile before ordering again.`,
          }),
        );
        return;
      }
      res.json(
        CommerceOrderCreateResponseV1Schema.parse({
          outcome: 'blocked',
          reason: `The storefront did not open a checkout (${created.reason}).`,
        }),
      );
      return;
    }

    // The exact amount comes from the invoice and from nowhere else.
    const validated = validateCommerceInvoiceV1({
      provider: {
        invoiceId: created.order.invoiceId,
        network: `eip155:${run.intent.chainId}`,
        asset: created.order.asset,
        payTo: created.order.payTo,
        amountAtomic: created.order.totalAtomic,
        providerFeeAtomic: created.order.providerFeeAtomic ?? null,
        expiresAt: created.order.expiresAt,
        paymentStatus: created.order.paymentStatus ?? 'unpaid',
        orderStatus: created.order.orderStatus ?? 'created',
        productId: candidate.product.productId,
        packageValue: candidate.product.packageValue,
        recipientPolicy: created.order.recipientPolicy ?? 'pinned',
      },
      intent: run.intent,
      candidate,
      authenticatedWallet: guard.user.address,
      now,
    });
    if (!validated.ok) {
      res.json(
        CommerceOrderCreateResponseV1Schema.parse({
          outcome: 'blocked',
          reason: `The invoice failed validation (${validated.reason}).`,
        }),
      );
      return;
    }

    const built = buildCommerceOrderV1({ intent: run.intent, candidate, created: created.order, now });
    if (!built.ok) {
      res.json(
        CommerceOrderCreateResponseV1Schema.parse({
          outcome: 'blocked',
          reason: `The checkout did not match the pinned payment terms (${built.reason}).`,
        }),
      );
      return;
    }
    const order = {
      ...built.order,
      providerStatus: validated.invoice.orderStatus,
      estimate: { totalAtomic: candidate.fees.totalAtomic, totalBasis: candidate.fees.totalBasis },
      invoice: validated.invoice,
    };
    const record = await repository.confirmCommerceOrder(orderRowId, guard.user.id, order);
    await repository.appendCommerceOrderEvent(orderRowId, guard.user.id, {
      schemaVersion: 'commerce-order-event/v1',
      invoiceId: validated.invoice.invoiceId,
      status: 'invoice_created',
      paymentState: 'awaiting_signature',
      deliveryState: 'not_started',
      detail: 'Price-locked invoice created. Nothing has been signed or sent.',
      observedAt: now.toISOString(),
    });

    res.json(
      CommerceOrderCreateResponseV1Schema.parse({
        outcome: 'created',
        orderId: record.id,
        order,
        invoice: validated.invoice,
        amounts: commerceAmountReviewV1({ candidate, invoice: validated.invoice }),
      }),
    );
  } catch (cause) {
    logger.error('Commerce order failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'commerce_order_failed', code: 'commerce_order_failed' });
  }
});

/** Loads a durable order by invoice id, tenant-scoped. */
async function loadCommerceOrderForResponseV1(
  res: Response,
  userId: string,
  invoiceId: string,
): Promise<{ repository: CommerceStorageRepository; record: CommerceOrderRecordV1 } | null> {
  const repository = commerceRouteRuntime.repository();
  const record = await repository.getCommerceOrderByInvoice(invoiceId, userId);
  if (!record) {
    res.json(
      CommerceOrderStatusResponseV1Schema.parse({
        outcome: 'unknown_order',
        reason: 'This wallet has no checkout with that invoice id.',
      }),
    );
    return null;
  }
  return { repository, record };
}

function commerceInvoiceIdParamV1(req: Request, res: Response): string | null {
  const invoiceId = String(req.params.invoiceId ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(invoiceId)) {
    res.status(400).json({ error: 'invalid_commerce_invoice_id', code: 'invalid_commerce_invoice_id' });
    return null;
  }
  return invoiceId;
}

function commerceReadGuardV1(req: Request, res: Response): NonNullable<ReturnType<typeof signedRoutePlanUser>> | null {
  const flags = commerceRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.commerceRouteV1) {
    res.status(404).json({ error: 'commerce_route_disabled', code: 'commerce_route_disabled' });
    return null;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return null;
  }
  return user;
}

routeIntelligenceRouter.get('/commerce/orders/:invoiceId', async (req, res) => {
  const user = commerceReadGuardV1(req, res);
  if (!user) return;
  const invoiceId = commerceInvoiceIdParamV1(req, res);
  if (invoiceId === null) return;
  if (!(await commerceStorageReady(res))) return;
  try {
    const loaded = await loadCommerceOrderForResponseV1(res, user.id, invoiceId);
    if (!loaded) return;
    const { repository, record } = loaded;
    if (!record.order) {
      res.json(
        CommerceOrderStatusResponseV1Schema.parse({
          outcome: 'creation_unknown',
          orderId: record.id,
          reason: 'A checkout was reserved but no invoice was ever confirmed for it.',
        }),
      );
      return;
    }
    const proof = await repository.getCommerceProof(record.id, user.id);
    const events = await repository.listCommerceOrderEvents(record.id, user.id);
    res.json(
      CommerceOrderStatusResponseV1Schema.parse({
        outcome: 'status',
        orderId: record.id,
        order: record.order,
        proof:
          proof ??
          buildStoredCommerceProofV1(record.order, commerceRouteRuntime.now()),
        providerStatus: record.providerStatus,
        events,
      }),
    );
  } catch (cause) {
    logger.error('Commerce order status failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'commerce_order_status_failed', code: 'commerce_order_status_failed' });
  }
});

/** A proof for an order that has never been reconciled: three legs, all at
 * their starting state, so the response is honest rather than empty. */
function buildStoredCommerceProofV1(order: CommerceOrderV1, now: Date) {
  const built = buildCommerceRouteProofV1({
    order,
    observation: {
      invoiceId: order.invoiceId,
      paymentSettled: false,
      paymentTransactionHash: null,
      settledAt: null,
      orderIds: [],
      deliveryState: 'not_started',
      itemCount: order.items.length,
      deliveredCount: 0,
      observedAt: now.toISOString(),
    },
    evidenceSetHash: ZERO_HASH_V1,
    now,
  });
  if (!built.ok) throw new Error('commerce proof could not be built');
  return built.proof;
}

routeIntelligenceRouter.post('/commerce/orders/:invoiceId/reconcile', async (req, res) => {
  const user = commerceReadGuardV1(req, res);
  if (!user) return;
  const invoiceId = commerceInvoiceIdParamV1(req, res);
  if (invoiceId === null) return;
  if (!(await commerceStorageReady(res))) return;
  try {
    const loaded = await loadCommerceOrderForResponseV1(res, user.id, invoiceId);
    if (!loaded) return;
    const { repository, record } = loaded;
    if (!record.order) {
      res.json(
        CommerceOrderStatusResponseV1Schema.parse({
          outcome: 'creation_unknown',
          orderId: record.id,
          reason: 'A checkout was reserved but no invoice was ever confirmed for it.',
        }),
      );
      return;
    }
    const now = commerceRouteRuntime.now();
    const observed = await commerceRouteRuntime.readOrderStatus({ invoiceId, now });
    if (!observed.ok) {
      res.json(
        CommerceOrderStatusResponseV1Schema.parse({
          outcome: 'provider_unavailable',
          reason: `The storefront could not report this order (${observed.reason}).`,
        }),
      );
      return;
    }

    const applied = applyCommerceOrderStatusV1({ order: record.order, observation: observed.status, now });
    // A reading the state machine refuses is a reconciliation signal, so the
    // stored order stands and the proof is still built from it.
    const order = applied.ok ? { ...applied.order, invoice: record.order.invoice, estimate: record.order.estimate } : record.order;
    const proofResult = buildCommerceRouteProofV1({
      order,
      observation: observed.status,
      evidenceSetHash: ZERO_HASH_V1,
      now,
    });
    if (!proofResult.ok) {
      res.json(
        CommerceOrderStatusResponseV1Schema.parse({
          outcome: 'provider_unavailable',
          reason: `The order status could not be reconciled (${proofResult.reason}).`,
        }),
      );
      return;
    }

    const providerStatus = commerceProviderStatusFromProofV1(proofResult.proof);
    if (applied.ok) {
      await repository.updateCommerceOrderStatus({
        orderId: record.id,
        userId: user.id,
        status: order.status,
        providerStatus,
        order,
      });
    }
    await repository.appendCommerceOrderEvent(record.id, user.id, {
      schemaVersion: 'commerce-order-event/v1',
      invoiceId,
      status: providerStatus,
      paymentState: order.paymentState,
      deliveryState: order.deliveryState,
      detail: null,
      observedAt: observed.status.observedAt,
    });
    await repository.upsertCommerceProof(record.id, user.id, proofResult.proof);

    const events = await repository.listCommerceOrderEvents(record.id, user.id);
    res.json(
      CommerceOrderStatusResponseV1Schema.parse({
        outcome: 'status',
        orderId: record.id,
        order,
        proof: proofResult.proof,
        providerStatus,
        events,
      }),
    );
  } catch (cause) {
    logger.error('Commerce reconcile failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'commerce_reconcile_failed', code: 'commerce_reconcile_failed' });
  }
});

/** The provider status implied by a proof. Derived from the legs, so it can
 * never claim more than the proof does. */
function commerceProviderStatusFromProofV1(proof: CommerceRouteProofV1): CommerceProviderStatusV1 {
  switch (proof.finalStatus) {
    case 'delivered':
      return 'delivered';
    case 'partial_delivery':
      return 'delivery_pending';
    case 'order_unconfirmed':
      // Paid, no order. NOT 'order_confirmed' and NOT 'delivered'.
      return 'payment_settled';
    case 'payment_failed':
      return 'expired';
    case 'failed':
      return 'cancelled';
    case 'reconciliation_required':
      return 'unknown';
    default:
      return proof.payment.state === 'settled' ? 'payment_settled' : 'payment_pending';
  }
}

routeIntelligenceRouter.get('/commerce/history', async (req, res) => {
  const user = commerceReadGuardV1(req, res);
  if (!user) return;
  if (!(await commerceStorageReady(res))) return;
  try {
    const rawLimit = Number.parseInt(String(req.query.limit ?? '20'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 20;
    const items = await commerceRouteRuntime.repository().listCommerceHistory(user.id, limit);
    res.json(CommerceHistoryResponseV1Schema.parse({ items }));
  } catch (cause) {
    logger.error('Commerce history failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'commerce_history_failed', code: 'commerce_history_failed' });
  }
});

// ===========================================================================
// T64.3 — the Commerce payment rail.
//
// prepare → approve → submission, then an onchain proof and a provider
// reconciliation that are DELIBERATELY separate ladders. The server builds the
// call, re-reads the invoice immediately before doing so, and hands back an
// UNSIGNED payload. It never signs, never broadcasts, never uses a Spend
// Permission, and never spends the Intelligence Budget on the purchase itself.
// ===========================================================================

/** The provider order read. A seam so tests never touch the network, and so
 * redemption material has exactly one entry point into the process. */
export const commerceDeliveryRuntime = {
  readOrder: async (_input: { orderId: string }): Promise<unknown> => null,
};

export const commercePaymentRuntime = {
  /** Re-reads the invoice from the provider immediately before a Blueprint. */
  readInvoiceDetail: (input: { invoiceId: string; now: Date }) =>
    resolveCommerceOrderGatewayV1().readOrderStatus(input),
  receipts: (): CommerceReceiptReaderV1 => resolveCommerceReceiptReaderV1(),
  now: () => new Date(),
};

/** Loads the durable order with its confirmed invoice, tenant-scoped. */
async function commercePaymentContextV1(
  res: Response,
  userId: string,
  orderId: string,
): Promise<{ repository: CommerceStorageRepository; record: CommerceOrderRecordV1 } | null> {
  const repository = commerceRouteRuntime.repository();
  const record = await repository.getCommerceOrder(orderId, userId);
  if (!record || !record.order || !record.order.invoice) {
    res.status(404).json({ error: 'commerce_order_not_found', code: 'commerce_order_not_found' });
    return null;
  }
  return { repository, record };
}

function commerceExecutionGateV1(res: Response): boolean {
  if (commerceRouteRuntime.flags(process.env).commerceExecutionV1) return true;
  res.status(404).json({ error: 'commerce_execution_disabled', code: 'commerce_execution_disabled' });
  return false;
}

routeIntelligenceRouter.post('/commerce/orders/:orderId/payment/prepare', async (req, res) => {
  // The execution gate comes FIRST: a disabled surface must not reveal
  // anything about whether the body would have been accepted.
  if (!commerceExecutionGateV1(res)) return;
  const guard = commerceRouteGuard(req, res, CommercePaymentPrepareRequestV1Schema, 'invalid_commerce_payment_request');
  if (!guard) return;
  if (!(await commerceStorageReady(res))) return;
  try {
    const orderId = String(req.params.orderId ?? '');
    const context = await commercePaymentContextV1(res, guard.user.id, orderId);
    if (!context) return;
    const { repository, record } = context;
    const order = record.order as CommerceOrderV1;
    const invoice = order.invoice as NonNullable<CommerceOrderV1['invoice']>;
    const now = commercePaymentRuntime.now();

    const run = await repository.getCommerceRouteRun(record.routeRunId, guard.user.id);
    const candidates = run ? await repository.listCommerceCandidates(run.id, guard.user.id) : [];
    const candidate = candidates.find((entry) => entry.candidateHash === record.candidateHash);
    if (!run || !candidate) {
      res.json(
        CommercePaymentPrepareResponseV1Schema.parse({
          outcome: 'blocked',
          reason: 'The stored comparison for this order is no longer available.',
          safety: null,
        }),
      );
      return;
    }

    // §2 — the invoice is re-read from the provider RIGHT BEFORE the Blueprint.
    const fresh = await commercePaymentRuntime.readInvoiceDetail({ invoiceId: invoice.invoiceId, now });
    if (!fresh.ok) {
      res.json(
        CommercePaymentPrepareResponseV1Schema.parse({
          outcome: 'blocked',
          reason: `The storefront could not confirm the invoice (${fresh.reason}).`,
          safety: null,
        }),
      );
      return;
    }
    const revalidated = revalidateCommerceInvoiceV1({
      fresh: {
        invoiceId: fresh.status.invoiceId,
        paymentStatus: fresh.status.paymentSettled ? 'paid' : 'unpaid',
        method: 'usdc_base',
        currency: 'USDC',
        amountAtomic: invoice.amountAtomic,
        recipient: invoice.payTo,
        expiresAt: invoice.expiresAt,
      },
      persisted: invoice,
      order,
      intent: run.intent,
      candidate,
      authenticatedWallet: guard.user.address,
      now,
    });
    if (!revalidated.ok) {
      // A changed invoice STOPS here. No replacement is opened automatically.
      if (revalidated.reason === 'invoice_changed' || revalidated.reason === 'invoice_expired') {
        res.json(
          CommercePaymentPrepareResponseV1Schema.parse({
            outcome: revalidated.reason,
            reason: revalidated.detail,
          }),
        );
        return;
      }
      res.json(
        CommercePaymentPrepareResponseV1Schema.parse({
          outcome: 'blocked',
          reason: revalidated.detail,
          safety: null,
        }),
      );
      return;
    }

    const built = buildCommercePaymentBlueprintV1({
      order,
      orderId: record.id,
      invoice,
      intent: run.intent,
      candidate,
      routeCardHash: record.routeCardHash as `0x${string}`,
      authenticatedWallet: guard.user.address,
      now,
    });
    if (!built.ok) {
      res.json(
        CommercePaymentPrepareResponseV1Schema.parse({
          outcome: 'blocked',
          reason: built.reason,
          safety: built.safety,
        }),
      );
      return;
    }
    // One Blueprint per order: a repeat returns the existing one, so a second
    // wallet prompt cannot be opened for the same money.
    const stored = await repository.upsertCommercePaymentBlueprint({
      orderId: record.id,
      userId: guard.user.id,
      walletAddress: guard.user.address,
      blueprint: built.blueprint,
    });
    const gate = commercePaymentSignableV1(stored.blueprint, now);
    res.json(
      CommercePaymentPrepareResponseV1Schema.parse({
        outcome: 'prepared',
        blueprint: stored.blueprint,
        safety: built.safety,
        signable: gate.signable,
        signableReason: gate.reason,
      }),
    );
  } catch (cause) {
    logger.error('Commerce payment prepare failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'commerce_payment_prepare_failed', code: 'commerce_payment_prepare_failed' });
  }
});

routeIntelligenceRouter.post('/commerce/orders/:orderId/payment/approve', async (req, res) => {
  // The execution gate comes FIRST: a disabled surface must not reveal
  // anything about whether the body would have been accepted.
  if (!commerceExecutionGateV1(res)) return;
  const guard = commerceRouteGuard(req, res, CommercePaymentApproveRequestV1Schema, 'invalid_commerce_payment_request');
  if (!guard) return;
  if (!(await commerceStorageReady(res))) return;
  try {
    const orderId = String(req.params.orderId ?? '');
    const repository = commerceRouteRuntime.repository();
    const stored = await repository.getCommercePaymentBlueprint(orderId, guard.user.id);
    if (!stored || stored.blueprint.blueprintHash !== guard.body.blueprintHash) {
      res.json(
        CommercePaymentApproveResponseV1Schema.parse({
          outcome: 'blocked',
          reason: 'No prepared payment matches that Blueprint for this wallet.',
          safety: null,
        }),
      );
      return;
    }
    const context = await commercePaymentContextV1(res, guard.user.id, orderId);
    if (!context) return;
    const now = commercePaymentRuntime.now();
    const run = await repository.getCommerceRouteRun(context.record.routeRunId, guard.user.id);
    const invoice = (context.record.order as CommerceOrderV1).invoice;
    if (!run || !invoice) {
      res.json(
        CommercePaymentApproveResponseV1Schema.parse({
          outcome: 'blocked',
          reason: 'The stored order for this payment is incomplete.',
          safety: null,
        }),
      );
      return;
    }

    // The kernel runs AGAIN at approve time, over the STORED calls.
    const safety = commercePaymentSafetyKernelV1({
      calls: stored.blueprint.calls,
      invoice,
      authenticatedWallet: guard.user.address,
      intent: run.intent,
      now,
    });
    if (safety.verdict === 'blocked') {
      res.json(
        CommercePaymentApproveResponseV1Schema.parse({
          outcome: 'blocked',
          reason: safety.blockedReason ?? 'The payment was blocked at approval.',
          safety,
        }),
      );
      return;
    }
    const gate = commercePaymentSignableV1(stored.blueprint, now);
    if (!gate.signable) {
      res.json(
        CommercePaymentApproveResponseV1Schema.parse({
          outcome: 'blocked',
          reason: gate.reason ?? 'This payment is not offered for signing.',
          safety,
        }),
      );
      return;
    }

    const approved = {
      ...stored.blueprint,
      status: 'approved' as const,
      approvedCallsHash: stored.blueprint.callsHash,
      updatedAt: now.toISOString(),
    };
    await repository.updateCommercePaymentBlueprint({ orderId, userId: guard.user.id, blueprint: approved });
    const call = approved.calls[0];
    res.json(
      CommercePaymentApproveResponseV1Schema.parse({
        outcome: 'approved',
        payload: {
          blueprintHash: approved.blueprintHash,
          approvedCallsHash: approved.callsHash,
          chainId: '0x2105',
          from: guard.user.address,
          // UNSIGNED. The wallet executes it; this server cannot.
          calls: [{ to: call.to, value: '0x0', data: call.data }],
        },
        safety,
      }),
    );
  } catch (cause) {
    logger.error('Commerce payment approve failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'commerce_payment_approve_failed', code: 'commerce_payment_approve_failed' });
  }
});

routeIntelligenceRouter.post('/commerce/orders/:orderId/payment/submission', async (req, res) => {
  // The execution gate comes FIRST: a disabled surface must not reveal
  // anything about whether the body would have been accepted.
  if (!commerceExecutionGateV1(res)) return;
  const guard = commerceRouteGuard(
    req,
    res,
    CommercePaymentSubmissionRequestV1Schema,
    'invalid_commerce_payment_request',
  );
  if (!guard) return;
  if (!(await commerceStorageReady(res))) return;
  try {
    const orderId = String(req.params.orderId ?? '');
    const repository = commerceRouteRuntime.repository();
    const stored = await repository.getCommercePaymentBlueprint(orderId, guard.user.id);
    if (!stored) {
      res.json(
        CommercePaymentSubmissionResponseV1Schema.parse({
          outcome: 'blocked',
          reason: 'No prepared payment exists for this order.',
        }),
      );
      return;
    }
    if (
      stored.blueprint.blueprintHash !== guard.body.blueprintHash ||
      stored.blueprint.callsHash !== guard.body.approvedCallsHash
    ) {
      // A replay against different calls is refused outright.
      res.json(
        CommercePaymentSubmissionResponseV1Schema.parse({
          outcome: 'conflict',
          reason: 'This submission does not match the approved payment.',
        }),
      );
      return;
    }
    if (guard.body.walletStatus === 'cancelled') {
      res.json(
        CommercePaymentSubmissionResponseV1Schema.parse({
          outcome: 'cancelled',
          reason: 'The wallet cancelled this payment. Nothing was sent.',
        }),
      );
      return;
    }
    // A repeat that names a DIFFERENT transaction is a conflict, not a second
    // payment; a repeat that names the same one is idempotent.
    if (stored.transactionHash && guard.body.transactionHash && stored.transactionHash !== guard.body.transactionHash) {
      res.json(
        CommercePaymentSubmissionResponseV1Schema.parse({
          outcome: 'conflict',
          reason: 'A different transaction is already recorded for this payment.',
        }),
      );
      return;
    }

    const now = commercePaymentRuntime.now();
    const submitted = {
      ...stored.blueprint,
      status: 'submitted' as const,
      approvedCallsHash: stored.blueprint.callsHash,
      updatedAt: now.toISOString(),
    };
    const record = await repository.updateCommercePaymentBlueprint({
      orderId,
      userId: guard.user.id,
      blueprint: submitted,
      submissionBatchId: guard.body.batchId,
      transactionHash: guard.body.transactionHash,
      providerProgress: 'payment_submitted',
    });
    res.json(
      CommercePaymentSubmissionResponseV1Schema.parse({
        outcome: 'recorded',
        status: {
          blueprintStatus: record.blueprint.status,
          progress: record.providerProgress,
          onchain: record.onchainState,
          transactionHash: record.transactionHash as `0x${string}` | null,
          delivery: record.deliveryRecord,
        },
      }),
    );
  } catch (cause) {
    logger.error('Commerce payment submission failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'commerce_payment_submission_failed', code: 'commerce_payment_submission_failed' });
  }
});

routeIntelligenceRouter.get('/commerce/orders/:orderId/delivery', async (req, res) => {
  const user = commerceReadGuardV1(req, res);
  if (!user) return;
  if (!(await commerceStorageReady(res))) return;
  // Redemption material must never be cached by a browser, a proxy, or a CDN.
  for (const [header, value] of Object.entries(COMMERCE_DELIVERY_HEADERS_V1)) res.setHeader(header, value);
  try {
    const orderId = String(req.params.orderId ?? '');
    const repository = commerceRouteRuntime.repository();
    const record = await repository.getCommerceOrder(orderId, user.id);
    // Tenant-scoped: another wallet gets `unknown_order`, not a 403 that would
    // confirm the order exists.
    if (!record || !record.order) {
      res.json(
        CommerceDeliveryResponseV1Schema.parse({
          outcome: 'unknown_order',
          reason: 'This wallet has no delivered order with that id.',
        }),
      );
      return;
    }
    const payment = await repository.getCommercePaymentBlueprint(orderId, user.id);
    // Only after the PROVIDER confirms delivery — an onchain payment is not
    // enough, and neither is a confirmed order.
    if (!payment || payment.providerProgress !== 'delivered') {
      res.json(
        CommerceDeliveryResponseV1Schema.parse({
          outcome: 'not_delivered',
          reason: 'The storefront has not confirmed delivery for this order yet.',
        }),
      );
      return;
    }
    const providerOrderId = record.order.items[0]?.orderId;
    if (!providerOrderId) {
      res.json(
        CommerceDeliveryResponseV1Schema.parse({
          outcome: 'not_delivered',
          reason: 'The storefront has confirmed no order id for this purchase yet.',
        }),
      );
      return;
    }
    const fetched = await commerceDeliveryRuntime.readOrder({ orderId: providerOrderId });
    const read = readCommerceDeliveryV1({
      order: fetched,
      orderStatus: 'delivered',
      now: commercePaymentRuntime.now(),
    });
    if (!read.ok || !read.secret || !read.record.redemptionAvailable) {
      res.json(
        CommerceDeliveryResponseV1Schema.parse({
          outcome: 'not_delivered',
          reason: 'The storefront returned no redemption material for this order.',
        }),
      );
      return;
    }
    // The RECORD is persisted; the secret is returned once and forgotten.
    await repository.updateCommercePaymentBlueprint({
      orderId,
      userId: user.id,
      blueprint: payment.blueprint,
      deliveryRecord: read.record,
    });
    res.json(
      CommerceDeliveryResponseV1Schema.parse({
        outcome: 'delivered',
        orderId,
        deliveryObservedAt: read.record.deliveryObservedAt as string,
        fields: read.secret.fields,
      }),
    );
  } catch (cause) {
    logger.error('Commerce delivery failed', safeFailureMetaV1(cause));
    res.status(500).json({ error: 'commerce_delivery_failed', code: 'commerce_delivery_failed' });
  }
});

// T65.1 — the NFT purchase rail lives in its own module and mounts on this
// router, so it appears under /api/route-intelligence wherever this router is
// mounted without another 500 lines in this file.
routeIntelligenceRouter.use(nftRouteIntelligenceRouter);
routeIntelligenceRouter.use(aiRouteIntelligenceRouter);
// T67C: the B20 Control rail. Read-only throughout — it mounts no route that
// prepares, approves or submits anything.
routeIntelligenceRouter.use(b20ControlRouter);
// Phase 3 RWA dossier: read-only, address-first and deterministic. It mounts
// no quote, prepare, approval or wallet route.
routeIntelligenceRouter.use(rwaDossierRouter);
routeIntelligenceRouter.use(rwaDiscoverRouter);
routeIntelligenceRouter.use(rwaInvestigateRouter);
// T67C.2: submission recovery. It mounts here so swap, earn and NFT share one
// recovery rail rather than growing one each — and it sends nothing: the only
// writes it makes are to the attempt table.
routeIntelligenceRouter.use(submissionRecoveryRouter);
// T67C.2: the OWNER half of public proof links. The visitor half is mounted
// outside the tenant middleware — see routes/index.ts — because a proof only
// its owner can read is not a proof anybody else can check.
routeIntelligenceRouter.use(publicProofOwnerRouter);

// ---------------------------------------------------------------------------
// Connected Intelligence 2 — plan and prepare ONE confirmed stock action.
//
// The whole of the ordinary path, entered one step later. The resolver returns
// an intent that was built from an address at the review boundary, so nothing
// here re-derives an identity from words; after that the run, the adapters, the
// engine, the card, the composer and the Safety Kernel are the same objects the
// web console uses. That is what keeps a stock action from becoming a second
// execution path.
// ---------------------------------------------------------------------------

export async function prepareStockActionBlueprintV1(input: {
  intent: RouteIntentV1;
  tenantId: string;
  walletAddress: `0x${string}`;
  requestId: string;
  now: Date;
}): Promise<TransactionPreparationResultV1> {
  const planned = await routePlanRouteRuntime.coordinate(
    {
      tenantId: input.tenantId,
      walletAddress: input.walletAddress,
      // Miorail's own sentence, built from an address. It is what the run
      // records; a user's chat words never reach this path.
      message: `Confirmed Miorail stock action for ${input.intent.toAsset?.address ?? 'an exact address'}`,
      requestId: input.requestId,
      now: input.now,
    },
    // Deterministic: no model, no extraction, no clarification. The intent was
    // established at the review boundary the user confirmed.
    async () => ({
      outcome: 'ready' as const,
      routeIntent: input.intent,
      clarification: null,
      issues: [],
      pendingIntent: null,
    }),
  );

  // A deterministic intent cannot need clarification and cannot be rejected —
  // it was built from an address, not from words. Anything but `evaluated`
  // means the ROUTE was not found, which is an honest market answer.
  if (planned.outcome !== 'evaluated' || !planned.routeCard) {
    return {
      outcome: 'unsupported',
      reason: 'unsupported_pair',
      detail:
        'No reviewed source returned a route for this exact confirmed question. That is the market answering at this size, not a Miorail failure.',
    };
  }

  // The card's OWN recommendation, never a choice made here. Which candidate a
  // card recommends is the engine's decision and it is already made and
  // reasoned; selecting a different one at this point would be a second
  // ranking that nobody reviewed.
  return swapPrepareRouteRuntime.prepare({
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    routeRunId: planned.routeRunId,
    routeCardHash: planned.routeCard.routeCardHash,
    selectedCandidateHash: planned.routeCard.recommendedCandidate.candidateHash,
    requestId: input.requestId,
    now: input.now,
  });
}
