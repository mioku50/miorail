// ---------------------------------------------------------------------------
// T67E §2 — Budget & payments.
//
// The surface is called "Budget & payments" and never "x402". x402 is the
// protocol underneath; a user has a monthly limit, a per-request cap and a list
// of charges. The protocol's name belongs in a technical-details block that
// nobody has to open.
//
// §2.4 is the reason this module exists. "Intelligence Budget is off" was one
// string standing in for eight different situations, four of which the user can
// fix in seconds and four of which they cannot fix at all. Merging them meant
// nobody could tell which they were in.
// ---------------------------------------------------------------------------

export type PaidIntelligenceStateV1 =
  /** The operator has not switched paid intelligence on. Nothing to fix here. */
  | 'feature_disabled'
  /** The server is configured but cannot settle — no facilitator auth. */
  | 'settlement_unavailable'
  /** No Spend Permission exists yet. The user can create one. */
  | 'permission_missing'
  /**
   * T71 — the user granted a permission and then withdrew it.
   *
   * Distinct from `permission_missing`, which it used to collapse into. "You
   * have not set this up" and "you turned this off" are different sentences,
   * and a user who deliberately revoked deserves to see that their action took
   * rather than a screen that looks like it forgot.
   */
  | 'revoked'
  /** A permission exists and the user paused it. */
  | 'paused'
  /** The monthly limit is spent. */
  | 'budget_exceeded'
  /** This one request costs more than the per-request cap allows. */
  | 'max_per_call_exceeded'
  /** The provider itself is down. Money was never at risk. */
  | 'provider_unavailable'
  /** Paid, and the service failed anyway. Money IS at risk. */
  | 'payment_settled_service_failed'
  /** A charge is in an indeterminate state and needs reconciliation. */
  | 'reconciliation_required'
  /** Everything is in place. */
  | 'ready';

export interface PaidIntelligenceViewV1 {
  state: PaidIntelligenceStateV1;
  /** Short status word for the panel header. */
  label: string;
  /** One sentence: what the situation is and what still works. */
  detail: string;
  /** What the USER can do, or null when there is nothing they can do. Null is
   * important: offering an action for `settlement_unavailable` would send a
   * user to fix a server they do not administer. */
  action: 'create_permission' | 'resume' | 'raise_limit' | 'raise_max_per_call' | 'reconcile' | null;
  /** Whether money is currently at risk. Drives the panel's tone. */
  moneyAtRisk: boolean;
}

const VIEW_V1: Record<PaidIntelligenceStateV1, Omit<PaidIntelligenceViewV1, 'state'>> = {
  feature_disabled: {
    label: 'Not enabled',
    detail: 'Paid intelligence is switched off on this server. Route comparison, scoring and proofs are unaffected.',
    action: null,
    moneyAtRisk: false,
  },
  settlement_unavailable: {
    label: 'Settlement unavailable',
    detail:
      'This server cannot settle payments right now, so paid checks are not offered. Nothing has been charged. Free route comparison still works.',
    action: null,
    moneyAtRisk: false,
  },
  permission_missing: {
    label: 'Not configured',
    detail: 'Miorail has no spending permission from your wallet, so it cannot buy paid evidence. Free comparison still works.',
    action: 'create_permission',
    moneyAtRisk: false,
  },
  revoked: {
    label: 'Revoked',
    detail:
      'You revoked this permission, so Miorail will not buy paid evidence. Free route comparison still works. Your wallet may still list the permission — remove it there to withdraw it on chain as well.',
    action: 'create_permission',
    moneyAtRisk: false,
  },
  paused: {
    label: 'Paused',
    detail: 'You paused paid services. Your permission is intact and nothing is being charged.',
    action: 'resume',
    moneyAtRisk: false,
  },
  budget_exceeded: {
    label: 'Monthly limit reached',
    detail: 'This period’s limit is spent. Paid checks resume next period, or sooner if you raise the limit.',
    action: 'raise_limit',
    moneyAtRisk: false,
  },
  max_per_call_exceeded: {
    label: 'Above per-request cap',
    detail: 'This check costs more than your per-request cap allows, so it was not bought. Nothing was charged.',
    action: 'raise_max_per_call',
    moneyAtRisk: false,
  },
  provider_unavailable: {
    label: 'Provider unavailable',
    detail: 'The paid provider did not answer. No payment was attempted, so nothing was charged.',
    action: null,
    moneyAtRisk: false,
  },
  payment_settled_service_failed: {
    label: 'Paid, not delivered',
    // The one state where the user has lost money. It says so plainly.
    detail: 'A payment settled and the service then failed. You were charged and did not receive the evidence. This is recorded for reconciliation.',
    action: 'reconcile',
    moneyAtRisk: true,
  },
  reconciliation_required: {
    label: 'Reconciliation required',
    detail: 'A charge is in an indeterminate state: it may or may not have settled. It is recorded and will be resolved before anything else is charged.',
    action: 'reconcile',
    moneyAtRisk: true,
  },
  ready: {
    label: 'Active',
    detail: 'Paid checks are available within your limits.',
    action: null,
    moneyAtRisk: false,
  },
};

export function paidIntelligenceViewV1(state: PaidIntelligenceStateV1): PaidIntelligenceViewV1 {
  return { state, ...VIEW_V1[state] };
}

/** Structural mirrors of the two wire objects this reads. */
export interface BudgetProjectionLikeV1 {
  status: 'active' | 'paused' | 'revoked' | 'expired';
  monthlyLimitUsdc: string;
  spentUsdc: string;
  reservedUsdc: string;
  remainingUsdc: string;
  maxPerRequestUsdc: string;
  allowedCategories: readonly string[];
  linkedSpendPermissionId: string;
  periodEndsAt: string | null;
}

export interface ChargeSummaryLikeV1 {
  chargeId: string;
  status: string;
  service: string;
  providerName: string;
  category: string;
  quotedUsdc: string;
  chargedUsdc: string | null;
  fundingMode: string;
  createdAt: string;
}

export interface PaidIntelligenceInputV1 {
  /** MIORAIL_PAID_INTELLIGENCE, from the server's own flags. */
  featureEnabled: boolean;
  /** Whether the facilitator can actually settle — T67X-A1's readiness. */
  settleReady: boolean;
  budget: BudgetProjectionLikeV1 | null;
  charges: readonly ChargeSummaryLikeV1[];
}

/**
 * The single state, resolved in priority order.
 *
 * The order is the point. A settled-but-undelivered charge outranks a spent
 * budget, because one has cost the user money and the other has only stopped
 * them spending more. A switched-off feature outranks everything, because when
 * the gate is off none of the rest was even attempted.
 */
export function paidIntelligenceStateV1(input: PaidIntelligenceInputV1): PaidIntelligenceStateV1 {
  if (!input.featureEnabled) return 'feature_disabled';
  if (!input.settleReady) return 'settlement_unavailable';

  // Money first. These outrank configuration because they are the only states
  // where something has already gone wrong with the user's funds.
  const unresolved = input.charges.find(
    (charge) => charge.status === 'reconciliation_required' || charge.status === 'failed',
  );
  if (unresolved?.status === 'reconciliation_required') return 'reconciliation_required';

  if (!input.budget) return 'permission_missing';
  // Withdrawn, not absent. `expired` joins `permission_missing` because the
  // user did not do anything — time did.
  if (input.budget.status === 'revoked') return 'revoked';
  if (input.budget.status === 'expired') return 'permission_missing';
  if (input.budget.status === 'paused') return 'paused';
  if (Number(input.budget.remainingUsdc) <= 0) return 'budget_exceeded';
  return 'ready';
}

// --- The drawer's own view model ---------------------------------------------

export interface BudgetRowV1 {
  label: string;
  value: string;
}

export interface BudgetPaymentsViewV1 {
  status: PaidIntelligenceViewV1;
  /** Null when there is no budget: the drawer then shows only the status and
   * the create action, never a table of zeros that looks like a real budget. */
  rows: BudgetRowV1[] | null;
  usedPercent: number;
  allowedCategories: string[];
  recipientLabel: string;
  charges: Array<{
    id: string;
    title: string;
    amount: string;
    status: string;
    /** True when this row is the reason the whole panel is in a bad state. */
    needsAttention: boolean;
  }>;
}

function usdc(value: string): string {
  return `${value} USDC`;
}

/** Human words for a charge status. `settled` is the only one that means the
 * money moved and the evidence arrived. */
export const CHARGE_STATUS_LABEL_V1: Record<string, string> = {
  quoted: 'quoted',
  reserved: 'reserved',
  payment_pending: 'payment pending',
  settled: 'settled',
  failed: 'failed — not charged',
  reconciliation_required: 'reconciliation required',
  released: 'released',
};

export const INTELLIGENCE_CATEGORY_LABEL_V1: Record<string, string> = {
  simulation: 'Simulation',
  contract_risk: 'Contract risk',
  liquidity_evidence: 'Liquidity evidence',
  premium_research: 'Premium research',
};

export function budgetPaymentsViewV1(input: PaidIntelligenceInputV1): BudgetPaymentsViewV1 {
  const state = paidIntelligenceStateV1(input);
  const budget = input.budget;
  const limit = Number(budget?.monthlyLimitUsdc ?? '0');
  const spent = Number(budget?.spentUsdc ?? '0');
  return {
    status: paidIntelligenceViewV1(state),
    rows: budget
      ? [
          { label: 'Monthly limit', value: usdc(budget.monthlyLimitUsdc) },
          { label: 'Spent', value: usdc(budget.spentUsdc) },
          // Reserved is shown separately from spent, always. It is money that
          // is committed and not yet gone, and folding it into either figure
          // makes one of them wrong.
          { label: 'Reserved', value: usdc(budget.reservedUsdc) },
          { label: 'Remaining', value: usdc(budget.remainingUsdc) },
          { label: 'Maximum per request', value: usdc(budget.maxPerRequestUsdc) },
          { label: 'Period ends', value: budget.periodEndsAt ?? 'not set' },
        ]
      : null,
    usedPercent: limit > 0 ? Math.max(0, Math.min(100, Math.round((spent / limit) * 100))) : 0,
    allowedCategories: (budget?.allowedCategories ?? []).map(
      (category) => INTELLIGENCE_CATEGORY_LABEL_V1[category] ?? category,
    ),
    // Named, not addressed: the drawer says who may charge, and a raw address
    // in a consent dialog is something nobody verifies and everybody skips.
    recipientLabel: budget ? 'Miorail service wallet' : 'nobody — no permission exists',
    charges: input.charges.map((charge) => ({
      id: charge.chargeId,
      title: `${charge.service} · ${charge.providerName}`,
      // The charged figure when there is one, the quote otherwise, and the two
      // are never silently swapped: a row showing a quote says so.
      amount: charge.chargedUsdc ? usdc(charge.chargedUsdc) : `${usdc(charge.quotedUsdc)} quoted`,
      status: CHARGE_STATUS_LABEL_V1[charge.status] ?? charge.status,
      needsAttention: charge.status === 'reconciliation_required',
    })),
  };
}

// ---------------------------------------------------------------------------
// T71 — the wallet flow's own states.
//
// Declared here rather than imported from `@mioagent/wallet-actions`: this
// package is compiled into the miniapp at a target where that package's
// dependencies do not belong, and a panel should not pull a wallet SDK into a
// bundle to name a string. `budgetPayments.test.ts` reads the hook's source
// from disk and fails if the two lists drift.
// ---------------------------------------------------------------------------

export const SPEND_PERMISSION_ONBOARDING_STATES_V1 = [
  'idle',
  'preparing',
  'awaiting_wallet',
  'verifying',
  'active',
  'wallet_rejected',
  'verification_failed',
  'verification_retryable',
  'failed',
] as const;
export type SpendPermissionOnboardingStatusV1 = (typeof SPEND_PERMISSION_ONBOARDING_STATES_V1)[number];

/** States where a wallet prompt is open or a check is running, so the panel
 * must not offer to start a second one. */
export function onboardingBusyV1(status: SpendPermissionOnboardingStatusV1 | undefined): boolean {
  return status === 'preparing' || status === 'awaiting_wallet' || status === 'verifying';
}

/** Whether trying again is worth offering. A declined prompt is retryable — the
 * user may simply have changed their mind — while a permission for the wrong
 * token is not, because signing the same thing again produces the same thing. */
export function onboardingRetryableV1(status: SpendPermissionOnboardingStatusV1 | undefined): boolean {
  return status === 'wallet_rejected' || status === 'verification_retryable' || status === 'failed';
}

/**
 * The consent text shown before a permission is created.
 *
 * Three sentences, in the user's units, with no protocol vocabulary. The third
 * one is not optional: a permission a user cannot find their way out of is not
 * consent.
 */
export function spendPermissionConsentV1(input: {
  monthlyLimitUsdc: string;
  maxPerRequestUsdc: string;
}): string[] {
  return [
    `Miorail may charge up to ${input.monthlyLimitUsdc} USDC per month.`,
    `No single request may cost more than ${input.maxPerRequestUsdc} USDC.`,
    'You can revoke this permission from Miorail at any time.',
  ];
}
