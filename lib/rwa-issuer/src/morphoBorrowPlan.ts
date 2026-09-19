// ---------------------------------------------------------------------------
// The venue writes the transaction. We measure what it does before anybody
// signs it, and we say plainly which parts we checked and which we did not.
//
// WHAT MORPHO ACTUALLY PREPARES — MEASURED, NOT ASSUMED
//
// `morpho_prepare_borrow` does NOT return a `borrow()` call. For a 10 USDC
// borrow on the curated NVDAc market it returned two transactions:
//
//   1. Morpho Blue · `setAuthorization(address,bool)` — authorising an adapter
//      (`GeneralAdapter1`) to act for this wallet inside the protocol;
//   2. Bundler3 · a multicall whose payload nests the borrow inside an adapter
//      call, several frames deep.
//
// An earlier version of this module decoded the head of each call as Morpho's
// five-word `MarketParams` struct. That is what a direct protocol call looks
// like and it is not what arrives. Decoding a nested bundle frame by frame
// would be a second, unreviewed ABI reader whose failure mode is a confident
// wrong answer about somebody's money.
//
// SO THE BINDING CHECK IS THE MEASUREMENT, NOT THE DECODING
//
// What the calldata MEANS is a claim; what the batch DOES is a measurement.
// `eth_simulateV1` executes the actual bytes against actual state in one
// evolving state, and its asset changes say what moved and to whom. That is
// the check a review is bound to. This module still refuses everything it can
// prove wrong structurally — native value, malformed data, an authorisation it
// cannot read — and shows every target address unabridged rather than hiding
// one behind an allowlist it was told about once.
//
// THE VENUE'S OWN SIMULATION IS A SECOND OPINION, NOT THE ANSWER
//
// Morpho simulates too, and returns the result beside the transactions.
// Measured 2026-09-19: asked to prepare 1,200 USDC on a market holding 823,
// it returned `SIMULATION_REVERTED — insufficient liquidity` AND TWO
// SIGNABLE TRANSACTIONS. A client that reads `transactions` and not
// `warnings` hands a user a transaction that reverts. Their verdict is carried
// and disagreement with ours is itself a refusal — neither is quietly
// preferred.
//
// The same session measured why `maxBorrowable` cannot be shown as what a user
// can borrow: it said 1,779 USDC on a market with 823 available. It is the
// health headroom alone. `morphoBorrowCapacityV1` is bounded by both.
// ---------------------------------------------------------------------------

import { selectorV1 } from '@mioagent/b20-control';
import type { ExecutionCallV1 } from '@mioagent/route-domain';

/** Morpho Blue on Base, read from the venue's own API rather than remembered. */
export const MORPHO_BLUE_BASE_V1 = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';

export const MORPHO_PLAN_SELECTORS_V1 = {
  /** `setAuthorization(address,bool)` on Morpho Blue. */
  setAuthorization: `0x${selectorV1('setAuthorization(address,bool)')}`,
  approve: `0x${selectorV1('approve(address,uint256)')}`,
} as const;

export const MORPHO_BORROW_PLAN_REFUSALS_V1 = [
  'venue_returned_no_calls',
  'call_not_decodable',
  'call_moves_native_value',
  'authorization_not_readable',
] as const;
export type MorphoBorrowPlanRefusalV1 = (typeof MORPHO_BORROW_PLAN_REFUSALS_V1)[number];

/** A transaction exactly as the venue handed it over. */
export interface PreparedTransactionV1 {
  to: string;
  data: string;
  value?: string | number | bigint | null;
  /** The venue's own words for this call. Carried verbatim, never trusted. */
  description?: string | null;
}

/** One call, with what we could establish about it and what we could not. */
export interface MorphoPlanStepV1 {
  index: number;
  to: string;
  selector: string;
  /** The venue's description, verbatim. A label, never evidence. */
  venueDescription: string | null;
  /** True when this module read the call itself rather than repeating a label. */
  decodedByMiorail: boolean;
  /** What we established, or the honest absence of it. */
  reading: string;
}

/** A `setAuthorization` this batch performs, named so a reader sees it. */
export interface MorphoPlanAuthorizationV1 {
  index: number;
  /** The address being given the right to act for this wallet inside Morpho. */
  authorized: string;
  granted: boolean;
}

export interface MorphoBorrowPlanV1 {
  calls: readonly ExecutionCallV1[];
  steps: readonly MorphoPlanStepV1[];
  /** Empty is meaningful: this batch grants nobody anything. */
  authorizations: readonly MorphoPlanAuthorizationV1[];
  /** Every distinct contract this batch touches, for the review to show. */
  targets: readonly string[];
  /**
   * What the venue's own simulation said, when it said anything.
   *
   * `null` means the venue published no simulation — not that it passed.
   */
  venueSimulation: { reverted: boolean; reason: string | null } | null;
}

export type MorphoBorrowPlanResultV1 =
  | { ok: true; plan: MorphoBorrowPlanV1 }
  | { ok: false; refusal: MorphoBorrowPlanRefusalV1; detail: string };

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const HEX_V1 = /^0x([0-9a-f][0-9a-f])*$/;

/** Guards rather than casts: the canonical call type demands `0x${string}`, and
 * the type system should carry the same guarantee the regex just established
 * instead of being told to trust an assertion. */
function isAddressV1(value: string): value is `0x${string}` {
  return ADDRESS_V1.test(value);
}

function isHexDataV1(value: string): value is `0x${string}` {
  return HEX_V1.test(value) && value.length >= 10;
}

function wordV1(data: string, index: number): string | null {
  const start = 10 + index * 64;
  const word = data.slice(start, start + 64);
  return word.length === 64 ? word : null;
}

function addressFromWordV1(word: string | null): `0x${string}` | null {
  if (word === null || !/^0{24}[0-9a-f]{40}$/.test(word)) return null;
  return `0x${word.slice(24)}`;
}

function isZeroValueV1(value: PreparedTransactionV1['value']): boolean {
  if (value === undefined || value === null || value === '') return true;
  try {
    if (typeof value === 'bigint') return value === 0n;
    if (typeof value === 'number') return value === 0;
    return BigInt(value) === 0n;
  } catch {
    return false;
  }
}

/**
 * Every call the venue prepared, checked for what can be proven from the bytes
 * alone and labelled honestly for what cannot.
 *
 * A step whose meaning this module could not establish is NOT a failure: it is
 * carried with `decodedByMiorail: false` and a reading that says so, and the
 * simulation is what decides whether the batch may be signed. Refusing every
 * call we cannot decode would refuse the entire flow, since the venue's own
 * bundler nests the operation several frames deep.
 */
export function morphoBorrowPlanV1(input: {
  prepared: readonly PreparedTransactionV1[];
  walletAddress: string;
  venueSimulation?: { reverted: boolean; reason: string | null } | null;
}): MorphoBorrowPlanResultV1 {
  const wallet = input.walletAddress.trim().toLowerCase();
  if (!isAddressV1(wallet)) {
    return { ok: false, refusal: 'call_not_decodable', detail: 'the wallet is not an exact address' };
  }
  if (input.prepared.length === 0) {
    return { ok: false, refusal: 'venue_returned_no_calls', detail: 'the venue prepared nothing' };
  }

  const calls: ExecutionCallV1[] = [];
  const steps: MorphoPlanStepV1[] = [];
  const authorizations: MorphoPlanAuthorizationV1[] = [];
  const targets = new Set<string>();

  for (const [index, tx] of input.prepared.entries()) {
    const to = String(tx.to ?? '').trim().toLowerCase();
    const data = String(tx.data ?? '').trim().toLowerCase();
    const venueDescription =
      typeof tx.description === 'string' && tx.description.trim().length > 0
        ? tx.description.trim()
        : null;

    if (!isAddressV1(to)) {
      return { ok: false, refusal: 'call_not_decodable', detail: `call ${index} has no target address` };
    }
    if (!isHexDataV1(data)) {
      return { ok: false, refusal: 'call_not_decodable', detail: `call ${index} carries no selector` };
    }
    if (!isZeroValueV1(tx.value)) {
      // A lending call needs no ETH. Native value here is a transfer wearing a
      // borrow's name, and there is no reading of it that makes it fine.
      return { ok: false, refusal: 'call_moves_native_value', detail: `call ${index} sends native value` };
    }

    targets.add(to);
    const selector = data.slice(0, 10);
    let callType: ExecutionCallV1['callType'] = 'other';
    let spender: `0x${string}` | null = null;
    let amountAtomic: string | null = null;
    let decodedByMiorail = false;
    let reading: string;

    if (to === MORPHO_BLUE_BASE_V1 && selector === MORPHO_PLAN_SELECTORS_V1.setAuthorization) {
      const authorized = addressFromWordV1(wordV1(data, 0));
      const flag = wordV1(data, 1);
      if (authorized === null || flag === null || !/^0{63}[01]$/.test(flag)) {
        return {
          ok: false,
          refusal: 'authorization_not_readable',
          detail: `call ${index} authorises something this build cannot read`,
        };
      }
      const granted = flag.endsWith('1');
      authorizations.push({ index, authorized, granted });
      decodedByMiorail = true;
      reading = granted
        ? `Gives ${authorized} the right to act for this wallet inside Morpho, until it is revoked.`
        : `Takes back ${authorized}'s right to act for this wallet inside Morpho.`;
    } else if (selector === MORPHO_PLAN_SELECTORS_V1.approve) {
      const approvedSpender = addressFromWordV1(wordV1(data, 0));
      const word = wordV1(data, 1);
      if (approvedSpender === null || word === null) {
        return { ok: false, refusal: 'call_not_decodable', detail: `call ${index} is not a readable approval` };
      }
      const amount = BigInt(`0x${word}`);
      callType = 'approval';
      spender = approvedSpender;
      amountAtomic = amount.toString();
      decodedByMiorail = true;
      reading = `Lets ${approvedSpender} move up to ${amount.toString()} atomic units of the token at ${to}.`;
    } else {
      // The bundler frame. Its meaning is several frames down and this module
      // does not pretend to read it — the simulation does.
      reading = `Miorail did not read what this call does. Its effect is measured in the simulation below, not taken from its label.`;
    }

    calls.push({
      index,
      callType,
      to,
      valueWei: '0',
      data,
      asset: null,
      amountAtomic,
      recipient: null,
      spender,
    });
    steps.push({ index, to, selector, venueDescription, decodedByMiorail, reading });
  }

  return {
    ok: true,
    plan: {
      calls,
      steps,
      authorizations,
      targets: [...targets],
      venueSimulation: input.venueSimulation ?? null,
    },
  };
}

/* -------------------------------------------------------------------------
 * The measurement the review is bound to.
 * ---------------------------------------------------------------------- */

/**
 * Three states, and they are not degrees of one another.
 *
 * `not_simulated` is OUR gap — no provider answered — and must never be read
 * as a pass. `reverted` is a measured fact about the batch. Only `executed`
 * can support putting a transaction in front of a reader.
 */
export type MorphoBorrowSimulationV1 =
  | {
      state: 'executed';
      blockNumber: number;
      /** Loan asset that arrived at the wallet, measured. Null when the
       * provider reported no asset changes to read. */
      loanReceivedAssets: bigint | null;
    }
  | { state: 'reverted'; failedCallIndex: number | null; reason: string | null }
  | { state: 'not_simulated'; reason: string };

export const MORPHO_BORROW_VERDICT_REFUSALS_V1 = {
  not_simulated:
    'No provider executed these calls, so nothing here has been measured. That is a gap in Miorail’s reading, not a finding about the transaction, and it is not a pass.',
  reverted:
    'These calls revert when executed against current state. Signing them would spend gas to achieve nothing.',
  venue_and_miorail_disagree:
    'The venue’s own simulation and Miorail’s disagree about whether these calls execute. Until they agree, neither answer is being relied on.',
  nothing_arrived:
    'The simulation executed and no loan asset reached this wallet. Whatever these calls do, they do not put the borrowed amount here.',
  wrong_amount_arrived:
    'The simulation executed and the amount that reached this wallet is not the amount under review.',
} as const;
export type MorphoBorrowVerdictRefusalV1 = keyof typeof MORPHO_BORROW_VERDICT_REFUSALS_V1;

/**
 * Whether this batch may be put in front of a reader for approval.
 *
 * The amount check is the one that catches what decoding cannot: a bundle that
 * executes cleanly and delivers something other than what the review describes
 * still fails here.
 */
export function morphoBorrowVerdictV1(input: {
  plan: MorphoBorrowPlanV1;
  simulation: MorphoBorrowSimulationV1;
  /** What the review says will arrive, in loan-asset atomic units. */
  expectedAssets: bigint;
}): { ok: true } | { ok: false; refusal: MorphoBorrowVerdictRefusalV1; detail: string | null } {
  const { plan, simulation, expectedAssets } = input;

  if (simulation.state === 'not_simulated') {
    return { ok: false, refusal: 'not_simulated', detail: simulation.reason };
  }
  if (simulation.state === 'reverted') {
    // The venue agreeing does not make it better, and the venue disagreeing
    // does not make it worse: a measured revert is a measured revert.
    return { ok: false, refusal: 'reverted', detail: simulation.reason };
  }
  if (plan.venueSimulation?.reverted === true) {
    return {
      ok: false,
      refusal: 'venue_and_miorail_disagree',
      detail: plan.venueSimulation.reason,
    };
  }
  if (simulation.loanReceivedAssets === null || simulation.loanReceivedAssets === 0n) {
    return { ok: false, refusal: 'nothing_arrived', detail: null };
  }
  if (simulation.loanReceivedAssets !== expectedAssets) {
    return {
      ok: false,
      refusal: 'wrong_amount_arrived',
      detail: `${simulation.loanReceivedAssets.toString()} arrived, ${expectedAssets.toString()} was under review`,
    };
  }
  return { ok: true };
}
