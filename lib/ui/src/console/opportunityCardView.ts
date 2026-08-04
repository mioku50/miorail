import { formatAtomicAmount } from '../formatAtomicAmount';
import { bpsLabelV1 } from './B20ExitCard';
import type { OpportunityCardViewV1, OpportunityStateV1 } from './OpportunitiesScreen';

// ---------------------------------------------------------------------------
// T70 §4/§8 — the wire card, turned into something a screen can draw.
//
// Shared because Base App and the web console must not each invent their own
// rounding, their own capacity wording, or their own idea of what a null means.
// One of those surfaces getting "not measured" and the other getting "0.00%"
// from the same row is the specific failure this file exists to prevent.
//
// BigInt(...) calls rather than bigint literals throughout: lib/ui is compiled
// by the miniapp at ES2017, where `0n` is a syntax error.
// ---------------------------------------------------------------------------

/** Structural mirror of `B20OpportunityCardV1` on the wire. Mirrored rather
 * than imported so lib/ui keeps no dependency on the API schema package. */
export interface OpportunityCardWireV1 {
  launch: {
    tokenAddress: string;
    name: string;
    symbol: string;
    variant: 'asset' | 'stablecoin';
    decimals: number | null;
    ageSeconds: number;
    canonical: boolean;
  };
  observation: {
    state: OpportunityStateV1;
    headline: string;
    detail: string;
    referencePositionAtomic: string;
    maxRoundTripBps: number;
    optimisticRoundTripBps: number | null;
    largestPassingSizeAtomic: string | null;
    firstFailingSizeAtomic: string | null;
    capacityStable: boolean | null;
    transferPolicyNotice: string | null;
    quoteAlignmentNotice: string | null;
    preEntryNotice: string | null;
    freshness: 'fresh' | 'stale';
  } | null;
  canCheckProfile: boolean;
  notMeasured: readonly string[];
}

/** USDC. The one asset this family quotes in, and the decimals the reference
 * position is expressed in. */
const QUOTE_DECIMALS_V1 = 6;

/** "4 min ago", "3 h ago", "2 d ago". Whole units only: a launch age to the
 * second implies a precision about when a token became visible that nothing
 * here has. Distinct from `ageLabelV1`, which formats QUOTE freshness in
 * minutes and seconds because a quote's age matters at that resolution. */
export function launchAgeLabelV1(ageSeconds: number): string {
  if (ageSeconds < 60) return 'just now';
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)} min ago`;
  if (ageSeconds < 86_400) return `${Math.floor(ageSeconds / 3600)} h ago`;
  return `${Math.floor(ageSeconds / 86_400)} d ago`;
}

function amountLabelV1(atomic: string, decimals: number | null, symbol: string): string {
  // Unknown decimals are stated, not guessed. A figure divided by an assumed
  // 18 is off by orders of magnitude and looks entirely plausible.
  if (decimals === null) return `${atomic} (atomic)`;
  return `${formatAtomicAmount(atomic, decimals)} ${symbol}`;
}

/**
 * Exit capacity, as a BOUND.
 *
 * The ladder probed a handful of sizes. It knows the largest that passed and
 * the smallest that failed, and nothing whatsoever about the range between
 * them — so that range is never collapsed into a single flattering number.
 */
export function capacityLabelV1(input: {
  largestPassingSizeAtomic: string | null;
  firstFailingSizeAtomic: string | null;
  decimals: number | null;
  symbol: string;
  capacityStable: boolean | null;
}): string | null {
  if (input.largestPassingSizeAtomic === null) return null;
  const passing = amountLabelV1(input.largestPassingSizeAtomic, input.decimals, input.symbol);
  const head = input.capacityStable === false ? `at least ${passing} (unstable)` : `at least ${passing}`;
  if (input.firstFailingSizeAtomic === null) return head;
  return `${head} · fails by ${amountLabelV1(input.firstFailingSizeAtomic, input.decimals, input.symbol)}`;
}

export const OPPORTUNITY_UNMEASURED_COPY_V1 = {
  headline: 'Not measured yet.',
  detail:
    'This launch is stored and waiting for an Exit-First measurement. Nothing has been checked about it — not the route, not the cost, not the controls.',
};

export const OPPORTUNITY_STALE_ACTION_COPY_V1 =
  'This measurement is past its freshness window. Refresh it before checking it against your wallet — an old quote is not a current one.';

export const OPPORTUNITY_UNMEASURED_ACTION_COPY_V1 =
  'There is no measurement to check against your wallet yet.';

export const OPPORTUNITY_SUPERSEDED_ACTION_COPY_V1 =
  'A chain reorganisation replaced this launch, so it is no longer current.';

export function opportunityCardViewV1(card: OpportunityCardWireV1): OpportunityCardViewV1 {
  const { launch, observation } = card;
  const symbol = launch.symbol || launch.tokenAddress.slice(0, 8);

  const notices: string[] = [];
  if (observation?.preEntryNotice) notices.push(observation.preEntryNotice);
  if (observation?.quoteAlignmentNotice) notices.push(observation.quoteAlignmentNotice);
  if (observation?.transferPolicyNotice) notices.push(observation.transferPolicyNotice);

  const actionUnavailableReason = !launch.canonical
    ? OPPORTUNITY_SUPERSEDED_ACTION_COPY_V1
    : observation === null
      ? OPPORTUNITY_UNMEASURED_ACTION_COPY_V1
      : card.canCheckProfile
        ? null
        : OPPORTUNITY_STALE_ACTION_COPY_V1;

  return {
    tokenAddress: launch.tokenAddress,
    symbol,
    name: launch.name,
    variantLabel: launch.variant,
    ageLabel: launchAgeLabelV1(launch.ageSeconds),
    state: observation?.state ?? 'unmeasured',
    headline: observation?.headline ?? OPPORTUNITY_UNMEASURED_COPY_V1.headline,
    detail: observation?.detail ?? OPPORTUNITY_UNMEASURED_COPY_V1.detail,
    // Null stays null the whole way. There is no `?? 0` anywhere in this file.
    costLabel:
      observation && observation.optimisticRoundTripBps !== null
        ? bpsLabelV1(observation.optimisticRoundTripBps)
        : null,
    capacityLabel: observation
      ? capacityLabelV1({
          largestPassingSizeAtomic: observation.largestPassingSizeAtomic,
          firstFailingSizeAtomic: observation.firstFailingSizeAtomic,
          decimals: launch.decimals,
          symbol,
          capacityStable: observation.capacityStable,
        })
      : null,
    profileLabel: observation
      ? `${formatAtomicAmount(observation.referencePositionAtomic, QUOTE_DECIMALS_V1)} USDC · ${bpsLabelV1(
          observation.maxRoundTripBps,
        )} round trip`
      : 'not measured',
    fresh: observation?.freshness === 'fresh',
    actionUnavailableReason,
    notices,
    notMeasured: card.notMeasured,
  };
}
