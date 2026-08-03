import type { B20PreparedEntryPlanV1 } from './b20EntryPlans.js';
import type { B20EntrySubmissionAttemptV1 } from './b20EntrySubmissions.js';

// ---------------------------------------------------------------------------
// T68F-B §1/§13 — one state, derived on the server, shared by both surfaces.
//
// The interface and the miniapp must never each decide what a plan's state is.
// Two implementations of "is this still submittable?" drift, and the direction
// they drift in is always the same: one of them offers a second Buy button for
// a transaction that is already in flight.
//
// So the state is computed HERE, from the stored plan and the stored attempt,
// and both surfaces switch on the single string this produces.
// ---------------------------------------------------------------------------

/**
 * Whether the complete submission path exists.
 *
 * Availability is a fact about the SURFACE, not about the plan. A plan holding
 * unsigned calls is not evidence that anything can send them — that inference
 * is exactly how a button appears for a path that does not exist.
 */
export interface B20EntryExecutionCapabilitiesV1 {
  /** The submission endpoints are reachable and their storage is migrated. */
  submissionRouteWired: boolean;
  /** The calling surface can actually reach a wallet (EIP-5792). */
  walletIntegrationWired: boolean;
  /** Status can be recovered afterwards. Without it a submission becomes
   * unobservable the moment the tab closes, so it is not offered. */
  reconciliationWired: boolean;
}

export const B20_ENTRY_EXECUTION_UNAVAILABLE_V1 = 'submission_not_wired' as const;

export function entryExecutionAvailableV1(
  capabilities: B20EntryExecutionCapabilitiesV1 | null | undefined,
): boolean {
  if (!capabilities) return false;
  return (
    capabilities.submissionRouteWired &&
    capabilities.walletIntegrationWired &&
    capabilities.reconciliationWired
  );
}

/** Every state a surface may render. One list, both surfaces. */
export const B20_ENTRY_UI_STATE_V1 = [
  'preparing',
  'review',
  'expired',
  'awaiting_wallet_approval',
  'user_rejected',
  'submitted',
  'reconciling',
  'entry_succeeded',
  'entry_reverted',
  'submitted_unknown',
  'reconciliation_required',
] as const;
export type B20EntryUiStateV1 = (typeof B20_ENTRY_UI_STATE_V1)[number];

/** States in which a surface may offer to open a wallet. Anything else showing
 * a submit button is a bug, and this list is what the tests assert against. */
export const B20_ENTRY_SUBMITTABLE_STATES_V1: readonly B20EntryUiStateV1[] = [
  'review',
  'user_rejected',
];

/** States where the only honest action left is to ask again what happened. */
export const B20_ENTRY_REFRESHABLE_STATES_V1: readonly B20EntryUiStateV1[] = [
  'awaiting_wallet_approval',
  'submitted',
  'reconciling',
  'submitted_unknown',
];

/**
 * The state of one prepared plan.
 *
 * The attempt wins over the plan wherever they could disagree: a stored
 * attempt is what a refresh must recover, and a page that re-read only the
 * plan would show `review` for an entry that is already on chain.
 */
export function entryUiStateV1(input: {
  plan: B20PreparedEntryPlanV1;
  attempt: B20EntrySubmissionAttemptV1 | null;
  now: Date;
}): B20EntryUiStateV1 {
  const attempt = input.attempt;

  if (attempt) {
    if (attempt.status === 'awaiting_wallet_approval') return 'awaiting_wallet_approval';
    if (attempt.status === 'submitted') return 'submitted';
    if (attempt.status === 'reconciling') return 'reconciling';
    switch (attempt.terminalOutcome) {
      case 'entry_succeeded':
        return 'entry_succeeded';
      case 'entry_reverted':
        return 'entry_reverted';
      case 'submitted_unknown':
        return 'submitted_unknown';
      case 'reconciliation_required':
        return 'reconciliation_required';
      case 'user_rejected':
        // Nothing was sent, so Review is still a legitimate place to return to
        // — but only if the plan itself is still alive.
        return Date.parse(input.plan.expiresAt) <= input.now.getTime() ? 'expired' : 'user_rejected';
      case 'cancelled_before_submission':
        return Date.parse(input.plan.expiresAt) <= input.now.getTime() ? 'expired' : 'review';
      default:
        break;
    }
  }

  // Expiry is derived here rather than stored, so no historical evidence is
  // rewritten to record the passage of time.
  if (Date.parse(input.plan.expiresAt) <= input.now.getTime()) return 'expired';
  return input.plan.lifecycle === 'prepared' ? 'review' : 'awaiting_wallet_approval';
}

/** Whether this state may show a button that opens a wallet. */
export function entryCanSubmitV1(state: B20EntryUiStateV1): boolean {
  return B20_ENTRY_SUBMITTABLE_STATES_V1.includes(state);
}

/** Whether this state may only offer a status refresh. */
export function entryCanRefreshV1(state: B20EntryUiStateV1): boolean {
  return B20_ENTRY_REFRESHABLE_STATES_V1.includes(state);
}
