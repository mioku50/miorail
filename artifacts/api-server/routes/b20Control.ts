import { Router, type NextFunction, type Request, type Response } from 'express';
import { createX402MiddlewareFromEnv } from '@mioagent/x402-gateway';
import {
  paidB20SimulationEnabledV1,
  resolvePaidB20SimulationPricingV1,
} from '../lib/paidIntelligenceConfig.js';
import { logger } from '@mioagent/utils';
import { createLlmProvider, createStructuredLlmProvider, type LlmProvider } from '@mioagent/llm';
import { safeZodIssuesV1 } from '../lib/safeZodIssues.js';
import {
  B20InspectRequestV1Schema,
  B20InspectResponseV1Schema,
  B20WatchRequestV1Schema,
  B20WatchResponseV1Schema,
  B20WatchlistAddRequestV1Schema,
  B20WatchlistResponseV1Schema,
  B20ExitCheckRequestV1Schema,
  B20ExitCheckResponseV1Schema,
  B20OpportunitySimulateRequestV1Schema,
  B20OpportunitySimulateResponseV1Schema,
  B20EntryPrepareRequestV1Schema,
  B20EntryPrepareResponseV1Schema,
  B20EntryPlanResponseV1Schema,
  B20EntryBeginSubmissionRequestV1Schema,
  B20EntryBeginSubmissionResponseV1Schema,
  B20EntryRecordSubmissionRequestV1Schema,
  B20EntryReconcileSubmissionRequestV1Schema,
  B20EntryStatusResponseV1Schema,
  B20OpportunityFeedResponseV1Schema,
  B20UniverseSummaryV1Schema,
  B20OpportunityDetailResponseV1Schema,
  B20MarketRailsResponseV1Schema,
  B20ConsoleAskRequestV1Schema,
  B20LaunchContextResponseV1Schema,
  B20ConsoleAskResponseV1Schema,
  B20CopilotAskRequestV1Schema,
  B20CopilotAskResponseV1Schema,
} from '@mioagent/api-zod';
import {
  B20RequestError,
  createB20ReaderV1,
  diffB20SnapshotsV1,
  exitControlsFromSnapshotV1,
  b20BalanceOfCalldataV1,
  b20DecimalsFromSnapshotV1,
  decodeB20BalanceV1,
  inspectB20TokenV1,
  detectB20IdentityV1,
  decodeB20CreatedV1,
  buildB20CardV1,
  isWellFormedAddressV1,
  refusalDetailV1,
  validateB20InspectRequestV1,
  b20TokenIndexStandingV1,
  B20_CHAIN_ID_V1,
  type B20ControlSnapshotV1,
  type B20ControlWatchV1,
  type B20DetectionOutcomeV1,
  type B20ReaderV1,
} from '@mioagent/b20-control';
import {
  RouteStorageConflictError,
  RouteStorageIntegrityError,
  createDatabaseB20StorageRepository,
  createDatabaseB20WatchlistRepository,
  createDatabaseB20ClearanceRepository,
  createDatabaseB20EntryPlanRepository,
  createDatabaseB20EntrySubmissionRepository,
  createDatabaseB20EntryRouteProofRepository,
  b20EntryReviewV1,
  entryExecutionAvailableV1,
  type B20EntryExecutionCapabilitiesV1,
  type B20EntrySubmissionRepositoryV1,
  type B20EntryRouteProofRepositoryV1,
  type B20ClearanceRepositoryV1,
  type B20EntryPlanRepositoryV1,
  type B20PreparedEntryPlanV1,
  b20SweepOutcomeFromDetectionV1,
  b20WatchlistIdV1,
  B20_WATCHLIST_CAPACITY_V1,
  type B20StorageRepositoryV1,
  type B20WatchlistEntryV1,
  type B20WatchlistRepositoryV1,
  createDatabaseB20ObservationRepository,
  createDatabaseB20LaunchDeployerRepository,
  createDatabaseB20ProjectRepository,
  createDatabaseB20LaunchBuyersRepository,
  createDatabaseB20LaunchPoolRepository,
  createDatabaseB20DiscoverRepository,
  B20_DISCOVER_LANE_V1,
  storedLaunchFromDecodedV1,
  decodeFeedCursorV1,
  encodeFeedCursorV1,
  type B20ObservationRepositoryV1,
  type B20LaunchDeployerRepositoryV1,
  type B20ProjectRepositoryV1,
  type B20ProjectRecordV1,
  type B20FeedRowV1,
  type B20OpportunityObservationV1,
  type B20LaunchBuyersRepositoryV1,
  type B20LaunchPoolRepositoryV1,
} from '@mioagent/route-storage';
import { client } from '@mioagent/db';
import { stableHashV1 } from '@mioagent/route-domain';
import { createViemBaseReceiptReader } from '../lib/baseReceiptReader.js';
import { reconcileB20EntryFromBaseV1 } from '../lib/b20EntryChainReconciler.js';
import {
  B20SuppliedDomainRefusedError,
  b20PublicContextSearchFromEnv,
  readB20PublicContextV1,
} from '../lib/b20PublicContextRead.js';
import {
  OPPORTUNITY_QUOTE_ASSET_V1,
  type B20PipelineStatusV1,
  b20OpportunityCardV1,
  b20LaunchBuyerWindowV1,
  type B20OpportunityCardV1,
  b20PipelineCopyV1,
  exitCapacityLeadersV1,
  measuredMoversV1,
  moversCollectingHistoryV1,
  MEASURED_MOVE_LABEL_V1,
  MEASURED_MOVE_NOTE_V1,
  MEASURED_MOVE_BASELINE_AGE_MS_V1,
  MEASURED_MOVE_BASELINE_TOLERANCE_MS_V1,
  b20PipelineStatusV1,
  profileRefusalV1,
  B20_STANDING_GROUPS_V1,
  B20_STANDING_GROUP_COPY_V1,
  B20_EXIT_STANDING_KINDS_V1,
  b20CardStandingGroupV1,
  b20ExitStandingV1,
  b20StandingGroupV1,
  b20LaunchContextV1,
  b20ProjectFilterMatchesV1,
  B20_PROJECT_FILTERS_V1,
  type B20ProjectFilterV1,
  b20ClaimStandingV1,
  b20FundamentalProfileFromStoredV1,
  B20_FUNDAMENTAL_PREDICATE_RULES_V1,
  b20PredicateMatchesProfileV1,
  type B20FundamentalPredicateV1,
  type B20FundamentalProfileV1,
  b20SenderRelationV1,
  b20SenderSupportsCountingV1,
  type B20DeployerCorpusV1,
  type B20DeployerReadingV1,
  type B20LaunchContextV1 as B20LaunchContextModelV1,
  type B20PublicContextV1,
  type B20StandingGroupV1,
} from '@mioagent/opportunity-rail';
import {
  AERODROME_USDC_V1,
  B20_BUYER_WINDOW_BLOCKS_V1,
  V4QuoteUnavailableError,
  createAerodromeReaderV1,
  type B20PoolV1,
} from '@mioagent/swap-adapters';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import { analyseExitV1, analyseV4ExitV1 } from '../lib/exitAnalysis.js';
import { runOpportunityV1 } from '../lib/opportunityRunner.js';
import { buildClearanceV1 } from '../lib/opportunityClearance.js';
import { prepareB20EntryV1 } from '../lib/b20EntryRunner.js';
import { buildPreparedPlanV1 } from '../lib/b20EntryPlanStore.js';
import {
  SUBMIT_REFUSAL_COPY_V1,
  attemptHoldsPlanSlotV1,
  entryWalletPayloadV1,
  submitGateRefusalV1,
  type EntryWalletPayloadV1,
} from '../lib/b20EntrySubmitGate.js';
import {
  entryStatusViewV1,
  openAttemptV1,
  recordWalletReportV1,
  type WalletReportV1,
} from '../lib/b20EntrySubmitRunner.js';
import {
  b20EntryProofSummaryV1,
  ensureB20EntryRouteProofV1,
  syncB20EntryRouteProofV1,
} from '../lib/b20EntryRouteProof.js';
// Imported for the TYPE, and for the `express-session` augmentation that comes
// with it. `req.session.user` below reads as `any` without it — this file was
// relying on the augmentation being loaded by whatever else the api-server
// program happened to compile, which held only inside that one tsconfig.
import type { TenantUser } from '../middleware/tenantAuth.js';
import { answerB20CopilotV1, b20ObservationRefMatchesV1 } from '../lib/b20Copilot.js';
import { narrateB20AnswerV1 } from '../lib/b20Answer.js';
import { planB20AnswerV1 } from '../lib/b20AnswerPlan.js';
import { b20ScopeIsPrivateV1, type B20ConsolePlanV1 } from '../lib/b20ConsolePlan.js';
import { resolveB20ConsolePlanV1 } from '../lib/b20ConsoleIntent.js';
import {
  B20_CONSOLE_BASE_CAVEATS_V1,
  b20ChangesAnswerV1,
  b20ExploreAnswerV1,
  b20FundamentalAnswerV1,
  b20InvestigateAnswerV1,
  b20NeedsEvidenceAnswerV1,
  b20PortfolioAnswerV1,
  b20PossiblePublicContextAnswerV1,
  b20ResearchCandidatesAnswerV1,
  type B20ReadingAttemptV1,
  type B20ConsoleDeterministicV1,
  type B20ConsoleProjectMatchV1,
  type B20ConsoleTokenReadV1,
} from '../lib/b20ConsoleAnswer.js';
import { referenceExitAssessmentV1, type B20ExitAssessmentV1 } from '../lib/b20ExitAssessment.js';
import {
  b20ObservationNeedsRefreshV1,
  b20TargetedMeasureBudgetMsV1,
  measureB20TokenOnDemandV1,
  B20_TARGETED_MEASURE_MAX_PER_REQUEST_V1,
  type B20TargetedMeasureResultV1,
} from '../lib/b20TargetedMeasure.js';
import {
  locateB20LaunchByCodeV1,
  type B20TargetedLaunchLookupV1,
} from '../lib/b20TargetedLaunch.js';
// The measurement pass and its wiring, imported rather than reimplemented. A
// second copy would be a second definition of what an observation is, and the
// first thing to drift would be which block the factory read and the control
// read were anchored at.
import {
  B20_MEASURE_DEFAULTS_V1,
  B20_MEASURE_REFERENCE_PROFILE_V1,
} from '../../../scripts/b20MeasureCli.js';
import {
  B20_NATIVE_POSITION_ATOMIC_V1,
  createB20MeasureDepsV1,
} from '../../../scripts/b20MeasureDeps.js';
import { createB20PoolStoreV1 } from '../../../scripts/b20PoolStore.js';

// ---------------------------------------------------------------------------
// T67C/T68F — the B20 Control and explicit entry rail.
//
// Inspection, watching and discovery remain read-only. Entry is a separate,
// explicit path: the server prepares and simulates exact calls, the client
// asks the Base Account for approval, and this server only reads Base receipts
// to reconcile the outcome into a canonical Route Proof. It never signs or
// broadcasts.
//
// Idempotency is per tenant + token + BLOCK. Two inspections in the same block
// are the same fact, so the second one reads the stored row instead of writing
// a second. Inside the TTL, a repeat request does not even re-read the chain —
// and the response says `cached: true`, because a snapshot from four blocks
// ago is a different claim from a current one and the user should be able to
// tell which they are looking at.
// ---------------------------------------------------------------------------

export const b20ControlRouter = Router();

/** The Base mainnet endpoint, resolved the way every other onchain read in
 * this server resolves it. Empty means the routes answer 503 rather than
 * guessing. */
function baseMainnetRpcUrlV1(): string {
  return (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
}

function ttlMsV1(): number {
  const raw = Number.parseInt((process.env.MIORAIL_B20_CONTROL_TTL_MS ?? '').trim(), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

/**
 * T67F — the sweep's own TTL, deliberately much longer than a single
 * inspection's.
 *
 * A sweep is up to 25 tokens, each several `eth_call`s, and it runs whenever
 * someone opens a page. Reusing the 30-second inspection TTL would turn a page
 * refresh into 250 metered calls. A control change does not need
 * thirty-second resolution: the thing being watched changes on the order of
 * hours, and the page states the age of what it read.
 */
function watchTtlMsV1(): number {
  const raw = Number.parseInt((process.env.MIORAIL_B20_WATCH_TTL_MS ?? '').trim(), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 300_000;
}

/**
 * How long a sweep may spend before it answers with what it has.
 *
 * A throttled endpoint does not fail — it answers slowly. Measured on
 * 2026-08-02, one full card on `mainnet.base.org` takes ~27 seconds of paced
 * reads, so twenty-five of them would outlive any browser and the caller would
 * see a dead request instead of the tokens that were read.
 *
 * The deadline turns that into a partial answer. Tokens past it are NAMED in
 * `notChecked`, which already means "not reached, which is not the same as
 * unchanged" — the page has said that since the sweep existed.
 */
function watchDeadlineMsV1(): number {
  const raw = Number.parseInt((process.env.MIORAIL_B20_WATCH_DEADLINE_MS ?? '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

export const b20RouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  repository: (): B20StorageRepositoryV1 => createDatabaseB20StorageRepository(client),
  watchlist: (): B20WatchlistRepositoryV1 => createDatabaseB20WatchlistRepository(client),
  clearances: (): B20ClearanceRepositoryV1 => createDatabaseB20ClearanceRepository(client),
  entryPlans: (): B20EntryPlanRepositoryV1 => createDatabaseB20EntryPlanRepository(client),
  entrySubmissions: (): B20EntrySubmissionRepositoryV1 =>
    createDatabaseB20EntrySubmissionRepository(client),
  entryProofs: (): B20EntryRouteProofRepositoryV1 =>
    createDatabaseB20EntryRouteProofRepository(client),
  receiptReader: createViemBaseReceiptReader,
  observations: (): B20ObservationRepositoryV1 => createDatabaseB20ObservationRepository(client),
  discover: () => createDatabaseB20DiscoverRepository(client),
  deployers: (): B20LaunchDeployerRepositoryV1 => createDatabaseB20LaunchDeployerRepository(client),
  projects: (): B20ProjectRepositoryV1 => createDatabaseB20ProjectRepository(client),
  publicContextSearch: b20PublicContextSearchFromEnv,
  publicContextRead: readB20PublicContextV1,
  /** Whether this server has the project-claim tables. A server without 0046
   * serves the same cards with `project: null` rather than failing a read. */
  projectsAvailable: async (): Promise<boolean> => {
    const rows = await client`
      SELECT
        to_regclass('public.b20_project_claims') AS claims,
        to_regclass('public.b20_project_evidence') AS evidence`;
    const row = rows[0];
    return Boolean(row && row.claims && row.evidence);
  },
  /**
   * The narrator, or null when none is configured.
   *
   * A seam rather than a direct call, so a test can hand in a provider that
   * says something wrong and assert that the reader never sees it. Null is an
   * ordinary state: without a provider this rail answers exactly as it did
   * before Stage 06, and `answerSource` says which one the reader got.
   */
  narrator: (): LlmProvider | null => {
    try {
      return createLlmProvider();
    } catch {
      // A misconfigured provider is not a reason to fail a read-only answer.
      return null;
    }
  },
  /** Closed-enum intent classification is separate from evidence narration.
   * This keeps the quick Mistral lane away from user-facing conclusions while
   * the primary lane remains available to explain the already-built fact
   * bundle. */
  classifier: (): LlmProvider | null => {
    try {
      return createStructuredLlmProvider();
    } catch {
      return null;
    }
  },
  launchPools: (): B20LaunchPoolRepositoryV1 => createDatabaseB20LaunchPoolRepository(client),
  /** Launch-window buying, cached per token. A targeted reading needs it for
   * the same reason the worker does: it is what separates "nobody bought" from
   * "people bought and could not sell", and without it an old launch would be
   * measured into the wrong section. */
  launchBuyers: (): B20LaunchBuyersRepositoryV1 => createDatabaseB20LaunchBuyersRepository(client),
  /** Checked separately again: a server without 0028/0029 can still inspect,
   * watch and certify — it simply has no Discover feed, and says so rather
   * than answering with an empty one. */
  discoverAvailable: async (): Promise<boolean> => {
    const rows = await client`
      SELECT
        to_regclass('public.b20_launches') AS launches,
        to_regclass('public.b20_opportunity_observations') AS observations,
        to_regclass('public.b20_discover_cursors') AS cursors`;
    const row = rows[0];
    return Boolean(row && row.launches && row.observations && row.cursors);
  },
  reader: () => createB20ReaderV1({ rpcUrl: baseMainnetRpcUrlV1() }),
  /** The Aerodrome Router, read-only. A separate reader from the B20 one
   * because they speak to different contracts with different decoders — sharing
   * one would mean a change to either could quietly alter the other. */
  aerodromeReader: () => createAerodromeReaderV1({ rpcUrl: baseMainnetRpcUrlV1() }),
  rpcConfigured: () => baseMainnetRpcUrlV1().length > 0,
  ttlMs: ttlMsV1,
  watchTtlMs: watchTtlMsV1,
  watchDeadlineMs: watchDeadlineMsV1,
  /** Wall clock for the sweep deadline, separate from `now` so a test can make
   * a sweep run long without also moving the timestamps on its snapshots. */
  monotonicMs: () => Date.now(),
  migrationAvailable: async (): Promise<boolean> => {
    const rows = await client`
      SELECT
        to_regclass('public.b20_control_snapshots') AS snapshots,
        to_regclass('public.b20_control_evidence') AS evidence
    `;
    const row = rows[0];
    return Boolean(row && row.snapshots && row.evidence);
  },
  /** Checked separately again: a server without migration 0025 can still quote
   * and still watch — it simply cannot certify anything. */
  clearanceAvailable: async (): Promise<boolean> => {
    const rows =
      await client`SELECT to_regclass('public.b20_opportunity_clearances') AS clearances`;
    return Boolean(rows[0]?.clearances);
  },
  /** Checked separately again: a server without migration 0026 can still
   * certify and still prepare — it simply cannot store what it prepared, and
   * says so rather than handing back an unstored plan. */
  /** T68F-B 1 - availability is a fact about this SURFACE, never an inference
   * from a plan holding unsigned calls. */
  executionCapabilities: async (): Promise<B20EntryExecutionCapabilitiesV1> => {
    const rows = await client`SELECT
      to_regclass('public.b20_entry_submissions') AS submissions,
      to_regclass('public.b20_entry_route_proofs') AS proofs,
      to_regclass('public.b20_entry_route_proof_events') AS proof_events`;
    const wired = Boolean(rows[0]?.submissions);
    const proofWired = Boolean(rows[0]?.proofs && rows[0]?.proof_events);
    return {
      submissionRouteWired: wired,
      walletIntegrationWired: wired,
      reconciliationWired: wired && baseMainnetRpcUrlV1().length > 0,
      routeProofWired: proofWired,
    };
  },
  entryPlanAvailable: async (): Promise<boolean> => {
    const rows = await client`
      SELECT
        to_regclass('public.b20_entry_plans') AS plans,
        to_regclass('public.b20_entry_executions') AS executions`;
    const row = rows[0];
    return Boolean(row && row.plans && row.executions);
  },
  /**
   * One targeted reading, injected for the same reason `runOpportunity` is: the
   * budgeting, freshness and cap logic around it is the part worth testing, and
   * it must be testable without a chain.
   */
  measureOnDemand: (input: {
    launch: { launchId: string; tokenAddress: string; blockNumber: string };
    budgetMs: number;
  }): Promise<B20TargetedMeasureResultV1> =>
    measureB20TokenOnDemandV1({
      launch: input.launch,
      pass: b20TargetedMeasurePassV1(),
      monotonicMs: b20RouteRuntime.monotonicMs,
      budgetMs: input.budgetMs,
    }),
  locateLaunchOnDemand: (input: {
    tokenAddress: string;
    budgetMs: number;
  }): Promise<B20TargetedLaunchLookupV1> =>
    locateB20LaunchByCodeV1({
      rpcUrl: baseMainnetRpcUrlV1(),
      tokenAddress: input.tokenAddress,
      budgetMs: input.budgetMs,
      monotonicMs: b20RouteRuntime.monotonicMs,
    }),
  /** Injected so a test can run the whole route without a chain or a provider. */
  runOpportunity: runOpportunityV1,
  prepareEntry: prepareB20EntryV1,
  /** Checked separately from the snapshot tables: a server that can inspect
   * but has not run 0024 must keep inspecting rather than 503 the whole tab. */
  watchlistAvailable: async (): Promise<boolean> => {
    const rows = await client`SELECT to_regclass('public.b20_watchlist') AS watchlist`;
    return Boolean(rows[0]?.watchlist);
  },
  now: () => new Date(),
};

function sessionUser(req: Request): TenantUser | null {
  const user = req.session?.user;
  if (
    !user ||
    user.chainId !== 8453 ||
    !/^0x[0-9a-f]{40}$/.test(user.address) ||
    user.id !== `eip155:8453:${user.address}`
  )
    return null;
  return user;
}

/** flag + session — the shared head of both routes. */
function b20Guard(
  req: Request,
  res: Response,
): { user: NonNullable<ReturnType<typeof sessionUser>> } | null {
  const flags = b20RouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1 || !flags.b20ControlV1) {
    res.status(404).json({ error: 'b20_control_disabled', code: 'b20_control_disabled' });
    return null;
  }
  const user = sessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return null;
  }
  return { user };
}

function storageFailure(res: Response, error: unknown, where: string, input?: unknown): void {
  if (error instanceof RouteStorageConflictError) {
    res
      .status(409)
      .json({
        error: 'b20_snapshot_conflict',
        code: 'b20_snapshot_conflict',
        detail: error.message,
      });
    return;
  }
  if (error instanceof RouteStorageIntegrityError) {
    res.status(500).json({ error: 'storage_integrity', code: 'storage_integrity' });
    return;
  }
  // The message is never echoed: an RPC error can carry the endpoint URL, and
  // the endpoint URL can carry the key.
  //
  // T73-LIVE-DB §4 — but `{ where, name: "ZodError" }` was not a diagnosis
  // either. It said a page of launches failed its schema somewhere, which is
  // where every investigation started rather than ended. The issues are
  // extracted as SHAPES — path, code, expected, and a category of what arrived
  // — so the next mismatch is readable from one log line without anybody
  // reproducing it, and without the received values (addresses, hashes, token
  // identities) reaching a log.
  const issues = safeZodIssuesV1(error, input);
  logger.error('B20 control storage failed', {
    where,
    name: error instanceof Error ? error.name : 'unknown',
    ...(issues ? { issues } : {}),
  });
  res.status(500).json({ error: 'storage_unavailable', code: 'storage_unavailable' });
}

/**
 * The console composes storage reads, planning and a response contract. A
 * failure in any of those layers must not be labelled `storage_unavailable`:
 * production did exactly that for two newly-added intents whose Zod enum had
 * drifted, sending a raw infrastructure code to the reader while Postgres was
 * healthy.
 */
function consoleAnswerFailure(res: Response, error: unknown): void {
  const issues = safeZodIssuesV1(error);
  logger.error('B20 console answer failed', {
    where: 'b20-console-ask',
    name: error instanceof Error ? error.name : 'unknown',
    ...(issues ? { issues } : {}),
  });
  res.status(500).json({
    error: 'Miorail could not verify this B20 answer. Please try again.',
    code: 'b20_console_answer_unavailable',
  });
}

function respondV1(
  res: Response,
  snapshot: B20ControlSnapshotV1,
  card: unknown,
  cached: boolean,
  watch: B20ControlWatchV1 | null = null,
): void {
  res.json(
    B20InspectResponseV1Schema.parse({
      snapshotId: snapshot.id,
      status: snapshot.status,
      cached,
      card,
      evidence: snapshot.evidence,
      // T67F — what moved since Miorail last read this token. Absent rather
      // than empty when there is nothing to compare against: an empty change
      // list reads as "nothing changed", which is a different claim from
      // "this is the first time we looked".
      ...(watch ? { watch } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// T69-C §1/§3/§4 — the Discover feed.
//
// Read-only over stored evidence: these two routes touch no endpoint, sign
// nothing, and cannot create a clearance or an entry plan. A background
// observation is DISPLAY CONTEXT. The only path to a qualified clearance runs
// through the wallet-bound simulation that already exists, and nothing here
// shortens it.
//
// The pipeline status is the part that earns its keep. An empty feed has seven
// causes and only one of them is "the chain was quiet"; answering all seven
// with an empty array tells a user the product is working when it is not.
// ---------------------------------------------------------------------------

/** How long a launch stays in the active feed window. Matches the measurement
 * worker's own window, so "awaiting measurement" counts the same launches the
 * worker would actually pick up. */
export const DISCOVER_FEED_WINDOW_MS_V1 = 48 * 60 * 60 * 1000;

export const FEED_STATES_V1 = ['candidate', 'provisional', 'rejected', 'unmeasured'] as const;

/** One projection for every public B20 reader (Discover, MCP, Copilot and the
 * paid seller API). A new card field must never require four hand-maintained
 * translations. */
export function b20DiscoverCardFromRowV1(
  row: B20FeedRowV1,
  pipeline: B20PipelineStatusV1,
  now: Date,
  /** The stored project profile for this token. Undefined on a server without
   * the claim tables, which puts `project: null` on the card — distinct from
   * the unverified profile, which is a real answer. */
  project?: B20FundamentalProfileV1 | null,
) {
  return b20OpportunityCardV1({
    project: project ?? null,
    launch: {
      tokenAddress: row.launch.tokenAddress,
      name: row.launch.name,
      symbol: row.launch.symbol,
      variant: row.launch.variant,
      decimals: row.launch.decimals,
      blockNumber: row.launch.blockNumber,
      transactionHash: row.launch.transactionHash,
      logIndex: row.launch.logIndex,
      detectedAt: row.launch.detectedAt,
      blockTimestamp: row.launch.blockTimestamp,
      canonical: row.launch.canonical,
    },
    observation: row.observation,
    launchBuyers: row.launchBuyers,
    launchBuyerWindow: b20LaunchBuyerWindowV1({
      launchBlock: row.launch.blockNumber,
      observedHead: pipeline.facts.confirmedHead,
      windowBlocks: B20_BUYER_WINDOW_BLOCKS_V1,
      measured: row.launchBuyers !== null,
      measuredToBlock: row.launchBuyers?.toBlock ?? null,
    }),
    now,
  });
}

// ---------------------------------------------------------------------------
// Fundamental Intelligence, on the read path.
//
// The stored rows ARE the findings — they were decided once by a verification
// pass and are re-rendered here through the same copy table, so the API, the
// MCP and the card cannot drift into three readings of one row.
//
// A server without the claim tables answers `undefined` and every card carries
// `project: null`. That is deliberately not the unverified profile: "this
// server does not run the layer" and "nobody has claimed this token" are
// different statements, and only the second is about the token.
// ---------------------------------------------------------------------------

export function b20ProjectProfileFromRecordV1(record: B20ProjectRecordV1): B20FundamentalProfileV1 {
  return b20FundamentalProfileFromStoredV1({
    claim: b20ClaimStandingV1({
      claimantDomain: record.claim.claimantDomain,
      status: record.claim.status,
      verifiedLinks: record.claim.verifiedLinks,
      refutedLinks: record.claim.refutedLinks,
      lastCheckedAt: record.claim.lastCheckedAt,
    }),
    claimantDomain: record.claim.claimantDomain,
    rows: record.evidence.map((row) => ({
      dimension: row.dimension,
      state: row.state,
      provenance: row.provenance,
      reference: row.reference,
      observedAt: row.observedAt,
    })),
  });
}

/** The profile for a token with no claim: the ordinary answer on this chain,
 * and a real one rather than an absence. */
export function b20UnclaimedProjectProfileV1(): B20FundamentalProfileV1 {
  return b20FundamentalProfileFromStoredV1({
    claim: b20ClaimStandingV1(null),
    claimantDomain: null,
    rows: [],
  });
}

/**
 * Profiles for a page of tokens, in one read.
 *
 * Returns null when this server has no claim tables — the caller then leaves
 * `project` off the cards entirely rather than asserting that nothing is
 * claimed.
 */
export async function readB20ProjectProfilesV1(
  tokenAddresses: readonly string[],
): Promise<Map<string, B20FundamentalProfileV1> | null> {
  if (tokenAddresses.length === 0) return new Map();
  // A server without the claim tables, or one whose read failed, answers null —
  // and every card then carries `project: null`. Narrow on purpose: the ONLY
  // thing this swallows is "the layer is not available here", and the caller
  // renders nothing rather than asserting that nobody claimed anything. A feed
  // must not 500 because an optional layer is absent.
  let records: B20ProjectRecordV1[];
  try {
    if (!(await b20RouteRuntime.projectsAvailable())) return null;
    records = await b20RouteRuntime.projects().readProjects({ chainId: 8453, tokenAddresses });
  } catch {
    return null;
  }
  const byToken = new Map<string, B20FundamentalProfileV1>();
  for (const address of tokenAddresses)
    byToken.set(address.toLowerCase(), b20UnclaimedProjectProfileV1());
  for (const record of records) {
    byToken.set(record.claim.tokenAddress.toLowerCase(), b20ProjectProfileFromRecordV1(record));
  }
  return byToken;
}

/**
 * The claimed corpus, matched on one fundamental predicate.
 *
 * Reads in the order the question is actually about:
 *
 *   1. the addresses whose stored evidence satisfies the predicate,
 *   2. their profiles,
 *   3. and only then a launch row, for a symbol and to say whether Discover
 *      has one at all.
 *
 * Step 3 never removes a match. A verified project whose launch Miorail has not
 * ingested is a fact about Miorail's index, and the earlier version of this
 * path dropped exactly that token with a silent `continue` — which would have
 * answered "which B20 have a live product" with "none" while the claim sat
 * verified in the database. Identity, ingestion and measurement are three axes,
 * and only the first one decides this answer.
 *
 * The predicate is re-checked against the rebuilt PROFILE even though the query
 * already filtered. That is not belt-and-braces: `b20FundamentalProfileFromStoredV1`
 * drops every finding when a claim is not verified, so re-checking is the lock
 * that holds even if the query's JOIN were ever written wrongly.
 */
export async function readB20FundamentalMatchesV1(input: {
  predicate?: B20FundamentalPredicateV1;
  predicates?: readonly B20FundamentalPredicateV1[];
  operator?: 'and' | 'or';
  limit: number;
}): Promise<{ matches: B20ConsoleProjectMatchV1[]; corpus: number; available: boolean }> {
  const predicates = input.predicates ?? (input.predicate ? [input.predicate] : []);
  const operator = input.operator ?? 'and';
  if (predicates.length === 0) return { matches: [], corpus: 0, available: false };
  let addresses: string[];
  let corpus: number;
  try {
    if (!(await b20RouteRuntime.projectsAvailable())) {
      return { matches: [], corpus: 0, available: false };
    }
    const projects = b20RouteRuntime.projects();
    corpus = await projects.verifiedClaimCount({ chainId: B20_CHAIN_ID_V1 });
    const sets = await Promise.all(
      predicates.map(async (predicate) => {
        const rule = B20_FUNDAMENTAL_PREDICATE_RULES_V1[predicate];
        // Read up to the corpus, not the answer limit. Intersecting two pages of
        // ten can miss a token that is the 11th result on one side even though
        // it is the first true AND match.
        const readLimit = Math.max(1, corpus);
        const found =
          rule.dimension === null
            ? await projects.verifiedTokenAddresses({ chainId: B20_CHAIN_ID_V1, limit: readLimit })
            : await projects.tokensMatchingEvidence({
                chainId: B20_CHAIN_ID_V1,
                dimension: rule.dimension,
                states: rule.states,
                limit: readLimit,
              });
        return new Set(found.map((address) => address.toLowerCase()));
      }),
    );
    const combined =
      operator === 'or'
        ? new Set(sets.flatMap((set) => [...set]))
        : new Set(
            [...(sets[0] ?? new Set<string>())].filter((address) =>
              sets.every((set) => set.has(address)),
            ),
          );
    addresses = [...combined].sort().slice(0, input.limit);
  } catch {
    // Same narrow swallow as the card read: the ONLY thing this hides is "the
    // layer is not available here", and the answer says so rather than
    // reporting an empty corpus, which would be a claim about the world.
    return { matches: [], corpus: 0, available: false };
  }

  const profiles = await readB20ProjectProfilesV1(addresses);
  if (profiles === null) return { matches: [], corpus, available: false };

  const observations = b20RouteRuntime.observations();
  const matches: B20ConsoleProjectMatchV1[] = [];
  for (const address of addresses) {
    const profile = profiles.get(address.toLowerCase());
    if (!profile) continue;
    const predicateMatches = predicates.map((predicate) =>
      b20PredicateMatchesProfileV1(predicate, profile),
    );
    const qualifies =
      operator === 'or' ? predicateMatches.some(Boolean) : predicateMatches.every(Boolean);
    if (!qualifies) continue;
    let symbol: string | null = null;
    let indexed = false;
    try {
      const found = await observations.getFeedRowForToken({
        tokenAddress: address,
        historyLimit: 1,
      });
      if (found) {
        indexed = true;
        symbol = found.row.launch.symbol;
      }
    } catch {
      // A launch read that failed leaves the match standing with no symbol.
      // The project evidence is what was asked for and it is already in hand.
    }
    matches.push({ tokenAddress: address, symbol, profile, indexed });
  }
  return { matches, corpus, available: true };
}

export async function readB20EvidenceForTokenV1(tokenAddress: string): Promise<{
  card: ReturnType<typeof b20OpportunityCardV1>;
  history: B20OpportunityObservationV1[];
} | null> {
  if (!/^0x[0-9a-f]{40}$/.test(tokenAddress)) return null;
  if (!(await b20RouteRuntime.discoverAvailable())) return null;
  const observations = b20RouteRuntime.observations();
  const now = b20RouteRuntime.now();
  const result = await observations.getFeedRowForToken({ tokenAddress, historyLimit: 12 });
  if (!result) return null;
  const pipeline = await pipelineStatusV1(observations, now, true);
  const profiles = await readB20ProjectProfilesV1([result.row.launch.tokenAddress]);
  return {
    card: b20DiscoverCardFromRowV1(
      result.row,
      pipeline,
      now,
      profiles?.get(result.row.launch.tokenAddress.toLowerCase()) ?? null,
    ),
    history: result.history,
  };
}

/** §1 — the status, assembled from counts the server actually has. */
export async function pipelineStatusV1(
  observations: B20ObservationRepositoryV1,
  now: Date,
  storageAvailable: boolean,
): Promise<B20PipelineStatusV1 & { message: string }> {
  if (!storageAvailable) {
    const status = b20PipelineStatusV1({
      storageAvailable: false,
      ingestionCursorBlock: null,
      confirmedHead: null,
      lastIngestionRunAt: null,
      lastIngestionResult: null,
      lastMeasurementRunAt: null,
      canonicalLaunchCount: 0,
      launchesAwaitingMeasurement: 0,
      observationCount: 0,
      observationsLastRun: null,
      budgetExhausted: false,
      operatorState: null,
      now: now.toISOString(),
    });
    return { ...status, message: b20PipelineCopyV1(status) };
  }
  const counts = await observations.pipelineCounts({
    now: now.toISOString(),
    maxLaunchAgeMs: DISCOVER_FEED_WINDOW_MS_V1,
  });
  const status = b20PipelineStatusV1({
    storageAvailable: true,
    ingestionCursorBlock: counts.ingestionCursorBlock,
    confirmedHead: counts.lastIngestionConfirmedHead,
    lastIngestionRunAt: counts.lastIngestionRunAt,
    lastIngestionResult: counts.lastIngestionResult,
    lastMeasurementRunAt: counts.lastMeasurementRunAt,
    canonicalLaunchCount: counts.canonicalLaunchCount,
    launchesAwaitingMeasurement: counts.launchesAwaitingMeasurement,
    observationCount: counts.observationCount,
    observationsLastRun: counts.observationsLastRun,
    budgetExhausted: counts.lastIngestionBudgetExhausted,
    operatorState: counts.ingestionOperatorState,
    // T73-LIVE §8 — the clock the staleness check runs against. A dead worker
    // used to report `healthy`, because nothing compared the last run to now.
    now: now.toISOString(),
  });
  return { ...status, message: b20PipelineCopyV1(status) };
}

/**
 * T72 §3 — the ONE Discover read.
 *
 * Extracted from the HTTP handler below so the MCP server calls exactly this,
 * rather than assembling its own page from the repository. A second reader
 * would be a second set of filters, a second freshness convention, and
 * eventually a second answer to "is this token worth looking at".
 *
 * Returns the same body the HTTP feed returns, already schema-parsed.
 */
/**
 * One Discover card, by address, through a DIRECT lookup.
 *
 * Extracted because the public MCP had its own answer to this question and the
 * answer was wrong: it read the newest 25 cards and searched the page, so
 * `miorail_get_b20_opportunity` returned `not_in_feed` for any launch outside
 * that page — 33,516 of the 33,541 canonical launches on 2026-08-18. It was
 * proven live against a measured, canonical token whose card the HTTP route
 * returned without difficulty.
 *
 * The project layer is populated here too. The detail route was building the
 * card without it, so reading a token by address quietly dropped its
 * fundamental profile while the list kept it.
 *
 * Null means NO CANONICAL LAUNCH. It is not "not a B20 token": this feed knows
 * what it ingested, and saying more would be a claim nothing measured.
 */
export async function readB20CardForTokenV1(tokenAddress: string): Promise<{
  card: B20OpportunityCardV1;
  history: readonly B20OpportunityObservationV1[];
} | null> {
  const observations = b20RouteRuntime.observations();
  const now = b20RouteRuntime.now();
  const found = await observations.getFeedRowForToken({ tokenAddress, historyLimit: 20 });
  if (!found) return null;
  const pipeline = await pipelineStatusV1(observations, now, true);
  const profiles = await readB20ProjectProfilesV1([found.row.launch.tokenAddress]);
  const card = b20OpportunityCardV1({
    launch: {
      tokenAddress: found.row.launch.tokenAddress,
      name: found.row.launch.name,
      symbol: found.row.launch.symbol,
      variant: found.row.launch.variant,
      decimals: found.row.launch.decimals,
      blockNumber: found.row.launch.blockNumber,
      transactionHash: found.row.launch.transactionHash,
      logIndex: found.row.launch.logIndex,
      detectedAt: found.row.launch.detectedAt,
      blockTimestamp: found.row.launch.blockTimestamp,
      canonical: found.row.launch.canonical,
    },
    observation: found.row.observation,
    launchBuyers: found.row.launchBuyers,
    launchBuyerWindow: b20LaunchBuyerWindowV1({
      launchBlock: found.row.launch.blockNumber,
      observedHead: pipeline.facts.confirmedHead,
      windowBlocks: B20_BUYER_WINDOW_BLOCKS_V1,
      measured: found.row.launchBuyers !== null,
      measuredToBlock: found.row.launchBuyers?.toBlock ?? null,
    }),
    project: profiles?.get(found.row.launch.tokenAddress.toLowerCase()) ?? null,
    now,
  });
  return { card, history: found.history };
}

export async function readDiscoverFeedV1(input: {
  limit: number;
  cursor: string | null;
  state: (typeof FEED_STATES_V1)[number] | 'all';
  freshness: 'fresh' | 'stale' | 'all';
  /** The verdict section, not the measurement state. `all` keeps the feed in
   * launch order and reads exactly one page, as it always has. */
  standing?: B20StandingGroupV1 | 'all';
  /** One exact conclusion rather than its whole section — `bought_not_sellable`
   * and `no_buyers_yet` share no section, but `venue_not_searched` and
   * `venue_not_found` do, and they are different statements. */
  standingKind?: string | null;
  /** Only launches where BOTH directions priced. The one filter that selects
   * for evidence rather than against it. */
  bothRoutes?: boolean;
  /** An upper bound on the measured round trip. A launch whose round trip was
   * never measured is EXCLUDED, not treated as zero. */
  maxRoundTripBps?: number | null;
  /** A lower bound on completed launch-window buying. A window that has not
   * closed has counted nobody, so it is excluded rather than read as zero. */
  minBuyers?: number | null;
  /**
   * Project context, which is a different axis from everything above.
   *
   * Every other filter narrows what was MEASURED about a market. This one
   * narrows by whether a project proved a link to the token — and `unknown` is
   * where almost every launch on this chain belongs, not a failing grade.
   */
  project?: B20ProjectFilterV1;
  maxLaunchAgeMs?: number;
}): Promise<{
  pipeline: B20PipelineStatusV1 & { message: string };
  cards: ReturnType<typeof b20OpportunityCardV1>[];
  nextCursor: string | null;
  serverTime: string;
}> {
  const available = await b20RouteRuntime.discoverAvailable();
  const observations = b20RouteRuntime.observations();
  const now = b20RouteRuntime.now();
  const pipeline = await pipelineStatusV1(observations, now, available);
  const maxLaunchAgeMs = input.maxLaunchAgeMs ?? DISCOVER_FEED_WINDOW_MS_V1;

  if (!available) {
    // An honest empty feed WITH a reason. Never a bare list.
    return { pipeline, cards: [], nextCursor: null, serverTime: now.toISOString() };
  }

  // Freshness is computed against SERVER time, so a client with a skewed clock
  // cannot promote a stale observation into an actionable one.
  const freshEnough = (card: ReturnType<typeof b20OpportunityCardV1>) => {
    if (input.freshness === 'all') return true;
    if (!card.observation) return false;
    return card.observation.freshness === input.freshness;
  };

  const standing = input.standing ?? 'all';
  const standingKind = input.standingKind ?? null;
  const maxRoundTripBps = input.maxRoundTripBps ?? null;
  const minBuyers = input.minBuyers ?? null;
  const bothRoutes = input.bothRoutes === true;

  /**
   * Every filter that cannot be expressed as a SQL predicate over one page.
   *
   * They are applied to the card projection, not to the row, so the answer is
   * the same object a reader will be shown. `maxRoundTripBps` and `minBuyers`
   * both EXCLUDE an unmeasured value rather than treating it as zero: "cheaper
   * than 3%" must not select a launch whose round trip nobody priced, and
   * "at least ten buyers" must not select a window that has not closed.
   */
  const matches = (card: ReturnType<typeof b20OpportunityCardV1>): boolean => {
    if (!freshEnough(card)) return false;
    if (standing !== 'all' && b20CardStandingGroupV1(card) !== standing) return false;
    const observation = card.observation;
    if (standingKind !== null && observation?.standing.kind !== standingKind) return false;
    if (
      bothRoutes &&
      !(
        observation?.entryRouteFound &&
        observation.exitRouteFound &&
        b20CardStandingGroupV1(card) === 'two_sided'
      )
    )
      return false;
    if (maxRoundTripBps !== null) {
      const measured = observation?.optimisticRoundTripBps ?? null;
      if (measured === null || measured > maxRoundTripBps) return false;
    }
    if (minBuyers !== null) {
      const window = observation?.launchBuyerWindow ?? null;
      const counted =
        window && window.status !== 'measured'
          ? null
          : (observation?.launchBuyers?.buyerCount ?? null);
      if (counted === null || counted < minBuyers) return false;
    }
    return true;
  };

  const narrowed =
    standing !== 'all' ||
    standingKind !== null ||
    bothRoutes ||
    maxRoundTripBps !== null ||
    minBuyers !== null;

  // Project context is attached AFTER a page is chosen, in one read, so a feed
  // that nobody filtered by project pays one query rather than one per row.
  const attachProjects = async (
    cards: ReturnType<typeof b20OpportunityCardV1>[],
  ): Promise<ReturnType<typeof b20OpportunityCardV1>[]> => {
    const profiles = await readB20ProjectProfilesV1(cards.map((card) => card.launch.tokenAddress));
    if (profiles === null) return cards;
    return cards.map((card) => ({
      ...card,
      project: profiles.get(card.launch.tokenAddress.toLowerCase()) ?? null,
    }));
  };

  const project = input.project ?? 'all';

  // A verified claim is rare, so the two positive project filters are answered
  // by reading the CLAIMED tokens rather than by paging the corpus looking for
  // them. The same reasoning as the standing filter: a section spread thinly
  // through 28,000 launches is, from a page of 25, the same as not having it.
  if (project === 'product_backed' || project === 'verified_project') {
    const claimed = (await b20RouteRuntime.projectsAvailable())
      ? await b20RouteRuntime.projects().verifiedTokenAddresses({ chainId: 8453, limit: 200 })
      : [];

    // The project filter runs FIRST, on one bulk read, and the page is filled
    // afterwards.
    //
    // The earlier order filled a page of `limit` claimed tokens, then filtered
    // it by standing — so asking for product-backed launches could return three
    // cards out of a page of twenty-five and look like there were only three,
    // with no way for a reader to tell a short page from a short world. Filter
    // before the bound, always: a bound applied to an unfiltered set is a bound
    // on the wrong thing.
    const claimedProfiles = await readB20ProjectProfilesV1(claimed);
    const wanted = claimed.filter((tokenAddress) => {
      const profile = claimedProfiles?.get(tokenAddress.toLowerCase()) ?? null;
      return profile !== null && b20ProjectFilterMatchesV1(project, profile.standing);
    });

    const cards: ReturnType<typeof b20OpportunityCardV1>[] = [];
    for (const tokenAddress of wanted) {
      // A claimed token Discover has no canonical launch row for cannot become
      // a card — a card IS a launch — so it is absent from this FEED. The
      // console answers the same question without a card and does not drop it;
      // see `readB20FundamentalMatchesV1`.
      const found = await observations.getFeedRowForToken({ tokenAddress, historyLimit: 1 });
      if (!found) continue;
      const card = b20DiscoverCardFromRowV1(
        found.row,
        pipeline,
        now,
        claimedProfiles?.get(tokenAddress.toLowerCase()) ?? null,
      );
      if (!matches(card)) continue;
      cards.push(card);
      if (cards.length >= input.limit) break;
    }
    return {
      pipeline,
      cards,
      // One bounded read. There is no second page of verified projects yet, and
      // a cursor implying one would be a promise this read cannot keep.
      nextCursor: null,
      serverTime: now.toISOString(),
    };
  }

  if (narrowed) {
    const filtered = await readNarrowedFeedV1({
      observations,
      pipeline,
      now,
      maxLaunchAgeMs,
      states: input.state === 'all' ? undefined : [input.state],
      cursor: input.cursor,
      limit: input.limit,
      matches,
    });
    const cards = await attachProjects(filtered.cards);
    return {
      pipeline,
      cards: project === 'unknown' ? cards.filter(unclaimedV1) : cards,
      nextCursor: filtered.nextCursor,
      serverTime: now.toISOString(),
    };
  }

  const page = await observations.listFeed({
    limit: input.limit,
    cursor: input.cursor,
    states: input.state === 'all' ? undefined : [input.state],
    maxLaunchAgeMs,
    now: now.toISOString(),
  });

  const cards = await attachProjects(
    page.rows.map((row) => b20DiscoverCardFromRowV1(row, pipeline, now)).filter(freshEnough),
  );

  return {
    pipeline,
    cards: project === 'unknown' ? cards.filter(unclaimedV1) : cards,
    nextCursor: page.nextCursor,
    serverTime: now.toISOString(),
  };
}

/** A card nobody has claimed. `project: null` counts — a server that does not
 * run the layer has not established that anybody claimed anything. */
function unclaimedV1(card: ReturnType<typeof b20OpportunityCardV1>): boolean {
  return card.project === null || card.project.standing === 'unverified';
}

/**
 * How many launches ONE filtered page may read before it stops and hands back
 * a cursor.
 *
 * The live 48-hour window held 1,139 canonical launches on 2026-08-15, so this
 * covers it whole today. The point of the bound is not the number: it is that
 * a growing window makes the read return a cursor rather than quietly serving a
 * truncated section that looks complete.
 */
export const DISCOVER_STANDING_SCAN_LIMIT_V1 = 1_200;
const DISCOVER_STANDING_PAGE_V1 = 100;

/**
 * A narrowed page of the feed.
 *
 * Every predicate runs over the CARD projection — the same object a reader
 * will be shown, built by the same function the screen groups with. It is
 * deliberately not a set of SQL predicates: `bought_not_sellable` and
 * `no_buyers_yet` are separated by whether a buyer window closed,
 * `sale_unpriced` by whether it was counted at all, and a second
 * implementation of those rules in SQL would be a second answer to what a card
 * means. Six of this repository's production bugs were exactly that shape.
 *
 * The cursor it returns points at the last row it CONSUMED, not at the end of
 * the page it was reading. Rows after that were never examined and come back on
 * the next call, so a narrowed feed pages without skipping.
 */
async function readNarrowedFeedV1(input: {
  observations: B20ObservationRepositoryV1;
  pipeline: B20PipelineStatusV1 & { message: string };
  now: Date;
  maxLaunchAgeMs: number;
  states: (typeof FEED_STATES_V1)[number][] | undefined;
  cursor: string | null;
  limit: number;
  matches: (card: ReturnType<typeof b20OpportunityCardV1>) => boolean;
}): Promise<{ cards: ReturnType<typeof b20OpportunityCardV1>[]; nextCursor: string | null }> {
  const cards: ReturnType<typeof b20OpportunityCardV1>[] = [];
  let cursor = input.cursor;
  let scanned = 0;

  while (scanned < DISCOVER_STANDING_SCAN_LIMIT_V1) {
    const page = await input.observations.listFeed({
      limit: Math.min(DISCOVER_STANDING_PAGE_V1, DISCOVER_STANDING_SCAN_LIMIT_V1 - scanned),
      cursor,
      states: input.states,
      maxLaunchAgeMs: input.maxLaunchAgeMs,
      now: input.now.toISOString(),
    });

    for (const row of page.rows) {
      scanned += 1;
      const card = b20DiscoverCardFromRowV1(row, input.pipeline, input.now);
      if (!input.matches(card)) continue;
      cards.push(card);
      if (cards.length >= input.limit) {
        return {
          cards,
          nextCursor: encodeFeedCursorV1({
            launchBlockNumber: row.launch.blockNumber,
            measuredAt: row.observation?.measuredAt ?? null,
            launchId: row.launch.id,
          }),
        };
      }
    }

    // No further page exists, so the section is complete rather than paused.
    if (!page.nextCursor) return { cards, nextCursor: null };
    cursor = page.nextCursor;
  }

  // The scan budget ran out with the section still open. The cursor says so.
  return { cards, nextCursor: cursor };
}

// ---------------------------------------------------------------------------
// The universe, counted — so nobody has to page it.
//
// The Discover feed answers "what are the newest launches". It cannot answer
// "how many launches were bought and could not be sold", and the only way to
// get that from the feed is 46 pages of 25. A planner doing that spends 46
// round trips to compute a number, and a person doing it does not.
//
// Built by reading the SAME card projection the feed reads, page by page, and
// grouping with the SAME standing function the screen groups with. That is
// deliberate and it is the whole design constraint: a summary computed by a
// second SQL rule would eventually disagree with the cards it claims to
// summarise, and a disagreement between a count and a list is the kind of bug
// that is only found by a user.
//
// The cost is real — roughly a dozen bounded queries — so the result is cached
// for a minute and the response states when it was computed. The corpus moves
// at about five observations per twenty seconds; a minute-old count is a count
// of a minute ago, and it says so rather than implying it is live.
// ---------------------------------------------------------------------------

const DISCOVER_SUMMARY_TTL_MS_V1 = 60_000;

export interface B20UniverseSummaryV1 {
  window: {
    maxLaunchAgeMs: number;
    /** Backward-compatible alias of `inspected`. */
    launches: number;
    /** Canonical launch rows included by the full storage aggregate. */
    inspected: number;
    /** Latest readings whose shared card standing is a completed conclusion
     * about the measured market condition (`aboutToken: true`). */
    completed: number;
    /** No latest reading, or a latest reading that describes an evidence gap
     * in Miorail rather than a conclusion about the token. */
    incomplete: number;
    /** False only when the storage layer could not establish the full window. */
    complete: boolean;
  };
  /** One row per measured conclusion, in the display order of their sections. */
  standing: { kind: string; group: B20StandingGroupV1; count: number; aboutToken: boolean }[];
  /** The same launches rolled up to the four sections a screen shows. */
  sections: { group: B20StandingGroupV1; label: string; count: number }[];
  /** The typed measurement vocabulary, unrolled. Not the same axis as
   * `standing`: one reason code can reach several conclusions. */
  reasonCodes: { code: string; count: number }[];
  /** Which venues the readings behind these counts actually asked. */
  venues: { venues: string | null; count: number }[];
  /** Launch-window buying, in bands. `not_counted` is its own band because a
   * window that has not closed has counted nobody — it is not a zero. */
  buyers: { band: string; count: number }[];
  computedAt: string;
  cachedForMs: number;
  caveats: readonly string[];
}

export const B20_SUMMARY_CAVEATS_V1 = [
  'These are counts of canonical launches and their latest supported stored readings inside a launch-age window, not of every B20 token on Base.',
  'Inspected is the corpus read. Completed means the latest card standing is a conclusion about the measured market condition; incomplete means Miorail still has an evidence gap. These counts are never interchangeable.',
  'A count under a conclusion whose aboutToken is false is a count of what MIORAIL could not measure. It is not a count of tokens with that property.',
  'Counts are computed from the same card projection the feed serves and may be up to a minute old. computedAt says when.',
] as const;

const BUYER_BANDS_V1 = ['not_counted', '0', '1', '2-9', '10+'] as const;

function buyerBandV1(count: number | null): string {
  if (count === null) return 'not_counted';
  if (count === 0) return '0';
  if (count === 1) return '1';
  return count < 10 ? '2-9' : '10+';
}

let summaryCacheV1: { key: string; at: number; value: B20UniverseSummaryV1 } | null = null;

/** Test seam: a summary computed under one corpus must not answer for another. */
export function resetB20SummaryCacheV1(): void {
  summaryCacheV1 = null;
}

export async function readB20UniverseSummaryV1(input: {
  maxLaunchAgeMs?: number;
  now?: Date;
}): Promise<B20UniverseSummaryV1> {
  const maxLaunchAgeMs = input.maxLaunchAgeMs ?? DISCOVER_FEED_WINDOW_MS_V1;
  const now = input.now ?? b20RouteRuntime.now();
  const key = String(maxLaunchAgeMs);
  if (
    summaryCacheV1 &&
    summaryCacheV1.key === key &&
    now.getTime() - summaryCacheV1.at < DISCOVER_SUMMARY_TTL_MS_V1
  ) {
    return summaryCacheV1.value;
  }

  const available = await b20RouteRuntime.discoverAvailable();
  const observations = b20RouteRuntime.observations();
  const standing = new Map<
    string,
    { group: B20StandingGroupV1; aboutToken: boolean; count: number }
  >();
  const sections = new Map<B20StandingGroupV1, number>();
  const reasonCodes = new Map<string, number>();
  const venues = new Map<string, number>();
  const buyers = new Map<string, number>();

  let launches = 0;
  let completed = 0;
  let incomplete = 0;
  const complete = available;
  if (available) {
    const aggregate = await observations.aggregateFeed({
      maxLaunchAgeMs,
      now: now.toISOString(),
    });
    launches = aggregate.inspected;
    for (const bucket of aggregate.buckets) {
      const conclusion = b20ExitStandingV1({
        observation: bucket.observation,
        buyerCount: bucket.buyerCount,
      });
      const group = b20StandingGroupV1(conclusion);
      const current = standing.get(conclusion.kind);
      if (current) current.count += bucket.count;
      else
        standing.set(conclusion.kind, {
          group,
          aboutToken: conclusion.aboutToken,
          count: bucket.count,
        });
      sections.set(group, (sections.get(group) ?? 0) + bucket.count);
      if (conclusion.aboutToken) completed += bucket.count;
      else incomplete += bucket.count;

      const reason = bucket.observation?.reasonCode ?? 'not_measured';
      reasonCodes.set(reason, (reasonCodes.get(reason) ?? 0) + bucket.count);

      // Null and empty both print as "not recorded": a row written before the
      // field existed did not search nothing, it did not say.
      const venueKey = bucket.observation?.venuesConsulted?.length
        ? [...bucket.observation.venuesConsulted].join(',')
        : 'not recorded';
      venues.set(venueKey, (venues.get(venueKey) ?? 0) + bucket.count);

      const band = buyerBandV1(bucket.buyerCount);
      buyers.set(band, (buyers.get(band) ?? 0) + bucket.count);
    }
  }

  const value: B20UniverseSummaryV1 = {
    window: {
      maxLaunchAgeMs,
      launches,
      inspected: launches,
      completed,
      incomplete,
      complete,
    },
    // Ordered by section, then by size within it, so the shape of the answer
    // matches the shape of the screen.
    standing: [...standing.entries()]
      .map(([kind, entry]) => ({
        kind,
        group: entry.group,
        count: entry.count,
        aboutToken: entry.aboutToken,
      }))
      .sort(
        (left, right) =>
          B20_STANDING_GROUPS_V1.indexOf(left.group) -
            B20_STANDING_GROUPS_V1.indexOf(right.group) || right.count - left.count,
      ),
    sections: B20_STANDING_GROUPS_V1.map((group) => ({
      group,
      label: B20_STANDING_GROUP_COPY_V1[group].label,
      count: sections.get(group) ?? 0,
    })).filter((section) => section.count > 0),
    reasonCodes: [...reasonCodes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => right.count - left.count),
    venues: [...venues.entries()]
      .map(([label, count]) => ({ venues: label === 'not recorded' ? null : label, count }))
      .sort((left, right) => right.count - left.count),
    // Every band is listed, including the empty ones: a missing band reads as
    // "not measured" when it means "none".
    buyers: BUYER_BANDS_V1.map((band) => ({ band, count: buyers.get(band) ?? 0 })),
    computedAt: now.toISOString(),
    cachedForMs: DISCOVER_SUMMARY_TTL_MS_V1,
    caveats: B20_SUMMARY_CAVEATS_V1,
  };
  summaryCacheV1 = { key, at: now.getTime(), value };
  return value;
}

// ---------------------------------------------------------------------------
// T73 — the two market rails.
//
// Read-only projections over stored observations, composed from the SAME feed
// read the Discover surface uses and the same mover pairing both repositories
// implement. No new measurement and no new ranking: the ordering key is named
// in the response, and it is one measured dimension.
// ---------------------------------------------------------------------------

/** §2 — ONE configured tolerance. A ladder probed against a different one
 * produces a larger passing size for the same pool and is excluded, not
 * ranked beside these. Matches the measurement worker's reference profile. */
export const MARKET_RAIL_TOLERANCE_BPS_V1 = 300;
/** The rail's 24 hours, and its window, from the shared projection. Declared
 * there rather than here because the measurement worker has to schedule against
 * the same two numbers — a route and a worker that each own a copy is how the
 * rail came to ask for pairs the cadence could never produce. */
export const MARKET_RAIL_BASELINE_AGE_MS_V1 = MEASURED_MOVE_BASELINE_AGE_MS_V1;
export const MARKET_RAIL_BASELINE_TOLERANCE_MS_V1 = MEASURED_MOVE_BASELINE_TOLERANCE_MS_V1;
/** §3 — a mover needs a measured exit for at least 25% of the tokens returned
 * by the reference entry. A ratio is intentional: a raw atomic threshold
 * silently treats 6-decimal and 18-decimal B20s as different markets. */
export const MARKET_RAIL_MIN_EXIT_COVERAGE_BPS_V1 = 2_500;
/** The active window currently holds fewer than 800 launches. Keep the read
 * bounded above that population so a market rail is not accidentally a
 * projection of only the first Discover page. */
export const MARKET_RAIL_ACTIVE_OBSERVATION_LIMIT_V1 = 1_000;

/**
 * Both market rails, ranked by the server.
 *
 * Extracted so the public MCP reads the SAME projection the UI rail does. It
 * had its own answer to "largest measured exit capacity": the newest 25 cards,
 * sorted inside the MCP. This one ranks over the bounded active window and
 * carries the typed exclusion reasons, which is what lets a reader tell "not on
 * the rail" from "measured and worse".
 */
/**
 * Several tokens, read the way the console reads them.
 *
 * Extracted so the agent-facing Compare uses the SAME reads as Investigate,
 * including the three separate statements a miss produces: a missing index row
 * is a fact about Miorail, not about the token, and the factory is asked before
 * anything is said. Bounded by the caller — every call site so far caps at five.
 */
export async function readB20TokenReadsV1(input: {
  tokenAddresses: readonly string[];
  historyLimit: number;
  /**
   * The holder-facing exit assessment, computed only when asked.
   *
   * It answers "which of MY positions is hardest to close", which is a question
   * only the Portfolio scope has. Compare does not, and computing it there was
   * both work nobody asked for and the one thing on this path that can throw on
   * a partial observation.
   */
  includeAssessments?: boolean;
}): Promise<{
  reads: B20ConsoleTokenReadV1[];
  assessments: Record<string, B20ExitAssessmentV1>;
}> {
  const observations = b20RouteRuntime.observations();
  const now = b20RouteRuntime.now();
  const pipeline = await pipelineStatusV1(observations, now, true);
  const projects = await readB20ProjectProfilesV1(input.tokenAddresses);
  const reads: B20ConsoleTokenReadV1[] = [];
  const assessments: Record<string, B20ExitAssessmentV1> = {};
  for (const tokenAddress of input.tokenAddresses) {
    const found = await observations.getFeedRowForToken({
      tokenAddress,
      historyLimit: input.historyLimit,
    });
    if (!found) {
      // A missing index row is a fact about Miorail, not about the token. Ask
      // the factory before saying anything: MIO is confirmed onchain and
      // predates the Discover scan window, and calling it "not a canonical
      // B20 launch" was Miorail denying its own token. Bounded by the
      // planner's five-token cap and only ever reached on a miss.
      const identity = await b20IdentityForMissingRowV1(tokenAddress, now);
      reads.push({
        tokenAddress,
        card: null,
        profile: null,
        historyCount: 0,
        indexStanding: b20TokenIndexStandingV1({ indexed: false, detection: identity }),
        detection: identity,
      });
      continue;
    }
    const raw = found.row.observation;
    reads.push({
      tokenAddress,
      card: b20OpportunityCardV1({
        launch: {
          tokenAddress: found.row.launch.tokenAddress,
          name: found.row.launch.name,
          symbol: found.row.launch.symbol,
          variant: found.row.launch.variant,
          decimals: found.row.launch.decimals,
          blockNumber: found.row.launch.blockNumber,
          transactionHash: found.row.launch.transactionHash,
          logIndex: found.row.launch.logIndex,
          detectedAt: found.row.launch.detectedAt,
          blockTimestamp: found.row.launch.blockTimestamp,
          canonical: found.row.launch.canonical,
        },
        observation: raw,
        launchBuyers: found.row.launchBuyers,
        launchBuyerWindow: b20LaunchBuyerWindowV1({
          launchBlock: found.row.launch.blockNumber,
          observedHead: pipeline.facts.confirmedHead,
          windowBlocks: B20_BUYER_WINDOW_BLOCKS_V1,
          measured: found.row.launchBuyers !== null,
          measuredToBlock: found.row.launchBuyers?.toBlock ?? null,
        }),
        project: projects?.get(found.row.launch.tokenAddress.toLowerCase()) ?? null,
        now,
      }),
      // The four fields the comparability rule reads, taken from the stored
      // observation rather than from the card: a card is a projection for a
      // screen and deliberately does not carry the measurement's identity.
      profile: raw
        ? {
            profileIdentity: raw.profileIdentity,
            referenceQuoteAsset: raw.referenceQuoteAsset,
            referencePositionAtomic: raw.referencePositionAtomic,
            measurementVersion: raw.measurementVersion,
          }
        : null,
      historyCount: found.history.length,
      // A row in the index settles identity on its own; the factory is not
      // consulted, and an observation may still be absent. Those stay three
      // separate statements.
      indexStanding: 'indexed_b20',
      detection: null,
    });
    if (raw && input.includeAssessments === true) {
      assessments[tokenAddress] = referenceExitAssessmentV1(raw, null);
    }
  }
  return { reads, assessments };
}

export async function readB20MarketRailsV1(input: { limit: number }): Promise<{
  pipeline: B20PipelineStatusV1;
  capacityLeaders: ReturnType<typeof exitCapacityLeadersV1>['leaders'];
  movers: ReturnType<typeof measuredMoversV1>['movers'];
  collectingHistory: boolean;
  toleranceBps: number;
  moveLabel: string;
  moveNote: string;
  serverTime: string;
}> {
  const available = await b20RouteRuntime.discoverAvailable();
  const observations = b20RouteRuntime.observations();
  const now = b20RouteRuntime.now();
  const pipeline = await pipelineStatusV1(observations, now, available);
  const limit = Math.max(1, Math.min(10, input.limit));

  if (!available) {
    return {
      pipeline,
      capacityLeaders: [],
      movers: [],
      collectingHistory: false,
      toleranceBps: MARKET_RAIL_TOLERANCE_BPS_V1,
      moveLabel: MEASURED_MOVE_LABEL_V1,
      moveNote: MEASURED_MOVE_NOTE_V1,
      serverTime: now.toISOString(),
    };
  }

  const pairs = await observations.listMoverPairs({
    limit: MARKET_RAIL_ACTIVE_OBSERVATION_LIMIT_V1,
    now: now.toISOString(),
    baselineAgeMs: MARKET_RAIL_BASELINE_AGE_MS_V1,
    baselineToleranceMs: MARKET_RAIL_BASELINE_TOLERANCE_MS_V1,
    maxLaunchAgeMs: DISCOVER_FEED_WINDOW_MS_V1,
  });
  const marketPairs = pairs.map((pair) => ({
    launch: {
      tokenAddress: pair.launch.tokenAddress,
      symbol: pair.launch.symbol,
      name: pair.launch.name,
      decimals: pair.launch.decimals,
      canonical: pair.launch.canonical,
    },
    latest: pair.latest,
    baseline: pair.baseline,
  }));
  const leaders = exitCapacityLeadersV1({
    rows: marketPairs.map((pair) => ({ launch: pair.launch, observation: pair.latest })),
    toleranceBps: MARKET_RAIL_TOLERANCE_BPS_V1,
    now,
    limit,
  });
  const movers = measuredMoversV1({
    pairs: marketPairs,
    now,
    baselineAgeMs: MARKET_RAIL_BASELINE_AGE_MS_V1,
    baselineToleranceMs: MARKET_RAIL_BASELINE_TOLERANCE_MS_V1,
    minExitCoverageBps: MARKET_RAIL_MIN_EXIT_COVERAGE_BPS_V1,
    limit,
  });

  return {
    pipeline,
    capacityLeaders: leaders.leaders,
    movers: movers.movers,
    collectingHistory: moversCollectingHistoryV1(movers),
    toleranceBps: MARKET_RAIL_TOLERANCE_BPS_V1,
    moveLabel: MEASURED_MOVE_LABEL_V1,
    moveNote: MEASURED_MOVE_NOTE_V1,
    serverTime: now.toISOString(),
  };
}

b20ControlRouter.get('/opportunities/b20/market/rails', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  const limitRaw = Number.parseInt(String(req.query.limit ?? '5'), 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10, limitRaw)) : 5;

  try {
    const available = await b20RouteRuntime.discoverAvailable();
    const observations = b20RouteRuntime.observations();
    const now = b20RouteRuntime.now();
    const pipeline = await pipelineStatusV1(observations, now, available);

    if (!available) {
      res.json(
        B20MarketRailsResponseV1Schema.parse({
          pipeline,
          capacityLeaders: [],
          movers: [],
          collectingHistory: false,
          toleranceBps: MARKET_RAIL_TOLERANCE_BPS_V1,
          moveLabel: MEASURED_MOVE_LABEL_V1,
          moveNote: MEASURED_MOVE_NOTE_V1,
          serverTime: now.toISOString(),
        }),
      );
      return;
    }

    // One bounded read supplies both rails. Reading the newest 50 launches made
    // the cards empty whenever the fresh measured exits sat on page two, even
    // though the worker and database were healthy.
    const pairs = await observations.listMoverPairs({
      limit: MARKET_RAIL_ACTIVE_OBSERVATION_LIMIT_V1,
      now: now.toISOString(),
      baselineAgeMs: MARKET_RAIL_BASELINE_AGE_MS_V1,
      baselineToleranceMs: MARKET_RAIL_BASELINE_TOLERANCE_MS_V1,
      maxLaunchAgeMs: DISCOVER_FEED_WINDOW_MS_V1,
    });
    const marketPairs = pairs.map((pair) => ({
      launch: {
        tokenAddress: pair.launch.tokenAddress,
        symbol: pair.launch.symbol,
        name: pair.launch.name,
        decimals: pair.launch.decimals,
        canonical: pair.launch.canonical,
      },
      latest: pair.latest,
      baseline: pair.baseline,
    }));
    const leaders = exitCapacityLeadersV1({
      rows: marketPairs.map((pair) => ({ launch: pair.launch, observation: pair.latest })),
      toleranceBps: MARKET_RAIL_TOLERANCE_BPS_V1,
      now,
      limit,
    });
    const movers = measuredMoversV1({
      pairs: marketPairs,
      now,
      baselineAgeMs: MARKET_RAIL_BASELINE_AGE_MS_V1,
      baselineToleranceMs: MARKET_RAIL_BASELINE_TOLERANCE_MS_V1,
      minExitCoverageBps: MARKET_RAIL_MIN_EXIT_COVERAGE_BPS_V1,
      limit,
    });

    res.json(
      B20MarketRailsResponseV1Schema.parse({
        pipeline,
        capacityLeaders: leaders.leaders,
        movers: movers.movers,
        // §5 — only when time is the ONLY thing missing.
        collectingHistory: moversCollectingHistoryV1(movers),
        toleranceBps: MARKET_RAIL_TOLERANCE_BPS_V1,
        moveLabel: MEASURED_MOVE_LABEL_V1,
        moveNote: MEASURED_MOVE_NOTE_V1,
        serverTime: now.toISOString(),
      }),
    );
  } catch (error) {
    storageFailure(res, error, 'b20-market-rails');
  }
});

/**
 * The universe, counted.
 *
 * Deliberately a separate route from the feed rather than a field on it: the
 * feed answers "what is newest" one page at a time, and folding a whole-window
 * count into every page would make the cheap read pay for the expensive one.
 */
b20ControlRouter.get('/opportunities/b20/summary', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  const launchAgeRaw = Number.parseInt(String(req.query.launchAge ?? ''), 10);
  const maxLaunchAgeMs =
    Number.isFinite(launchAgeRaw) && launchAgeRaw > 0 ? launchAgeRaw : DISCOVER_FEED_WINDOW_MS_V1;
  try {
    res.json(B20UniverseSummaryV1Schema.parse(await readB20UniverseSummaryV1({ maxLaunchAgeMs })));
  } catch (error) {
    storageFailure(res, error, 'b20-universe-summary');
  }
});

b20ControlRouter.get('/opportunities/b20', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  const limitRaw = Number.parseInt(String(req.query.limit ?? '25'), 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, limitRaw)) : 25;
  const stateParam = String(req.query.state ?? 'all');
  if (stateParam !== 'all' && !(FEED_STATES_V1 as readonly string[]).includes(stateParam)) {
    res.status(400).json({ error: 'unknown_state_filter', code: 'unknown_state_filter' });
    return;
  }
  const freshness = String(req.query.freshness ?? 'all');
  if (!['fresh', 'stale', 'all'].includes(freshness)) {
    res.status(400).json({ error: 'unknown_freshness_filter', code: 'unknown_freshness_filter' });
    return;
  }
  // The verdict section. Refused rather than ignored when unknown: silently
  // serving the whole feed for a filter the caller believed in is how a client
  // comes to show "Bought, not sellable" above cards that are nothing of the
  // kind.
  const standing = String(req.query.standing ?? 'all');
  if (standing !== 'all' && !(B20_STANDING_GROUPS_V1 as readonly string[]).includes(standing)) {
    res.status(400).json({ error: 'unknown_standing_filter', code: 'unknown_standing_filter' });
    return;
  }
  const cursor =
    typeof req.query.cursor === 'string' && req.query.cursor.length > 0 ? req.query.cursor : null;
  if (cursor && !decodeFeedCursorV1(cursor)) {
    // Refused rather than treated as "start from the top": silently restarting
    // a paginated feed looks to a caller like duplicated results.
    res.status(400).json({ error: 'invalid_cursor', code: 'invalid_cursor' });
    return;
  }
  const launchAgeRaw = Number.parseInt(String(req.query.launchAge ?? ''), 10);
  const maxLaunchAgeMs =
    Number.isFinite(launchAgeRaw) && launchAgeRaw > 0 ? launchAgeRaw : DISCOVER_FEED_WINDOW_MS_V1;

  // The evidence axis. Each one is REFUSED when unparseable rather than
  // silently dropped: a caller who asked for "at least ten buyers" and got the
  // whole feed would read every card as satisfying it.
  const boundedIntV1 = (raw: unknown, min: number, max: number): number | null | 'invalid' => {
    if (raw === undefined || raw === '') return null;
    const value = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(value) || value < min || value > max) return 'invalid';
    return value;
  };
  const maxRoundTripBps = boundedIntV1(req.query.maxRoundTripBps, 0, 100_000);
  const minBuyers = boundedIntV1(req.query.minBuyers, 0, 1_000_000);
  if (maxRoundTripBps === 'invalid' || minBuyers === 'invalid') {
    res.status(400).json({ error: 'invalid_filter_bound', code: 'invalid_filter_bound' });
    return;
  }
  const standingKind =
    typeof req.query.standingKind === 'string' && req.query.standingKind.length > 0
      ? req.query.standingKind
      : null;
  if (
    standingKind !== null &&
    !(B20_EXIT_STANDING_KINDS_V1 as readonly string[]).includes(standingKind)
  ) {
    res.status(400).json({ error: 'unknown_standing_kind', code: 'unknown_standing_kind' });
    return;
  }
  const bothRoutes = String(req.query.bothRoutes ?? '') === 'true';

  // Project context. Refused when unknown rather than silently widened: a
  // caller who asked for verified projects and got the whole feed would read
  // every card as one.
  const projectRaw =
    typeof req.query.project === 'string' && req.query.project.length > 0
      ? req.query.project
      : 'all';
  if (!(B20_PROJECT_FILTERS_V1 as readonly string[]).includes(projectRaw)) {
    res.status(400).json({ error: 'unknown_project_filter', code: 'unknown_project_filter' });
    return;
  }

  // Held outside the try so the failure log can say what SHAPE arrived at the
  // schema, not merely that something did.
  let feed: Awaited<ReturnType<typeof readDiscoverFeedV1>> | undefined;
  try {
    feed = await readDiscoverFeedV1({
      limit,
      cursor,
      state: stateParam as (typeof FEED_STATES_V1)[number] | 'all',
      freshness: freshness as 'fresh' | 'stale' | 'all',
      standing: standing as B20StandingGroupV1 | 'all',
      standingKind,
      bothRoutes,
      maxRoundTripBps,
      minBuyers,
      project: projectRaw as B20ProjectFilterV1,
      maxLaunchAgeMs,
    });
    res.json(B20OpportunityFeedResponseV1Schema.parse(feed));
  } catch (error) {
    storageFailure(res, error, 'b20-opportunity-feed', feed);
  }
});

/**
 * Ask about one exact Discover card.
 *
 * Read-only by construction: the request has no wallet, amount-to-sign,
 * calldata, payment or tool name. The client references an observation, but
 * every fact is reloaded from append-only storage before the deterministic
 * answer is built. A card that changed while the tab was open is a 409, never
 * an answer that quietly mixes old UI context with new server evidence.
 */
b20ControlRouter.post('/opportunities/b20/copilot/ask', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;
  const parsed = B20CopilotAskRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: 'invalid_b20_copilot_request', code: 'invalid_b20_copilot_request' });
    return;
  }

  try {
    if (!(await b20RouteRuntime.discoverAvailable())) {
      res.status(503).json({ error: 'discover_unavailable', code: 'discover_unavailable' });
      return;
    }
    const observations = b20RouteRuntime.observations();
    const found = await observations.getFeedRowForToken({
      tokenAddress: parsed.data.tokenAddress,
      historyLimit: 20,
    });
    if (!found) {
      res.status(404).json({ error: 'launch_not_found', code: 'launch_not_found' });
      return;
    }

    const current = found.row.observation;
    const referencesMatch = b20ObservationRefMatchesV1(current, parsed.data);
    if (!referencesMatch) {
      res.status(409).json({
        error: 'b20_observation_changed',
        code: 'b20_observation_changed',
        detail:
          'This B20 card changed after it was opened. Refresh Discover before asking about it.',
      });
      return;
    }

    const now = b20RouteRuntime.now();
    const pipeline = await pipelineStatusV1(observations, now, true);
    const card = b20OpportunityCardV1({
      launch: {
        tokenAddress: found.row.launch.tokenAddress,
        name: found.row.launch.name,
        symbol: found.row.launch.symbol,
        variant: found.row.launch.variant,
        decimals: found.row.launch.decimals,
        blockNumber: found.row.launch.blockNumber,
        transactionHash: found.row.launch.transactionHash,
        logIndex: found.row.launch.logIndex,
        detectedAt: found.row.launch.detectedAt,
        blockTimestamp: found.row.launch.blockTimestamp,
        canonical: found.row.launch.canonical,
      },
      observation: current,
      launchBuyers: found.row.launchBuyers,
      launchBuyerWindow: b20LaunchBuyerWindowV1({
        launchBlock: found.row.launch.blockNumber,
        observedHead: pipeline.facts.confirmedHead,
        windowBlocks: B20_BUYER_WINDOW_BLOCKS_V1,
        measured: found.row.launchBuyers !== null,
        measuredToBlock: found.row.launchBuyers?.toBlock ?? null,
      }),
      now,
    });
    // Stage 06 — the deterministic answer is built FIRST and remains the
    // answer. The narrator is offered the same evidence and replaces that
    // sentence only by passing every check; anything else and the reader gets
    // exactly what shipped before a model was involved.
    const deterministic = answerB20CopilotV1({
      card,
      history: found.history,
      question: parsed.data.question,
    });
    const plan = planB20AnswerV1({
      question: parsed.data.question,
      tokenAddress: parsed.data.tokenAddress,
    });
    if (plan.refusal) {
      // Out of scope, and refused without spending a narration on it. The
      // evidence the deterministic answer gathered still ships, because the
      // question being unanswerable does not make the card less true.
      res.json(
        B20CopilotAskResponseV1Schema.parse({
          ...deterministic,
          answer: plan.refusal,
          answerSource: 'deterministic_evidence',
        }),
      );
      return;
    }

    const narrated = await narrateB20AnswerV1({
      question: parsed.data.question,
      bundle: {
        intent: plan.intent,
        facts: deterministic.facts.map((fact) => ({ label: fact.label, value: fact.value })),
        missing: deterministic.missingEvidence,
        caveats: deterministic.caveats,
        // One card, so the assertions are read straight off it. The card
        // console is the surface where "not measured" is most often the true
        // answer, which is exactly why it needs the check: a narration must be
        // able to say it when the card has no observation, and must not be
        // able to say it when the card has one.
        assertions: {
          state: card.observation ? 'measured' : 'not_measured',
          matched: card.observation ? 1 : 0,
          complete: true,
          subjects: [card.launch.symbol || card.launch.tokenAddress],
          about: card.observation?.standing.aboutToken === false ? 'miorail' : 'token',
        },
      },
      deterministic: deterministic.answer,
      provider: b20RouteRuntime.narrator(),
    });
    if (narrated.narrationRejectedBecause) {
      // Operator-facing only. A reader is never shown why a sentence they
      // cannot see was discarded.
      logger.info('b20 copilot narration not used', {
        intent: plan.intent,
        because: narrated.narrationRejectedBecause,
      });
    }
    res.json(
      B20CopilotAskResponseV1Schema.parse({
        ...deterministic,
        answer: narrated.answer,
        answerSource: narrated.answerSource,
      }),
    );
  } catch (error) {
    storageFailure(res, error, 'b20-copilot-ask');
  }
});

/**
 * What the B20 factory says about an address Discover has no row for.
 *
 * Returns the raw detection outcome, or null when the check could not be run at
 * all. Both feed `b20TokenIndexStandingV1`, which is the only place allowed to
 * turn them into words — and which has no branch that reads silence as
 * `not_b20`.
 *
 * Read-only and fail-closed. A thrown reader, an unset RPC URL and a refused
 * request all produce null rather than an exception, because an identity check
 * that could not run must not take down an answer the rest of which is fine.
 */
export async function b20IdentityForMissingRowV1(
  tokenAddress: string,
  now: Date,
): Promise<B20DetectionOutcomeV1 | null> {
  void now;
  try {
    // Identity only — three reads. The full `inspectB20TokenV1` answers the
    // same question but then reads every field a control card shows, which
    // measured 36 seconds for one address against production. A console
    // fallback does not need a card, and a reader waiting half a minute for
    // "we have no row for this" is its own defect.
    return await detectB20IdentityV1(
      { reader: b20RouteRuntime.reader() },
      { chainId: B20_CHAIN_ID_V1, tokenAddress },
    );
  } catch {
    return null;
  }
}

type B20TargetedIndexOutcomeV1 =
  | { indexed: true }
  | {
      indexed: false;
      outcome:
        | 'launch_lookup_unavailable'
        | 'launch_lookup_timed_out'
        | 'launch_event_not_found'
        | 'not_indexed';
      reason: string | null;
    };

/**
 * Recover one factory-confirmed launch that the Discover cursor never stored.
 *
 * The chain side is bounded by `locateB20LaunchByCodeV1`: binary-search the
 * token's first code block, then read one exact B20Created log. The storage
 * side is the existing historical-ingestion method, so the same schema,
 * provenance and conflict rules apply; this route does not invent a launch
 * row from token metadata.
 */
export async function indexMissingB20LaunchV1(input: {
  tokenAddress: string;
  budgetMs: number;
}): Promise<B20TargetedIndexOutcomeV1> {
  const lookup = await b20RouteRuntime.locateLaunchOnDemand(input);
  if (lookup.outcome === 'provider_unavailable') {
    return { indexed: false, outcome: 'launch_lookup_unavailable', reason: null };
  }
  if (lookup.outcome === 'timed_out') {
    return { indexed: false, outcome: 'launch_lookup_timed_out', reason: null };
  }
  if (lookup.outcome === 'not_found') {
    return {
      indexed: false,
      outcome: 'launch_event_not_found',
      reason: 'canonical_launch_event_not_found',
    };
  }

  const decoded = decodeB20CreatedV1(lookup.log);
  if (
    !decoded.ok ||
    decoded.launch.tokenAddress !== input.tokenAddress.toLowerCase() ||
    BigInt(decoded.launch.blockNumber) !== BigInt(lookup.creationBlock)
  ) {
    return {
      indexed: false,
      outcome: 'launch_event_not_found',
      reason: 'canonical_launch_event_unreadable',
    };
  }

  const repository = b20RouteRuntime.discover();
  const cursor = await repository.getCursor(B20_DISCOVER_LANE_V1);
  if (!cursor || BigInt(decoded.launch.blockNumber) >= BigInt(cursor.lastProcessedBlock)) {
    // The live cursor owns this range. A targeted read never moves it or writes
    // ahead of it; the next worker pass will ingest the launch atomically with
    // the cursor that claims to have covered it.
    return { indexed: false, outcome: 'not_indexed', reason: 'live_ingestion_pending' };
  }

  const now = b20RouteRuntime.now().toISOString();
  const transactionIndex =
    lookup.log.transactionIndex && /^0x[0-9a-fA-F]+$/.test(lookup.log.transactionIndex)
      ? Number(BigInt(lookup.log.transactionIndex))
      : null;
  const launch = storedLaunchFromDecodedV1({
    launch: decoded.launch,
    detectedAt: now,
    confirmationCount: Math.max(0, lookup.headBlock - lookup.creationBlock),
    transactionIndex: Number.isSafeInteger(transactionIndex) ? transactionIndex : null,
    blockTimestamp: decoded.launch.blockTimestamp,
  });
  await repository.insertHistoricalLaunches({
    key: B20_DISCOVER_LANE_V1,
    fromBlock: decoded.launch.blockNumber,
    toBlock: decoded.launch.blockNumber,
    launches: [launch],
    now,
  });
  return { indexed: true };
}

/**
 * Readings taken because a reader named a token, before the cards are read.
 *
 * The gap this closes: Discover's worker measures launches inside a 48-hour
 * age window, which is right for a background pass over 33,000 launches and
 * wrong for a person who has just pasted an address. A launch that missed its
 * window was never measured and never would be, and Investigate answered "No
 * stored measurement" — technically true, and read by everyone as a finding
 * about the token.
 *
 * Three bounds, all of them here rather than inside the pass:
 *
 *   The FLAG. Off, this returns nothing and Investigate behaves exactly as it
 *   did — a stored measurement or its absence. This is the first B20 read that
 *   spends metered calls inside an HTTP request, and that is an operator's
 *   decision.
 *
 *   The BUDGET, wall-clock and shared across the request, and a cap on how
 *   many tokens one question may cause a reading of. Tokens past either are
 *   reported as `not_attempted`, never silently dropped.
 *
 *   FRESHNESS. A current observation is used as it stands. Only an absent or
 *   stale one causes a reading, which is the same policy the freshness window
 *   already states on every card.
 *
 * What it deliberately does NOT do is take the measure lease. That lease
 * exists so two workers do not walk the same queue; this walks no queue, and
 * holding it would stop the feed for as long as one reader waited.
 */
export async function refreshB20ReadingsV1(input: {
  tokenAddresses: readonly string[];
}): Promise<B20ReadingAttemptV1[]> {
  if (b20RouteRuntime.flags(process.env).b20TargetedMeasureV1 !== true) return [];

  const targets = input.tokenAddresses.slice(0, B20_TARGETED_MEASURE_MAX_PER_REQUEST_V1);
  const skipped = input.tokenAddresses.slice(B20_TARGETED_MEASURE_MAX_PER_REQUEST_V1);

  if (!b20RouteRuntime.rpcConfigured()) {
    // Enabled and unable is a different statement from disabled, and only the
    // first one belongs in a reader's answer.
    return input.tokenAddresses.map((tokenAddress) => ({
      tokenAddress,
      outcome: 'unavailable_here' as const,
      reason: null,
    }));
  }

  const observations = b20RouteRuntime.observations();
  const now = b20RouteRuntime.now();
  const budgetMs = b20TargetedMeasureBudgetMsV1();
  const startedAt = b20RouteRuntime.monotonicMs();

  const attempts: B20ReadingAttemptV1[] = [];
  for (const tokenAddress of targets) {
    const remaining = budgetMs - (b20RouteRuntime.monotonicMs() - startedAt);
    if (remaining <= 0) {
      attempts.push({ tokenAddress, outcome: 'not_attempted', reason: null });
      continue;
    }
    let found = await observations.getFeedRowForToken({ tokenAddress, historyLimit: 1 });
    if (!found) {
      // Ask the canonical factory before spending the bounded historical
      // lookup. A random contract address never causes the binary search.
      const identity = await b20IdentityForMissingRowV1(tokenAddress, now);
      if (identity !== 'b20' && identity !== 'b20_uninitialised') {
        attempts.push({ tokenAddress, outcome: 'not_indexed', reason: null });
        continue;
      }
      const lookupRemaining = budgetMs - (b20RouteRuntime.monotonicMs() - startedAt);
      if (lookupRemaining <= 0) {
        attempts.push({ tokenAddress, outcome: 'not_attempted', reason: null });
        continue;
      }
      const indexed = await indexMissingB20LaunchV1({
        tokenAddress,
        // Leave most of the request budget for the actual Exit-First pass. A
        // managed endpoint normally finishes the ~26 lookups far below this.
        budgetMs: Math.min(10_000, Math.max(1, Math.floor(lookupRemaining * 0.45))),
      });
      if (!indexed.indexed) {
        attempts.push({ tokenAddress, outcome: indexed.outcome, reason: indexed.reason });
        continue;
      }
      found = await observations.getFeedRowForToken({ tokenAddress, historyLimit: 1 });
      if (!found) {
        attempts.push({
          tokenAddress,
          outcome: 'not_indexed',
          reason: 'launch_insert_not_visible',
        });
        continue;
      }
    }
    if (!b20ObservationNeedsRefreshV1({ observation: found.row.observation, now })) continue;

    const measureRemaining = budgetMs - (b20RouteRuntime.monotonicMs() - startedAt);
    if (measureRemaining <= 0) {
      attempts.push({ tokenAddress, outcome: 'not_attempted', reason: null });
      continue;
    }
    const result = await b20RouteRuntime.measureOnDemand({
      launch: {
        launchId: found.row.launch.id,
        tokenAddress: found.row.launch.tokenAddress,
        blockNumber: found.row.launch.blockNumber,
      },
      budgetMs: measureRemaining,
    });
    logger.info('b20 targeted measurement', {
      // The token address is public — it is on a Discover card — and the
      // outcome is what an operator needs to see the cost of this path. No
      // endpoint, no key, no wallet.
      tokenAddress: result.tokenAddress,
      outcome: result.outcome,
      elapsedMs: result.elapsedMs,
    });
    attempts.push({ tokenAddress, outcome: result.outcome, reason: result.reason });
  }

  for (const tokenAddress of skipped) {
    // Only the ones that would actually have needed a reading. A token past the
    // cap whose measurement is already current was not "not reached" — it was
    // not needed, and saying otherwise would name a gap that does not exist.
    const found = await observations.getFeedRowForToken({ tokenAddress, historyLimit: 1 });
    if (!found) {
      attempts.push({ tokenAddress, outcome: 'not_indexed', reason: null });
      continue;
    }
    if (!b20ObservationNeedsRefreshV1({ observation: found.row.observation, now })) continue;
    attempts.push({ tokenAddress, outcome: 'not_attempted', reason: null });
  }
  return attempts;
}

/**
 * The measurement pass's dependencies, built per request.
 *
 * The same wiring the worker uses and the same reference profile — a second
 * profile here would be a second definition of what an observation means, and
 * the two would produce figures that look comparable and are not.
 *
 * Both stores are passed for cost rather than for correctness: a resolved pool
 * is fixed at launch, and a closed buying window never reopens, so without them
 * every reading would re-pay the most expensive calls in the pass to relearn
 * facts already in Postgres.
 */
function b20TargetedMeasurePassV1() {
  return {
    observations: b20RouteRuntime.observations(),
    deps: createB20MeasureDepsV1({
      rpcUrl: baseMainnetRpcUrlV1(),
      maxRetries: B20_MEASURE_DEFAULTS_V1.maxRetries,
      nativePositionAtomic: B20_NATIVE_POSITION_ATOMIC_V1,
      poolStore: createB20PoolStoreV1(b20RouteRuntime.launchPools()),
      buyerRepository: b20RouteRuntime.launchBuyers(),
    }),
    config: {
      ...B20_MEASURE_DEFAULTS_V1,
      profile: { ...B20_MEASURE_REFERENCE_PROFILE_V1 },
      // Deliberately not applied and deliberately left in place: the pass reads
      // neither of these — they select the QUEUE — and a reader asking about a
      // token from three weeks ago must not be refused for its age.
      maxLaunchAgeMs: B20_MEASURE_DEFAULTS_V1.maxLaunchAgeMs,
      minReMeasureIntervalMs: B20_MEASURE_DEFAULTS_V1.minReMeasureIntervalMs,
    },
    now: b20RouteRuntime.now,
  };
}

/**
 * Stage 07 — runs a console plan.
 *
 * Every branch here is a call this file already makes for a public read, with
 * the plan's own bounded arguments. That is deliberate and is the whole reason
 * the planner emits four step kinds and not a query language: a console that
 * could express a read the rest of the product cannot is a second Discover,
 * with its own idea of what a launch means.
 */
export async function runB20ConsolePlanV1(
  plan: B20ConsolePlanV1,
): Promise<B20ConsoleDeterministicV1> {
  const summaryStep = plan.steps.find((step) => step.tool === 'summary');
  const listStep = plan.steps.find((step) => step.tool === 'list');
  const projectsStep = plan.steps.find((step) => step.tool === 'projects');
  const publicContextStep = plan.steps.find((step) => step.tool === 'public-context');
  const positionsStep = plan.steps.find((step) => step.tool === 'positions');
  const cardsStep = plan.steps.find((step) => step.tool === 'cards') ?? positionsStep;
  const changesStep = plan.steps.find((step) => step.tool === 'changes');
  const researchStep = plan.steps.find((step) => step.tool === 'research');

  if (publicContextStep && publicContextStep.tool === 'public-context') {
    const tokenAddress = publicContextStep.tokenAddress;
    const found = await b20RouteRuntime
      .observations()
      .getFeedRowForToken({ tokenAddress, historyLimit: 1 });
    const identity = found
      ? 'b20'
      : await b20IdentityForMissingRowV1(tokenAddress, b20RouteRuntime.now());
    const canonical = found ? found.row.launch.canonical === true : identity === 'b20';

    const profiles = await readB20ProjectProfilesV1([tokenAddress]);
    const fundamentalLayerAvailable = profiles !== null;
    const fundamental = profiles?.get(tokenAddress.toLowerCase()) ?? null;
    const symbol = found?.row.launch.symbol ?? null;

    if (!canonical) {
      const reason = identity === null || identity === 'rpc_failure'
        ? 'Miorail could not confirm this address against the B20 factory, so it did not search the public web.'
        : identity === 'b20_uninitialised'
          ? 'The B20 factory reports this token as not initialized, so Miorail did not search for project accounts.'
          : 'The B20 factory did not confirm this address as a canonical B20 token, so Miorail did not search the public web.';
      return b20PossiblePublicContextAnswerV1({
        tokenAddress,
        symbol,
        context: null,
        unavailableReason: reason,
        fundamental,
        fundamentalLayerAvailable,
      });
    }

    if (b20RouteRuntime.flags().b20PublicContextV1 !== true) {
      return b20PossiblePublicContextAnswerV1({
        tokenAddress,
        symbol,
        context: null,
        unavailableReason: 'Possible Public Context is not enabled on this deployment, so no public source was read.',
        fundamental,
        fundamentalLayerAvailable,
      });
    }

    const search = b20RouteRuntime.publicContextSearch();
    if (search === null && publicContextStep.domain === null) {
      return b20PossiblePublicContextAnswerV1({
        tokenAddress,
        symbol,
        context: null,
        unavailableReason: 'Public search is not configured on this deployment, so no public source was read.',
        fundamental,
        fundamentalLayerAvailable,
      });
    }

    let context: B20PublicContextV1 | null = null;
    let unavailableReason: string | null = null;
    try {
      context = await b20RouteRuntime.publicContextRead({
        chainId: B20_CHAIN_ID_V1,
        tokenAddress,
        symbol,
        name: found?.row.launch.name ?? null,
        domain: publicContextStep.domain,
        deps: {
          search:
            search ??
            (async () => {
              throw new Error('public search unavailable');
            }),
          now: b20RouteRuntime.now,
        },
      });
    } catch (error) {
      unavailableReason =
        error instanceof B20SuppliedDomainRefusedError
          ? `The supplied domain was refused: ${error.refusal}`
          : 'The public-context lookup did not complete, so Miorail makes no claim about public accounts.';
    }

    return b20PossiblePublicContextAnswerV1({
      tokenAddress,
      symbol,
      context,
      unavailableReason,
      fundamental,
      fundamentalLayerAvailable,
    });
  }

  if (cardsStep && (cardsStep.tool === 'cards' || cardsStep.tool === 'positions')) {
    // A reading is taken BEFORE the cards are read, and only for Investigate.
    //
    // Not for Portfolio: that scope's token list is a wallet's holdings, and
    // spending a metered reading per holding on every question would turn a
    // ranking into a measurement run. A holder's answer is about what Miorail
    // already measured, and it says so.
    const attempts = positionsStep
      ? []
      : await refreshB20ReadingsV1({ tokenAddresses: cardsStep.tokenAddresses });

    // One read for the whole plan. Project context answers "does MIO have a
    // live product" and "did this project exist before its token", and both are
    // questions about a card the console is already reading.
    const { reads, assessments } = await readB20TokenReadsV1({
      tokenAddresses: cardsStep.tokenAddresses,
      historyLimit: cardsStep.historyLimit,
      // Only the holder-facing answer needs it.
      includeAssessments: positionsStep !== undefined,
    });
    // Same reads, two answers. A holder is asking which of THEIR positions is
    // hardest to close, and a side-by-side of cards does not answer that.
    return positionsStep
      ? b20PortfolioAnswerV1({ reads, assessments })
      : b20InvestigateAnswerV1({ reads, attempts });
  }

  // Fundamentals answer BEFORE the summary fallback and without reading it.
  // The universe summary counts what was measured in a 48-hour window; a
  // question about which projects have a live product is asked of the claimed
  // corpus, and quoting the other one at the reader was the defect this branch
  // removes rather than works around.
  if (projectsStep && projectsStep.tool === 'projects') {
    const found = await readB20FundamentalMatchesV1({
      predicate: projectsStep.predicate,
      predicates: projectsStep.predicates ?? [projectsStep.predicate],
      operator: projectsStep.operator ?? 'and',
      limit: projectsStep.limit,
    });
    return b20FundamentalAnswerV1({
      predicate: projectsStep.predicate,
      predicates: projectsStep.predicates ?? [projectsStep.predicate],
      operator: projectsStep.operator ?? 'and',
      matches: found.matches,
      corpus: found.corpus,
      available: found.available,
    });
  }

  if (researchStep && researchStep.tool === 'research') {
    // Four bounded pages and the movers rail, read together. Each one is a
    // measured property that already has a section on the feed, so this cannot
    // invent a category the rest of the product does not publish — and it
    // cannot rank across them, because there is nothing here that orders one
    // category above another.
    const limit = researchStep.limit;
    const page = async (input: {
      standing?: (typeof B20_STANDING_GROUPS_V1)[number];
      standingKind?: (typeof B20_EXIT_STANDING_KINDS_V1)[number];
      project?: (typeof B20_PROJECT_FILTERS_V1)[number];
    }) =>
      (
        await readDiscoverFeedV1({
          limit,
          cursor: null,
          state: 'all',
          freshness: 'all',
          standing: input.standing ?? 'all',
          standingKind: input.standingKind ?? null,
          bothRoutes: false,
          minBuyers: null,
          project: input.project ?? 'all',
        })
      ).cards;

    const [boughtNotSellable, twoSided, verifiedProject, moverPairs] = await Promise.all([
      page({ standingKind: 'bought_not_sellable' }),
      page({ standing: 'two_sided' }),
      page({ project: 'verified_project' }),
      b20RouteRuntime.observations().listMoverPairs({
        limit: MARKET_RAIL_ACTIVE_OBSERVATION_LIMIT_V1,
        now: b20RouteRuntime.now().toISOString(),
        baselineAgeMs: MARKET_RAIL_BASELINE_AGE_MS_V1,
        baselineToleranceMs: MARKET_RAIL_BASELINE_TOLERANCE_MS_V1,
        maxLaunchAgeMs: DISCOVER_FEED_WINDOW_MS_V1,
      }),
    ]);
    const movers = measuredMoversV1({
      pairs: moverPairs.map((pair) => ({
        launch: {
          tokenAddress: pair.launch.tokenAddress,
          symbol: pair.launch.symbol,
          name: pair.launch.name,
          decimals: pair.launch.decimals,
          canonical: pair.launch.canonical,
        },
        latest: pair.latest,
        baseline: pair.baseline,
      })),
      now: b20RouteRuntime.now(),
      baselineAgeMs: MARKET_RAIL_BASELINE_AGE_MS_V1,
      baselineToleranceMs: MARKET_RAIL_BASELINE_TOLERANCE_MS_V1,
      minExitCoverageBps: MARKET_RAIL_MIN_EXIT_COVERAGE_BPS_V1,
      limit,
    });
    return b20ResearchCandidatesAnswerV1({
      categories: [
        {
          label: 'Bought, and a sale would not price',
          because:
            'wallets bought in the launch window and Miorail could not price a sale back at its reference size. This is the measurement Exit-First exists to make.',
          cards: boughtNotSellable,
        },
        {
          label: 'Both directions priced',
          because:
            'a purchase and a sale were both quoted against the same measured pool, so the round-trip cost and the tested exit capacity are on the card.',
          cards: twoSided,
        },
        {
          label: 'Carries a verified project claim',
          because:
            'a project proved control of a domain and claimed the token there, so there is published project evidence to read beside the measurement.',
          cards: verifiedProject,
        },
      ],
      movers: movers.movers,
    });
  }

  if (changesStep && changesStep.tool === 'changes') {
    const observations = b20RouteRuntime.observations();
    const now = b20RouteRuntime.now();
    const pairs = await observations.listMoverPairs({
      limit: MARKET_RAIL_ACTIVE_OBSERVATION_LIMIT_V1,
      now: now.toISOString(),
      baselineAgeMs: MARKET_RAIL_BASELINE_AGE_MS_V1,
      baselineToleranceMs: MARKET_RAIL_BASELINE_TOLERANCE_MS_V1,
      maxLaunchAgeMs: DISCOVER_FEED_WINDOW_MS_V1,
    });
    const result = measuredMoversV1({
      pairs: pairs.map((pair) => ({
        launch: {
          tokenAddress: pair.launch.tokenAddress,
          symbol: pair.launch.symbol,
          name: pair.launch.name,
          decimals: pair.launch.decimals,
          canonical: pair.launch.canonical,
        },
        latest: pair.latest,
        baseline: pair.baseline,
      })),
      now,
      baselineAgeMs: MARKET_RAIL_BASELINE_AGE_MS_V1,
      baselineToleranceMs: MARKET_RAIL_BASELINE_TOLERANCE_MS_V1,
      minExitCoverageBps: MARKET_RAIL_MIN_EXIT_COVERAGE_BPS_V1,
      limit: changesStep.limit,
    });
    return b20ChangesAnswerV1({
      changes: {
        movers: result.movers,
        excluded: result.excluded,
        collectingHistory: moversCollectingHistoryV1(result),
        baselineAgeMs: MARKET_RAIL_BASELINE_AGE_MS_V1,
        pairsConsidered: pairs.length,
      },
    });
  }

  const summary = await readB20UniverseSummaryV1({
    maxLaunchAgeMs:
      summaryStep && summaryStep.tool === 'summary'
        ? summaryStep.launchAgeHours * 60 * 60 * 1000
        : DISCOVER_FEED_WINDOW_MS_V1,
  });
  const cards =
    listStep && listStep.tool === 'list'
      ? (
          await readDiscoverFeedV1({
            limit: listStep.limit,
            cursor: null,
            state: 'all',
            freshness: 'all',
            standing: listStep.standing ?? 'all',
            standingKind: listStep.standingKind ?? null,
            bothRoutes: listStep.bothRoutes === true,
            minBuyers: listStep.minBuyers ?? null,
            project: listStep.project ?? 'all',
          })
        ).cards
      : undefined;
  // Same two reads, a different answer — because the SUBJECT is different. The
  // explore builder opens every answer with how the universe looks; a reader
  // who asked which launches need more evidence is asking about a measurement
  // Miorail did not finish, and that answer has to attribute the gap in its
  // own first sentence rather than in a caveat.
  return plan.intent === 'find_needs_evidence'
    ? b20NeedsEvidenceAnswerV1({ summary, cards })
    : b20ExploreAnswerV1({ summary, cards, intent: plan.intent });
}

/**
 * Ask about the universe, about named tokens, or about what changed.
 *
 * Read-only by the same construction as the per-card copilot: no wallet, no
 * calldata, no payment, no tool name from the client. What differs is what a
 * client may reference — nothing. There is no observation id to pin here, so
 * the response reports which reads ran instead, and a reader can see what the
 * answer was built from.
 */
b20ControlRouter.post('/opportunities/b20/console/ask', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;
  const parsed = B20ConsoleAskRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: 'invalid_b20_console_request', code: 'invalid_b20_console_request' });
    return;
  }

  try {
    if (!(await b20RouteRuntime.discoverAvailable())) {
      res.status(503).json({ error: 'discover_unavailable', code: 'discover_unavailable' });
      return;
    }
    const now = b20RouteRuntime.now();
    const resolution = await resolveB20ConsolePlanV1({
      question: parsed.data.question,
      scope: parsed.data.scope,
      tokenAddresses: parsed.data.tokenAddresses,
      provider: b20RouteRuntime.classifier(),
    });
    const plan = resolution.plan;
    if (resolution.source !== 'deterministic') {
      logger.info('b20 console semantic intent resolution', {
        source: resolution.source,
        scope: parsed.data.scope,
        intent: plan.intent,
        reason: resolution.reason,
      });
    }

    if (plan.refusal) {
      // Refused before any read, so an out-of-scope question costs nothing.
      res.json(
        B20ConsoleAskResponseV1Schema.parse({
          schemaVersion: 'b20-console-answer/v1',
          scope: plan.scope,
          intent: plan.intent,
          answerSource: 'deterministic_evidence',
          answer: plan.refusal,
          facts: [],
          missingEvidence: [],
          caveats: [...B20_CONSOLE_BASE_CAVEATS_V1],
          reads: [],
          serverTime: now.toISOString(),
        }),
      );
      return;
    }

    const deterministic = await runB20ConsolePlanV1(plan);
    // A private scope is never narrated. The bundle for a portfolio answer is
    // the wallet's own token list, and sending it to a language provider for a
    // nicer sentence is a trade nobody agreed to. Enforced by withholding the
    // provider rather than by trusting a downstream check.
    const narrated = await narrateB20AnswerV1({
      question: parsed.data.question,
      bundle: {
        intent: plan.intent,
        facts: deterministic.facts.map((fact) => ({ label: fact.label, value: fact.value })),
        missing: deterministic.missingEvidence,
        caveats: deterministic.caveats,
        // What the deterministic answer MEANT. The verifier holds the narration
        // to it, so a fluent sentence that reverses the conclusion is discarded
        // rather than published.
        assertions: deterministic.assertions,
      },
      deterministic: deterministic.answer,
      // Public-context candidates must remain exactly UNVERIFIED. Withholding
      // the narrator makes an accidental candidate → verified rewrite
      // impossible rather than merely asking a verifier to notice one.
      provider:
        b20ScopeIsPrivateV1(plan.scope) || plan.intent === 'find_possible_public_context'
          ? null
          : b20RouteRuntime.narrator(),
    });
    if (
      narrated.narrationRejectedBecause &&
      !b20ScopeIsPrivateV1(plan.scope) &&
      plan.intent !== 'find_possible_public_context'
    ) {
      // Never logged for a private scope: the reason would name the intent and
      // the shape of a wallet's holdings, and nothing about that belongs in an
      // operator log.
      logger.info('b20 console narration not used', {
        scope: plan.scope,
        intent: plan.intent,
        because: narrated.narrationRejectedBecause,
      });
    }

    res.json(
      B20ConsoleAskResponseV1Schema.parse({
        schemaVersion: 'b20-console-answer/v1',
        scope: plan.scope,
        intent: plan.intent,
        answerSource: narrated.answerSource,
        answer: narrated.answer,
        facts: deterministic.facts,
        missingEvidence: deterministic.missingEvidence,
        caveats: deterministic.caveats,
        reads: deterministic.reads,
        serverTime: now.toISOString(),
      }),
    );
  } catch (error) {
    consoleAnswerFailure(res, error);
  }
});

/**
 * Stage 09 — Launch Context for one token.
 *
 * Its own route, reached on request. Not a field on the card and not a tab:
 * a surface with a Launch Context tab has to fill it, and the honest content
 * for almost every launch is "an address sent a transaction, and Miorail knows
 * nothing else about it". That belongs where somebody asked for it.
 */
export async function readB20LaunchContextV1(
  tokenAddress: string,
): Promise<B20LaunchContextModelV1 | null> {
  const observations = b20RouteRuntime.observations();
  const found = await observations.getFeedRowForToken({ tokenAddress, historyLimit: 1 });
  if (!found) return null;

  const deployers = b20RouteRuntime.deployers();
  const stored = await deployers.readDeployer(found.row.launch.id);

  const reading: B20DeployerReadingV1 = !stored
    ? { status: 'not_read' }
    : stored.deployerAddress === null
      ? { status: 'transaction_absent', readAt: stored.readAt }
      : {
          status: 'read',
          deployerAddress: stored.deployerAddress,
          relation: b20SenderRelationV1(stored.transactionTo),
          readAt: stored.readAt,
        };

  // The counting read runs only when the relation supports it. Fetching it
  // anyway and dropping it later would spend a query to produce something the
  // domain layer is required to throw away.
  let corpus: B20DeployerCorpusV1 | null = null;
  if (reading.status === 'read' && b20SenderSupportsCountingV1(reading.relation)) {
    const [counts, coverage] = await Promise.all([
      deployers.countsForDeployer({ deployerAddress: reading.deployerAddress, limit: 25 }),
      deployers.deployerCoverage(),
    ]);
    corpus = {
      launchCount: counts.launchCount,
      // Grouped by the SAME reason vocabulary the feed speaks, so a context
      // panel cannot invent a second set of words for one conclusion.
      standingSampleSize: counts.launches.length,
      standingCounts: [
        ...counts.launches.reduce((acc, launch) => {
          const kind = launch.state === null ? 'not_measured' : (launch.reasonCode ?? launch.state);
          acc.set(kind, (acc.get(kind) ?? 0) + 1);
          return acc;
        }, new Map<string, number>()),
      ].map(([kind, count]) => ({ kind, count })),
      coverage,
    };
  }

  // Claims are not implemented as a submission path yet, so there is never a
  // claim to read. `null` is the honest input and produces the default
  // standing — which is the resting state for almost every launch anyway.
  return b20LaunchContextV1({ reading, corpus, claim: null });
}

// ---------------------------------------------------------------------------
// Unverified public context, for one token, when a reader asks.
//
// Separate route from every other B20 read, and gated separately, because it is
// the only one that reaches a third party on a user's behalf. It never runs on
// a feed render and never in the background: a search costs money and a false
// link costs more, and both are bounded by somebody actually asking.
// ---------------------------------------------------------------------------
b20ControlRouter.get(
  '/opportunities/b20/:tokenAddress/public-context',
  async (req: Request, res: Response) => {
    const guard = b20Guard(req, res);
    if (!guard) return;

    const tokenAddress = String(req.params.tokenAddress ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(tokenAddress)) {
      res.status(400).json({ error: 'invalid_token_address', code: 'invalid_token_address' });
      return;
    }

    if (b20RouteRuntime.flags().b20PublicContextV1 !== true) {
      res.status(503).json({ error: 'public_context_disabled', code: 'public_context_disabled' });
      return;
    }

    // A reader may name the domain themselves. That path needs no vendor at all:
    // the question stops being "which page on the web is this project" — which is
    // the part a search is for — and becomes "does THIS page name this token",
    // which Miorail answers with its own fetch.
    const domain =
      typeof req.query.domain === 'string' && req.query.domain.trim().length > 0
        ? req.query.domain.trim()
        : null;
    const search = b20PublicContextSearchFromEnv();
    if (search === null && domain === null) {
      // "This server cannot look" is not "nothing was found". Only the second is
      // a statement about the token, and it is not this one.
      res
        .status(503)
        .json({ error: 'public_search_unconfigured', code: 'public_search_unconfigured' });
      return;
    }

    try {
      if (!(await b20RouteRuntime.discoverAvailable())) {
        res.status(503).json({ error: 'discover_unavailable', code: 'discover_unavailable' });
        return;
      }
      // The name and symbol come from the launch Miorail ingested, never from the
      // request: a caller who could supply them would be choosing what Miorail
      // asks the internet.
      const found = await b20RouteRuntime
        .observations()
        .getFeedRowForToken({ tokenAddress, historyLimit: 1 });
      if (!found) {
        res.status(404).json({ error: 'launch_not_found', code: 'launch_not_found' });
        return;
      }
      const context = await readB20PublicContextV1({
        chainId: 8453,
        tokenAddress,
        symbol: found.row.launch.symbol ?? null,
        name: found.row.launch.name ?? null,
        domain,
        // Never reached when a domain was named, and a refusal rather than a
        // silent no-op when it is missing and needed.
        deps: {
          search:
            search ??
            (async () => {
              throw new Error('no search provider');
            }),
          now: () => b20RouteRuntime.now(),
        },
      });
      res.json({
        schemaVersion: 'b20-public-context/v1',
        ...context,
        serverTime: b20RouteRuntime.now().toISOString(),
      });
    } catch (error) {
      if (error instanceof B20SuppliedDomainRefusedError) {
        // A named domain Miorail will not fetch. Refused with the reason, rather
        // than repaired into something the caller did not ask for.
        res
          .status(400)
          .json({ error: 'invalid_domain', code: 'invalid_domain', detail: error.refusal });
        return;
      }
      storageFailure(res, error, 'b20-public-context');
    }
  },
);

b20ControlRouter.get(
  '/opportunities/b20/:tokenAddress/context',
  async (req: Request, res: Response) => {
    const guard = b20Guard(req, res);
    if (!guard) return;

    const tokenAddress = String(req.params.tokenAddress ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(tokenAddress)) {
      res.status(400).json({ error: 'invalid_token_address', code: 'invalid_token_address' });
      return;
    }
    try {
      if (!(await b20RouteRuntime.discoverAvailable())) {
        res.status(503).json({ error: 'discover_unavailable', code: 'discover_unavailable' });
        return;
      }
      const context = await readB20LaunchContextV1(tokenAddress);
      if (!context) {
        res.status(404).json({ error: 'launch_not_found', code: 'launch_not_found' });
        return;
      }
      res.json(
        B20LaunchContextResponseV1Schema.parse({
          schemaVersion: 'b20-launch-context/v1',
          tokenAddress,
          ...context,
          serverTime: b20RouteRuntime.now().toISOString(),
        }),
      );
    } catch (error) {
      storageFailure(res, error, 'b20-launch-context');
    }
  },
);

b20ControlRouter.get('/opportunities/b20/:tokenAddress', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  const tokenAddress = String(req.params.tokenAddress ?? '').toLowerCase();
  // Malformed and unknown stay DISTINCT: one is a client mistake, the other is
  // a fact about the feed, and collapsing them hides both.
  if (!/^0x[0-9a-f]{40}$/.test(tokenAddress)) {
    res.status(400).json({ error: 'invalid_token_address', code: 'invalid_token_address' });
    return;
  }

  try {
    const available = await b20RouteRuntime.discoverAvailable();
    const now = b20RouteRuntime.now();
    if (!available) {
      res.status(503).json({ error: 'discover_unavailable', code: 'discover_unavailable' });
      return;
    }
    const pipeline = await pipelineStatusV1(b20RouteRuntime.observations(), now, true);
    // The one by-address read, shared with the public MCP. It also populates
    // the project layer, which this route was dropping while the list kept it.
    const found = await readB20CardForTokenV1(tokenAddress);
    if (!found) {
      // No CANONICAL launch for this address. Not "not a B20 token" — this
      // feed only knows what it ingested, and saying more would be a claim
      // nothing measured.
      res.status(404).json({ error: 'launch_not_found', code: 'launch_not_found' });
      return;
    }

    res.json(
      B20OpportunityDetailResponseV1Schema.parse({
        card: found.card,
        history: found.history.map((entry) => ({
          state: entry.state,
          reasonCode: entry.reasonCode,
          observationBlockNumber: entry.observationBlockNumber,
          optimisticRoundTripBps: entry.optimisticRoundTripBps,
          largestPassingSizeAtomic: entry.largestPassingSizeAtomic,
          measuredAt: entry.measuredAt,
          staleAfter: entry.staleAfter,
        })),
        pipeline,
        serverTime: now.toISOString(),
      }),
    );
  } catch (error) {
    storageFailure(res, error, 'b20-opportunity-detail');
  }
});

b20ControlRouter.post('/b20/inspect', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  const parsed = B20InspectRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: 'invalid_b20_inspect_request', code: 'invalid_b20_inspect_request' });
    return;
  }
  // Decided with no network access at all, so a malformed address never
  // becomes an RPC round trip.
  const refusal = validateB20InspectRequestV1(parsed.data.chainId, parsed.data.tokenAddress);
  if (refusal) {
    res.status(400).json({ error: refusal, code: refusal, detail: refusalDetailV1(refusal) });
    return;
  }
  if (!b20RouteRuntime.rpcConfigured()) {
    res.status(503).json({ error: 'b20_rpc_unavailable', code: 'b20_rpc_unavailable' });
    return;
  }

  try {
    if (!(await b20RouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'b20_storage_unavailable', code: 'b20_storage_unavailable' });
      return;
    }
    const repository = b20RouteRuntime.repository();
    const now = b20RouteRuntime.now();

    // Inside the TTL the stored snapshot IS the answer, and it is returned
    // marked as cached rather than re-read and re-presented as current.
    const ttl = b20RouteRuntime.ttlMs();
    const latest = await repository.latestSnapshot(guard.user.id, parsed.data.tokenAddress);
    if (latest && ttl > 0 && now.getTime() - Date.parse(latest.observedAt) < ttl) {
      // No watch on a cache hit: the answer IS the stored snapshot, so there is
      // no newer reading to compare it against. Returning an empty change list
      // here would say "nothing changed" on the strength of not having looked.
      respondV1(res, latest.snapshot, buildB20CardV1(latest.snapshot), true);
      return;
    }

    const result = await inspectB20TokenV1(
      { reader: b20RouteRuntime.reader() },
      {
        tenantId: guard.user.id,
        chainId: parsed.data.chainId,
        tokenAddress: parsed.data.tokenAddress,
        now,
      },
    );
    // A failed read is still recorded: "the endpoint did not answer at this
    // moment" is a fact worth having, and storing it keeps a retry storm from
    // looking like a series of different tokens.
    const stored = await repository.insertSnapshot({
      userId: guard.user.id,
      snapshot: result.snapshot,
    });
    // T67F — `latest` was read above, before this insert. Reading it afterwards
    // would compare the new snapshot against itself and report no change,
    // forever.
    const watch = diffB20SnapshotsV1(latest?.snapshot ?? null, stored.snapshot);
    respondV1(
      res,
      stored.snapshot,
      result.card,
      stored.snapshotHash !== result.snapshot.snapshotHash,
      watch,
    );
  } catch (error) {
    if (error instanceof B20RequestError) {
      res.status(400).json({ error: error.refusal, code: error.refusal, detail: error.message });
      return;
    }
    storageFailure(res, error, 'inspect');
  }
});

// ---------------------------------------------------------------------------
// POST /b20/watch — the Control Watch sweep over the tokens a caller holds.
//
// The client sends the addresses; the server never guesses a holdings list,
// because a wrong one would produce a watch page about somebody else's
// position. Read-only, like every route in this file.
//
// Three properties:
//
//   * Bounded. At most 25 tokens per request, each capped by the sweep TTL, and
//     the first RPC failure ends the sweep rather than retrying 24 more times
//     against an endpoint that is already failing. Whatever was not reached is
//     NAMED, so the page never implies it checked everything.
//   * A cache hit still produces a diff. Inside the TTL the two most recent
//     STORED snapshots are compared, so the page keeps showing the last real
//     change instead of going blank between reads.
//   * `not_b20` is an ordinary answer. Most tokens in a wallet are not B20, and
//     saying so is not a finding about them.
// ---------------------------------------------------------------------------
/**
 * The caller's balance of one B20 token, read from the token itself.
 *
 * One extra `eth_call` per watched token, and the reason it is worth it: no
 * balance provider indexes B20, so without this a wallet holding a B20 token is
 * reported as holding nothing. A failed read returns null and stays null — a
 * zero would be a claim about a position that was never measured.
 */
async function b20BalanceV1(
  reader: B20ReaderV1,
  snapshot: B20ControlSnapshotV1,
  holder: string,
): Promise<{ balanceAtomic: string | null; decimals: number | null }> {
  const decimals = b20DecimalsFromSnapshotV1(snapshot);
  if (snapshot.blockNumber === null) return { balanceAtomic: null, decimals };
  try {
    const result = await reader.call({
      to: snapshot.tokenAddress,
      data: b20BalanceOfCalldataV1(holder),
      // The SAME block as the controls. A balance from a later block beside
      // controls from an earlier one is two facts pretending to be one.
      blockTag: `0x${BigInt(snapshot.blockNumber).toString(16)}`,
    });
    return { balanceAtomic: result.ok ? decodeB20BalanceV1(result.value) : null, decimals };
  } catch {
    return { balanceAtomic: null, decimals };
  }
}

b20ControlRouter.post('/b20/watch', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  const parsed = B20WatchRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_b20_watch_request', code: 'invalid_b20_watch_request' });
    return;
  }
  if (!b20RouteRuntime.rpcConfigured()) {
    res.status(503).json({ error: 'b20_rpc_unavailable', code: 'b20_rpc_unavailable' });
    return;
  }

  try {
    if (!(await b20RouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'b20_storage_unavailable', code: 'b20_storage_unavailable' });
      return;
    }
    const repository = b20RouteRuntime.repository();
    const now = b20RouteRuntime.now();
    const ttl = b20RouteRuntime.watchTtlMs();
    // De-duplicated, because a portfolio can list the same address twice and
    // each duplicate would be a second paid read of the same fact.
    const tokens = [...new Set(parsed.data.tokens.map((token) => token.toLowerCase()))];

    // ONE reader for the whole sweep. Each token used to build its own, which
    // threw away the reader's pacing between tokens: the endpoint would throttle
    // token 1, the reader would learn to slow down, and token 2 would start
    // over at full speed and be throttled again. The state that survives here is
    // the backoff, the retry-after and whether the endpoint takes batches.
    const reader = b20RouteRuntime.reader();

    // ONE block for the whole sweep. Two fewer calls per token, but the reason
    // is that these snapshots are shown side by side: tokens read at different
    // blocks are not comparable, and nothing on the page could say so.
    const anchor = await reader.readBlockAnchor();
    if (!anchor.ok) {
      // A configured endpoint that did not answer is a different sentence from
      // no endpoint at all, and it is not a statement about any token.
      res.status(503).json({ error: 'b20_rpc_no_answer', code: 'b20_rpc_no_answer' });
      return;
    }

    // Resolved once, not per token: a server that has not run migration 0024
    // still sweeps, it just has no watchlist clock to update.
    const watchlist = (await b20RouteRuntime.watchlistAvailable())
      ? b20RouteRuntime.watchlist()
      : null;

    const results: unknown[] = [];
    const notChecked: string[] = [];
    let sweepStopped = false;
    const deadlineMs = b20RouteRuntime.watchDeadlineMs();
    const startedAt = b20RouteRuntime.monotonicMs();

    for (const token of tokens) {
      // Checked before each token rather than mid-token: a half-read card would
      // be stored as a snapshot and diffed against later, so the deadline may
      // only ever fall between tokens.
      if (!sweepStopped && b20RouteRuntime.monotonicMs() - startedAt >= deadlineMs)
        sweepStopped = true;
      if (sweepStopped) {
        notChecked.push(token);
        continue;
      }
      const refusal = validateB20InspectRequestV1(parsed.data.chainId, token);
      if (refusal) {
        results.push({
          tokenAddress: token,
          displayName: null,
          displaySymbol: null,
          outcome: 'unreadable',
          reason: refusalDetailV1(refusal),
        });
        continue;
      }

      const recent = await repository.recentSnapshots(guard.user.id, token, 2);
      const fresh =
        recent[0] && ttl > 0 && now.getTime() - Date.parse(recent[0].observedAt) < ttl
          ? recent[0]
          : null;

      if (fresh) {
        // Inside the TTL: compare the two most recent STORED snapshots. This is
        // why `recentSnapshots` exists — `latestSnapshot` alone would diff the
        // cached row against itself and report nothing, forever.
        const card = buildB20CardV1(fresh.snapshot);
        const balance =
          fresh.snapshot.detection.outcome === 'not_b20'
            ? { balanceAtomic: null, decimals: null }
            : await b20BalanceV1(reader, fresh.snapshot, guard.user.address);
        results.push({
          tokenAddress: token,
          displayName: card.displayName,
          displaySymbol: card.displaySymbol,
          outcome: fresh.snapshot.detection.outcome === 'not_b20' ? 'not_b20' : 'watched',
          watch: diffB20SnapshotsV1(recent[1]?.snapshot ?? null, fresh.snapshot),
          controls: exitControlsFromSnapshotV1(fresh.snapshot),
          ...balance,
          reason: null,
        });
        continue;
      }

      const result = await inspectB20TokenV1(
        { reader },
        {
          tenantId: guard.user.id,
          chainId: parsed.data.chainId,
          tokenAddress: token,
          now,
          anchor: anchor.value,
        },
      );
      if (result.snapshot.detection.outcome === 'rpc_failure') {
        // The endpoint is failing. Trying the remaining tokens would be 24 more
        // failures against it, so the sweep stops and says what it did not
        // reach rather than reporting them all as unreadable tokens.
        sweepStopped = true;
        results.push({
          tokenAddress: token,
          displayName: null,
          displaySymbol: null,
          outcome: 'unreadable',
          reason: 'The Base endpoint did not answer. This says nothing about the token.',
        });
        continue;
      }
      const previous = recent[0] ?? null;
      const stored = await repository.insertSnapshot({
        userId: guard.user.id,
        snapshot: result.snapshot,
      });
      // An interactive read counts as a read. Without this the background sweep
      // would re-read, minutes later, a token the user just paid to read — and
      // the page would still say "never checked by Miorail" beside it.
      if (watchlist) {
        await watchlist.recordSweep({
          id: b20WatchlistIdV1(guard.user.id, token),
          at: now,
          outcome: b20SweepOutcomeFromDetectionV1(stored.snapshot.detection.outcome),
        });
      }
      const balance =
        stored.snapshot.detection.outcome === 'not_b20'
          ? { balanceAtomic: null, decimals: null }
          : await b20BalanceV1(reader, stored.snapshot, guard.user.address);
      results.push({
        tokenAddress: token,
        displayName: result.card.displayName,
        displaySymbol: result.card.displaySymbol,
        outcome: stored.snapshot.detection.outcome === 'not_b20' ? 'not_b20' : 'watched',
        watch: diffB20SnapshotsV1(previous?.snapshot ?? null, stored.snapshot),
        controls: exitControlsFromSnapshotV1(stored.snapshot),
        ...balance,
        reason: null,
      });
    }

    res.json(
      B20WatchResponseV1Schema.parse({
        tokens: results,
        notChecked,
        checkedAt: now.toISOString(),
      }),
    );
  } catch (error) {
    if (error instanceof B20RequestError) {
      res.status(400).json({ error: error.refusal, code: error.refusal, detail: error.message });
      return;
    }
    storageFailure(res, error, 'watch');
  }
});

// ---------------------------------------------------------------------------
// T68B — the watchlist.
//
// The list a background sweep reads. It lives on the server for one reason: a
// sweep that runs on a timer has no browser to ask, so a watchlist in
// localStorage is a watchlist nothing can watch.
//
// Only addresses a user typed in go here. Miorail does not decide on anyone's
// behalf what is worth watching, and a list seeded from a portfolio feed would
// miss every B20 token anyway — none of them are indexed by a balance provider.
// ---------------------------------------------------------------------------

/** The shared head of the three watchlist routes: flag, session, migration. */
async function watchlistGuard(
  req: Request,
  res: Response,
): Promise<{
  user: NonNullable<ReturnType<typeof sessionUser>>;
  repository: B20WatchlistRepositoryV1;
} | null> {
  const guard = b20Guard(req, res);
  if (!guard) return null;
  if (!(await b20RouteRuntime.watchlistAvailable())) {
    res.status(503).json({ error: 'b20_watchlist_unavailable', code: 'b20_watchlist_unavailable' });
    return null;
  }
  return { user: guard.user, repository: b20RouteRuntime.watchlist() };
}

function watchlistBodyV1(entries: readonly B20WatchlistEntryV1[]) {
  return {
    tokens: entries.map((entry) => ({
      tokenAddress: entry.tokenAddress,
      addedAt: entry.createdAt,
      lastSweptAt: entry.lastSweptAt,
      lastOutcome: entry.lastOutcome,
    })),
    remaining: Math.max(0, B20_WATCHLIST_CAPACITY_V1 - entries.length),
  };
}

// ---------------------------------------------------------------------------
// T68D — the only endpoint that can certify a B20 entry.
//
// It quotes, simulates the entry, re-quotes the exit at the size the entry
// actually produced, simulates all four calls in one state, and stores a
// clearance only when the wallet's own decoded movements prove the round trip.
//
// The clearance is NOT an allowlist entry. It authorises one preparation for
// the wallet, token, profile and route it names, and expires. Ordinary
// arbitrary-ERC-20 routing stays unsupported either way.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T72-B §3 — the execution facades.
//
// Everything below the HTTP layer used to live inside these handlers. It was
// lifted out unchanged so a second surface (the authenticated MCP server) can
// run the SAME code rather than a second implementation of it.
//
// That is not tidiness. A second qualification path drifts, and it drifts in
// one direction: towards being more permissive, because the surface that
// reimplements it is the one that wanted an easier answer. So the private MCP
// tools do not get their own runner, their own gate, or their own view of what
// `qualified` means — they call these functions and render what comes back.
//
// A refusal carries the HTTP status the web route already used, so both
// surfaces agree on the difference between "not yours" (404) and "not allowed"
// (403), and neither invents a code the other has never seen.
// ---------------------------------------------------------------------------

export type B20FacadeRefusalV1 = { ok: false; status: number; code: string; detail?: string };
export type B20FacadeResultV1<T> = { ok: true; body: T } | B20FacadeRefusalV1;

/**
 * The ONE path that can produce a qualified clearance (§3).
 *
 * It quotes, simulates the entry, re-quotes the exit at the size the entry
 * actually produced, and simulates all four calls in one state — against the
 * asking wallet. A background Discover observation reaches none of this:
 * `provisional` was measured against a pool nobody had entered, and nothing
 * short of this function promotes it.
 */
export async function runOpportunitySimulationV1(input: {
  tenantId: string;
  walletAddress: string;
  chainId: number;
  tokenAddress: string;
  positionAtomic: string;
  maxRoundTripBps: number;
  maxExitSlippageBps: number;
}): Promise<B20FacadeResultV1<Record<string, unknown>>> {
  const refusal = validateB20InspectRequestV1(input.chainId, input.tokenAddress);
  if (refusal) return { ok: false, status: 400, code: refusal, detail: refusalDetailV1(refusal) };

  const profile = {
    quoteAsset: OPPORTUNITY_QUOTE_ASSET_V1,
    positionAtomic: input.positionAtomic,
    maxRoundTripBps: input.maxRoundTripBps,
    maxExitSlippageBps: input.maxExitSlippageBps,
  } as const;
  // The user's numbers, bounded by the server's. A profile outside the bounds
  // is refused with the field named, not clamped into something they did not
  // choose and then answered as if they had.
  const outOfBounds = profileRefusalV1(profile);
  if (outOfBounds) return { ok: false, status: 400, code: outOfBounds };
  if (!b20RouteRuntime.rpcConfigured())
    return { ok: false, status: 503, code: 'b20_rpc_unavailable' };
  if (!(await b20RouteRuntime.migrationAvailable())) {
    return { ok: false, status: 503, code: 'b20_storage_unavailable' };
  }

  const recent = await b20RouteRuntime
    .repository()
    .recentSnapshots(input.tenantId, input.tokenAddress, 1);
  const snapshot = recent[0]?.snapshot ?? null;
  if (!snapshot) {
    // Controls are prior to price, and prior to simulation. Certifying a
    // token whose controls were never read would clear one whose transfers
    // are paused.
    return {
      ok: false,
      status: 409,
      code: 'b20_controls_unread',
      detail:
        'This token’s controls have not been read yet. Check it once before simulating an entry.',
    };
  }
  const controls = exitControlsFromSnapshotV1(snapshot);
  const now = b20RouteRuntime.now();

  const controlRefusal = !controls.factoryConfirmed
    ? ('not_b20' as const)
    : !controls.controlsFullyRead
      ? ('controls_unreadable' as const)
      : controls.transfersPaused
        ? ('transfers_paused' as const)
        : controls.transferPolicyActive
          ? ('transfer_policy_may_block' as const)
          : null;
  if (controlRefusal) {
    // Refused before a single quote or simulation is spent.
    return {
      ok: true,
      body: B20OpportunitySimulateResponseV1Schema.parse({
        tokenAddress: input.tokenAddress,
        viability: 'rejected',
        rejectionReason: controlRefusal,
        unmeasuredReason: null,
        coverage: 'complete',
        viableRouteConfirmed: false,
        bestRouteConfirmed: false,
        clearanceId: null,
        expiresAt: null,
        simulatedRoundTripBps: null,
        simulatedReturnedAtomic: null,
        simulatedAcquiredAtomic: null,
        simulationBlockNumber: null,
        controlsBlockNumber: snapshot.blockNumber,
        checkedAt: now.toISOString(),
      }),
    };
  }

  const run = await b20RouteRuntime.runOpportunity(
    { reader: b20RouteRuntime.aerodromeReader(), now: () => now },
    {
      wallet: input.walletAddress as `0x${string}`,
      tokenAddress: input.tokenAddress as `0x${string}`,
      profile,
    },
  );

  let clearanceId: string | null = null;
  let expiresAt: string | null = null;
  if (
    run.certified.outcome.viability === 'qualified' &&
    run.entryRoute &&
    run.exitRoute &&
    run.calls &&
    run.simulationEvidenceHash &&
    snapshot.blockNumber
  ) {
    if (await b20RouteRuntime.clearanceAvailable()) {
      const clearance = buildClearanceV1({
        id: `b20-clearance:${stableHashV1('b20-clearance-id/v1', {
          tenantId: input.tenantId,
          token: input.tokenAddress,
          evidence: run.simulationEvidenceHash,
        }).slice(2, 34)}`,
        tenantId: input.tenantId,
        walletAddress: input.walletAddress,
        tokenAddress: input.tokenAddress,
        profile,
        controlSnapshotHash: snapshot.snapshotHash,
        controlBlockNumber: snapshot.blockNumber,
        entryRoute: run.entryRoute,
        exitRoute: run.exitRoute,
        calls: run.calls,
        simulationEvidenceHash: run.simulationEvidenceHash,
        certified: run.certified,
        now,
      });
      const stored = await b20RouteRuntime.clearances().insertClearance(clearance);
      clearanceId = stored.id;
      expiresAt = stored.expiresAt;
    }
  }

  const outcome = run.certified.outcome;
  return {
    ok: true,
    body: B20OpportunitySimulateResponseV1Schema.parse({
      tokenAddress: input.tokenAddress,
      viability: outcome.viability,
      rejectionReason: outcome.viability === 'rejected' ? outcome.reason : null,
      unmeasuredReason: outcome.viability === 'unmeasured' ? outcome.reason : null,
      coverage: run.certified.coverage.coverage,
      viableRouteConfirmed: run.certified.coverage.viableRouteConfirmed,
      bestRouteConfirmed: run.certified.coverage.bestRouteConfirmed,
      clearanceId,
      expiresAt,
      simulatedRoundTripBps: run.certified.simulatedRoundTripBps,
      simulatedReturnedAtomic: run.certified.simulatedReturnedAtomic,
      simulatedAcquiredAtomic: run.certified.simulatedAcquiredAtomic,
      simulationBlockNumber: run.certified.simulationBlockNumber,
      controlsBlockNumber: snapshot.blockNumber,
      checkedAt: now.toISOString(),
    }),
  };
}

/** Maps a facade refusal onto the response shape both surfaces already use. */
function facadeRefusalV1(res: Response, refusal: B20FacadeRefusalV1): void {
  res.status(refusal.status).json({
    error: refusal.code,
    code: refusal.code,
    ...(refusal.detail ? { detail: refusal.detail } : {}),
  });
}

// ---------------------------------------------------------------------------
// The one operation in this product worth charging for.
//
// Everything else Miorail does either has a free equivalent elsewhere (a swap
// with more routers, in any wallet) or is a safety check on a transaction the
// user is about to sign, which must never be metered. This is neither: it is
// the sequential simulation of BOTH legs against one state — the only thing
// that can promote a measurement to `qualified`, and the answer no other tool
// on Base gives.
//
// Built once at module load, like the swap gateway it replaces. Fails closed:
// with the surface off, or the price unreadable, no x402 challenge is ever
// issued and no money is at risk.
// ---------------------------------------------------------------------------
function buildB20SimulatePaymentMiddlewareV1(env: NodeJS.ProcessEnv = process.env) {
  // Off is not an error. The simulation stays available unpaid, exactly as it
  // was before this surface existed — turning the charge on is the deliberate
  // act, not turning it off.
  if (!paidB20SimulationEnabledV1(env)) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  const pricing = resolvePaidB20SimulationPricingV1(env);
  if (!pricing) {
    // A price that cannot be parsed must never become "free": it is a
    // misconfiguration, and answering as though the operation were unpriced
    // would give away the one thing this product sells.
    return (_req: Request, res: Response) => {
      res.status(503).json({ error: 'b20_simulation_unpriced', code: 'b20_simulation_unpriced' });
    };
  }
  return createX402MiddlewareFromEnv(
    {
      routePath: '/route-intelligence/b20/opportunity/simulate',
      serviceName: 'Miorail B20 Exit Proof',
      amountAtomicOverride: pricing.amountAtomic,
    },
    env,
  );
}

export const b20SimulatePaymentRuntimeV1 = {
  // Overridable so tests can exercise both the paid and unpaid paths without
  // reaching a facilitator — the same seam every other runtime here uses.
  middleware: buildB20SimulatePaymentMiddlewareV1(),
};

b20ControlRouter.post(
  '/b20/opportunity/simulate',
  (req: Request, res: Response, next: NextFunction) =>
    b20SimulatePaymentRuntimeV1.middleware(req, res, next),
  async (req: Request, res: Response) => {
    const guard = b20Guard(req, res);
    if (!guard) return;

    const parsed = B20OpportunitySimulateRequestV1Schema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          error: 'invalid_b20_opportunity_request',
          code: 'invalid_b20_opportunity_request',
        });
      return;
    }

    try {
      const result = await runOpportunitySimulationV1({
        tenantId: guard.user.id,
        walletAddress: guard.user.address,
        chainId: parsed.data.chainId,
        tokenAddress: parsed.data.tokenAddress,
        positionAtomic: parsed.data.positionAtomic,
        maxRoundTripBps: parsed.data.maxRoundTripBps,
        maxExitSlippageBps: parsed.data.maxExitSlippageBps,
      });
      if (!result.ok) {
        facadeRefusalV1(res, result);
        return;
      }
      res.json(result.body);
    } catch (error) {
      storageFailure(res, error, 'opportunity-simulate');
    }
  },
);

// ---------------------------------------------------------------------------
// T68E — consuming a clearance in a verified entry plan.
//
// A clearance is permission to ATTEMPT a preparation, never permission to reuse
// the numbers that earned it. Before anything reaches a wallet this route
// re-reads the token's controls, re-quotes the exact cleared route, rebuilds
// every byte server-side, runs a strict kernel over the result and simulates
// the precise calls on offer. Any one of those failing returns a refusal that
// NAMES the binding rather than a plan.
//
// Nothing here signs or broadcasts. The response is unsigned calls for the
// user's own Base Account to approve, or nothing at all.
// ---------------------------------------------------------------------------

/**
 * T72-B §4 — clearance → prepare → persisted plan → kernel → exact-call
 * simulation, as one function both surfaces call.
 *
 * It returns the plan's PROJECTION and never its calls. That was already true
 * of the web route; it matters more now, because the caller on the other side
 * may be a language model, and the difference between "here is what this plan
 * does" and "here are the bytes" is the difference between a review and a
 * transaction.
 */
export async function prepareEntryFromClearanceV1(input: {
  tenantId: string;
  walletAddress: string;
  clearanceId: string;
  chainId: number;
  profileIdentity: string;
  requestId: string;
}): Promise<B20FacadeResultV1<Record<string, unknown>>> {
  if (!b20RouteRuntime.rpcConfigured())
    return { ok: false, status: 503, code: 'b20_rpc_unavailable' };
  if (!(await b20RouteRuntime.clearanceAvailable())) {
    return { ok: false, status: 503, code: 'b20_clearance_unavailable' };
  }
  if (!(await b20RouteRuntime.entryPlanAvailable())) {
    return { ok: false, status: 503, code: 'b20_entry_plan_unavailable' };
  }
  const now = b20RouteRuntime.now();
  const clearanceId = input.clearanceId;
  const plans = b20RouteRuntime.entryPlans();

  // §2 — the idempotency lookup runs BEFORE any quoting. A retry must return
  // the stored plan, not re-quote the pool and offer different numbers to a
  // user who only refreshed.
  const replay = await plans.findByIdempotency({
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    clearanceId,
    requestId: input.requestId,
  });
  if (replay) {
    const replayCapabilities = await b20RouteRuntime.executionCapabilities();
    return {
      ok: true,
      body: B20EntryPrepareResponseV1Schema.parse({
        outcome: 'prepared',
        refusalReason: null,
        refusalDetail: null,
        clearanceId,
        blueprintHash: replay.blueprintHash,
        tokenAddress: replay.tokenAddress,
        positionAtomic: replay.positionAtomic,
        expectedOutputAtomic: replay.expectedOutputAtomic,
        minimumOutputAtomic: replay.minimumOutputAtomic,
        entrySourceKey: replay.entrySourceKey,
        coverage: replay.coverage,
        viableRouteConfirmed: replay.viableRouteConfirmed,
        bestRouteConfirmed: replay.bestRouteConfirmed,
        certifiedControlBlockNumber: replay.certificationBlockNumber,
        prepareControlBlockNumber: replay.prepareControlBlockNumber,
        clearanceExpiresAt: replay.clearanceExpiresAt,
        // The executable bytes are NOT replayed. They live server-side until
        // a submission path exists to use them; a Review reads the
        // projection.
        calls: null,
        preparedAt: replay.createdAt,
        planId: replay.id,
        review: b20EntryReviewV1(replay, replayCapabilities),
        executionAvailable: entryExecutionAvailableV1(replayCapabilities),
        executionUnavailableReason: entryExecutionAvailableV1(replayCapabilities)
          ? null
          : 'submission_not_wired',
      }),
    };
  }

  const clearance = await b20RouteRuntime.clearances().getClearance(clearanceId, input.tenantId);

  const prepared = await b20RouteRuntime.prepareEntry(
    {
      b20Reader: b20RouteRuntime.reader(),
      aerodromeReader: b20RouteRuntime.aerodromeReader(),
      now: () => now,
    },
    {
      clearance,
      tenantId: input.tenantId,
      walletAddress: input.walletAddress,
      chainId: input.chainId,
      profileIdentity: input.profileIdentity,
    },
  );

  // §1/§7 — a successful preparation becomes a stored immutable entity
  // before it is described to anyone. Persisting from the SERVER's own
  // blueprint, clearance, controls and simulation: the request contributed a
  // clearance id, a profile identity and a request id, and nothing else.
  const capabilities = await b20RouteRuntime.executionCapabilities();
  const capabilitiesAvailable = entryExecutionAvailableV1(capabilities);
  let stored: Awaited<ReturnType<typeof plans.insertPreparedPlan>> | null = null;
  if (prepared.blueprint && (!clearance || !prepared.simulation)) {
    // Unreachable through the runner, which refuses a plan it could not
    // simulate. Stated anyway: a blueprint that cannot be stored with the
    // evidence that justified it is never described as prepared, because
    // "prepared" is about to mean "there is a row a wallet can be asked to
    // sign against".
    return { ok: false, status: 500, code: 'storage_integrity' };
  }
  if (prepared.blueprint && clearance && prepared.simulation) {
    const draft = buildPreparedPlanV1({
      clearance,
      blueprint: prepared.blueprint,
      simulation: prepared.simulation,
      tokenName: prepared.tokenName,
      tokenSymbol: prepared.tokenSymbol,
      tokenDecimals: prepared.tokenDecimals,
      requestId: input.requestId,
      now,
    });
    stored = await plans.insertPreparedPlan(draft);
  }

  return {
    ok: true,
    body: B20EntryPrepareResponseV1Schema.parse({
      outcome: prepared.blueprint ? 'prepared' : 'refused',
      refusalReason: prepared.refusal,
      refusalDetail: prepared.detail,
      clearanceId,
      blueprintHash: prepared.blueprint?.blueprintHash ?? null,
      tokenAddress: clearance?.tokenAddress ?? prepared.tokenAddress,
      positionAtomic: clearance?.positionAtomic ?? '1',
      expectedOutputAtomic: prepared.blueprint?.expectedOutputAtomic ?? null,
      minimumOutputAtomic: prepared.blueprint?.minimumOutputAtomic ?? null,
      entrySourceKey: prepared.blueprint?.entrySourceKey ?? null,
      coverage: prepared.blueprint?.coverage ?? clearance?.coverage ?? null,
      viableRouteConfirmed: clearance?.viableRouteConfirmed ?? false,
      bestRouteConfirmed: clearance?.bestRouteConfirmed ?? false,
      certifiedControlBlockNumber: clearance?.controlBlockNumber ?? null,
      prepareControlBlockNumber: prepared.blueprint?.prepareControlBlockNumber ?? null,
      clearanceExpiresAt: clearance?.expiresAt ?? now.toISOString(),
      // T68F-B §12 — executable bytes leave this server through ONE contract:
      // the wallet action on begin-submission. Preparation describes a plan;
      // it does not hand out a transaction, so a card cannot submit directly.
      calls: null,
      preparedAt: now.toISOString(),
      planId: stored?.plan.id ?? null,
      review: stored ? b20EntryReviewV1(stored.plan, capabilities) : null,
      // Availability is a fact about this surface, never an inference from
      // the plan holding unsigned calls. When false it is not a provider
      // failure and not a token rejection — the plan is sound.
      executionAvailable: stored ? capabilitiesAvailable : false,
      executionUnavailableReason: stored && !capabilitiesAvailable ? 'submission_not_wired' : null,
    }),
  };
}

b20ControlRouter.post(
  '/opportunities/:clearanceId/prepare-entry',
  async (req: Request, res: Response) => {
    const guard = b20Guard(req, res);
    if (!guard) return;

    const parsed = B20EntryPrepareRequestV1Schema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid_b20_entry_request', code: 'invalid_b20_entry_request' });
      return;
    }

    try {
      const result = await prepareEntryFromClearanceV1({
        tenantId: guard.user.id,
        walletAddress: guard.user.address,
        clearanceId: String(req.params.clearanceId ?? ''),
        chainId: parsed.data.chainId,
        profileIdentity: parsed.data.profileIdentity,
        requestId: parsed.data.requestId,
      });
      if (!result.ok) {
        facadeRefusalV1(res, result);
        return;
      }
      res.json(result.body);
    } catch (error) {
      storageFailure(res, error, 'prepare-entry');
    }
  },
);

/**
 * §9 — the authenticated read.
 *
 * Tenant- AND wallet-scoped by the repository, not by a check here: another
 * wallet receives exactly what a nonexistent plan receives, because the
 * difference between "not yours" and "not there" is itself information.
 *
 * It returns the projection, never the unsigned calldata. Executable bytes
 * leave the server only through the guarded begin-submission endpoint below.
 */
b20ControlRouter.get('/opportunities/entry-plans/:planId', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  try {
    if (!(await b20RouteRuntime.entryPlanAvailable())) {
      res
        .status(503)
        .json({ error: 'b20_entry_plan_unavailable', code: 'b20_entry_plan_unavailable' });
      return;
    }
    const plan = await b20RouteRuntime.entryPlans().getPreparedPlan({
      planId: String(req.params.planId ?? ''),
      tenantId: guard.user.id,
      walletAddress: guard.user.address,
    });
    if (!plan) {
      res.status(404).json({ error: 'b20_entry_plan_not_found', code: 'b20_entry_plan_not_found' });
      return;
    }
    const capabilities = await b20RouteRuntime.executionCapabilities();
    const review = b20EntryReviewV1(plan, capabilities);
    const attempt = await b20RouteRuntime
      .entrySubmissions()
      .latestForPlan({ planId: plan.id, tenantId: guard.user.id });
    const proof =
      capabilities.routeProofWired && attempt
        ? await b20RouteRuntime.entryProofs().getProofForAttempt({
            attemptId: attempt.id,
            tenantId: guard.user.id,
          })
        : null;
    res.json(
      B20EntryPlanResponseV1Schema.parse({
        review,
        expiresAt: plan.expiresAt,
        // Derived from the clock, never stored: recording the passage of time
        // by rewriting immutable evidence would destroy the evidence.
        expired: Date.parse(plan.expiresAt) <= b20RouteRuntime.now().getTime(),
        executionAvailable: review.executionAvailable,
        executionUnavailableReason: review.executionUnavailableReason,
        // A refresh reads the ATTEMPT, so a submitted entry never looks
        // prepared again just because the tab was reloaded.
        status: entryStatusViewV1({ plan, attempt, capabilities, now: b20RouteRuntime.now() }),
        routeProof: b20EntryProofSummaryV1(proof),
      }),
    );
  } catch (error) {
    storageFailure(res, error, 'entry-plan-read');
  }
});

/**
 * Loads one plan, wallet-scoped.
 *
 * The scoping is in the QUERY, not in a check afterwards: another wallet
 * receives exactly what a nonexistent plan receives, because the difference
 * between "not yours" and "not there" is itself information — and on the MCP
 * surface that information would be an assistant confirming that a stranger's
 * plan exists.
 */
export async function loadEntryPlanV1(input: {
  tenantId: string;
  walletAddress: string;
  planId: string;
}): Promise<B20FacadeResultV1<B20PreparedEntryPlanV1>> {
  if (!(await b20RouteRuntime.entryPlanAvailable())) {
    return { ok: false, status: 503, code: 'b20_entry_plan_unavailable' };
  }
  const plan = await b20RouteRuntime.entryPlans().getPreparedPlan({
    planId: input.planId,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
  });
  if (!plan) return { ok: false, status: 404, code: 'b20_entry_plan_not_found' };
  return { ok: true, body: plan };
}

/** The shared head of every submission route. */
async function entryPlanGuard(req: Request, res: Response) {
  const guard = b20Guard(req, res);
  if (!guard) return null;
  const loaded = await loadEntryPlanV1({
    tenantId: guard.user.id,
    walletAddress: guard.user.address,
    planId: String(req.params.planId ?? ''),
  });
  if (!loaded.ok) {
    facadeRefusalV1(res, loaded);
    return null;
  }
  return { user: guard.user, plan: loaded.body };
}

/**
 * T68F-B 2/3, T72-B §5 — open a submission and produce the wallet request.
 *
 * The caller contributes a chain id, a profile identity and an idempotency
 * handle. It contributes NO calls, no calldata, no router, no recipient and no
 * amount: every executable byte is recovered from the stored plan by id. That
 * was already true when the caller was a browser; it is the whole security
 * argument now that the caller may be a language model.
 *
 * A gate refusal is not an HTTP error — the plan exists and the caller is
 * entitled to know where it stands — so the refusal travels in the body with
 * its own status, and both surfaces render the same reason.
 */
export interface BeginSubmissionResultV1 {
  httpStatus: number;
  body: Record<string, unknown>;
  outcome: 'ready' | 'refused';
  reason: string | null;
  /** The exact persisted calls, present only on `ready`. */
  payload: EntryWalletPayloadV1 | null;
  attemptId: string | null;
}

export async function beginEntrySubmissionV1(input: {
  tenantId: string;
  walletAddress: string;
  plan: B20PreparedEntryPlanV1;
  chainId: number;
  profileIdentity: string;
  attemptRequestId: string;
}): Promise<BeginSubmissionResultV1> {
  const now = b20RouteRuntime.now();
  const capabilities = await b20RouteRuntime.executionCapabilities();
  const submissions = b20RouteRuntime.entrySubmissions();
  const plan = input.plan;
  const existing = await submissions.latestForPlan({ planId: plan.id, tenantId: input.tenantId });

  const refused = (reason: string, detail: string, httpStatus = 200): BeginSubmissionResultV1 => ({
    httpStatus,
    outcome: 'refused',
    reason,
    payload: null,
    attemptId: null,
    body: B20EntryBeginSubmissionResponseV1Schema.parse({
      outcome: 'refused',
      reason,
      detail,
      status: entryStatusViewV1({ plan, attempt: existing, capabilities, now }),
    }),
  });

  if (!entryExecutionAvailableV1(capabilities)) {
    return refused('submission_not_wired', 'Submission is not available on this server.', 503);
  }

  // An attempt that already holds this plan's slot is RETURNED, never
  // replaced. A double click, a remount and a retried fetch all land here.
  if (existing && existing.status === 'awaiting_wallet_approval') {
    const proof = await ensureB20EntryRouteProofV1({
      repository: b20RouteRuntime.entryProofs(),
      plan,
      attempt: existing,
      now,
    });
    return {
      httpStatus: 200,
      outcome: 'ready',
      reason: null,
      payload: entryWalletPayloadV1(plan),
      attemptId: existing.id,
      body: B20EntryBeginSubmissionResponseV1Schema.parse({
        outcome: 'ready',
        attemptId: existing.id,
        payload: entryWalletPayloadV1(plan),
        review: b20EntryReviewV1(plan, capabilities),
        status: entryStatusViewV1({ plan, attempt: existing, capabilities, now }),
        routeProof: b20EntryProofSummaryV1(proof),
      }),
    };
  }

  const clearance = await b20RouteRuntime
    .clearances()
    .getClearance(plan.clearanceId, input.tenantId);
  const gate = submitGateRefusalV1({
    plan,
    clearance,
    walletAddress: input.walletAddress,
    tenantId: input.tenantId,
    chainId: input.chainId,
    profileIdentity: input.profileIdentity,
    // §11 — not "is there a live attempt?" but "has this plan's one slot been
    // taken?". A succeeded, reverted or unresolved attempt keeps it.
    hasLiveAttempt: attemptHoldsPlanSlotV1(existing),
    now,
    // The prepare-time control read is what this plan was built on, and a
    // plan is short-lived precisely so this stays close to now.
    controlsReadAt: new Date(Date.parse(plan.createdAt)),
  });
  if (gate) return refused(gate, SUBMIT_REFUSAL_COPY_V1[gate]);

  const attempt = await openAttemptV1({
    submissions,
    plan,
    attemptRequestId: input.attemptRequestId,
    now,
  });
  // A proof exists BEFORE executable bytes leave the server. If this write
  // fails, no wallet payload is returned; a retry recovers the same attempt
  // and completes this deterministic insert.
  const proof = await ensureB20EntryRouteProofV1({
    repository: b20RouteRuntime.entryProofs(),
    plan,
    attempt,
    now,
  });
  return {
    httpStatus: 200,
    outcome: 'ready',
    reason: null,
    // The only place executable bytes leave this server, and they are always
    // the stored ones.
    payload: entryWalletPayloadV1(plan),
    attemptId: attempt.id,
    body: B20EntryBeginSubmissionResponseV1Schema.parse({
      outcome: 'ready',
      attemptId: attempt.id,
      payload: entryWalletPayloadV1(plan),
      review: b20EntryReviewV1(plan, capabilities),
      status: entryStatusViewV1({ plan, attempt, capabilities, now }),
      routeProof: b20EntryProofSummaryV1(proof),
    }),
  };
}

b20ControlRouter.post(
  '/opportunities/entry-plans/:planId/begin-submission',
  async (req: Request, res: Response) => {
    const parsedBody = B20EntryBeginSubmissionRequestV1Schema.safeParse(req.body);
    if (!parsedBody.success) {
      res
        .status(400)
        .json({ error: 'invalid_b20_submission_request', code: 'invalid_b20_submission_request' });
      return;
    }
    const guard = await entryPlanGuard(req, res);
    if (!guard) return;

    try {
      const result = await beginEntrySubmissionV1({
        tenantId: guard.user.id,
        walletAddress: guard.user.address,
        plan: guard.plan,
        chainId: parsedBody.data.chainId,
        profileIdentity: parsedBody.data.profileIdentity,
        attemptRequestId: parsedBody.data.attemptRequestId,
      });
      res.status(result.httpStatus).json(result.body);
    } catch (error) {
      storageFailure(res, error, 'begin-submission');
    }
  },
);

/**
 * T68F-B 6/8, T72-B §7 — record what the WALLET did.
 *
 * The caller reports the wallet's behaviour, never a result: neither a browser
 * nor an MCP client can tell this server that a transaction succeeded. The only
 * fact it contributes that the server did not already have is the batch id.
 */
export async function recordEntrySubmissionV1(input: {
  tenantId: string;
  walletAddress: string;
  plan: B20PreparedEntryPlanV1;
  attemptId: string;
  result: WalletReportV1;
  batchId: string | null;
}): Promise<B20FacadeResultV1<Record<string, unknown>>> {
  const now = b20RouteRuntime.now();
  const capabilities = await b20RouteRuntime.executionCapabilities();
  const submissions = b20RouteRuntime.entrySubmissions();
  const attempt = await submissions.getAttempt({
    attemptId: input.attemptId,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
  });
  if (!attempt || attempt.planId !== input.plan.id) {
    return { ok: false, status: 404, code: 'b20_entry_attempt_not_found' };
  }

  const updated = await recordWalletReportV1({
    submissions,
    attempt,
    report: input.result,
    batchId: input.batchId,
    now,
  });
  if (!updated) return { ok: false, status: 409, code: 'b20_entry_submission_conflict' };
  const proof = await syncB20EntryRouteProofV1({
    repository: b20RouteRuntime.entryProofs(),
    plan: input.plan,
    attempt: updated,
    now,
  });

  return {
    ok: true,
    body: B20EntryStatusResponseV1Schema.parse({
      review: b20EntryReviewV1(input.plan, capabilities),
      status: entryStatusViewV1({ plan: input.plan, attempt: updated, capabilities, now }),
      routeProof: b20EntryProofSummaryV1(proof),
      expiresAt: input.plan.expiresAt,
      expired: Date.parse(input.plan.expiresAt) <= now.getTime(),
    }),
  };
}

b20ControlRouter.post(
  '/opportunities/entry-plans/:planId/record-submission',
  async (req: Request, res: Response) => {
    const parsedBody = B20EntryRecordSubmissionRequestV1Schema.safeParse(req.body);
    if (!parsedBody.success) {
      res
        .status(400)
        .json({ error: 'invalid_b20_submission_request', code: 'invalid_b20_submission_request' });
      return;
    }
    // A batch id belongs to a submission and to nothing else. A rejection that
    // named one would be claiming something reached the chain.
    const body = parsedBody.data;
    if ((body.result === 'submitted') !== (body.batchId !== null)) {
      res
        .status(400)
        .json({ error: 'invalid_b20_submission_request', code: 'invalid_b20_submission_request' });
      return;
    }
    const guard = await entryPlanGuard(req, res);
    if (!guard) return;

    try {
      const result = await recordEntrySubmissionV1({
        tenantId: guard.user.id,
        walletAddress: guard.user.address,
        plan: guard.plan,
        attemptId: body.attemptId,
        result: body.result,
        batchId: body.batchId,
      });
      if (!result.ok) {
        facadeRefusalV1(res, result);
        return;
      }
      res.json(result.body);
    } catch (error) {
      storageFailure(res, error, 'record-submission');
    }
  },
);

/** One read-only reconciliation pass. The browser can identify transactions
 * reported by wallet_getCallsStatus, but it cannot declare success: receipt
 * status, gas, block and ERC-20 movements are re-read on Base by the server. */
export async function reconcileEntrySubmissionV1(input: {
  tenantId: string;
  walletAddress: string;
  plan: B20PreparedEntryPlanV1;
  attemptId: string;
  transactionHashes: string[];
}): Promise<B20FacadeResultV1<Record<string, unknown>>> {
  const now = b20RouteRuntime.now();
  const capabilities = await b20RouteRuntime.executionCapabilities();
  if (!entryExecutionAvailableV1(capabilities)) {
    return { ok: false, status: 503, code: 'b20_entry_reconciliation_unavailable' };
  }
  const submissions = b20RouteRuntime.entrySubmissions();
  const attempt = await submissions.getAttempt({
    attemptId: input.attemptId,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
  });
  if (!attempt || attempt.planId !== input.plan.id) {
    return { ok: false, status: 404, code: 'b20_entry_attempt_not_found' };
  }
  const updated = await reconcileB20EntryFromBaseV1({
    reader: b20RouteRuntime.receiptReader(),
    submissions,
    proofs: b20RouteRuntime.entryProofs(),
    plan: input.plan,
    attempt,
    transactionHashes: input.transactionHashes,
    now,
  });
  const proof = await b20RouteRuntime.entryProofs().getProofForAttempt({
    attemptId: updated.id,
    tenantId: input.tenantId,
  });
  return {
    ok: true,
    body: B20EntryStatusResponseV1Schema.parse({
      review: b20EntryReviewV1(input.plan, capabilities),
      status: entryStatusViewV1({ plan: input.plan, attempt: updated, capabilities, now }),
      routeProof: b20EntryProofSummaryV1(proof),
      expiresAt: input.plan.expiresAt,
      expired: Date.parse(input.plan.expiresAt) <= now.getTime(),
    }),
  };
}

b20ControlRouter.post(
  '/opportunities/entry-plans/:planId/reconcile-submission',
  async (req: Request, res: Response) => {
    const parsedBody = B20EntryReconcileSubmissionRequestV1Schema.safeParse(req.body);
    if (!parsedBody.success) {
      res
        .status(400)
        .json({
          error: 'invalid_b20_reconciliation_request',
          code: 'invalid_b20_reconciliation_request',
        });
      return;
    }
    const guard = await entryPlanGuard(req, res);
    if (!guard) return;
    try {
      const result = await reconcileEntrySubmissionV1({
        tenantId: guard.user.id,
        walletAddress: guard.user.address,
        plan: guard.plan,
        attemptId: parsedBody.data.attemptId,
        transactionHashes: parsedBody.data.transactionHashes,
      });
      if (!result.ok) {
        facadeRefusalV1(res, result);
        return;
      }
      res.json(result.body);
    } catch (error) {
      storageFailure(res, error, 'reconcile-submission');
    }
  },
);

/** T68F-B 9/11, T72-B §8 — where did it get to. A refresh reads storage, so a
 * submitted entry never returns to `review`. */
export async function readEntryPlanStatusV1(input: {
  tenantId: string;
  plan: B20PreparedEntryPlanV1;
}): Promise<Record<string, unknown>> {
  const now = b20RouteRuntime.now();
  const capabilities = await b20RouteRuntime.executionCapabilities();
  const attempt = await b20RouteRuntime
    .entrySubmissions()
    .latestForPlan({ planId: input.plan.id, tenantId: input.tenantId });
  const proof =
    capabilities.routeProofWired && attempt
      ? await b20RouteRuntime.entryProofs().getProofForAttempt({
          attemptId: attempt.id,
          tenantId: input.tenantId,
        })
      : null;
  return B20EntryStatusResponseV1Schema.parse({
    review: b20EntryReviewV1(input.plan, capabilities),
    status: entryStatusViewV1({ plan: input.plan, attempt, capabilities, now }),
    routeProof: b20EntryProofSummaryV1(proof),
    expiresAt: input.plan.expiresAt,
    expired: Date.parse(input.plan.expiresAt) <= now.getTime(),
  });
}

b20ControlRouter.get(
  '/opportunities/entry-plans/:planId/status',
  async (req: Request, res: Response) => {
    const guard = await entryPlanGuard(req, res);
    if (!guard) return;
    try {
      res.json(await readEntryPlanStatusV1({ tenantId: guard.user.id, plan: guard.plan }));
    } catch (error) {
      storageFailure(res, error, 'entry-plan-status');
    }
  },
);

b20ControlRouter.get('/b20/watchlist', async (req: Request, res: Response) => {
  const guard = await watchlistGuard(req, res);
  if (!guard) return;
  try {
    const entries = await guard.repository.listForUser(guard.user.id);
    res.json(B20WatchlistResponseV1Schema.parse(watchlistBodyV1(entries)));
  } catch (error) {
    storageFailure(res, error, 'watchlist');
  }
});

b20ControlRouter.post('/b20/watchlist', async (req: Request, res: Response) => {
  const guard = await watchlistGuard(req, res);
  if (!guard) return;

  const parsed = B20WatchlistAddRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: 'invalid_b20_watchlist_request', code: 'invalid_b20_watchlist_request' });
    return;
  }
  // Refused before any write, for the same reason inspection refuses it: a
  // malformed address is a caller error, not a fact about a token.
  const refusal = validateB20InspectRequestV1(parsed.data.chainId, parsed.data.tokenAddress);
  if (refusal) {
    res.status(400).json({ error: refusal, code: refusal, detail: refusalDetailV1(refusal) });
    return;
  }

  try {
    await guard.repository.addToken({
      userId: guard.user.id,
      tokenAddress: parsed.data.tokenAddress,
      now: b20RouteRuntime.now(),
    });
    // The whole list comes back, not just the new row: the cap and the sweep
    // clock belong to the list, and a surface that patched one entry in would
    // have to recompute both from a state it does not own.
    res
      .status(201)
      .json(
        B20WatchlistResponseV1Schema.parse(
          watchlistBodyV1(await guard.repository.listForUser(guard.user.id)),
        ),
      );
  } catch (error) {
    if (error instanceof RouteStorageConflictError) {
      // 409, not 400: the request was well formed and the account is simply
      // full. The detail names the cap so the user knows what to do about it.
      res.status(409).json({
        error: 'b20_watchlist_full',
        code: 'b20_watchlist_full',
        detail: error.message,
      });
      return;
    }
    storageFailure(res, error, 'watchlist');
  }
});

b20ControlRouter.delete('/b20/watchlist/:tokenAddress', async (req: Request, res: Response) => {
  const guard = await watchlistGuard(req, res);
  if (!guard) return;

  const address = String(req.params.tokenAddress ?? '');
  if (!isWellFormedAddressV1(address)) {
    res.status(400).json({ error: 'b20_address_invalid', code: 'b20_address_invalid' });
    return;
  }
  try {
    // Removing something that is not there is not an error: the caller wanted
    // it gone, and it is gone. Two tabs must not turn one removal into a 404.
    await guard.repository.removeToken(guard.user.id, address);
    res.json(
      B20WatchlistResponseV1Schema.parse(
        watchlistBodyV1(await guard.repository.listForUser(guard.user.id)),
      ),
    );
  } catch (error) {
    storageFailure(res, error, 'watchlist');
  }
});

// ---------------------------------------------------------------------------
// T68C — the exit check.
//
// "Can I get back out, and at what cost." A read, entirely: `getAmountsOut` is
// a view function, and this route's whole output is numbers and a verdict. It
// prepares nothing, approves nothing and hands no route to an execution path.
//
// That distinction is what lets it quote an ARBITRARY token. The swap
// allowlist exists to stop Miorail routing into anything; quoting is not
// routing, and refusing to quote would mean refusing to answer the one
// question a holder of a B20 token actually has.
//
// The controls come from the STORED snapshot, not a fresh read. Two reasons:
// a control card is ~15 metered calls on top of the ~18 this route already
// spends, and the answer says which block the controls came from so the two
// halves can be dated independently rather than implied to be simultaneous.
// ---------------------------------------------------------------------------

async function storedV4PoolV1(tokenAddress: string): Promise<{
  indexed: boolean;
  pool: B20PoolV1 | null;
}> {
  const row = await b20RouteRuntime.launchPools().readLaunchPool(tokenAddress);
  if (!row) return { indexed: false, pool: null };
  if (row.outcome !== 'resolved') return { indexed: true, pool: null };
  return {
    indexed: true,
    pool: {
      poolId: row.poolId,
      key: {
        currency0: row.currency0,
        currency1: row.currency1,
        fee: row.fee,
        tickSpacing: row.tickSpacing,
        hooks: row.hooks,
      },
      token: row.tokenAddress,
      quoteAsset: row.quoteAsset,
      tokenIsCurrency0: row.tokenIsCurrency0,
      blockNumber: Number(row.poolBlockNumber),
    },
  };
}

b20ControlRouter.post('/b20/exit-check', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  const parsed = B20ExitCheckRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: 'invalid_b20_exit_check_request', code: 'invalid_b20_exit_check_request' });
    return;
  }
  const refusal = validateB20InspectRequestV1(parsed.data.chainId, parsed.data.tokenAddress);
  if (refusal) {
    res.status(400).json({ error: refusal, code: refusal, detail: refusalDetailV1(refusal) });
    return;
  }
  if (!b20RouteRuntime.rpcConfigured()) {
    res.status(503).json({ error: 'b20_rpc_unavailable', code: 'b20_rpc_unavailable' });
    return;
  }

  try {
    if (!(await b20RouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'b20_storage_unavailable', code: 'b20_storage_unavailable' });
      return;
    }
    const recent = await b20RouteRuntime
      .repository()
      .recentSnapshots(guard.user.id, parsed.data.tokenAddress, 1);
    const snapshot = recent[0]?.snapshot ?? null;
    if (!snapshot) {
      // Refused rather than assumed open. An exit check that skipped the
      // controls would clear a token whose transfers are paused, which is the
      // exact failure this whole rail exists to prevent.
      res.status(409).json({
        error: 'b20_controls_unread',
        code: 'b20_controls_unread',
        detail:
          'This token’s controls have not been read yet. Check it once before asking whether you can exit.',
      });
      return;
    }

    const controls = exitControlsFromSnapshotV1(snapshot);
    const profile = {
      positionAtomic: parsed.data.positionAtomic,
      maxRoundTripBps: parsed.data.maxRoundTripBps,
      maxSlippageBps: parsed.data.maxSlippageBps,
    };
    const v4 = await storedV4PoolV1(parsed.data.tokenAddress);
    const v4Pool = v4.pool;
    let analysis;
    if (v4Pool && v4Pool.quoteAsset === AERODROME_USDC_V1) {
      const quoteReader = b20RouteRuntime.reader();
      analysis = await analyseV4ExitV1({
        pool: v4Pool,
        profile,
        controls,
        call: async (request) => {
          const result = await quoteReader.call({ ...request, blockTag: 'latest' });
          if (result.ok) return result.value;
          if (result.reason === 'reverted' || result.reason === 'empty_result') return '';
          throw new V4QuoteUnavailableError();
        },
      });
    } else {
      analysis = await analyseExitV1({
        reader: b20RouteRuntime.aerodromeReader(),
        tokenAddress: parsed.data.tokenAddress as `0x${string}`,
        profile,
        controls,
      });
      // Aerodrome is only one searched venue. If no v4 PoolKey is indexed,
      // its empty answer cannot become "no route" while the venue B20 tokens
      // normally use was never asked.
      if (!analysis.entryRouteFound && analysis.verdict.status === 'rejected' && !v4.indexed) {
        analysis = {
          ...analysis,
          verdict: { status: 'unmeasured' as const, reason: 'venue_not_indexed' as const },
          // Coverage is incomplete, but the endpoint did answer. Keeping this
          // false prevents the UI from blaming the RPC for a missing PoolKey.
          endpointDegraded: false,
        };
      } else if (
        v4Pool &&
        v4Pool.quoteAsset !== AERODROME_USDC_V1 &&
        !analysis.entryRouteFound &&
        analysis.verdict.status === 'rejected'
      ) {
        analysis = {
          ...analysis,
          verdict: { status: 'unmeasured' as const, reason: 'quote_asset_mismatch' as const },
          // Both venues answered; they simply do not provide the same quote
          // asset, and no ETH/USD conversion is inferred here.
          endpointDegraded: false,
        };
      }
    }

    // T68D — the quote path may reject and may never certify. A pass here is
    // PROVISIONAL: the exit was priced against the pool before the entry moved
    // it, and only `/b20/opportunity/simulate` can promote that to qualified.
    const status =
      analysis.verdict.status === 'qualifies' ? ('provisional' as const) : analysis.verdict.status;
    res.json(
      B20ExitCheckResponseV1Schema.parse({
        tokenAddress: parsed.data.tokenAddress,
        status,
        // An `unmeasured` outcome carries no reason about the token, because
        // there is none: the endpoint is what stopped the check.
        reason: analysis.verdict.status === 'rejected' ? analysis.verdict.reason : null,
        unmeasuredReason: analysis.verdict.status === 'unmeasured' ? analysis.verdict.reason : null,
        coverage: analysis.endpointDegraded ? ('partial' as const) : ('complete' as const),
        // A quote proves nothing executes. Only a simulation can confirm a
        // route, so both of these are false on this endpoint, always.
        viableRouteConfirmed: false,
        bestRouteConfirmed: false,
        measurement: analysis.verdict.status === 'qualifies' ? analysis.verdict.measurement : null,
        optimistic: analysis.verdict.status === 'qualifies' ? analysis.verdict.optimistic : false,
        roundTripCostBps: analysis.roundTrip?.costBps ?? null,
        exitCapacityAtomic: analysis.exitCapacity.capacityAtomic,
        firstFailingAtomic: analysis.exitCapacity.firstFailingAtomic,
        probeCount: analysis.exitCapacity.probeCount,
        capacityInformative: analysis.capacityInformative,
        referenceSizeAtomic: analysis.referenceSizeAtomic,
        endpointDegraded: analysis.endpointDegraded,
        controlsBlockNumber: snapshot.blockNumber,
        entryInputAtomic: analysis.positionAtomicUsed,
        entryOutputAtomic: analysis.entryOutputAtomic,
        quoteAsset: analysis.quoteAsset,
        provider: analysis.provider,
        sourceKey: analysis.sourceKey,
        checkedAt: b20RouteRuntime.now().toISOString(),
      }),
    );
  } catch (error) {
    storageFailure(res, error, 'exit-check');
  }
});

b20ControlRouter.get('/b20/snapshots/:id', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  try {
    if (!(await b20RouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'b20_storage_unavailable', code: 'b20_storage_unavailable' });
      return;
    }
    // Tenant isolation is the QUERY, not a check afterwards: another tenant's
    // snapshot is not found rather than found and refused.
    const record = await b20RouteRuntime
      .repository()
      .getSnapshot(String(req.params.id), guard.user.id);
    if (!record) {
      res.status(404).json({ error: 'b20_snapshot_not_found', code: 'b20_snapshot_not_found' });
      return;
    }
    respondV1(res, record.snapshot, buildB20CardV1(record.snapshot), true);
  } catch (error) {
    storageFailure(res, error, 'get_snapshot');
  }
});
