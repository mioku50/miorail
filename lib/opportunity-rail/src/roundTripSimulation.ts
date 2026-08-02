// ---------------------------------------------------------------------------
// T68D §4 — proving a round trip instead of quoting one.
//
// A quote answers "what would come out if the pool were untouched". Two quotes
// answer that twice, against the same untouched pool, which is precisely the
// state that cannot exist after the first leg executes. That is why
// `quoted_pre_entry` may reject and may never certify.
//
// This module reads what a SIMULATION observed: four calls in one ordered
// state, and the wallet's own decoded asset movements. The certification rule
// is deliberately strict about one thing above all — the exit must consume
// exactly what the entry produced. An exit that sold a quoted amount while the
// entry produced something else is two facts pretending to be a round trip.
//
// Nothing here signs, broadcasts, overrides state or forges a balance. It
// decodes evidence.
// ---------------------------------------------------------------------------

const BPS_DENOMINATOR = 10_000n;

/** One decoded wallet movement, as the simulation reported it. */
export interface SimulatedAssetChangeLikeV1 {
  token: string;
  direction: 'in' | 'out';
  amountAtomic: string;
  callIndex: number;
}

export interface SimulatedCallLikeV1 {
  index: number;
  status: 'success' | 'reverted';
}

/** The four calls, by position. The order is the proof: an approval after its
 * swap proves nothing, and a reordered list is a different transaction. */
export const ROUND_TRIP_CALL_INDEX_V1 = {
  approveEntry: 0,
  entrySwap: 1,
  approveExit: 2,
  exitSwap: 3,
} as const;

export const ROUND_TRIP_CALL_COUNT_V1 = 4;

export type RoundTripCertificationV1 =
  | {
      status: 'certified';
      /** What the wallet actually paid, from the decoded movement. */
      spentAtomic: string;
      /** What the entry actually produced. */
      acquiredAtomic: string;
      /** What came back. */
      returnedAtomic: string;
      /** Basis points of the position that did not come back, rounded against
       * the user. */
      costBps: number;
    }
  | { status: 'reverted'; callIndex: number }
  /** The simulation ran but does not prove the flow. Never a finding about the
   * token: an undecodable log is a gap in evidence, not a property of a pool. */
  | { status: 'undecodable'; reason: string };

export interface CertifyRoundTripInputV1 {
  quoteAsset: string;
  tokenAddress: string;
  /** The position the profile asked about, atomic units of the quote asset. */
  positionAtomic: string;
  calls: readonly SimulatedCallLikeV1[];
  assetChangesAvailable: boolean;
  assetChanges: readonly SimulatedAssetChangeLikeV1[];
}

function sumV1(
  changes: readonly SimulatedAssetChangeLikeV1[],
  filter: { token: string; direction: 'in' | 'out'; callIndex: number },
): bigint {
  const token = filter.token.toLowerCase();
  let total = 0n;
  for (const change of changes) {
    if (
      change.token.toLowerCase() === token &&
      change.direction === filter.direction &&
      change.callIndex === filter.callIndex
    ) {
      total += BigInt(change.amountAtomic);
    }
  }
  return total;
}

/**
 * Whether a simulated four-call sequence proves the round trip.
 *
 * Fail-closed at every step. A missing call, a wrong count, a revert, an
 * undecodable movement or an exit that did not consume the entry's output all
 * stop the certification — none of them downgrade into "probably fine".
 */
export function certifyRoundTripV1(input: CertifyRoundTripInputV1): RoundTripCertificationV1 {
  if (input.calls.length !== ROUND_TRIP_CALL_COUNT_V1) {
    return { status: 'undecodable', reason: 'the simulation did not return four calls' };
  }
  for (const call of input.calls) {
    if (call.status === 'reverted') return { status: 'reverted', callIndex: call.index };
  }
  if (!input.assetChangesAvailable) {
    // A simulation can pass while its asset effects stay unprovable. That is
    // not a round trip, and it must not be shown as one.
    return { status: 'undecodable', reason: 'the simulation proved no asset movements' };
  }

  const spent = sumV1(input.assetChanges, {
    token: input.quoteAsset,
    direction: 'out',
    callIndex: ROUND_TRIP_CALL_INDEX_V1.entrySwap,
  });
  const acquired = sumV1(input.assetChanges, {
    token: input.tokenAddress,
    direction: 'in',
    callIndex: ROUND_TRIP_CALL_INDEX_V1.entrySwap,
  });
  const sold = sumV1(input.assetChanges, {
    token: input.tokenAddress,
    direction: 'out',
    callIndex: ROUND_TRIP_CALL_INDEX_V1.exitSwap,
  });
  const returned = sumV1(input.assetChanges, {
    token: input.quoteAsset,
    direction: 'in',
    callIndex: ROUND_TRIP_CALL_INDEX_V1.exitSwap,
  });

  if (spent <= 0n) return { status: 'undecodable', reason: 'no quote asset left the wallet' };
  if (acquired <= 0n) return { status: 'undecodable', reason: 'the entry produced no token' };
  if (returned <= 0n) return { status: 'undecodable', reason: 'no quote asset came back' };

  // THE rule. An exit that sold a different quantity than the entry produced
  // measured two different positions and reported one number.
  if (sold !== acquired) {
    return {
      status: 'undecodable',
      reason: 'the exit did not sell exactly what the entry produced',
    };
  }

  // The wallet must have spent the position the profile asked about. A smaller
  // spend would be a round trip for a size nobody asked for.
  if (spent !== BigInt(input.positionAtomic)) {
    return { status: 'undecodable', reason: 'the entry did not spend the requested position' };
  }

  const lost = spent - returned;
  const costBps = lost <= 0n ? 0 : Number((lost * BPS_DENOMINATOR + spent - 1n) / spent);
  return {
    status: 'certified',
    spentAtomic: spent.toString(),
    acquiredAtomic: acquired.toString(),
    returnedAtomic: returned.toString(),
    costBps,
  };
}

/**
 * Reads the entry's output out of a TWO-call simulation.
 *
 * The first pass exists because the exit's calldata has to name an exact
 * amount, and that amount is only knowable once the entry has actually run.
 * Building the exit from the quote instead would either leave a residue (the
 * entry produced more) or revert (it produced less) — and a residue silently
 * understates the round trip.
 */
export function entryOutputFromSimulationV1(input: {
  tokenAddress: string;
  calls: readonly SimulatedCallLikeV1[];
  assetChangesAvailable: boolean;
  assetChanges: readonly SimulatedAssetChangeLikeV1[];
}): { status: 'measured'; acquiredAtomic: string } | { status: 'reverted'; callIndex: number } | { status: 'undecodable'; reason: string } {
  if (input.calls.length !== 2) {
    return { status: 'undecodable', reason: 'the entry probe did not return two calls' };
  }
  for (const call of input.calls) {
    if (call.status === 'reverted') return { status: 'reverted', callIndex: call.index };
  }
  if (!input.assetChangesAvailable) {
    return { status: 'undecodable', reason: 'the entry probe proved no asset movements' };
  }
  const acquired = sumV1(input.assetChanges, {
    token: input.tokenAddress,
    direction: 'in',
    callIndex: ROUND_TRIP_CALL_INDEX_V1.entrySwap,
  });
  if (acquired <= 0n) return { status: 'undecodable', reason: 'the entry produced no token' };
  return { status: 'measured', acquiredAtomic: acquired.toString() };
}

/**
 * The minimum output a leg may accept, from a quoted amount and a tolerance.
 *
 * Integer arithmetic, rounded DOWN, so the floor is never higher than the
 * tolerance allows. A float here would put a user's slippage guard one wei
 * either side of what they agreed to, at random.
 */
export function minimumOutputV1(quotedAtomic: string, toleranceBps: number): string {
  const quoted = BigInt(quotedAtomic);
  const tolerance = BigInt(Math.max(0, Math.min(10_000, Math.trunc(toleranceBps))));
  const minimum = (quoted * (BPS_DENOMINATOR - tolerance)) / BPS_DENOMINATOR;
  // Never zero: a zero minimum is an unbounded-slippage swap, and the encoder
  // refuses one anyway. Surfacing 1 wei here would be a lie, so this is the
  // caller's error to see.
  return minimum > 0n ? minimum.toString() : '0';
}
