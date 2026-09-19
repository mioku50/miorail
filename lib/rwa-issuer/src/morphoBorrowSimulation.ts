// ---------------------------------------------------------------------------
// What the batch DID, as opposed to what its calldata claims.
//
// `morphoBorrowPlanV1` reads the two calls Morpho prepares and can prove only
// what the bytes prove: no native value, and the authorisation decoded and
// named. The borrow itself is nested several frames inside a Bundler3
// multicall, so its effect is not available to any honest decoder we have.
//
// This module turns ONE `eth_simulateV1` run — every call in order, one
// evolving state — into the single fact a review is allowed to rest on: how
// much of the loan asset actually reached this wallet.
//
// AN UNREAD ARRIVAL IS NOT A ZERO ARRIVAL
//
// The provider reports asset changes as an explicitly-statused block: a run
// can execute cleanly and still leave its effects unprovable (no logs, an
// event this build cannot decode, a native movement that emits nothing). Those
// are two opposite facts —
//
//   read:  the logs were decoded and nothing of the loan asset came here
//   unread: nobody established what came here
//
// — and the type below makes it impossible to carry one while saying the
// other. The first refuses a borrow because of what the batch does; the second
// refuses it because of a gap in our own reading, and they must never share a
// sentence ([[a-gate-that-fails-open-must-say-so]]).
//
// THE NET, NOT THE SUM OF ARRIVALS
//
// A batch that credits this wallet 10 USDC and takes 10 USDC back has an
// inbound sum of 10 and leaves nothing behind. The measure is the net change
// for the loan asset, so a round trip reads as the zero it is.
// ---------------------------------------------------------------------------

/** One decoded asset movement, already expressed relative to the wallet that
 * was simulated. The shape is the provider contract's, narrowed to the fields
 * this reading uses, so nothing in this package depends on the simulation
 * apparatus itself. */
export interface SimulatedAssetChangeV1 {
  token: string;
  direction: 'in' | 'out';
  /** Unsigned base-unit integer, as a decimal string. */
  amountAtomic: string;
}

/** The provider's own statused block. `null`/`undefined` means the provider
 * published no asset-change block at all — which is unread, never empty. */
export interface SimulatedAssetChangesV1 {
  status: 'available' | 'unavailable';
  unavailableReason: string | null;
  changes: readonly SimulatedAssetChangeV1[];
}

/** One simulated batch, narrowed to what a borrow verdict needs. */
export interface SimulatedBatchV1 {
  status: 'success' | 'reverted';
  blockNumber: number;
  failedCallIndex: number | null;
  revertReason: string | null;
  assetChanges?: SimulatedAssetChangesV1 | null;
}

/**
 * What reached the wallet, or why nobody knows.
 *
 * Two constructors, no third state, and no field that can be set to a number
 * while the reading failed.
 */
export type MorphoBorrowArrivalV1 =
  | { read: true; assets: bigint }
  | { read: false; reason: string };

/**
 * Three states, and they are not degrees of one another.
 *
 * `not_simulated` is OUR gap — no provider answered — and must never be read
 * as a pass. `reverted` is a measured fact about the batch. Only `executed`
 * can support putting a transaction in front of a reader, and even then only
 * when its arrival was actually read.
 */
export type MorphoBorrowSimulationV1 =
  | { state: 'executed'; blockNumber: number; arrival: MorphoBorrowArrivalV1 }
  | { state: 'reverted'; failedCallIndex: number | null; reason: string | null }
  | { state: 'not_simulated'; reason: string };

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const UNSIGNED_V1 = /^(0|[1-9][0-9]*)$/;

/**
 * The net movement of one token across the whole batch, relative to the wallet
 * that was simulated.
 *
 * Every refusal here names the thing that was missing. A change whose amount
 * this build cannot parse makes the WHOLE reading unread rather than being
 * skipped: a skipped entry is an arrival silently understated, which is the
 * direction that lets a transaction through.
 */
export function morphoBorrowArrivalV1(input: {
  assetChanges?: SimulatedAssetChangesV1 | null;
  loanTokenAddress: string;
}): MorphoBorrowArrivalV1 {
  const token = input.loanTokenAddress.trim().toLowerCase();
  if (!ADDRESS_V1.test(token)) {
    return { read: false, reason: 'the loan asset was not given as an exact address' };
  }
  const block = input.assetChanges;
  if (!block) {
    return { read: false, reason: 'the simulation published no asset changes to read' };
  }
  if (block.status === 'unavailable') {
    return {
      read: false,
      reason: block.unavailableReason?.trim() || 'the simulation could not prove what moved',
    };
  }

  let net = 0n;
  for (const change of block.changes) {
    const changed = String(change.token ?? '').trim().toLowerCase();
    if (changed !== token) continue;
    const raw = String(change.amountAtomic ?? '').trim();
    if (!UNSIGNED_V1.test(raw)) {
      return { read: false, reason: 'the simulation reported an amount this build cannot read' };
    }
    const amount = BigInt(raw);
    if (change.direction === 'in') net += amount;
    else if (change.direction === 'out') net -= amount;
    else return { read: false, reason: 'the simulation reported a direction this build cannot read' };
  }
  return { read: true, assets: net };
}

/**
 * One executed batch, turned into the measurement the verdict is bound to.
 *
 * A revert carries no arrival at all: the EVM discards a reverted call's logs,
 * so anything decoded from them would be an effect that never happened.
 */
export function morphoBorrowSimulationFromBatchV1(input: {
  batch: SimulatedBatchV1;
  loanTokenAddress: string;
}): MorphoBorrowSimulationV1 {
  const { batch } = input;
  if (batch.status === 'reverted') {
    return {
      state: 'reverted',
      failedCallIndex: batch.failedCallIndex,
      reason: batch.revertReason?.trim() || null,
    };
  }
  if (!Number.isSafeInteger(batch.blockNumber) || batch.blockNumber <= 0) {
    // A run whose block cannot be named cannot be cited in a review, and a
    // review without a block is a number with no clock on it.
    return { state: 'not_simulated', reason: 'the simulation did not name the block it ran against' };
  }
  return {
    state: 'executed',
    blockNumber: batch.blockNumber,
    arrival: morphoBorrowArrivalV1({
      assetChanges: batch.assetChanges,
      loanTokenAddress: input.loanTokenAddress,
    }),
  };
}
