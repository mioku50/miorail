import { MARKET_TAIL_CONFIRMATIONS_V1, MARKET_TAIL_MAX_SPAN_V1 } from './constants.js';

// ---------------------------------------------------------------------------
// Which blocks a pass may read.
//
// Its own function because both mistakes it prevents are silent. Reading to the
// head writes events for transactions a reorg can still take back, and reading
// an unbounded span is the request that comes back "response too large" after
// the endpoint has already spent the time.
// ---------------------------------------------------------------------------

export type TailRangeV1 =
  /** `reachedHead`: the range ends at the safe head, not at the span. A run
   * stops after such a pass: another one would only chase the blocks Base made
   * while this one ran, and at Denim's five blocks a second it always finds
   * some, so a run of N passes would always spend all N. */
  | { ok: true; fromBlock: number; toBlock: number; reachedHead: boolean }
  | { ok: false; reason: 'caught_up' };

export function tailRangeV1(input: {
  /** The last block already stored. The next pass starts after it. */
  lastBlock: number;
  headBlock: number;
  confirmations?: number;
  maxSpan?: number;
}): TailRangeV1 {
  const confirmations = input.confirmations ?? MARKET_TAIL_CONFIRMATIONS_V1;
  const maxSpan = Math.max(1, input.maxSpan ?? MARKET_TAIL_MAX_SPAN_V1);
  const safeHead = input.headBlock - confirmations;
  const fromBlock = input.lastBlock + 1;
  if (safeHead < fromBlock) return { ok: false, reason: 'caught_up' };
  const spanEnd = fromBlock + maxSpan - 1;
  return { ok: true, fromBlock, toBlock: Math.min(safeHead, spanEnd), reachedHead: safeHead <= spanEnd };
}

/**
 * Whether a run may start another pass inside its time budget: the time used
 * plus the slowest pass so far must fit. A run that stops here has not failed:
 * the cursor holds every pass it finished, and the next run continues from it.
 * Without the budget, a backlog longer than one run (a host move, a throttled
 * hour) ran every pass until systemd killed the run, which reported a failed
 * unit each hour and skipped the corporate-action stage that follows the passes.
 * No budget leaves `--passes` as the only bound.
 */
export function passFitsBudgetV1(input: {
  elapsedMs: number;
  /** The slowest pass of this run so far; 0 before the first. */
  slowestPassMs: number;
  budgetMs: number | null;
}): boolean {
  if (input.budgetMs === null) return true;
  return input.elapsedMs + input.slowestPassMs <= input.budgetMs;
}
