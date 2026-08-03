import { stableHashV1 } from '@mioagent/route-domain';
import {
  AERODROME_ROUTER_V1,
  encodeExactApproveV1,
  encodeSwapExactTokensForTokensV1,
  aerodromeSourceKeyV1,
  sameAerodromeRouteV1,
  type AerodromeRouteLegV1,
} from '@mioagent/swap-adapters';
import {
  OPPORTUNITY_QUOTE_ASSET_V1,
  minimumOutputV1,
  type OpportunityProfileV2,
} from '@mioagent/opportunity-rail';
import type { B20OpportunityClearanceV1 } from '@mioagent/route-storage';
import type { ExecutionCallV1 } from '@mioagent/route-domain';

import { routeHashV1 } from './opportunityClearance.js';

// ---------------------------------------------------------------------------
// T68E — consuming a clearance in an entry plan.
//
// A clearance describes a PAST state in which an opportunity was certified. It
// is permission to attempt a preparation, never permission to reuse the numbers
// that earned it. Everything executable below is rebuilt here from the stored
// clearance and a fresh quote; nothing structural comes from the client.
//
// This path has its own strict kernel rather than the generic Safety Kernel.
// Not to avoid a check — the list below is the same list — but because the
// generic one takes a `RouteIntentV1`, and `isTrustedRouteAsset` refuses a B20
// token by design. Widening that allowlist to satisfy a type would open
// arbitrary-token routing for every path in the product, which is precisely
// what a clearance exists to avoid needing.
// ---------------------------------------------------------------------------

/** How long a fresh entry quote may be acted on. Pools move; a quote older than
 * this is re-taken rather than trusted. */
export const ENTRY_QUOTE_TTL_MS_V1 = 20_000;
/** Seconds ahead the swap deadline is set. */
export const ENTRY_DEADLINE_WINDOW_SECONDS_V1 = 300n;

export type EntryPlanRefusalV1 =
  | 'entry_plan_stale'
  | 'entry_route_substituted'
  | 'entry_controls_changed'
  | 'entry_transfers_paused'
  | 'entry_controls_unreadable'
  | 'entry_not_b20'
  | 'entry_quote_expired'
  | 'entry_minimum_unsatisfiable'
  | 'entry_simulation_unavailable'
  | 'entry_simulation_reverted'
  | 'entry_spend_exceeds_profile'
  | 'entry_wrong_asset_acquired'
  | 'entry_kernel_blocked';

export const ENTRY_PLAN_REFUSAL_COPY_V1: Record<EntryPlanRefusalV1, string> = {
  entry_plan_stale:
    'The route that was cleared no longer prices this position. Run the opportunity check again — a different route has not been verified.',
  entry_route_substituted:
    'A different route now prices better. Miorail does not silently swap the reviewed route for another one; run the check again to review it.',
  entry_controls_changed:
    'This token’s controls changed since it was cleared. Nothing is prepared against a control state that has moved.',
  entry_transfers_paused:
    'Transfers of this token are paused now. A position bought here could not be sold.',
  entry_controls_unreadable:
    'This token’s controls could not be fully re-read, and a partial read never clears an entry.',
  entry_not_b20: 'The B20 factory no longer recognises this address.',
  entry_quote_expired: 'The entry quote expired before it could be prepared. Nothing was sent.',
  entry_minimum_unsatisfiable:
    'The fresh quote is below the minimum your profile allows, so no plan was built.',
  entry_simulation_unavailable:
    'The entry could not be simulated, and an unsimulated plan is never offered to a wallet.',
  entry_simulation_reverted:
    'The prepared entry reverts when simulated against the live chain. Nothing is offered to sign.',
  entry_spend_exceeds_profile:
    'The simulated spend exceeds the position you approved. Nothing is offered to sign.',
  entry_wrong_asset_acquired:
    'The simulation acquired a different token than the one that was cleared. Nothing is offered to sign.',
  entry_kernel_blocked: 'A safety check on the prepared calls failed, so nothing is offered to sign.',
};

// --- §3: prepare-time revalidation -------------------------------------------

/** The exit-relevant controls, re-read immediately before preparation. */
export interface EntryControlStateV1 {
  factoryConfirmed: boolean;
  transfersPaused: boolean;
  transferPolicyActive: boolean;
  controlsFullyRead: boolean;
  snapshotHash: string;
  blockNumber: string | null;
}

/**
 * Whether the token is still the token that was cleared.
 *
 * A clearance is not re-issued when this fails, and nothing is silently
 * re-certified: the user is told what moved and asked to run the evaluation
 * again. Silently re-clearing would make the whole gate decorative.
 */
export function revalidateControlsV1(input: {
  cleared: { snapshotHash: string };
  fresh: EntryControlStateV1;
}): EntryPlanRefusalV1 | null {
  if (!input.fresh.factoryConfirmed) return 'entry_not_b20';
  if (!input.fresh.controlsFullyRead) return 'entry_controls_unreadable';
  if (input.fresh.transfersPaused) return 'entry_transfers_paused';
  // The policy conclusion, not the policy itself — B20 cannot enumerate one.
  // A gate that appeared since certification is a material change.
  if (input.fresh.transferPolicyActive) return 'entry_controls_changed';
  if (input.fresh.snapshotHash !== input.cleared.snapshotHash) return 'entry_controls_changed';
  return null;
}

// --- §4: the re-quote ---------------------------------------------------------

export interface FreshEntryQuoteV1 {
  route: readonly AerodromeRouteLegV1[];
  /** The router's output for exactly the profile position. */
  outputAtomic: string;
  quotedAt: Date;
}

/**
 * Whether a fresh quote may be prepared against the cleared route.
 *
 * The route is compared leg by leg — factory, both tokens and the curve. A
 * better route discovered since certification is NOT taken: substitution is
 * refused, because the user reviewed one route and a different one has not
 * been through this gate at all.
 */
export function revalidateQuoteV1(input: {
  clearance: { entryRouteHash: string };
  clearedRoute: readonly AerodromeRouteLegV1[];
  fresh: FreshEntryQuoteV1 | null;
  profile: OpportunityProfileV2;
  now: Date;
  ttlMs?: number;
}): EntryPlanRefusalV1 | null {
  if (!input.fresh) return 'entry_plan_stale';
  if (!sameAerodromeRouteV1(input.clearedRoute, input.fresh.route)) return 'entry_route_substituted';
  if (routeHashV1(input.fresh.route) !== input.clearance.entryRouteHash) {
    return 'entry_route_substituted';
  }
  const age = input.now.getTime() - input.fresh.quotedAt.getTime();
  if (age < 0 || age > (input.ttlMs ?? ENTRY_QUOTE_TTL_MS_V1)) return 'entry_quote_expired';
  if (BigInt(input.fresh.outputAtomic) <= 0n) return 'entry_plan_stale';
  const minimum = minimumOutputV1(input.fresh.outputAtomic, input.profile.maxExitSlippageBps);
  if (BigInt(minimum) <= 0n) return 'entry_minimum_unsatisfiable';
  return null;
}

// --- §5: the blueprint --------------------------------------------------------

export interface B20EntryBlueprintV1 {
  schemaVersion: 'b20-entry-blueprint/v1';
  blueprintHash: string;
  clearanceId: string;
  profileIdentity: string;
  walletAddress: string;
  chainId: 8453;
  tokenAddress: string;
  quoteAsset: string;
  /** Exactly the position the profile approved. */
  positionAtomic: string;
  expectedOutputAtomic: string;
  minimumOutputAtomic: string;
  deadlineSeconds: string;
  /** The control state when the opportunity was CERTIFIED, and again at
   * preparation. Two hashes, because they are two different readings and a
   * single field would hide a change between them. */
  certifiedControlSnapshotHash: string;
  prepareControlSnapshotHash: string;
  prepareControlBlockNumber: string | null;
  entryRouteHash: string;
  entrySourceKey: string;
  freshQuoteHash: string;
  certificationEvidenceHash: string;
  coverage: 'complete' | 'partial';
  viableRouteConfirmed: boolean;
  bestRouteConfirmed: boolean;
  calls: ExecutionCallV1[];
}

/**
 * The unsigned entry.
 *
 * At most two calls: an exact, bounded approval and the swap. There is no
 * unlimited approval anywhere in this path, the recipient is always the
 * authenticated wallet, and every byte is encoded here from pinned constants.
 */
export function buildEntryBlueprintV1(input: {
  clearance: B20OpportunityClearanceV1;
  fresh: FreshEntryQuoteV1;
  freshControls: EntryControlStateV1;
  /** The wallet's CURRENT allowance to the Router. An approval is emitted only
   * when the standing one is short — an approval nobody needs is a state change
   * nobody asked for. */
  observedAllowanceAtomic: string;
  deadlineSeconds: bigint;
}): B20EntryBlueprintV1 {
  const position = BigInt(input.clearance.positionAtomic);
  const minimum = minimumOutputV1(input.fresh.outputAtomic, input.clearance.maxExitSlippageBps);
  const wallet = input.clearance.walletAddress as `0x${string}`;

  const calls: ExecutionCallV1[] = [];
  if (BigInt(input.observedAllowanceAtomic) < position) {
    calls.push({
      index: 0,
      callType: 'approval',
      to: OPPORTUNITY_QUOTE_ASSET_V1,
      valueWei: '0',
      data: encodeExactApproveV1(AERODROME_ROUTER_V1, position),
      asset: null,
      amountAtomic: position.toString(),
      recipient: null,
      spender: AERODROME_ROUTER_V1,
    });
  }
  calls.push({
    index: calls.length,
    callType: 'swap',
    to: AERODROME_ROUTER_V1,
    // Never native value on this path: the input is USDC, and a non-zero value
    // would be ETH leaving the wallet for something nobody priced.
    valueWei: '0',
    data: encodeSwapExactTokensForTokensV1({
      amountIn: position,
      amountOutMin: BigInt(minimum),
      routes: input.fresh.route,
      to: wallet,
      deadline: input.deadlineSeconds,
    }),
    asset: null,
    amountAtomic: position.toString(),
    recipient: wallet,
    spender: null,
  });

  const draft = {
    schemaVersion: 'b20-entry-blueprint/v1' as const,
    clearanceId: input.clearance.id,
    profileIdentity: input.clearance.profileIdentity,
    walletAddress: input.clearance.walletAddress,
    chainId: 8453 as const,
    tokenAddress: input.clearance.tokenAddress,
    quoteAsset: OPPORTUNITY_QUOTE_ASSET_V1,
    positionAtomic: position.toString(),
    expectedOutputAtomic: input.fresh.outputAtomic,
    minimumOutputAtomic: minimum,
    deadlineSeconds: input.deadlineSeconds.toString(),
    certifiedControlSnapshotHash: input.clearance.controlSnapshotHash,
    prepareControlSnapshotHash: input.freshControls.snapshotHash,
    prepareControlBlockNumber: input.freshControls.blockNumber,
    entryRouteHash: input.clearance.entryRouteHash,
    entrySourceKey: aerodromeSourceKeyV1(input.fresh.route[0]!),
    freshQuoteHash: stableHashV1('b20-entry-quote/v1', {
      route: input.fresh.route.map((leg) => aerodromeSourceKeyV1(leg)),
      amountIn: position.toString(),
      amountOut: input.fresh.outputAtomic,
    }),
    certificationEvidenceHash: input.clearance.simulationEvidenceHash,
    coverage: input.clearance.coverage,
    viableRouteConfirmed: input.clearance.viableRouteConfirmed,
    bestRouteConfirmed: input.clearance.bestRouteConfirmed,
    calls,
  };
  // Deterministic: the same clearance, quote and controls produce the same
  // hash, which is what makes preparation idempotent.
  return { ...draft, blueprintHash: stableHashV1('b20-entry-blueprint/v1', draft) };
}

// --- §6: the dedicated kernel -------------------------------------------------

export interface EntryKernelCheckV1 {
  id: string;
  status: 'passed' | 'failed';
  detail: string | null;
}

export interface EntryKernelResultV1 {
  verdict: 'allowed' | 'blocked';
  blockedReason: EntryPlanRefusalV1 | null;
  checks: EntryKernelCheckV1[];
}

/**
 * The strict check over the prepared calls.
 *
 * Every item the generic Safety Kernel would check, checked against the
 * clearance rather than against a route intent. A failure blocks the whole
 * plan — this path never partially trusts a batch.
 */
export function runEntryKernelV1(input: {
  blueprint: B20EntryBlueprintV1;
  walletAddress: string;
  clearance: B20OpportunityClearanceV1;
  now: Date;
}): EntryKernelResultV1 {
  const checks: EntryKernelCheckV1[] = [];
  let blocked: EntryPlanRefusalV1 | null = null;
  /** One check. A failure records the reason and blocks the WHOLE plan — this
   * path never partially trusts a batch. */
  const expect = (
    ok: boolean,
    id: string,
    detail: string,
    reason: EntryPlanRefusalV1 = 'entry_kernel_blocked',
  ): void => {
    if (ok) {
      checks.push({ id, status: 'passed', detail: null });
      return;
    }
    checks.push({ id, status: 'failed', detail });
    blocked ??= reason;
  };

  const plan = input.blueprint;
  expect(plan.chainId === 8453, 'chain_is_base_mainnet', 'not Base mainnet');
  expect(
    plan.walletAddress.toLowerCase() === input.walletAddress.toLowerCase(),
    'wallet_matches_session',
    'the plan names another wallet',
  );
  expect(
    plan.quoteAsset.toLowerCase() === OPPORTUNITY_QUOTE_ASSET_V1,
    'quote_asset_is_canonical_usdc',
    'the input is not canonical USDC',
  );
  expect(
    plan.tokenAddress.toLowerCase() === input.clearance.tokenAddress.toLowerCase(),
    'token_matches_clearance',
    'the plan names another token',
  );
  expect(
    plan.profileIdentity === input.clearance.profileIdentity,
    'profile_matches_clearance',
    'the plan names another profile',
  );
  expect(
    plan.entryRouteHash === input.clearance.entryRouteHash,
    'route_matches_clearance',
    'the route was substituted',
    'entry_route_substituted',
  );
  expect(
    plan.positionAtomic === input.clearance.positionAtomic,
    'position_matches_profile',
    'the spend is not the approved position',
    'entry_spend_exceeds_profile',
  );

  // Calls: at most an exact approval and one swap, in that order.
  const approvals = plan.calls.filter((call) => call.callType === 'approval');
  const swaps = plan.calls.filter((call) => call.callType === 'swap');
  expect(swaps.length === 1, 'exactly_one_swap', `${swaps.length} swap calls`);
  expect(approvals.length <= 1, 'at_most_one_approval', `${approvals.length} approvals`);
  expect(
    plan.calls.every((call) => call.valueWei === '0'),
    'no_native_value',
    'a call carries native value',
  );
  expect(
    plan.calls.every((call, index) => call.index === index),
    'call_order_is_dense',
    'call indices are not in order',
  );

  for (const approval of approvals) {
    expect(
      approval.to.toLowerCase() === OPPORTUNITY_QUOTE_ASSET_V1,
      'approval_is_on_usdc',
      'an approval targets another token',
    );
    expect(
      approval.spender?.toLowerCase() === AERODROME_ROUTER_V1,
      'approval_spender_is_pinned_router',
      'an approval names another spender',
    );
    // Bounded, and exactly the position. There is no unlimited variant here.
    expect(
      approval.amountAtomic === plan.positionAtomic,
      'approval_is_exact',
      'the approval is not the exact position',
    );
  }
  for (const swap of swaps) {
    expect(
      swap.to.toLowerCase() === AERODROME_ROUTER_V1,
      'swap_targets_pinned_router',
      'the swap targets another router',
    );
    expect(
      swap.recipient?.toLowerCase() === input.walletAddress.toLowerCase(),
      'recipient_is_authenticated_wallet',
      'the swap sends the token elsewhere',
    );
  }

  expect(
    BigInt(plan.minimumOutputAtomic) > 0n,
    'minimum_output_is_positive',
    'unbounded slippage',
    'entry_minimum_unsatisfiable',
  );
  expect(
    BigInt(plan.minimumOutputAtomic) <= BigInt(plan.expectedOutputAtomic),
    'minimum_not_above_expected',
    'the floor exceeds the quote',
  );
  expect(
    BigInt(plan.deadlineSeconds) > BigInt(Math.floor(input.now.getTime() / 1000)),
    'deadline_is_in_the_future',
    'the deadline has already passed',
    'entry_quote_expired',
  );
  expect(
    Date.parse(input.clearance.expiresAt) > input.now.getTime(),
    'clearance_still_live',
    'the clearance expired',
    'entry_plan_stale',
  );

  return { verdict: blocked ? 'blocked' : 'allowed', blockedReason: blocked, checks };
}

// --- §6: the mandatory simulation of the exact calls ---------------------------

/**
 * Whether the simulated entry matches the plan the user is about to sign.
 *
 * The opportunity simulation proved a viable scenario existed. THIS proves the
 * exact bytes now on offer do what the plan says. A clearance does not replace
 * it, and neither does the fact that a near-identical batch passed minutes ago.
 */
export function verifyEntrySimulationV1(input: {
  blueprint: B20EntryBlueprintV1;
  simulation: {
    ok: boolean;
    calls?: readonly { index: number; status: 'success' | 'reverted' }[];
    assetChangesAvailable?: boolean;
    assetChanges?: readonly {
      token: string;
      direction: 'in' | 'out';
      amountAtomic: string;
      callIndex: number;
    }[];
  };
}): EntryPlanRefusalV1 | null {
  if (!input.simulation.ok) return 'entry_simulation_unavailable';
  const calls = input.simulation.calls ?? [];
  if (calls.length !== input.blueprint.calls.length) return 'entry_simulation_unavailable';
  if (calls.some((call) => call.status === 'reverted')) return 'entry_simulation_reverted';
  if (!input.simulation.assetChangesAvailable) return 'entry_simulation_unavailable';

  const swapIndex = input.blueprint.calls.findIndex((call) => call.callType === 'swap');
  const changes = input.simulation.assetChanges ?? [];
  const sum = (token: string, direction: 'in' | 'out') =>
    changes
      .filter(
        (change) =>
          change.token.toLowerCase() === token.toLowerCase() &&
          change.direction === direction &&
          change.callIndex === swapIndex,
      )
      .reduce((total, change) => total + BigInt(change.amountAtomic), 0n);

  const spent = sum(input.blueprint.quoteAsset, 'out');
  const acquired = sum(input.blueprint.tokenAddress, 'in');
  if (spent <= 0n || acquired <= 0n) return 'entry_simulation_unavailable';
  // Never more than the user approved. Equality is the expected case; anything
  // above it is a plan that outgrew its own review.
  if (spent > BigInt(input.blueprint.positionAtomic)) return 'entry_spend_exceeds_profile';
  if (acquired < BigInt(input.blueprint.minimumOutputAtomic)) return 'entry_wrong_asset_acquired';
  return null;
}
