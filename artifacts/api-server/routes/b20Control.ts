import { Router, type NextFunction, type Request, type Response } from 'express';
import { createX402MiddlewareFromEnv } from '@mioagent/x402-gateway';
import {
  paidB20SimulationEnabledV1,
  resolvePaidB20SimulationPricingV1,
} from '../lib/paidIntelligenceConfig.js';
import { logger } from '@mioagent/utils';
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
  B20OpportunityDetailResponseV1Schema,
  B20MarketRailsResponseV1Schema,
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
  buildB20CardV1,
  isWellFormedAddressV1,
  refusalDetailV1,
  validateB20InspectRequestV1,
  type B20ControlSnapshotV1,
  type B20ControlWatchV1,
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
  createDatabaseB20LaunchPoolRepository,
  decodeFeedCursorV1,
  type B20ObservationRepositoryV1,
  type B20LaunchPoolRepositoryV1,
} from '@mioagent/route-storage';
import { client } from '@mioagent/db';
import { stableHashV1 } from '@mioagent/route-domain';
import { createViemBaseReceiptReader } from '../lib/baseReceiptReader.js';
import { reconcileB20EntryFromBaseV1 } from '../lib/b20EntryChainReconciler.js';
import {
  OPPORTUNITY_QUOTE_ASSET_V1,
  type B20PipelineStatusV1,
  b20OpportunityCardV1,
  b20LaunchBuyerWindowV1,
  b20PipelineCopyV1,
  exitCapacityLeadersV1,
  measuredMoversV1,
  moversCollectingHistoryV1,
  MEASURED_MOVE_LABEL_V1,
  MEASURED_MOVE_NOTE_V1,
  b20PipelineStatusV1,
  profileRefusalV1,
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
  launchPools: (): B20LaunchPoolRepositoryV1 => createDatabaseB20LaunchPoolRepository(client),
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
    const rows = await client`SELECT to_regclass('public.b20_opportunity_clearances') AS clearances`;
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

/** flag + session — the shared head of both routes. */
function b20Guard(req: Request, res: Response): { user: NonNullable<ReturnType<typeof sessionUser>> } | null {
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
    res.status(409).json({ error: 'b20_snapshot_conflict', code: 'b20_snapshot_conflict', detail: error.message });
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
export async function readDiscoverFeedV1(input: {
  limit: number;
  cursor: string | null;
  state: (typeof FEED_STATES_V1)[number] | 'all';
  freshness: 'fresh' | 'stale' | 'all';
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

  const page = await observations.listFeed({
    limit: input.limit,
    cursor: input.cursor,
    states: input.state === 'all' ? undefined : [input.state],
    maxLaunchAgeMs,
    now: now.toISOString(),
  });

  const cards = page.rows
    .map((row) =>
      b20OpportunityCardV1({
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
      }),
    )
    // Freshness is computed against SERVER time, so a client with a skewed
    // clock cannot promote a stale observation into an actionable one.
    .filter((card) => {
      if (input.freshness === 'all') return true;
      if (!card.observation) return false;
      return card.observation.freshness === input.freshness;
    });

  return { pipeline, cards, nextCursor: page.nextCursor, serverTime: now.toISOString() };
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
export const MARKET_RAIL_BASELINE_AGE_MS_V1 = 24 * 60 * 60 * 1000;
/** A measurement pass is not on a precise timer, so "about 24 hours" needs a
 * window. Four hours either side: wide enough to survive a slow pass, narrow
 * enough that the label is not a fiction. */
export const MARKET_RAIL_BASELINE_TOLERANCE_MS_V1 = 4 * 60 * 60 * 1000;
/** §3 — a mover needs a measured exit for at least 25% of the tokens returned
 * by the reference entry. A ratio is intentional: a raw atomic threshold
 * silently treats 6-decimal and 18-decimal B20s as different markets. */
export const MARKET_RAIL_MIN_EXIT_COVERAGE_BPS_V1 = 2_500;
/** The active window currently holds fewer than 800 launches. Keep the read
 * bounded above that population so a market rail is not accidentally a
 * projection of only the first Discover page. */
export const MARKET_RAIL_ACTIVE_OBSERVATION_LIMIT_V1 = 1_000;

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
  const cursor = typeof req.query.cursor === 'string' && req.query.cursor.length > 0 ? req.query.cursor : null;
  if (cursor && !decodeFeedCursorV1(cursor)) {
    // Refused rather than treated as "start from the top": silently restarting
    // a paginated feed looks to a caller like duplicated results.
    res.status(400).json({ error: 'invalid_cursor', code: 'invalid_cursor' });
    return;
  }
  const launchAgeRaw = Number.parseInt(String(req.query.launchAge ?? ''), 10);
  const maxLaunchAgeMs = Number.isFinite(launchAgeRaw) && launchAgeRaw > 0 ? launchAgeRaw : DISCOVER_FEED_WINDOW_MS_V1;

  // Held outside the try so the failure log can say what SHAPE arrived at the
  // schema, not merely that something did.
  let feed: Awaited<ReturnType<typeof readDiscoverFeedV1>> | undefined;
  try {
    feed = await readDiscoverFeedV1({
      limit,
      cursor,
      state: stateParam as (typeof FEED_STATES_V1)[number] | 'all',
      freshness: freshness as 'fresh' | 'stale' | 'all',
      maxLaunchAgeMs,
    });
    res.json(B20OpportunityFeedResponseV1Schema.parse(feed));
  } catch (error) {
    storageFailure(res, error, 'b20-opportunity-feed', feed);
  }
});

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
    const observations = b20RouteRuntime.observations();
    const now = b20RouteRuntime.now();
    if (!available) {
      res.status(503).json({ error: 'discover_unavailable', code: 'discover_unavailable' });
      return;
    }
    const found = await observations.getFeedRowForToken({ tokenAddress, historyLimit: 20 });
    if (!found) {
      // No CANONICAL launch for this address. Not "not a B20 token" — this
      // feed only knows what it ingested, and saying more would be a claim
      // nothing measured.
      res.status(404).json({ error: 'launch_not_found', code: 'launch_not_found' });
      return;
    }
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
      observation: found.row.observation,
      // The list endpoint already carries this joined row. The detail endpoint
      // must not make the same token lose its launch-window evidence when a
      // user opens it.
      launchBuyers: found.row.launchBuyers,
      now,
    });

    res.json(
      B20OpportunityDetailResponseV1Schema.parse({
        card,
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
    res.status(400).json({ error: 'invalid_b20_inspect_request', code: 'invalid_b20_inspect_request' });
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
    const stored = await repository.insertSnapshot({ userId: guard.user.id, snapshot: result.snapshot });
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
      if (!sweepStopped && b20RouteRuntime.monotonicMs() - startedAt >= deadlineMs) sweepStopped = true;
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
      const stored = await repository.insertSnapshot({ userId: guard.user.id, snapshot: result.snapshot });
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
): Promise<{ user: NonNullable<ReturnType<typeof sessionUser>>; repository: B20WatchlistRepositoryV1 } | null> {
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
  if (!b20RouteRuntime.rpcConfigured()) return { ok: false, status: 503, code: 'b20_rpc_unavailable' };
  if (!(await b20RouteRuntime.migrationAvailable())) {
    return { ok: false, status: 503, code: 'b20_storage_unavailable' };
  }

  const recent = await b20RouteRuntime.repository().recentSnapshots(input.tenantId, input.tokenAddress, 1);
  const snapshot = recent[0]?.snapshot ?? null;
  if (!snapshot) {
    // Controls are prior to price, and prior to simulation. Certifying a
    // token whose controls were never read would clear one whose transfers
    // are paused.
    return {
      ok: false,
      status: 409,
      code: 'b20_controls_unread',
      detail: 'This token’s controls have not been read yet. Check it once before simulating an entry.',
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
  (req: Request, res: Response, next: NextFunction) => b20SimulatePaymentRuntimeV1.middleware(req, res, next),
  async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  const parsed = B20OpportunitySimulateRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_b20_opportunity_request', code: 'invalid_b20_opportunity_request' });
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
  if (!b20RouteRuntime.rpcConfigured()) return { ok: false, status: 503, code: 'b20_rpc_unavailable' };
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

b20ControlRouter.post('/opportunities/:clearanceId/prepare-entry', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  const parsed = B20EntryPrepareRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_b20_entry_request', code: 'invalid_b20_entry_request' });
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
});

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
      res.status(503).json({ error: 'b20_entry_plan_unavailable', code: 'b20_entry_plan_unavailable' });
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
    const proof = capabilities.routeProofWired && attempt
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

  const clearance = await b20RouteRuntime.clearances().getClearance(plan.clearanceId, input.tenantId);
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
      res.status(400).json({ error: 'invalid_b20_submission_request', code: 'invalid_b20_submission_request' });
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
      res.status(400).json({ error: 'invalid_b20_submission_request', code: 'invalid_b20_submission_request' });
      return;
    }
    // A batch id belongs to a submission and to nothing else. A rejection that
    // named one would be claiming something reached the chain.
    const body = parsedBody.data;
    if ((body.result === 'submitted') !== (body.batchId !== null)) {
      res.status(400).json({ error: 'invalid_b20_submission_request', code: 'invalid_b20_submission_request' });
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
      res.status(400).json({ error: 'invalid_b20_reconciliation_request', code: 'invalid_b20_reconciliation_request' });
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
  const proof = capabilities.routeProofWired && attempt
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
    res.status(400).json({ error: 'invalid_b20_watchlist_request', code: 'invalid_b20_watchlist_request' });
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
    res.status(201).json(
      B20WatchlistResponseV1Schema.parse(watchlistBodyV1(await guard.repository.listForUser(guard.user.id))),
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
    res.json(B20WatchlistResponseV1Schema.parse(watchlistBodyV1(await guard.repository.listForUser(guard.user.id))));
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
  return { indexed: true, pool: {
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
  } };
}

b20ControlRouter.post('/b20/exit-check', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  const parsed = B20ExitCheckRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_b20_exit_check_request', code: 'invalid_b20_exit_check_request' });
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
        detail: 'This token’s controls have not been read yet. Check it once before asking whether you can exit.',
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
    const record = await b20RouteRuntime.repository().getSnapshot(String(req.params.id), guard.user.id);
    if (!record) {
      res.status(404).json({ error: 'b20_snapshot_not_found', code: 'b20_snapshot_not_found' });
      return;
    }
    respondV1(res, record.snapshot, buildB20CardV1(record.snapshot), true);
  } catch (error) {
    storageFailure(res, error, 'get_snapshot');
  }
});
