import {
  B20_OBSERVATION_REJECTION_COPY_V1,
  B20_OBSERVATION_UNMEASURED_COPY_V1,
  B20_NOT_MEASURED_DIMENSIONS_V1,
  b20PipelineCopyV1,
  b20CardStandingGroupV1,
  B20_STANDING_GROUP_COPY_V1,
  type B20OpportunityCardV1,
  type B20StandingGroupV1,
} from '@mioagent/opportunity-rail';
import { readDiscoverFeedV1, pipelineStatusV1, b20RouteRuntime } from '../b20Control.js';

// ---------------------------------------------------------------------------
// T72 — the read-only tool layer.
//
// Every tool here is a projection of what the workers already measured, taken
// through `readDiscoverFeedV1` — the same function the HTTP feed uses. There is
// no second Discover, no second ranking and no second interpretation of a B20
// control (§3).
//
// The harder half is §4/§7. An assistant reading this output will paraphrase
// it, and a paraphrase drops qualifiers first: "provisional pass at 1.18%"
// becomes "1.18% round trip", which becomes "cheap to trade". So the
// qualifiers are not adjacent to the numbers — they are STRUCTURAL. Every
// figure that has a caveat is returned as an object carrying it, and the three
// sentences that must survive summarisation are repeated on every payload that
// could be quoted alone.
// ---------------------------------------------------------------------------

/** §7 — the things an assistant must not lose. Attached to every
 * response, because any one of them may be the only object a model quotes. */
export const MIORAIL_MCP_CAVEATS_V1 = {
  provisional:
    'PROVISIONAL IS NOT QUALIFIED. A provisional result was measured before any entry moved the pool: the entry and the exit were quoted separately, against the pool as it stood. Only a wallet-bound sequential simulation can confirm a round trip, and this server cannot run one.',
  routeCoverage:
    'NO SUPPORTED ROUTE DOES NOT MEAN NO ROUTE. Miorail searched the venues it supports. A token with no entry or exit route here may still trade somewhere Miorail does not read.',
  capacity:
    'EXIT CAPACITY IS MEASURED, NOT INTERPOLATED. The ladder priced a handful of sizes. It knows the largest that passed and the smallest that failed, and nothing about the range between them. Do not report a figure inside that gap.',
  poolHook:
    'POOL HOOK PERMISSIONS ARE NOT BEHAVIOR. Address bits say which callbacks a Uniswap v4 hook may run; they do not prove that it used them. Only measured route results state an observed outcome.',
  launchBuying:
    'LAUNCH-WINDOW BUYING IS NOT CURRENT HOLDINGS. Counts and shares describe gross buying during the complete launch window; wallets may have sold since. They do not identify snipers, bots, insiders, related wallets or intent.',
} as const;

/** §6 — bounded, and not by the caller. */
export const MCP_MAX_PAGE_V1 = 25;
export const MCP_DEFAULT_PAGE_V1 = 10;

const ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/;

/**
 * §6 — errors an assistant may repeat verbatim to a stranger.
 *
 * A thrown error here reaches an MCP client, which may render it into a chat
 * transcript, a log aggregator, or a training set. So no cause is ever
 * propagated: a storage error carries a connection string, an RPC error
 * carries an endpoint, and an endpoint carries a key.
 */
export class McpPublicError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpPublicError';
  }
}

export function publicFailureV1(error: unknown): McpPublicError {
  if (error instanceof McpPublicError) return error;
  return new McpPublicError(
    'miorail_unavailable',
    'Miorail could not answer that right now. Nothing in this response is a statement about any token.',
  );
}

/** The card, flattened for a reader that has no schema in front of it. Every
 * measured number keeps the qualifier that makes it honest. */
export interface McpOpportunityV1 {
  /** The exact display-safe object returned to Discover Card consumers. This
   * is the parity anchor: a new card field reaches MCP without a second manual
   * projection having to remember it. */
  discoverCard: B20OpportunityCardV1;
  token: {
    address: string;
    symbol: string;
    name: string;
    variant: string;
    decimals: number | null;
  };
  launch: {
    blockNumber: string;
    /** Null when no block timestamp was available. NOT a detection time. */
    launchedAt: string | null;
    launchTimeKnown: boolean;
    /** Present when the launch time is unknown, so a reader does not invent one. */
    note?: string;
  };
  /** `null` when this launch has never been measured — different from a
   * measurement that found nothing. */
  measurement: {
    state: 'candidate' | 'provisional' | 'rejected' | 'unmeasured';
    reasonCode: string | null;
    headline: string;
    detail: string;
    /** What the measurement concluded, beside what it recorded. `aboutToken`
     * is false when the card describes Miorail's own limits, and a reader that
     * paraphrases such a card as a property of the token is wrong. */
    standing: {
      kind: string;
      headline: string;
      detail: string;
      aboutToken: boolean;
      section: B20StandingGroupV1;
      sectionLabel: string;
    };
    freshness: 'fresh' | 'stale';
    measuredAt: string;
    staleAfter: string;
    observationBlockNumber: string;
    quoteAlignment: string;
    quoteAlignmentNote: string | null;
    routeCoverage: 'complete' | 'partial';
    routeCoverageNote: string;
    entryRouteFound: boolean;
    exitRouteFound: boolean;
    routeLiquidity: {
      entrySourceKey: string | null;
      exitSourceKey: string | null;
      note: string;
    };
    poolHook: {
      assessment: NonNullable<B20OpportunityCardV1['observation']>['poolHook'];
      note: string;
    };
    launchBuying: {
      aggregate: NonNullable<B20OpportunityCardV1['observation']>['launchBuyers'];
      window: NonNullable<B20OpportunityCardV1['observation']>['launchBuyerWindow'];
      note: string;
    };
    viableRouteConfirmed: boolean;
    bestRouteConfirmed: boolean;
    roundTrip: { measuredBps: number | null; note: string };
    exitCapacity: {
      largestPassingSizeAtomic: string | null;
      firstFailingSizeAtomic: string | null;
      probeCount: number;
      stable: boolean | null;
      note: string;
    };
    referenceProfile: {
      positionAtomic: string;
      quoteAsset: string;
      maxRoundTripBps: number;
      maxExitSlippageBps: number;
    };
    controls: {
      transfersPaused: boolean | null;
      transferPolicyState: string | null;
      transferPolicyNote: string | null;
      controlsComplete: boolean | null;
      controlsBlockNumber: string | null;
    };
    preEntryNote: string | null;
  } | null;
  /** §7 — what this server will not tell you, named rather than left blank. */
  notMeasured: readonly string[];
  caveats: typeof MIORAIL_MCP_CAVEATS_V1;
}

function opportunityFromCardV1(card: B20OpportunityCardV1): McpOpportunityV1 {
  const observation = card.observation;
  return {
    discoverCard: card,
    token: {
      address: card.launch.tokenAddress,
      symbol: card.launch.symbol,
      name: card.launch.name,
      variant: card.launch.variant,
      decimals: card.launch.decimals,
    },
    launch: {
      blockNumber: card.launch.blockNumber,
      launchedAt: card.launch.launchedAt,
      launchTimeKnown: card.launch.launchTimeSource === 'onchain_block',
      ...(card.launch.launchTimeSource === 'onchain_block'
        ? {}
        : {
            note: 'The launch time is unknown. Miorail discovered this token at the block above; do not report that block time as a launch time or infer an age from it.',
          }),
    },
    measurement: observation
      ? {
          state: observation.state,
          reasonCode: observation.reasonCode,
          headline: observation.headline,
          detail: observation.detail,
          // What the measurement CONCLUDED, beside what it recorded. `state`
          // and `reasonCode` are the evidence vocabulary; a model asked "is
          // this token any good" will reach for a conclusion, so the one that
          // exists is here rather than left to be improvised from a reason
          // code. `aboutToken: false` is the load-bearing half: it marks a card
          // that describes Miorail's own limits, which must never be
          // paraphrased into a finding about the token.
          standing: {
            ...observation.standing,
            section: b20CardStandingGroupV1(card),
            sectionLabel: B20_STANDING_GROUP_COPY_V1[b20CardStandingGroupV1(card)].label,
          },
          freshness: observation.freshness,
          measuredAt: observation.measuredAt,
          staleAfter: observation.staleAfter,
          observationBlockNumber: observation.observationBlockNumber,
          quoteAlignment: observation.quoteAlignment,
          quoteAlignmentNote: observation.quoteAlignmentNotice,
          routeCoverage: observation.routeCoverage,
          routeCoverageNote:
            observation.routeCoverage === 'complete'
              ? MIORAIL_MCP_CAVEATS_V1.routeCoverage
              : `The route search did not complete, so this token was compared against only part of what Miorail supports. ${MIORAIL_MCP_CAVEATS_V1.routeCoverage}`,
          entryRouteFound: observation.entryRouteFound,
          exitRouteFound: observation.exitRouteFound,
          routeLiquidity: {
            entrySourceKey: observation.entrySourceKey,
            exitSourceKey: observation.exitSourceKey,
            note:
              observation.routeCoverage === 'complete'
                ? 'Provider source keys identify the measured entry and exit routes. A null source means that side was not found on the supported venues.'
                : `Provider source keys cover only the completed part of the search. ${MIORAIL_MCP_CAVEATS_V1.routeCoverage}`,
          },
          poolHook: {
            assessment: observation.poolHook,
            note: MIORAIL_MCP_CAVEATS_V1.poolHook,
          },
          launchBuying: {
            aggregate: observation.launchBuyers,
            window: observation.launchBuyerWindow,
            note: MIORAIL_MCP_CAVEATS_V1.launchBuying,
          },
          viableRouteConfirmed: observation.viableRouteConfirmed,
          bestRouteConfirmed: observation.bestRouteConfirmed,
          roundTrip: {
            measuredBps: observation.optimisticRoundTripBps,
            note:
              observation.optimisticRoundTripBps === null
                ? 'No round-trip cost was measured. Do not report this as zero, free, or cheap.'
                : MIORAIL_MCP_CAVEATS_V1.provisional,
          },
          exitCapacity: {
            largestPassingSizeAtomic: observation.largestPassingSizeAtomic,
            firstFailingSizeAtomic: observation.firstFailingSizeAtomic,
            probeCount: observation.capacityProbeCount,
            stable: observation.capacityStable,
            note: MIORAIL_MCP_CAVEATS_V1.capacity,
          },
          referenceProfile: {
            positionAtomic: observation.referencePositionAtomic,
            quoteAsset: observation.referenceQuoteAsset,
            maxRoundTripBps: observation.maxRoundTripBps,
            maxExitSlippageBps: observation.maxExitSlippageBps,
          },
          controls: {
            transfersPaused: observation.transfersPaused,
            transferPolicyState: observation.transferPolicyState,
            transferPolicyNote: observation.transferPolicyNotice,
            controlsComplete: observation.controlsComplete,
            controlsBlockNumber: observation.controlsBlockNumber,
          },
          preEntryNote: observation.preEntryNotice,
        }
      : null,
    notMeasured: card.notMeasured,
    caveats: MIORAIL_MCP_CAVEATS_V1,
  };
}

// --- the five tools ---------------------------------------------------------

export async function miorailDiscoverStatusV1(): Promise<Record<string, unknown>> {
  try {
    const available = await b20RouteRuntime.discoverAvailable();
    const status = await pipelineStatusV1(
      b20RouteRuntime.observations(),
      b20RouteRuntime.now(),
      available,
    );
    return {
      state: status.state,
      summary: status.message,
      blocksBehind: status.blocksBehind,
      counts: {
        canonicalLaunches: status.facts.canonicalLaunchCount,
        awaitingMeasurement: status.facts.launchesAwaitingMeasurement,
        observations: status.facts.observationCount,
      },
      lastIngestionRunAt: status.facts.lastIngestionRunAt,
      lastMeasurementRunAt: status.facts.lastMeasurementRunAt,
      // The whole reason this tool exists: an empty opportunity list means
      // something different in each of these states, and a reader with only
      // the list cannot tell which.
      emptyListMeaning:
        status.state === 'healthy'
          ? 'Both workers are current, so an empty opportunity list means no measured launch currently matches.'
          : `An empty opportunity list right now does NOT mean the chain is quiet: ${b20PipelineCopyV1(status)}`,
      caveats: MIORAIL_MCP_CAVEATS_V1,
    };
  } catch (error) {
    throw publicFailureV1(error);
  }
}

export async function miorailListOpportunitiesV1(input: {
  state?: 'all' | 'candidate' | 'provisional' | 'rejected' | 'unmeasured';
  freshness?: 'all' | 'fresh' | 'stale';
  standing?: B20StandingGroupV1 | 'all';
  limit?: number;
  cursor?: string | null;
}): Promise<Record<string, unknown>> {
  try {
    const limit = Math.max(
      1,
      Math.min(MCP_MAX_PAGE_V1, Math.floor(input.limit ?? MCP_DEFAULT_PAGE_V1)),
    );
    const feed = await readDiscoverFeedV1({
      limit,
      cursor: input.cursor ?? null,
      state: input.state === undefined || input.state === 'all' ? 'all' : input.state,
      freshness: input.freshness ?? 'all',
      standing: input.standing ?? 'all',
    });
    return {
      pipeline: { state: feed.pipeline.state, summary: feed.pipeline.message },
      // Stated even when the list is long: a reader that sees ten cards should
      // not conclude ten is all there is.
      pagination: { returned: feed.cards.length, limit, nextCursor: feed.nextCursor },
      opportunities: feed.cards.map(opportunityFromCardV1),
      serverTime: feed.serverTime,
      caveats: MIORAIL_MCP_CAVEATS_V1,
    };
  } catch (error) {
    throw publicFailureV1(error);
  }
}

export async function miorailGetOpportunityV1(input: {
  tokenAddress: string;
}): Promise<Record<string, unknown>> {
  const tokenAddress = String(input.tokenAddress ?? '').toLowerCase();
  if (!ADDRESS_V1.test(tokenAddress)) {
    // Malformed and unknown stay distinct: one is the caller's mistake and the
    // other is a fact about the feed.
    throw new McpPublicError('invalid_token_address', 'That is not a Base token address.');
  }
  try {
    // Read through the same feed, filtered — no second lookup path.
    const feed = await readDiscoverFeedV1({
      limit: MCP_MAX_PAGE_V1,
      cursor: null,
      state: 'all',
      freshness: 'all',
    });
    const found = feed.cards.find(
      (card) => card.launch.tokenAddress.toLowerCase() === tokenAddress,
    );
    if (!found) {
      throw new McpPublicError(
        'not_in_feed',
        'Miorail has no measured launch for that address in its current window. That is a statement about what Miorail has read, not about the token.',
      );
    }
    return {
      pipeline: { state: feed.pipeline.state, summary: feed.pipeline.message },
      opportunity: opportunityFromCardV1(found),
      serverTime: feed.serverTime,
      caveats: MIORAIL_MCP_CAVEATS_V1,
    };
  } catch (error) {
    throw publicFailureV1(error);
  }
}

/**
 * The typed rejection vocabulary, in full.
 *
 * Exists so an assistant asked "why was this rejected?" reads the shared copy
 * table instead of paraphrasing a reason code into something stronger. Every
 * entry says whether the finding depends on the asking wallet — the same
 * distinction the UI uses to decide whether to offer a wallet check.
 */
export function miorailExplainRejectionV1(input: { reasonCode?: string }): Record<string, unknown> {
  const walletIndependent = [
    'not_b20',
    'uninitialized',
    'transfers_paused',
    'no_entry_route',
    'no_exit_route',
  ];
  const describe = (code: string, copy: string, kind: 'rejected' | 'unmeasured') => ({
    reasonCode: code,
    state: kind,
    meaning: copy,
    dependsOnAskingWallet: !walletIndependent.includes(code),
    // The line that stops "rejected" being read as "scam".
    isAJudgementOfTheToken: false,
  });

  const all = [
    ...Object.entries(B20_OBSERVATION_REJECTION_COPY_V1).map(([code, copy]) =>
      describe(code, copy, 'rejected'),
    ),
    ...Object.entries(B20_OBSERVATION_UNMEASURED_COPY_V1).map(([code, copy]) =>
      describe(code, copy, 'unmeasured'),
    ),
  ];

  const requested = input.reasonCode
    ? all.find((entry) => entry.reasonCode === input.reasonCode)
    : undefined;
  if (input.reasonCode && !requested) {
    throw new McpPublicError(
      'unknown_reason_code',
      'Miorail does not use that reason code. Do not guess what it means.',
    );
  }

  return {
    reasons: requested ? [requested] : all,
    guidance: {
      rejectedMeans:
        'Rejected means a specific measured condition was not met at a specific block, against Miorail’s reference profile. It is not a safety verdict, a scam flag or a score.',
      unmeasuredMeans:
        'Unmeasured means Miorail could not complete a reading. It says nothing at all about the token.',
      notMeasuredAtAll: B20_NOT_MEASURED_DIMENSIONS_V1,
    },
    caveats: MIORAIL_MCP_CAVEATS_V1,
  };
}

/**
 * §2's fifth tool.
 *
 * NOT a ranking, a score or a recommendation — T69-C forbids ordering the feed
 * by anything opaque, and this server adds no interpretation layer of its own
 * (§3). What it does is sort the SAME cards by one explicitly named measured
 * dimension, which the caller has to choose, and say so in the payload.
 *
 * Only provisional cards are eligible: they are the only ones carrying the
 * numbers either ordering reads, and a rejected token has no place in a list a
 * reader will treat as "the good ones".
 */
export const MCP_LEADER_DIMENSIONS_V1 = [
  'largest_measured_exit_capacity',
  'lowest_measured_round_trip',
] as const;
export type McpLeaderDimensionV1 = (typeof MCP_LEADER_DIMENSIONS_V1)[number];

export async function miorailMarketLeadersV1(input: {
  orderBy: McpLeaderDimensionV1;
  limit?: number;
}): Promise<Record<string, unknown>> {
  if (!(MCP_LEADER_DIMENSIONS_V1 as readonly string[]).includes(input.orderBy)) {
    throw new McpPublicError(
      'unknown_ordering',
      `orderBy must be one of: ${MCP_LEADER_DIMENSIONS_V1.join(', ')}. Miorail has no overall ranking to fall back on.`,
    );
  }
  try {
    const limit = Math.max(
      1,
      Math.min(MCP_MAX_PAGE_V1, Math.floor(input.limit ?? MCP_DEFAULT_PAGE_V1)),
    );
    const feed = await readDiscoverFeedV1({
      limit: MCP_MAX_PAGE_V1,
      cursor: null,
      state: 'provisional',
      freshness: 'fresh',
    });

    const eligible = feed.cards.filter((card) =>
      input.orderBy === 'largest_measured_exit_capacity'
        ? card.observation?.largestPassingSizeAtomic != null
        : card.observation?.optimisticRoundTripBps != null,
    );
    const ordered = [...eligible].sort((left, right) => {
      if (input.orderBy === 'largest_measured_exit_capacity') {
        const a = BigInt(left.observation!.largestPassingSizeAtomic!);
        const b = BigInt(right.observation!.largestPassingSizeAtomic!);
        return a === b ? 0 : a > b ? -1 : 1;
      }
      return left.observation!.optimisticRoundTripBps! - right.observation!.optimisticRoundTripBps!;
    });

    return {
      orderedBy: input.orderBy,
      // Said in the payload, not only in the tool description, because the
      // payload is what gets quoted.
      orderingMeaning:
        input.orderBy === 'largest_measured_exit_capacity'
          ? 'Sorted by the largest exit size that stayed within the reference slippage tolerance. This is one measured dimension, not a ranking, a score or a recommendation. A larger measured capacity does not mean a better token.'
          : 'Sorted by the measured pre-entry round-trip cost, cheapest first. This is one measured dimension, not a ranking, a score or a recommendation. A cheaper round trip does not mean a better token.',
      eligibility:
        'Only fresh provisional measurements appear here, because they are the only ones carrying this number. Absence from this list is not a negative finding.',
      pipeline: { state: feed.pipeline.state, summary: feed.pipeline.message },
      results: ordered.slice(0, limit).map(opportunityFromCardV1),
      serverTime: feed.serverTime,
      caveats: MIORAIL_MCP_CAVEATS_V1,
    };
  } catch (error) {
    throw publicFailureV1(error);
  }
}
