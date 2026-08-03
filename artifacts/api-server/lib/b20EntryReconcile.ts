import { stableHashV1 } from '@mioagent/route-domain';
import type {
  B20EntryReconciliationV1,
  B20EntryTerminalOutcomeV1,
  B20PreparedEntryPlanV1,
} from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// T68F-B §9/§10 — deciding what actually happened.
//
// Two separate judgements, deliberately kept apart:
//
//   1. Did the batch execute?           (the wallet status provider's answer)
//   2. Did it do what the plan said?    (the asset changes, checked here)
//
// Conflating them is how a product ends up telling somebody "your entry
// succeeded" because a transaction confirmed, when what confirmed was an
// approval and no token ever arrived.
//
// The rule that shapes everything below: a TRANSIENT failure is never an
// outcome. A status provider that times out has told us nothing about the
// chain, and `entry_reverted` is a claim about the chain. Unresolved states are
// unresolved, and the UI offers a refresh rather than another Buy button.
// ---------------------------------------------------------------------------

/** What the wallet's status endpoint said. Deliberately narrow: this module
 * never sees a provider body. */
export type WalletCallStatusV1 = 'pending' | 'confirmed' | 'reverted' | 'unknown' | 'unavailable';

/** One asset movement, relative to the authenticated wallet. */
export interface ObservedAssetChangeV1 {
  token: string;
  direction: 'in' | 'out';
  amountAtomic: string;
  /** Where the asset landed, when the provider reports it. Null when it does
   * not — which is treated as "not proven to be the wallet", not as consent. */
  counterparty?: string | null;
}

export interface ReconcileInputV1 {
  plan: B20PreparedEntryPlanV1;
  status: WalletCallStatusV1;
  /** Null when the provider could not report them. A confirmed batch whose
   * asset changes are unavailable is NOT a successful entry. */
  assetChanges: ObservedAssetChangeV1[] | null;
  transactionHashes: string[];
  blockNumber: string | null;
  /** How many times reconciliation has already come back unresolved. */
  attempts?: number;
  maxAttempts?: number;
}

export type ReconcileVerdictV1 =
  | { state: 'pending' }
  | { state: 'reconciling' }
  | {
      state: 'terminal';
      outcome: B20EntryTerminalOutcomeV1;
      reconciliation: B20EntryReconciliationV1 | null;
      errorCode: string | null;
    };

/** After this many unresolved checks the attempt stops claiming it is still
 * working and says so. It never becomes a revert. */
export const MAX_RECONCILE_ATTEMPTS_V1 = 12;

const ZERO = 0n;

/**
 * Whether the observed movements match the entry the plan describes.
 *
 * Every rule here exists because its absence would let something else be
 * reported as a successful entry:
 *
 *   * an approval alone confirms nothing about a swap;
 *   * a different token arriving is a different trade;
 *   * a token landing somewhere other than the authenticated wallet is
 *     somebody else's position;
 *   * spending more than the profile allowed is not the trade that was
 *     approved, even if the output looks fine;
 *   * receiving less than the minimum is the slippage bound being breached.
 */
export function assetsMatchPlanV1(input: {
  plan: B20PreparedEntryPlanV1;
  changes: ObservedAssetChangeV1[];
}): { ok: true; spentAtomic: string; receivedAtomic: string } | { ok: false; reason: string } {
  const wallet = input.plan.walletAddress.toLowerCase();
  const quote = input.plan.quoteAsset.toLowerCase();
  const token = input.plan.tokenAddress.toLowerCase();

  let spent = ZERO;
  let received = ZERO;
  let foreignIn = false;

  for (const change of input.changes) {
    const asset = change.token.toLowerCase();
    const amount = BigInt(change.amountAtomic);
    if (change.direction === 'out' && asset === quote) {
      spent += amount;
      continue;
    }
    if (change.direction !== 'in') continue;
    if (asset === token) {
      // A recipient the provider names must be this wallet. A recipient it
      // does not name is not evidence that it was.
      if (change.counterparty && change.counterparty.toLowerCase() !== wallet) {
        return { ok: false, reason: 'another_recipient' };
      }
      received += amount;
      continue;
    }
    if (asset !== quote) foreignIn = true;
  }

  if (received === ZERO) {
    // An approval executes, confirms, and moves nothing. It is not an entry.
    return { ok: false, reason: foreignIn ? 'wrong_token_received' : 'no_token_received' };
  }
  if (foreignIn) return { ok: false, reason: 'wrong_token_received' };
  if (spent === ZERO) return { ok: false, reason: 'no_quote_asset_spent' };
  if (spent > BigInt(input.plan.positionAtomic)) return { ok: false, reason: 'spend_above_profile' };
  if (received < BigInt(input.plan.minimumOutputAtomic)) {
    return { ok: false, reason: 'output_below_minimum' };
  }
  return { ok: true, spentAtomic: spent.toString(), receivedAtomic: received.toString() };
}

/** The evidence hash for a reconciled entry. Derived from what THIS server
 * observed and checked — never from a provider body. */
export function reconciliationEvidenceHashV1(input: {
  planId: string;
  callsHash: string;
  spentAtomic: string;
  receivedAtomic: string;
  blockNumber: string | null;
  transactionHashes: string[];
}): string {
  return stableHashV1('b20-entry-reconciliation/v1', {
    planId: input.planId,
    callsHash: input.callsHash,
    spentAtomic: input.spentAtomic,
    receivedAtomic: input.receivedAtomic,
    blockNumber: input.blockNumber,
    transactionHashes: [...input.transactionHashes].sort(),
  });
}

/**
 * The whole decision.
 *
 * Note what is NOT here: there is no branch that produces `entry_reverted` from
 * anything other than the chain saying the batch reverted, and no branch that
 * produces success without checked asset movements.
 */
export function reconcileEntryV1(input: ReconcileInputV1): ReconcileVerdictV1 {
  const attempts = input.attempts ?? 0;
  const max = input.maxAttempts ?? MAX_RECONCILE_ATTEMPTS_V1;

  if (input.status === 'pending') return { state: 'pending' };

  if (input.status === 'reverted') {
    // The chain executed it and rejected it. This is the only path to this
    // outcome, and it says nothing about whether the token is safe.
    return { state: 'terminal', outcome: 'entry_reverted', reconciliation: null, errorCode: null };
  }

  if (input.status === 'unknown' || input.status === 'unavailable') {
    // A provider that cannot answer has told us nothing about the chain. We
    // keep asking, and eventually say so honestly — never send again.
    if (attempts < max) return { state: 'reconciling' };
    return {
      state: 'terminal',
      outcome: 'submitted_unknown',
      reconciliation: null,
      errorCode: input.status === 'unavailable' ? 'status_provider_unavailable' : 'status_unknown',
    };
  }

  // Confirmed. Now the second, separate question: did it do what was planned?
  if (!input.assetChanges) {
    if (attempts < max) return { state: 'reconciling' };
    return {
      state: 'terminal',
      outcome: 'reconciliation_required',
      reconciliation: null,
      errorCode: 'asset_changes_unavailable',
    };
  }

  const matched = assetsMatchPlanV1({ plan: input.plan, changes: input.assetChanges });
  if (!matched.ok) {
    // It confirmed, and it did something other than the plan. That is a
    // reconciliation problem for a human, not a revert and not a success.
    return {
      state: 'terminal',
      outcome: 'reconciliation_required',
      reconciliation: null,
      errorCode: matched.reason,
    };
  }

  return {
    state: 'terminal',
    outcome: 'entry_succeeded',
    reconciliation: {
      spentAtomic: matched.spentAtomic,
      receivedAtomic: matched.receivedAtomic,
      confirmedBlockNumber: input.blockNumber,
      transactionHashes: [...new Set(input.transactionHashes.map((hash) => hash.toLowerCase()))]
        .filter((hash) => /^0x[0-9a-f]{64}$/.test(hash))
        .slice(0, 16),
      evidenceHash: reconciliationEvidenceHashV1({
        planId: input.plan.id,
        callsHash: input.plan.callsHash,
        spentAtomic: matched.spentAtomic,
        receivedAtomic: matched.receivedAtomic,
        blockNumber: input.blockNumber,
        transactionHashes: input.transactionHashes,
      }),
    },
    errorCode: null,
  };
}
