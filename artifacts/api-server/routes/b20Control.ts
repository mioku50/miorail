import { Router, type Request, type Response } from 'express';
import { logger } from '@mioagent/utils';
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
  B20EntryStatusResponseV1Schema,
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
  b20EntryReviewV1,
  entryExecutionAvailableV1,
  type B20EntryExecutionCapabilitiesV1,
  type B20EntrySubmissionRepositoryV1,
  type B20ClearanceRepositoryV1,
  type B20EntryPlanRepositoryV1,
  b20SweepOutcomeFromDetectionV1,
  b20WatchlistIdV1,
  B20_WATCHLIST_CAPACITY_V1,
  type B20StorageRepositoryV1,
  type B20WatchlistEntryV1,
  type B20WatchlistRepositoryV1,
} from '@mioagent/route-storage';
import { client } from '@mioagent/db';
import { stableHashV1 } from '@mioagent/route-domain';
import { OPPORTUNITY_QUOTE_ASSET_V1, profileRefusalV1 } from '@mioagent/opportunity-rail';
import { createAerodromeReaderV1 } from '@mioagent/swap-adapters';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import { analyseExitV1 } from '../lib/exitAnalysis.js';
import { runOpportunityV1 } from '../lib/opportunityRunner.js';
import { buildClearanceV1 } from '../lib/opportunityClearance.js';
import { prepareB20EntryV1 } from '../lib/b20EntryRunner.js';
import { buildPreparedPlanV1 } from '../lib/b20EntryPlanStore.js';
import {
  SUBMIT_REFUSAL_COPY_V1,
  entryWalletPayloadV1,
  submitGateRefusalV1,
} from '../lib/b20EntrySubmitGate.js';
import {
  entryStatusViewV1,
  openAttemptV1,
  recordWalletReportV1,
} from '../lib/b20EntrySubmitRunner.js';

// ---------------------------------------------------------------------------
// T67C — the B20 Control rail.
//
// Two routes, both read-only, and that is a property of the code: nothing in
// this file builds a call, prepares a transaction, requests an approval or
// touches a wallet. The only outbound network traffic is `eth_call` and
// `eth_getBlockByNumber` through the injected reader.
//
// Idempotency is per tenant + token + BLOCK. Two inspections in the same block
// are the same fact, so the second one reads the stored row instead of writing
// a second. Inside the TTL, a repeat request does not even re-read the chain —
// and the response says `cached: true`, because a snapshot from four blocks
// ago is a different claim from a current one and the user should be able to
// tell which they are looking at.
// ---------------------------------------------------------------------------

export const b20ControlRouter = Router();

/** The Base mainnet endpoint, resolved the way every other on-chain read in
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
    const rows = await client`SELECT to_regclass('public.b20_entry_submissions') AS submissions`;
    const wired = Boolean(rows[0]?.submissions);
    return {
      submissionRouteWired: wired,
      walletIntegrationWired: wired,
      reconciliationWired: wired,
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

function storageFailure(res: Response, error: unknown, where: string): void {
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
  logger.error('B20 control storage failed', { where, name: error instanceof Error ? error.name : 'unknown' });
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

b20ControlRouter.post('/b20/opportunity/simulate', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  const parsed = B20OpportunitySimulateRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_b20_opportunity_request', code: 'invalid_b20_opportunity_request' });
    return;
  }
  const refusal = validateB20InspectRequestV1(parsed.data.chainId, parsed.data.tokenAddress);
  if (refusal) {
    res.status(400).json({ error: refusal, code: refusal, detail: refusalDetailV1(refusal) });
    return;
  }

  const profile = {
    quoteAsset: OPPORTUNITY_QUOTE_ASSET_V1,
    positionAtomic: parsed.data.positionAtomic,
    maxRoundTripBps: parsed.data.maxRoundTripBps,
    maxExitSlippageBps: parsed.data.maxExitSlippageBps,
  } as const;
  // The user's numbers, bounded by the server's. A profile outside the bounds
  // is refused with the field named, not clamped into something they did not
  // choose and then answered as if they had.
  const outOfBounds = profileRefusalV1(profile);
  if (outOfBounds) {
    res.status(400).json({ error: outOfBounds, code: outOfBounds });
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
      // Controls are prior to price, and prior to simulation. Certifying a
      // token whose controls were never read would clear one whose transfers
      // are paused.
      res.status(409).json({
        error: 'b20_controls_unread',
        code: 'b20_controls_unread',
        detail: 'This token’s controls have not been read yet. Check it once before simulating an entry.',
      });
      return;
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
      res.json(
        B20OpportunitySimulateResponseV1Schema.parse({
          tokenAddress: parsed.data.tokenAddress,
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
      );
      return;
    }

    const run = await b20RouteRuntime.runOpportunity(
      { reader: b20RouteRuntime.aerodromeReader(), now: () => now },
      {
        wallet: guard.user.address as `0x${string}`,
        tokenAddress: parsed.data.tokenAddress as `0x${string}`,
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
            tenantId: guard.user.id,
            token: parsed.data.tokenAddress,
            evidence: run.simulationEvidenceHash,
          }).slice(2, 34)}`,
          tenantId: guard.user.id,
          walletAddress: guard.user.address,
          tokenAddress: parsed.data.tokenAddress,
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
    res.json(
      B20OpportunitySimulateResponseV1Schema.parse({
        tokenAddress: parsed.data.tokenAddress,
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
    );
  } catch (error) {
    storageFailure(res, error, 'opportunity-simulate');
  }
});

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

b20ControlRouter.post('/opportunities/:clearanceId/prepare-entry', async (req: Request, res: Response) => {
  const guard = b20Guard(req, res);
  if (!guard) return;

  const parsed = B20EntryPrepareRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_b20_entry_request', code: 'invalid_b20_entry_request' });
    return;
  }
  if (!b20RouteRuntime.rpcConfigured()) {
    res.status(503).json({ error: 'b20_rpc_unavailable', code: 'b20_rpc_unavailable' });
    return;
  }

  try {
    if (!(await b20RouteRuntime.clearanceAvailable())) {
      res.status(503).json({ error: 'b20_clearance_unavailable', code: 'b20_clearance_unavailable' });
      return;
    }
    if (!(await b20RouteRuntime.entryPlanAvailable())) {
      res.status(503).json({ error: 'b20_entry_plan_unavailable', code: 'b20_entry_plan_unavailable' });
      return;
    }
    const now = b20RouteRuntime.now();
    const clearanceId = String(req.params.clearanceId ?? '');
    const plans = b20RouteRuntime.entryPlans();

    // §2 — the idempotency lookup runs BEFORE any quoting. A retry must return
    // the stored plan, not re-quote the pool and offer different numbers to a
    // user who only refreshed.
    const replay = await plans.findByIdempotency({
      tenantId: guard.user.id,
      walletAddress: guard.user.address,
      clearanceId,
      requestId: parsed.data.requestId,
    });
    if (replay) {
      const replayCapabilities = await b20RouteRuntime.executionCapabilities();
      res.json(
        B20EntryPrepareResponseV1Schema.parse({
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
      );
      return;
    }

    const clearance = await b20RouteRuntime
      .clearances()
      .getClearance(clearanceId, guard.user.id);

    const prepared = await b20RouteRuntime.prepareEntry(
      {
        b20Reader: b20RouteRuntime.reader(),
        aerodromeReader: b20RouteRuntime.aerodromeReader(),
        now: () => now,
      },
      {
        clearance,
        tenantId: guard.user.id,
        walletAddress: guard.user.address,
        chainId: parsed.data.chainId,
        profileIdentity: parsed.data.profileIdentity,
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
      res.status(500).json({ error: 'storage_integrity', code: 'storage_integrity' });
      return;
    }
    if (prepared.blueprint && clearance && prepared.simulation) {
      const draft = buildPreparedPlanV1({
        clearance,
        blueprint: prepared.blueprint,
        simulation: prepared.simulation,
        tokenName: prepared.tokenName,
        tokenSymbol: prepared.tokenSymbol,
        requestId: parsed.data.requestId,
        now,
      });
      stored = await plans.insertPreparedPlan(draft);
    }

    res.json(
      B20EntryPrepareResponseV1Schema.parse({
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
    );
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
 * It returns the projection, never the unsigned calldata. The executable bytes
 * stay server-side while no submission path exists to use them.
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
      }),
    );
  } catch (error) {
    storageFailure(res, error, 'entry-plan-read');
  }
});

/**
 * The shared head of every submission route: flag, session, storage, and the
 * plan itself — read wallet-scoped, so another wallet gets a 404 rather than a
 * refusal that confirms the plan exists.
 */
async function entryPlanGuard(req: Request, res: Response) {
  const guard = b20Guard(req, res);
  if (!guard) return null;
  if (!(await b20RouteRuntime.entryPlanAvailable())) {
    res.status(503).json({ error: 'b20_entry_plan_unavailable', code: 'b20_entry_plan_unavailable' });
    return null;
  }
  const plan = await b20RouteRuntime.entryPlans().getPreparedPlan({
    planId: String(req.params.planId ?? ''),
    tenantId: guard.user.id,
    walletAddress: guard.user.address,
  });
  if (!plan) {
    res.status(404).json({ error: 'b20_entry_plan_not_found', code: 'b20_entry_plan_not_found' });
    return null;
  }
  return { user: guard.user, plan };
}

/**
 * T68F-B 2/3 — open a submission and hand back the wallet request.
 *
 * The request carries a chain id, a profile identity and an idempotency handle.
 * It carries NO calls, no calldata, no router, no recipient and no amount: the
 * server recovers every executable byte from the stored plan by id. There is no
 * code path here by which a browser can contribute a transaction.
 */
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
      const now = b20RouteRuntime.now();
      const capabilities = await b20RouteRuntime.executionCapabilities();
      const submissions = b20RouteRuntime.entrySubmissions();
      const plan = guard.plan;
      const existing = await submissions.latestForPlan({ planId: plan.id, tenantId: guard.user.id });

      const refuse = (reason: string, detail: string, status = 200): void => {
        res.status(status).json(
          B20EntryBeginSubmissionResponseV1Schema.parse({
            outcome: 'refused',
            reason,
            detail,
            status: entryStatusViewV1({ plan, attempt: existing, capabilities, now }),
          }),
        );
      };

      if (!capabilities.submissionRouteWired) {
        refuse('submission_not_wired', 'Submission is not available on this server.', 503);
        return;
      }

      // An attempt that already holds this plan's slot is RETURNED, never
      // replaced. A double click, a remount and a retried fetch all land here.
      if (existing && existing.status === 'awaiting_wallet_approval') {
        res.json(
          B20EntryBeginSubmissionResponseV1Schema.parse({
            outcome: 'ready',
            attemptId: existing.id,
            payload: entryWalletPayloadV1(plan),
            review: b20EntryReviewV1(plan, capabilities),
            status: entryStatusViewV1({ plan, attempt: existing, capabilities, now }),
          }),
        );
        return;
      }

      const clearance = await b20RouteRuntime.clearances().getClearance(plan.clearanceId, guard.user.id);
      const gate = submitGateRefusalV1({
        plan,
        clearance,
        walletAddress: guard.user.address,
        tenantId: guard.user.id,
        chainId: parsedBody.data.chainId,
        profileIdentity: parsedBody.data.profileIdentity,
        hasLiveAttempt: Boolean(existing && existing.status !== 'terminal'),
        now,
        // The prepare-time control read is what this plan was built on, and a
        // plan is short-lived precisely so this stays close to now.
        controlsReadAt: new Date(Date.parse(plan.createdAt)),
      });
      if (gate) {
        refuse(gate, SUBMIT_REFUSAL_COPY_V1[gate]);
        return;
      }

      const attempt = await openAttemptV1({
        submissions,
        plan,
        attemptRequestId: parsedBody.data.attemptRequestId,
        now,
      });
      res.json(
        B20EntryBeginSubmissionResponseV1Schema.parse({
          outcome: 'ready',
          attemptId: attempt.id,
          // The only place executable bytes leave this server, and they are
          // always the stored ones.
          payload: entryWalletPayloadV1(plan),
          review: b20EntryReviewV1(plan, capabilities),
          status: entryStatusViewV1({ plan, attempt, capabilities, now }),
        }),
      );
    } catch (error) {
      storageFailure(res, error, 'begin-submission');
    }
  },
);

/**
 * T68F-B 6/8 — record what the WALLET did.
 *
 * The client reports the wallet's behaviour, never a result: a browser cannot
 * tell this server that a transaction succeeded. The only fact it contributes
 * that the server did not already have is the batch id.
 */
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
      const now = b20RouteRuntime.now();
      const capabilities = await b20RouteRuntime.executionCapabilities();
      const submissions = b20RouteRuntime.entrySubmissions();
      const attempt = await submissions.getAttempt({
        attemptId: body.attemptId,
        tenantId: guard.user.id,
        walletAddress: guard.user.address,
      });
      if (!attempt || attempt.planId !== guard.plan.id) {
        res.status(404).json({ error: 'b20_entry_attempt_not_found', code: 'b20_entry_attempt_not_found' });
        return;
      }

      const updated = await recordWalletReportV1({
        submissions,
        attempt,
        report: body.result,
        batchId: body.batchId,
        now,
      });
      if (!updated) {
        res.status(409).json({ error: 'b20_entry_submission_conflict', code: 'b20_entry_submission_conflict' });
        return;
      }
      res.json(
        B20EntryStatusResponseV1Schema.parse({
          review: b20EntryReviewV1(guard.plan, capabilities),
          status: entryStatusViewV1({ plan: guard.plan, attempt: updated, capabilities, now }),
          expiresAt: guard.plan.expiresAt,
          expired: Date.parse(guard.plan.expiresAt) <= now.getTime(),
        }),
      );
    } catch (error) {
      storageFailure(res, error, 'record-submission');
    }
  },
);

/** T68F-B 9/11 — where did it get to. A refresh reads storage, so a submitted
 * entry never returns to `review`. */
b20ControlRouter.get(
  '/opportunities/entry-plans/:planId/status',
  async (req: Request, res: Response) => {
    const guard = await entryPlanGuard(req, res);
    if (!guard) return;
    try {
      const now = b20RouteRuntime.now();
      const capabilities = await b20RouteRuntime.executionCapabilities();
      const attempt = await b20RouteRuntime
        .entrySubmissions()
        .latestForPlan({ planId: guard.plan.id, tenantId: guard.user.id });
      res.json(
        B20EntryStatusResponseV1Schema.parse({
          review: b20EntryReviewV1(guard.plan, capabilities),
          status: entryStatusViewV1({ plan: guard.plan, attempt, capabilities, now }),
          expiresAt: guard.plan.expiresAt,
          expired: Date.parse(guard.plan.expiresAt) <= now.getTime(),
        }),
      );
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
    const analysis = await analyseExitV1({
      reader: b20RouteRuntime.aerodromeReader(),
      tokenAddress: parsed.data.tokenAddress as `0x${string}`,
      profile: {
        positionAtomic: parsed.data.positionAtomic,
        maxRoundTripBps: parsed.data.maxRoundTripBps,
        maxSlippageBps: parsed.data.maxSlippageBps,
      },
      controls,
    });

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
