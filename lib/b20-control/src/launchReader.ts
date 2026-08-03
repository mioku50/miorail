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
// Three properties, and each exists because its absence produces a specific
// wrong answer:
//
//   * THE CURSOR NEVER PASSES AN UNPROCESSED RANGE. A cursor that advanced on
//     partial failure would silently skip launches, and the gap would be
//     indistinguishable from a quiet hour — forever, because nothing re-reads
//     an old range.
//
//   * A CHANGED EVENT SHAPE STOPS THE READER. The B20Created signature is
//     derived from an observed topic0, not published. If it changes, the only
//     honest outcome is "no launch feed"; a decoder that kept going would
//     record real tokens with wrong names.
//
//   * REORGS ARE DETECTED BY STORED BLOCK HASHES. A confirmation delay makes
//     one unlikely, not impossible, and a launch that was reorged out is not a
//     launch.
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

export type LaunchReaderStateV1 =
  | { status: 'ok' }
  /** An operator state, never written against a token. */
  | { status: 'decoder_mismatch'; refusal: B20LaunchDecodeRefusalV1; atBlock: string | null }
  | { status: 'reorg_detected'; atBlock: string; storedHash: string; observedHash: string }
  | { status: 'endpoint_shape'; detail: string }
  | { status: 'endpoint_unavailable' };

export interface LaunchLogSourceV1 {
  /** `eth_getLogs` over an inclusive block range, already bounded by the
   * caller. Returns null when the endpoint could not answer — which is not the
   * same as "no launches", and the reader treats it that way. */
  getLogs(input: { fromBlock: number; toBlock: number }): Promise<RawLogV1[] | null>;
  /** The current head. Null when unavailable. */
  headBlock(): Promise<number | null>;
}

export interface LaunchCursorV1 {
  /** The last block whose logs are fully processed. */
  lastProcessedBlock: number;
  /** Its hash, so a reorg beneath us is visible rather than assumed away. */
  lastProcessedBlockHash: string | null;
}

export interface ReadLaunchesInputV1 {
  source: LaunchLogSourceV1;
  cursor: LaunchCursorV1;
  /** Hard ceilings for one run. A worker that can be run from a timer must be
   * unable to spend an unbounded amount of anything. */
  maxRange?: number;
  maxLaunches?: number;
  confirmations?: number;
}

export interface ReadLaunchesResultV1 {
  launches: B20LaunchV1[];
  /** Where the cursor may safely move to. NEVER past a range this run did not
   * fully process — on any refusal it stays exactly where it was. */
  nextCursor: LaunchCursorV1;
  state: LaunchReaderStateV1;
  /** True when the budget stopped the run before the confirmed head. The
   * remaining blocks are not "empty"; they are not_checked. */
  budgetExhausted: boolean;
  scannedTo: number | null;
}

/**
 * One bounded pass.
 *
 * On ANY refusal the cursor is returned unchanged. That is the single most
 * important line in this file: a reader that advanced past a range it could not
 * decode would turn a decoder bug into permanent, invisible data loss.
 */
export async function readB20LaunchesV1(input: ReadLaunchesInputV1): Promise<ReadLaunchesResultV1> {
  const maxRange = input.maxRange ?? LAUNCH_MAX_RANGE_V1;
  const maxLaunches = input.maxLaunches ?? 200;
  const confirmations = input.confirmations ?? LAUNCH_CONFIRMATIONS_V1;
  const unchanged = (state: LaunchReaderStateV1): ReadLaunchesResultV1 => ({
    launches: [],
    nextCursor: input.cursor,
    state,
    budgetExhausted: false,
    scannedTo: null,
  });

  const head = await input.source.headBlock();
  if (head === null) return unchanged({ status: 'endpoint_unavailable' });

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
      scannedTo: input.cursor.lastProcessedBlock,
    };
  }

  const toBlock = Math.min(confirmedHead, fromBlock + maxRange - 1);
  const budgetExhausted = toBlock < confirmedHead;

  const logs = await input.source.getLogs({ fromBlock, toBlock });
  if (logs === null) return unchanged({ status: 'endpoint_unavailable' });
  if (!Array.isArray(logs)) {
    // A non-array response is the endpoint changing shape, not an empty range.
    return unchanged({ status: 'endpoint_shape', detail: 'getLogs did not return an array' });
  }

  const launches: B20LaunchV1[] = [];
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
      return unchanged({
        status: 'decoder_mismatch',
        refusal: decoded.refusal,
        atBlock: log.blockNumber ? BigInt(log.blockNumber).toString() : null,
      });
    }
    const id = launchIdV1(decoded.launch);
    // One log is one launch even within a single response.
    if (seen.has(id)) continue;
    seen.add(id);
    launches.push(decoded.launch);
    if (launches.length >= maxLaunches) break;
  }

  // If the launch budget cut the scan short, the cursor may only advance to the
  // last block we actually finished. Advancing to `toBlock` would skip the rest
  // of that range forever.
  const truncated = launches.length >= maxLaunches;
  const lastComplete = truncated
    ? Math.max(input.cursor.lastProcessedBlock, Number(launches[launches.length - 1]!.blockNumber) - 1)
    : toBlock;
  const anchor = launches.find((launch) => Number(launch.blockNumber) === lastComplete);

  return {
    launches: truncated
      ? launches.filter((launch) => Number(launch.blockNumber) <= lastComplete)
      : launches,
    nextCursor: {
      lastProcessedBlock: lastComplete,
      lastProcessedBlockHash: anchor?.blockHash ?? input.cursor.lastProcessedBlockHash,
    },
    state: { status: 'ok' },
    budgetExhausted: budgetExhausted || truncated,
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

/** How far back to rewind after a reorg: past the confirmation window, so the
 * re-read starts from blocks the chain has since settled. */
export function rewindCursorV1(cursor: LaunchCursorV1, confirmations = LAUNCH_CONFIRMATIONS_V1): LaunchCursorV1 {
  return {
    lastProcessedBlock: Math.max(0, cursor.lastProcessedBlock - confirmations * 2),
    // The hash is dropped deliberately: the block it named may not exist.
    lastProcessedBlockHash: null,
  };
}
