import {
  B20_ENTRY_EXECUTION_FAMILY_V1,
  b20EntryApprovedCallsHashV1,
  entryPlanCallsHashV1,
  type B20EntrySubmissionAttemptV1,
  type B20OpportunityClearanceV1,
  type B20PreparedEntryPlanV1,
} from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// T68F-B §3 — the submission-time gate.
//
// This is the last check before a wallet is opened, and it is the only one that
// runs against the STORED plan rather than against anything a browser said.
// Everything it verifies is re-derived here: the calls hash is recomputed from
// the stored bytes rather than read from a column, so a row edited in the
// database is caught by the same code path that catches a tampered request.
//
// It never rebuilds, re-quotes or re-certifies. A stale plan is refused and the
// user runs the qualification again — silently re-preparing would hand somebody
// a transaction they never reviewed.
// ---------------------------------------------------------------------------

export type SubmitRefusalV1 =
  | 'entry_plan_not_found'
  | 'entry_plan_expired'
  | 'entry_plan_wrong_family'
  | 'entry_plan_wrong_lifecycle'
  | 'entry_plan_wallet_mismatch'
  | 'entry_plan_chain_mismatch'
  | 'entry_plan_profile_mismatch'
  | 'entry_plan_clearance_expired'
  | 'entry_plan_clearance_mismatch'
  | 'entry_plan_calls_tampered'
  | 'entry_plan_simulation_missing'
  | 'entry_plan_proof_evidence_missing'
  | 'entry_plan_already_submitted'
  | 'entry_plan_controls_stale';

export const SUBMIT_REFUSAL_COPY_V1: Record<SubmitRefusalV1, string> = {
  entry_plan_not_found: 'That entry plan does not exist for this wallet.',
  entry_plan_expired:
    'This plan expired before it was confirmed. Nothing was sent — run the opportunity check again.',
  entry_plan_wrong_family: 'That plan belongs to a different kind of execution.',
  entry_plan_wrong_lifecycle:
    'This plan is no longer waiting to be signed. Refresh to see where it got to.',
  entry_plan_wallet_mismatch: 'That plan was prepared for a different wallet.',
  entry_plan_chain_mismatch: 'That plan is for a different chain.',
  entry_plan_profile_mismatch:
    'The position or tolerance changed since this plan was prepared. A new plan is needed.',
  entry_plan_clearance_expired:
    'The clearance behind this plan has expired. Pools move, so it is short-lived by design — run the check again.',
  entry_plan_clearance_mismatch: 'This plan and its clearance no longer agree.',
  entry_plan_calls_tampered:
    'The stored transaction no longer matches what was checked, so nothing is offered to sign.',
  entry_plan_simulation_missing:
    'This plan has no prepare-time simulation on record, and an unsimulated plan is never sent to a wallet.',
  entry_plan_proof_evidence_missing:
    'This plan lacks token decimals or simulation gas needed for a factual Route Proof. Run the opportunity check again.',
  entry_plan_already_submitted:
    'This plan has already been submitted. Refresh the status rather than sending it twice.',
  entry_plan_controls_stale:
    'This token’s controls have not been re-read recently enough to sign against. Run the check again.',
};

/**
 * The two terminal outcomes that mean NOTHING reached the chain.
 *
 * Everything else — succeeded, reverted, unknown, needs-reconciliation — is a
 * statement about a batch that exists, and a plan whose batch exists must never
 * be offered to a wallet again.
 */
export const B20_RETRYABLE_TERMINAL_OUTCOMES_V1 = [
  'user_rejected',
  'cancelled_before_submission',
] as const;

/**
 * T72-B §7/§11 — whether an attempt still holds this plan's only submission
 * slot.
 *
 * The callers used to ask only whether an attempt was non-terminal, which meant
 * a plan whose entry had already SUCCEEDED could be handed to a wallet a second
 * time. Nothing did, because both surfaces hide the button — but a hidden
 * button is not a guard, and the caller on the other side of this gate may now
 * be an assistant calling the endpoint directly.
 *
 * `submitted_unknown` is the case that matters most: it means a batch was sent
 * and its result could not be established. Retrying that is precisely how
 * somebody buys the same token twice.
 */
export function attemptHoldsPlanSlotV1(attempt: B20EntrySubmissionAttemptV1 | null): boolean {
  if (!attempt) return false;
  if (attempt.status !== 'terminal') return true;
  return !(B20_RETRYABLE_TERMINAL_OUTCOMES_V1 as readonly string[]).includes(
    attempt.terminalOutcome ?? '',
  );
}

/** How old the prepare-time control read may be when a wallet is opened.
 * Shorter than the plan's own life on purpose: the deadline governs whether the
 * swap can still execute, this governs whether we still believe the token. */
export const CONTROL_FRESHNESS_MS_V1 = 120_000;

export interface SubmitGateInputV1 {
  plan: B20PreparedEntryPlanV1 | null;
  clearance: B20OpportunityClearanceV1 | null;
  /** The authenticated session's wallet, never a field from the request. */
  walletAddress: string;
  tenantId: string;
  chainId: number;
  profileIdentity: string;
  /** True when any attempt already holds this plan's submission slot. */
  hasLiveAttempt: boolean;
  now: Date;
  /** When the controls behind this plan were last read. Null means never,
   * which fails closed. */
  controlsReadAt: Date | null;
  controlFreshnessMs?: number;
}

/**
 * Whether a wallet action may be produced for this plan.
 *
 * Ordered from the most specific mismatch outward, so a user whose clearance
 * expired is told that rather than handed something generic that sends them
 * looking for a chain problem.
 */
export function submitGateRefusalV1(input: SubmitGateInputV1): SubmitRefusalV1 | null {
  const plan = input.plan;
  if (!plan) return 'entry_plan_not_found';
  if (plan.tenantId !== input.tenantId) return 'entry_plan_not_found';
  if (plan.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    return 'entry_plan_wallet_mismatch';
  }
  if (plan.executionFamily !== B20_ENTRY_EXECUTION_FAMILY_V1) return 'entry_plan_wrong_family';
  if (plan.chainId !== input.chainId || plan.chainId !== 8453) return 'entry_plan_chain_mismatch';
  if (plan.profileIdentity !== input.profileIdentity) return 'entry_plan_profile_mismatch';

  // A second wallet batch for one plan is the failure that costs real money,
  // so it is checked before anything that could be argued about.
  if (input.hasLiveAttempt) return 'entry_plan_already_submitted';
  if (plan.lifecycle !== 'prepared') return 'entry_plan_wrong_lifecycle';

  if (Date.parse(plan.expiresAt) <= input.now.getTime()) return 'entry_plan_expired';

  const clearance = input.clearance;
  if (!clearance || clearance.id !== plan.clearanceId) return 'entry_plan_clearance_mismatch';
  if (
    clearance.tokenAddress.toLowerCase() !== plan.tokenAddress.toLowerCase() ||
    clearance.profileIdentity !== plan.profileIdentity ||
    clearance.entryRouteHash !== plan.entryRouteHash ||
    clearance.walletAddress.toLowerCase() !== plan.walletAddress.toLowerCase()
  ) {
    return 'entry_plan_clearance_mismatch';
  }
  if (Date.parse(clearance.expiresAt) <= input.now.getTime()) return 'entry_plan_clearance_expired';

  // Recomputed from the stored bytes, never read from a column. A row edited in
  // the database is caught by the same line that catches a tampered request.
  if (entryPlanCallsHashV1(plan.calls) !== plan.callsHash) return 'entry_plan_calls_tampered';
  if (!plan.prepareSimulationEvidenceHash) return 'entry_plan_simulation_missing';
  if (plan.tokenDecimals === null || plan.prepareSimulationGasUsed === null) {
    return 'entry_plan_proof_evidence_missing';
  }

  const readAt = input.controlsReadAt;
  const freshness = input.controlFreshnessMs ?? CONTROL_FRESHNESS_MS_V1;
  if (!readAt || input.now.getTime() - readAt.getTime() > freshness) {
    return 'entry_plan_controls_stale';
  }
  return null;
}

/** The wallet payload, in the shape the existing Base Account integration
 * already speaks. Built ONLY from stored bytes; there is no path by which a
 * request can contribute a call, a target or a value. */
export interface EntryWalletPayloadV1 {
  planId: string;
  blueprintHash: string;
  /** Canonical RouteProofV1 hash of the typed approved calls. */
  approvedCallsHash: string;
  /** B20 plan byte hash retained for submission binding and MCP hand-off. */
  callsHash: string;
  chainId: '0x2105';
  from: string;
  calls: { to: string; value: string; data: string }[];
  atomicRequired: true;
}

export function entryWalletPayloadV1(plan: B20PreparedEntryPlanV1): EntryWalletPayloadV1 {
  return {
    planId: plan.id,
    blueprintHash: plan.blueprintHash,
    approvedCallsHash: b20EntryApprovedCallsHashV1(plan),
    callsHash: plan.callsHash,
    // Base mainnet, as a hex literal, because that is what the wallet contract
    // pins and a number here would be a different assertion.
    chainId: '0x2105',
    from: plan.walletAddress,
    calls: plan.calls.map((call) => ({
      to: call.to,
      // Always zero on this path; hex because the wallet contract is hex.
      value: `0x${BigInt(call.valueWei).toString(16)}`,
      data: call.data,
    })),
    // Approval and swap must land together or not at all: an approval that
    // executed without its swap is a standing allowance nobody asked for.
    atomicRequired: true,
  };
}
