import {
  B20_CREATED_TOPIC_V1,
  decodeB20CreatedV1,
  launchIdV1,
  type B20LaunchDecodeRefusalV1,
  type B20LaunchV1,
  type RawLogV1,
} from './launches.js';
import { B20_FACTORY_V1 } from './pinned.js';

// ---------------------------------------------------------------------------
// T69 §1/§3/§15 — reading launches without ever getting ahead of ourselves.
//
// Four properties, and each exists because its absence produces a specific
// wrong answer:
//
//   * THE CURSOR NEVER PASSES AN UNPROCESSED RANGE. A cursor that advanced on
//     partial failure would silently skip launches, and the gap would be
//     indistinguishable from a quiet hour — forever, because nothing re-reads
//     an old range.
//
//   * THE CURSOR HASH ALWAYS BELONGS TO THE CURSOR BLOCK. It is read
//     explicitly for the block the cursor moved to, never inherited from the
//     previous cursor and never taken from a launch log that happened to sit
//     in that block. A hash belonging to some other block makes the reorg
//     check answer a question nobody asked.
//
//   * A CHANGED EVENT SHAPE STOPS THE READER. The B20Created signature is
//     derived from an observed topic0, not published. If it changes, the only
//     honest outcome is "no launch feed"; a decoder that kept going would
//     record real tokens with wrong names.
//
//   * BLOCKS ARE PROCESSED WHOLE. The launch budget stops between blocks, never
//     inside one, because a cursor that sat mid-block would either skip the
//     rest of that block forever or return it again on every run.
//
// Quota is counted in CALLS, not requests — the measured behaviour of
// mainnet.base.org, recorded in T67F. `eth_getLogs` over a wide range is one
// request and an unbounded amount of work, which is why the range is capped
// here rather than trusted to the endpoint.
// ---------------------------------------------------------------------------

/** Default ceiling on a single `eth_getLogs` window. Wide enough to catch up
 * after an outage in a few runs, narrow enough that one call cannot ask the
 * endpoint for hours of history. */
export const LAUNCH_MAX_RANGE_V1 = 800;

/** Blocks left between the chain head and anything this reader will accept.
 * Base finality is fast; this is about reorg depth, not latency. */
export const LAUNCH_CONFIRMATIONS_V1 = 12;

/** Default soft ceiling on launches committed by one run, applied at block
 * boundaries. */
export const LAUNCH_MAX_LAUNCHES_V1 = 200;

/** How far back a reorg sends the cursor. Deeper than the confirmation window
 * by a wide margin: a reorg that reached confirmed blocks was already deeper
 * than expected, so the re-read starts from somewhere the chain has settled. */
export const LAUNCH_REWIND_DEPTH_V1 = 64;

/** Why a read stopped without an endpoint answer. Fixed categories, never an
 * echo of the endpoint — a URL with a key in it must not reach a log line. */
export type LaunchEndpointCallV1 = 'head' | 'logs' | 'anchor';

export type LaunchReaderStateV1 =
  | { status: 'ok' }
  /** An operator state, never written against a token. */
  | { status: 'decoder_mismatch'; refusal: B20LaunchDecodeRefusalV1; atBlock: string | null }
  | { status: 'reorg_detected'; atBlock: string; storedHash: string; observedHash: string }
  | { status: 'endpoint_shape'; detail: string }
  | { status: 'endpoint_unavailable'; call: LaunchEndpointCallV1 };

export interface LaunchLogSourceV1 {
  /** `eth_getLogs` over an inclusive block range, already bounded by the
   * caller. Returns null when the endpoint could not answer — which is not the
   * same as "no launches", and the reader treats it that way. */
  getLogs(input: { fromBlock: number; toBlock: number }): Promise<RawLogV1[] | null>;
  /** The current head. Null when unavailable. */
  headBlock(): Promise<number | null>;
  /**
   * The hash of one specific block.
   *
   * Separate from `getLogs` on purpose. The cursor's anchor has to be the hash
   * of the block the cursor names, and most ranges end on a block that emitted
   * nothing at all — so there is no log to take it from, and the previous
   * cursor's hash belongs to a different block entirely.
   */
  blockHash(blockNumber: number): Promise<string | null>;
}

export interface LaunchCursorV1 {
  /** The last block whose logs are fully processed. */
  lastProcessedBlock: number;
  /** ITS hash — the hash of `lastProcessedBlock` and no other block. Null only
   * on a cold cursor, which is why a missing hash is not a reorg. */
  lastProcessedBlockHash: string | null;
}

export interface ReadLaunchesInputV1 {
  source: LaunchLogSourceV1;
  cursor: LaunchCursorV1;
  /** Hard ceilings for one run. A worker that can be run from a timer must be
   * unable to spend an unbounded amount of anything. */
  maxRange?: number;
  /** Soft ceiling, applied between blocks. See `readB20LaunchesV1`. */
  maxLaunches?: number;
  confirmations?: number;
}

export interface ReadLaunchesResultV1 {
  launches: B20LaunchV1[];
  /** Where the cursor may safely move to, with the hash of that exact block.
   * NEVER past a range this run did not fully process — on any refusal it stays
   * exactly where it was. */
  nextCursor: LaunchCursorV1;
  state: LaunchReaderStateV1;
  /** True when a budget stopped the run before the confirmed head. The
   * remaining blocks are not "empty"; they are not_checked. */
  budgetExhausted: boolean;
  /** The confirmed head this run saw, so a caller can report what it did not
   * reach. Null when the head could not be read. */
  confirmedHead: number | null;
  /** The window actually requested from the endpoint, or null when none was. */
  scannedFrom: number | null;
  scannedTo: number | null;
}

/**
 * One bounded pass.
 *
 * On ANY refusal the cursor is returned unchanged. That is the single most
 * important line in this file: a reader that advanced past a range it could not
 * decode would turn a decoder bug into permanent, invisible data loss.
 *
 * `maxLaunches` is a SOFT limit that only ever stops the run between blocks.
 * A block is processed whole or not at all — including a block that alone
 * carries more launches than the budget, which is taken complete so the run
 * still makes progress rather than returning that block forever.
 */
export async function readB20LaunchesV1(input: ReadLaunchesInputV1): Promise<ReadLaunchesResultV1> {
  const maxRange = input.maxRange ?? LAUNCH_MAX_RANGE_V1;
  const maxLaunches = input.maxLaunches ?? LAUNCH_MAX_LAUNCHES_V1;
  const confirmations = input.confirmations ?? LAUNCH_CONFIRMATIONS_V1;
  const unchanged = (
    state: LaunchReaderStateV1,
    confirmedHead: number | null = null,
  ): ReadLaunchesResultV1 => ({
    launches: [],
    nextCursor: input.cursor,
    state,
    budgetExhausted: false,
    confirmedHead,
    scannedFrom: null,
    scannedTo: null,
  });

  const head = await input.source.headBlock();
  if (head === null) return unchanged({ status: 'endpoint_unavailable', call: 'head' });

  // Nothing within the confirmation window is read at all, so a reorg has to
  // be deeper than this to reach stored data.
  const confirmedHead = head - confirmations;
  const fromBlock = input.cursor.lastProcessedBlock + 1;
  if (confirmedHead < fromBlock) {
    return {
      launches: [],
      nextCursor: input.cursor,
      state: { status: 'ok' },
      budgetExhausted: false,
      confirmedHead,
      scannedFrom: null,
      scannedTo: null,
    };
  }

  const toBlock = Math.min(confirmedHead, fromBlock + maxRange - 1);
  const rangeCapped = toBlock < confirmedHead;

  const logs = await input.source.getLogs({ fromBlock, toBlock });
  if (logs === null) return unchanged({ status: 'endpoint_unavailable', call: 'logs' }, confirmedHead);
  if (!Array.isArray(logs)) {
    // A non-array response is the endpoint changing shape, not an empty range.
    return unchanged({ status: 'endpoint_shape', detail: 'getLogs did not return an array' }, confirmedHead);
  }

  // Decode EVERYTHING matching in the window before deciding what to keep. The
  // endpoint has already been paid for these logs, and a decoder failure
  // anywhere in the range has to stop the run — including in a block the
  // launch budget would otherwise have left for the next one.
  const byBlock = new Map<number, B20LaunchV1[]>();
  const seen = new Set<string>();
  for (const log of logs) {
    // Reorg-removed logs are not launches. They are dropped here rather than
    // decoded, because a removed log describes a block that no longer exists.
    if (log.removed) continue;
    if ((log.topics?.[0] ?? '').toLowerCase() !== B20_CREATED_TOPIC_V1) continue;
    if (log.address?.toLowerCase() !== B20_FACTORY_V1) continue;

    const decoded = decodeB20CreatedV1(log);
    if (!decoded.ok) {
      // The event shape changed. Stop, keep the cursor, and surface it as an
      // OPERATOR state — never as a fact about the token in the log.
      return unchanged(
        {
          status: 'decoder_mismatch',
          refusal: decoded.refusal,
          atBlock: log.blockNumber ? BigInt(log.blockNumber).toString() : null,
        },
        confirmedHead,
      );
    }
    const id = launchIdV1(decoded.launch);
    // One log is one launch even within a single response.
    if (seen.has(id)) continue;
    seen.add(id);
    const block = Number(decoded.launch.blockNumber);
    const batch = byBlock.get(block);
    if (batch) batch.push(decoded.launch);
    else byBlock.set(block, [decoded.launch]);
  }

  // Ascending, because "the last block we finished" is only meaningful in order.
  const blocks = [...byBlock.keys()].sort((left, right) => left - right);
  const launches: B20LaunchV1[] = [];
  let lastComplete = toBlock;
  let truncated = false;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const batch = byBlock.get(block)!;
    if (launches.length > 0 && launches.length + batch.length > maxLaunches) {
      // Stop BEFORE this block. The previous one is the last we finished, and
      // this block is left whole for the next run.
      lastComplete = block - 1;
      truncated = true;
      break;
    }
    // A single block over budget is taken complete. Splitting it would either
    // lose the rest of it or return it again on every run, forever.
    launches.push(...batch);
    if (launches.length >= maxLaunches && index + 1 < blocks.length) {
      lastComplete = block;
      truncated = true;
      break;
    }
  }

  if (lastComplete <= input.cursor.lastProcessedBlock) {
    // Nothing was finished. Not a failure — just no progress, and no anchor to
    // read, because the cursor is not moving.
    return {
      launches: [],
      nextCursor: input.cursor,
      state: { status: 'ok' },
      budgetExhausted: true,
      confirmedHead,
      scannedFrom: fromBlock,
      scannedTo: toBlock,
    };
  }

  // The anchor for the block the cursor is about to name — read explicitly,
  // for that block, every time. Without this the cursor would carry the
  // previous run's hash on a new block number, and the reorg check would be
  // comparing a hash against a block it never belonged to.
  const anchorHash = await input.source.blockHash(lastComplete);
  if (anchorHash === null) {
    // Nothing durable moves. The launches are dropped and re-read next run —
    // they cost nothing to re-read, and a cursor with no verified anchor costs
    // a reorg nobody can detect.
    return unchanged({ status: 'endpoint_unavailable', call: 'anchor' }, confirmedHead);
  }

  return {
    launches,
    nextCursor: {
      lastProcessedBlock: lastComplete,
      lastProcessedBlockHash: anchorHash.toLowerCase(),
    },
    state: { status: 'ok' },
    budgetExhausted: rangeCapped || truncated,
    confirmedHead,
    scannedFrom: fromBlock,
    scannedTo: lastComplete,
  };
}

/**
 * Whether the chain still agrees with what we stored.
 *
 * A stored block hash that no longer matches the chain means the range beneath
 * the cursor was reorganised, and everything read from it is suspect. The
 * caller rewinds; nothing here quietly repairs the data.
 */
export function detectReorgV1(input: {
  cursor: LaunchCursorV1;
  observedHashAtCursor: string | null;
}): LaunchReaderStateV1 {
  const stored = input.cursor.lastProcessedBlockHash;
  const observed = input.observedHashAtCursor;
  // No stored hash is a cold start, not a reorg. Claiming one would rewind a
  // healthy cursor on every fresh deploy.
  if (!stored || !observed) return { status: 'ok' };
  if (stored.toLowerCase() === observed.toLowerCase()) return { status: 'ok' };
  return {
    status: 'reorg_detected',
    atBlock: String(input.cursor.lastProcessedBlock),
    storedHash: stored,
    observedHash: observed,
  };
}

/** How far back to rewind after a reorg. The hash is dropped rather than
 * guessed: the caller re-reads the anchor for the block it lands on, because a
 * cursor carrying a hash from a block it no longer names is the bug this whole
 * file is arranged to prevent. */
export function rewindCursorV1(cursor: LaunchCursorV1, depth = LAUNCH_REWIND_DEPTH_V1): LaunchCursorV1 {
  return {
    lastProcessedBlock: Math.max(0, cursor.lastProcessedBlock - depth),
    lastProcessedBlockHash: null,
  };
}
