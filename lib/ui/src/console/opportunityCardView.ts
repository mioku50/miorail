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
    blockNumber: string;
    /** Null when no block timestamp was reported. Not a launch time. */
    ageSeconds: number | null;
    launchTimeSource: 'onchain_block' | 'discovered';
    canonical: boolean;
  };
  observation: {
    observationId?: string;
    evidenceHash?: string;
    state: OpportunityStateV1;
    headline: string;
    detail: string;
    referencePositionAtomic: string;
    /** The asset the position is denominated in. Not always USDC: B20's v4
     * pools are quoted against native ETH. */
    referenceQuoteAsset?: string | null;
    maxRoundTripBps: number;
    entryRouteFound: boolean;
    exitRouteFound: boolean;
    entrySourceKey: string | null;
    exitSourceKey: string | null;
    routeCoverage: 'complete' | 'partial';
    optimisticRoundTripBps: number | null;
    largestPassingSizeAtomic: string | null;
    firstFailingSizeAtomic: string | null;
    capacityStable: boolean | null;
    transferPolicyNotice: string | null;
    quoteAlignmentNotice: string | null;
    preEntryNotice: string | null;
    /** Decoded server-side from the hook's own address, so this screen never
     * re-derives permission bits. Absent for a venue with no hooks. */
    poolHook?: {
      standing: 'standard' | 'non_standard' | 'no_hook' | 'unreadable';
      permissions: {
        hook: string;
        mayChangeSwapAmounts: boolean;
        mayInterceptSwaps: boolean;
        mayGateLiquidity: boolean;
      } | null;
    } | null;
    /** Launch-window buying lives inside the observation on the API wire.
     * Null means the window has not been measured; a measured zero is an
     * object whose buyerCount is zero. */
    launchBuyers: {
      buyerCount: number;
      topBuyerShareBps: number | null;
      topThreeShareBps: number | null;
    } | null;
    /** Why a null launchBuyers value is null. Older servers may omit this;
     * the client then stays silent instead of guessing from a block number. */
    launchBuyerWindow?: {
      status: 'collecting' | 'measured' | 'closed_unmeasured' | 'unknown';
      closesAtBlock: string;
    } | null;
    observationBlockNumber?: string;
    freshness: 'fresh' | 'stale';
  } | null;
  canCheckProfile: boolean;
  /** T69-C.1 §2 — the server decided this from the rejection reason. The view
   * renders it; it does not re-derive it, because two implementations of "may
   * a wallet overturn this?" is one too many. */
  action: {
    action: 'check_wallet' | 'try_profile' | 'refresh_measurement' | 'none';
    label: string | null;
    reason: string;
  };
  notMeasured: readonly string[];
}

/** USDC. The one asset this family quotes in, and the decimals the reference
 * position is expressed in. */
const QUOTE_DECIMALS_V1 = 6;

/** Native ETH, as Uniswap v4 addresses it. */
const NATIVE_ASSET_V1 = '0x0000000000000000000000000000000000000000';

/**
 * How to render the position, in the asset it was actually measured in.
 *
 * B20's v4 pools are quoted against native ETH, so the reference asset is not
 * always USDC. Printing wei with six decimals and a "USDC" suffix would put a
 * number on the card that is wrong by twelve orders of magnitude AND name the
 * wrong currency — a card stating a trade nobody priced.
 *
 * Unknown assets are shown by address rather than assumed: a guessed symbol on
 * a long-tail token is exactly the kind of confident wrong label this feed
 * exists to avoid.
 */
function quoteAssetDisplayV1(asset: string | null | undefined): { decimals: number; symbol: string } {
  const address = (asset ?? '').toLowerCase();
  if (address === NATIVE_ASSET_V1) return { decimals: 18, symbol: 'ETH' };
  if (address === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') {
    return { decimals: QUOTE_DECIMALS_V1, symbol: 'USDC' };
  }
  return { decimals: QUOTE_DECIMALS_V1, symbol: address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'quote asset' };
}

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

/**
 * T69-C.1 §1 — the row a card shows for time.
 *
 * When the chain told us when the token was created, that is a launch time and
 * it is labelled as one. When it did not, the honest thing to show is what
 * Miorail actually knows: that it found this launch, and at which block. The
 * previous behaviour — detection time under a "Launched" label — made every
 * stored launch look minutes old while the worker was days behind.
 */
export function launchTimeRowV1(launch: {
  ageSeconds: number | null;
  launchTimeSource: 'onchain_block' | 'discovered';
  blockNumber: string;
}): { label: string; value: string } {
  if (launch.launchTimeSource === 'onchain_block' && launch.ageSeconds !== null) {
    return { label: 'Launched', value: launchAgeLabelV1(launch.ageSeconds) };
  }
  return { label: 'Discovered by Miorail', value: `block ${launch.blockNumber}` };
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

  // §2 — the server chose the action from the rejection reason. A stale card
  // whose action is `none` because the evidence is wallet-independent must not
  // be quietly upgraded here into "refresh and try again".
  const serverAction = card.action;
  const actionLabel = serverAction.action === 'none' ? null : serverAction.label;
  const timeRow = launchTimeRowV1(launch);

  return {
    tokenAddress: launch.tokenAddress,
    symbol,
    name: launch.name,
    variantLabel: launch.variant,
    timeLabel: timeRow.label,
    timeValue: timeRow.value,
    state: observation?.state ?? 'unmeasured',
    observationId: (observation?.observationId as `0x${string}` | undefined) ?? null,
    evidenceHash: (observation?.evidenceHash as `0x${string}` | undefined) ?? null,
    observationBlockNumber: observation?.observationBlockNumber ?? null,
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
      ? (() => {
          const quote = quoteAssetDisplayV1(observation.referenceQuoteAsset);
          return `${formatAtomicAmount(observation.referencePositionAtomic, quote.decimals)} ${
            quote.symbol
          } · ${bpsLabelV1(observation.maxRoundTripBps)} round trip`;
        })()
      // Null, not the words. The row is hidden entirely when there is no
      // measurement to name a profile for.
      : null,
    fresh: observation?.freshness === 'fresh',
    actionLabel,
    // Always shown, whether or not there is a button: a card that offers
    // nothing has to say why, and a card that offers something has to say what
    // that something would actually establish.
    actionReason: serverAction.reason,
    notices,
    notMeasured: card.notMeasured,
    ...hookLabelsV1(card.observation?.poolHook ?? null),
    ...routeLabelsV1(card.observation ?? null),
    // The API contract nests launch buyers in the observation. Reading a
    // top-level field silently discarded every stored buyer row while all
    // fixtures still passed because they tested the helper in isolation.
    ...buyerLabelsV1(
      card.observation?.launchBuyers ?? null,
      card.observation?.launchBuyerWindow ?? null,
    ),
  };
}

function routeSourceLabelV1(source: string | null): string | null {
  if (!source) return null;
  const normalized = source.toLowerCase();
  if (normalized.startsWith('aerodrome')) return 'Aerodrome';
  if (normalized.startsWith('uniswap-v4')) return 'Uniswap v4';
  if (normalized.startsWith('kyberswap')) return 'KyberSwap';
  return 'an allowlisted venue';
}

/**
 * Route availability is useful even when a round trip is impossible. The
 * broken leg is the reason the two headline metrics are null; hiding it made
 * a correctly rejected card look as though the worker learned nothing.
 */
export function routeLabelsV1(
  observation: OpportunityCardWireV1['observation'],
): { routeLabel: string | null; routeNote: string | null; routeTone: 'ok' | 'warn' } {
  if (!observation) return { routeLabel: null, routeNote: null, routeTone: 'warn' };
  const entry = routeSourceLabelV1(observation.entrySourceKey);
  const exit = routeSourceLabelV1(observation.exitSourceKey);
  const coverage = observation.routeCoverage === 'partial'
    ? ' One or more configured venues did not answer, so route coverage is partial.'
    : '';

  if (observation.entryRouteFound && observation.exitRouteFound) {
    const venue = entry && exit && entry === exit ? ` via ${entry}` : '';
    return {
      routeLabel: 'Entry + exit found',
      routeNote: `Miorail priced both route legs${venue}. This states route availability; depth is only the measured exit ladder.${coverage}`,
      routeTone: 'ok',
    };
  }
  if (observation.entryRouteFound) {
    return {
      routeLabel: 'Entry found · exit missing',
      routeNote: `Miorail priced entry${entry ? ` via ${entry}` : ''}, but no configured venue returned the route back. Round trip and exit capacity therefore stay unmeasured.${coverage}`,
      routeTone: 'warn',
    };
  }
  if (observation.exitRouteFound) {
    return {
      routeLabel: 'Exit found · entry missing',
      routeNote: `Miorail priced an exit${exit ? ` via ${exit}` : ''}, but no configured venue returned the reference entry. A comparable round trip therefore stays unmeasured.${coverage}`,
      routeTone: 'warn',
    };
  }
  return {
    routeLabel: 'No priced route',
    routeNote: `No configured venue returned either route leg in this pass. No cost or capacity is inferred from that absence.${coverage}`,
    routeTone: 'warn',
  };
}

/**
 * Launch-window buying, in words.
 *
 * Three states, and keeping them apart is the whole job. Null means NOBODY
 * MEASURED — a launch whose ten-thousand-block window is still open has no
 * answer yet, and rendering that as "0 buyers" would be a claim nobody made.
 * A measured zero means nobody bought, which is the common true answer and is
 * said plainly. Anything else carries the concentration, because one wallet
 * holding everything and seventy-six wallets sharing it are different exits.
 *
 * Never "snipers": intent is not on chain. And never a holdings claim — this
 * is gross buying in a window, and a buyer may have sold it all since.
 */
export function buyerLabelsV1(
  buyers: NonNullable<OpportunityCardWireV1['observation']>['launchBuyers'] | undefined,
  window: NonNullable<OpportunityCardWireV1['observation']>['launchBuyerWindow'] | undefined = null,
): { buyersLabel: string | null; buyersNote: string | null } {
  if (!buyers) {
    if (window?.status === 'collecting') {
      return {
        buyersLabel: 'Collecting',
        buyersNote: `The launch-buying window is still open and closes at block ${window.closesAtBlock}. Miorail waits for the full window before stating a buyer count.`,
      };
    }
    if (window?.status === 'closed_unmeasured') {
      return {
        buyersLabel: 'Not measured',
        buyersNote: 'The launch-buying window is closed, but no complete buyer aggregate is stored. No buyer count is claimed.',
      };
    }
    if (window?.status === 'unknown') {
      return {
        buyersLabel: 'Not measured',
        buyersNote: 'The current confirmed Base head is unavailable, so Miorail cannot tell whether the launch-buying window has closed.',
      };
    }
    return { buyersLabel: null, buyersNote: null };
  }
  if (buyers.buyerCount === 0) {
    return {
      buyersLabel: 'Nobody',
      buyersNote: 'Nothing left the pool in the launch window. There is no buying to concentrate.',
    };
  }
  const wallets = buyers.buyerCount === 1 ? '1 wallet' : `${buyers.buyerCount} wallets`;
  const top = buyers.topBuyerShareBps === null ? null : bpsLabelV1(buyers.topBuyerShareBps);
  const label = top ? `${wallets} · largest ${top}` : wallets;
  const note = buyers.buyerCount === 1
    ? 'One wallet took everything that left the pool in the launch window, so an exit depends on that wallet not selling first. Bought, not held — it may have sold since.'
    : `Largest share of launch-window buying${top ? ` is ${top}` : ''}. Bought, not held: a wallet counted here may have sold it all since.`;
  return { buyersLabel: label, buyersNote: note };
}

/**
 * The hook, in words, or nothing.
 *
 * Two rules. It states PERMISSION — "may take a fee on every swap" — never
 * behaviour, because the bits in a hook's address say what the PoolManager
 * will call, not what the hook then does. And an unreadable hook says so
 * rather than defaulting to "standard": 48 of 50 sampled launches use the same
 * hook, so a silent default would be right often enough to be trusted and
 * wrong exactly where it matters.
 */
export function hookLabelsV1(
  hook: NonNullable<OpportunityCardWireV1['observation']>['poolHook'],
): { hookLabel: string | null; hookNote: string | null } {
  if (!hook) return { hookLabel: null, hookNote: null };
  if (hook.standing === 'unreadable') {
    return { hookLabel: 'Not readable', hookNote: 'The pool hook could not be decoded.' };
  }
  if (hook.standing === 'no_hook') {
    return { hookLabel: 'None', hookNote: 'Nothing can intercept a swap in this pool.' };
  }
  const permissions = hook.permissions;
  const label = hook.standing === 'standard' ? 'Standard launch hook' : 'Not the usual hook';
  const may: string[] = [];
  // Ordered by what an exit-first reader needs first: the cost of getting out
  // before who may provide the liquidity.
  if (permissions?.mayChangeSwapAmounts) may.push('change the amounts of every swap');
  if (permissions?.mayInterceptSwaps) may.push('refuse a swap');
  if (permissions?.mayGateLiquidity) may.push('gate who adds or removes liquidity');
  const note = may.length > 0
    ? `This pool charges no fee of its own, so the hook is what sets the cost of exiting. It may ${may.join(', ')}. What it actually does is not stated here — only the measured round trip is.`
    : 'This hook claims none of the permissions that affect a swap.';
  return { hookLabel: label, hookNote: note };
}
