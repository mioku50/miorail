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
  | { ok: true; fromBlock: number; toBlock: number }
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
  return { ok: true, fromBlock, toBlock: Math.min(safeHead, fromBlock + maxSpan - 1) };
}
