import { Router, type Request, type Response } from 'express';
import { logger } from '@mioagent/utils';
import {
  B20InspectRequestV1Schema,
  B20InspectResponseV1Schema,
  B20WatchRequestV1Schema,
  B20WatchResponseV1Schema,
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
  type B20StorageRepositoryV1,
} from '@mioagent/route-storage';
import { client } from '@mioagent/db';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';

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
  reader: () => createB20ReaderV1({ rpcUrl: baseMainnetRpcUrlV1() }),
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
