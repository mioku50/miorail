import type { SimulationStateV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// One simulation, one state.
//
// Production showed the Review screen saying both of these at once, about the
// same Aerodrome swap:
//
//   "The Safety Kernel refused this transaction —
//    simulation_evidence: This swap reverts in simulation, so it cannot be signed."
//   "Simulation not available — No simulation provider answered."
//
// Both sentences came from real code and neither was a display bug. The kernel
// read the stored `SimulationStateV1`; the Pre-flight block read the separate
// `/simulate` response, which is absent whenever preparation is BLOCKED — and
// a missing response was rendered as "no provider answered". Two readers, two
// vocabularies, one fact.
//
// So the fact gets a name of its own. `classifySimulationOutcomeV1` maps a
// stored state to exactly ONE of five outcomes, and both the kernel detail and
// the screen render from that single value. They cannot disagree, because
// there is nothing left to disagree about.
//
// The fifth outcome is `insufficient_funds`, and it is not a nicety. An
// `eth_call` from a wallet that cannot cover the value reverts, and the old
// mapping reported that as "this swap reverts in simulation" — a sentence
// about the ROUTE for a fact about the WALLET. A user with an empty balance
// was being told the market was broken.
// ---------------------------------------------------------------------------

export type SimulationOutcomeV1 =
  /** Executed against live state; every call succeeded. */
  | 'simulation_passed'
  /** Executed against live state; a call reverted. Evidence, not absence. */
  | 'simulation_reverted'
  /** The wallet cannot fund this call. About the wallet, never the route. */
  | 'insufficient_funds'
  /** A simulator answered and refused this call SHAPE (e.g. a batch). */
  | 'simulation_method_unsupported'
  /** No simulator answered at all: unconfigured, timed out, rate limited. */
  | 'simulation_provider_unavailable';

/**
 * Provider error codes that mean "the wallet cannot pay", not "the route is
 * broken". `provider_insufficient_funds` is the adapter's own classification;
 * the RPC strings are what a bare Base node returns for the same condition.
 */
const INSUFFICIENT_FUNDS_CODES_V1: readonly string[] = [
  'provider_insufficient_funds',
  'insufficient_funds',
  'insufficient_balance',
];

/** Codes that mean a simulator ANSWERED and declined this call shape. */
const METHOD_UNSUPPORTED_CODES_V1: readonly string[] = [
  'provider_method_unsupported',
  'provider_call_count_mismatch',
  'provider_invalid_schema',
  'provider_chain_mismatch',
  'provider_blueprint_mismatch',
];

/** Recognise the funds condition in an RPC message that carried no code. */
const INSUFFICIENT_FUNDS_TEXT_V1 =
  /insufficient\s+(?:funds|balance)|insufficient\s+funds\s+for\s+gas|exceeds\s+balance|transfer\s+amount\s+exceeds\s+balance/iu;

/**
 * The single state a stored simulation is in.
 *
 * `not_requested` and `pending` are folded into `simulation_provider_unavailable`
 * on purpose: from a signing decision's point of view "nobody has asked yet"
 * and "nobody answered" are the same absence of evidence, and inventing a
 * sixth outcome for them would put a state on screen that no copy explains.
 */
export function classifySimulationOutcomeV1(state: SimulationStateV1): SimulationOutcomeV1 {
  if (state.status === 'passed') return 'simulation_passed';
  const code = (state.errorCode ?? '').trim().toLowerCase();
  if (INSUFFICIENT_FUNDS_CODES_V1.includes(code) || INSUFFICIENT_FUNDS_TEXT_V1.test(code)) {
    return 'insufficient_funds';
  }
  if (state.status === 'failed') {
    return METHOD_UNSUPPORTED_CODES_V1.includes(code) ? 'simulation_method_unsupported' : 'simulation_reverted';
  }
  if (METHOD_UNSUPPORTED_CODES_V1.includes(code)) return 'simulation_method_unsupported';
  return 'simulation_provider_unavailable';
}

/** Did a simulator actually run these calls? Only then is a refusal evidence
 * about the route rather than about our own coverage. */
export function simulationWasExecutedV1(outcome: SimulationOutcomeV1): boolean {
  return outcome === 'simulation_passed' || outcome === 'simulation_reverted' || outcome === 'insufficient_funds';
}

export interface SimulationOutcomeCopyV1 {
  /** The screen's heading for the Pre-flight block. */
  headline: string;
  /** One sentence a user can act on. */
  detail: string;
  /** Short label for the status pill. */
  subLabel: string;
}

/**
 * One sentence per outcome, written for the person deciding whether to sign.
 *
 * Kept here rather than in the UI package so the kernel's `blockedReason` and
 * the Review screen quote the same words. When they lived apart they drifted,
 * and the drift is what put two contradicting sentences on one screen.
 */
export const SIMULATION_OUTCOME_COPY_V1: Readonly<Record<SimulationOutcomeV1, SimulationOutcomeCopyV1>> = Object.freeze({
  simulation_passed: {
    headline: 'Simulation passed on Base mainnet 8453',
    detail: 'These exact calls were executed against live Base state and all of them succeeded.',
    subLabel: 'passed',
  },
  simulation_reverted: {
    headline: 'Simulation reverted on Base mainnet 8453',
    detail: 'These exact calls were executed against live Base state and reverted. Nothing was signed — change the route or the amount and try again.',
    subLabel: 'reverted',
  },
  insufficient_funds: {
    headline: 'Your wallet cannot fund this swap',
    detail: 'The simulation ran and failed because this wallet does not hold enough to cover the input amount and gas. This is about the balance, not about the route.',
    subLabel: 'insufficient funds',
  },
  simulation_method_unsupported: {
    headline: 'No simulator supports this call shape',
    detail: 'A simulator answered but cannot execute this call shape — an ordered approve-and-swap batch needs a provider that simulates a batch against one evolving state. Miorail will not sign calldata it could not simulate.',
    subLabel: 'not supported',
  },
  simulation_provider_unavailable: {
    headline: 'Simulation not available',
    detail: 'No simulation provider answered. Route comparison and the calls above are unchanged.',
    subLabel: 'not available',
  },
});

/** The `simulation_evidence` detail the Safety Kernel records when it blocks. */
export function simulationBlockedDetailV1(provider: string, outcome: SimulationOutcomeV1): string {
  const copy = SIMULATION_OUTCOME_COPY_V1[outcome];
  return outcome === 'simulation_method_unsupported'
    ? `${copy.detail} (${provider}, simulation_method_unsupported)`
    : copy.detail;
}
