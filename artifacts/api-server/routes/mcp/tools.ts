import {
  B20_OBSERVATION_REJECTION_COPY_V1,
  B20_OBSERVATION_UNMEASURED_COPY_V1,
  B20_NOT_MEASURED_DIMENSIONS_V1,
  b20PipelineCopyV1,
  b20CardStandingGroupV1,
  B20_STANDING_GROUP_COPY_V1,
  type B20FundamentalProfileV1,
  type B20OpportunityCardV1,
  type B20StandingGroupV1,
  B20_FUNDAMENTAL_PREDICATES_V1,
  B20_FUNDAMENTAL_PREDICATE_RULES_V1,
  type B20FundamentalPredicateV1,
} from '@mioagent/opportunity-rail';
import {
  readB20UniverseSummaryV1,
  readDiscoverFeedV1,
  readB20CardForTokenV1,
  readB20FundamentalMatchesV1,
  readB20MarketRailsV1,
  readB20TokenReadsV1,
  pipelineStatusV1,
  b20RouteRuntime,
} from '../b20Control.js';
import { b20ComparabilityV1 } from '../../lib/b20ConsoleAnswer.js';
import {
  B20SuppliedDomainRefusedError,
  b20PublicContextSearchFromEnv,
  readB20PublicContextV1,
} from '../../lib/b20PublicContextRead.js';

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
  projectContext:
    'A VERIFIED PROJECT LINK IS NOT A REVIEW. It means a project served a file on a domain it controls naming this token, and Miorail checked what that file declared. Miorail did not read the project’s code, assess its team, or form any view about its token. `product: live` means a declared endpoint answered a real request — not that the product is useful, correct, safe or maintained. An unverified project is the ORDINARY case on this chain and is never a negative finding: absence of a claim is absence of evidence, not evidence of absence.',
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
  /** Project context. Null when this server does not run the layer. */
  project: B20FundamentalProfileV1 | null;
  /** The exact display-safe object returned to Discover Card consumers. This
   * is the parity anchor: a new card field reaches MCP without a second manual
   * projection having to remember it. Present only in `full`. */
  discoverCard?: B20OpportunityCardV1;
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
    venuesConsulted: readonly string[] | null;
    venuesNote: string;
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
  /** Only in `full`. In `summary` the caveats are on the RESPONSE, once — the
   * same block repeated per item is 40% of a page and reads as boilerplate,
   * which is the one thing a caveat must not become. */
  caveats?: typeof MIORAIL_MCP_CAVEATS_V1;
}

/**
 * How much of a card an agent gets.
 *
 * `summary` is the default because the full shape is 7.4 KB per opportunity,
 * of which 40.6% is the caveat block and 32% is `discoverCard` restating
 * `token`, `launch` and `measurement`. At a page of 25 that is ~184 KB with the
 * same 1,750-byte disclaimer 26 times — and an agent handed that will summarise
 * it, which is exactly where `aboutToken: false` and `unknown` turn into
 * statements about a token.
 *
 * `full` keeps the old shape byte for byte, for a caller that was reading
 * `discoverCard` directly.
 */
export type McpVerbosityV1 = 'summary' | 'full';

function opportunityFromCardV1(
  card: B20OpportunityCardV1,
  verbosity: McpVerbosityV1 = 'full',
): McpOpportunityV1 {
  const observation = card.observation;
  return {
    // Dropped in `summary`: every field of it is already projected below, and
    // a reader that has both will quote whichever it met first.
    ...(verbosity === 'full' ? { discoverCard: card } : {}),
    /**
     * Whether a project proved a link to this token, and what its own
     * declarations turned out to be.
     *
     * Kept beside `measurement` rather than inside it because the two answer
     * different questions from different evidence: a measurement is what
     * Miorail priced against a pool, and this is what a project published
     * about itself and Miorail then checked. Null means this server does not
     * run the layer — which is not the same as "nobody claimed it".
     */
    project: card.project,
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
          // WHICH venues were asked, beside whether the candidates answered.
          // Null means the row does not record it, and 1,662 stored launches
          // are frozen at a verdict produced before Uniswap v4 — where B20
          // tokens actually trade — was in the search at all. A model must not
          // read those as "this token has no route".
          venuesConsulted: observation.venuesConsulted ?? null,
          venuesNote:
            observation.venuesConsulted && observation.venuesConsulted.includes('uniswap-v4')
              ? 'This reading searched the venue where B20 tokens trade.'
              : 'This reading did NOT search Uniswap v4, where B20 tokens trade. Its route findings are unmeasured, not negative — do not report them as a property of the token.',
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
    ...(verbosity === 'full' ? { caveats: MIORAIL_MCP_CAVEATS_V1 } : {}),
  };
}

// --- the tools --------------------------------------------------------------

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

export async function miorailSummariseUniverseV1(input: {
  launchAgeHours?: number;
}): Promise<Record<string, unknown>> {
  try {
    const hours = Math.max(1, Math.min(720, Math.floor(input.launchAgeHours ?? 48)));
    return { ...(await readB20UniverseSummaryV1({ maxLaunchAgeMs: hours * 60 * 60 * 1000 })) };
  } catch (error) {
    throw publicFailureV1(error);
  }
}

export async function miorailListOpportunitiesV1(input: {
  state?: 'all' | 'candidate' | 'provisional' | 'rejected' | 'unmeasured';
  freshness?: 'all' | 'fresh' | 'stale';
  standing?: B20StandingGroupV1 | 'all';
  standingKind?: string;
  bothRoutes?: boolean;
  maxRoundTripBps?: number;
  minBuyers?: number;
  project?: 'all' | 'product_backed' | 'verified_project' | 'unknown';
  limit?: number;
  cursor?: string | null;
  verbosity?: McpVerbosityV1;
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
      standingKind: input.standingKind ?? null,
      bothRoutes: input.bothRoutes === true,
      // Undefined means "no bound", and that is NOT the same as zero: a bound
      // of zero selects only launches whose measured round trip was exactly
      // free, which is a question somebody may legitimately ask.
      maxRoundTripBps: input.maxRoundTripBps ?? null,
      minBuyers: input.minBuyers ?? null,
      project: input.project ?? 'all',
    });
    return {
      pipeline: { state: feed.pipeline.state, summary: feed.pipeline.message },
      // Stated even when the list is long: a reader that sees ten cards should
      // not conclude ten is all there is.
      pagination: { returned: feed.cards.length, limit, nextCursor: feed.nextCursor },
      opportunities: feed.cards.map((card) => opportunityFromCardV1(card, input.verbosity ?? 'summary')),
      serverTime: feed.serverTime,
      // Once, on the response. Never once per opportunity.
      caveats: MIORAIL_MCP_CAVEATS_V1,
    };
  } catch (error) {
    throw publicFailureV1(error);
  }
}

export async function miorailGetOpportunityV1(input: {
  tokenAddress: string;
  verbosity?: McpVerbosityV1;
  /** Opt-in. Absent means the field is not on the response at all — not null,
   * because an absent field cannot be read as "Miorail looked and found
   * nothing". */
  includePublicContext?: boolean;
  /** A bare hostname the caller already knows. When present NO SEARCH RUNS. */
  publicContextDomain?: string;
}): Promise<Record<string, unknown>> {
  const tokenAddress = String(input.tokenAddress ?? '').toLowerCase();
  if (!ADDRESS_V1.test(tokenAddress)) {
    // Malformed and unknown stay distinct: one is the caller's mistake and the
    // other is a fact about the feed.
    throw new McpPublicError('invalid_token_address', 'That is not a Base token address.');
  }
  try {
    // A DIRECT lookup, shared with the HTTP detail route.
    //
    // This used to read the newest 25 cards and search the page, so it answered
    // `not_in_feed` for 33,516 of the 33,541 canonical launches — including
    // measured ones whose card the HTTP route returned without difficulty. An
    // agent asking about a token by address got a sentence that sounded like a
    // fact about the token and was a fact about the page size.
    const found = await readB20CardForTokenV1(tokenAddress);
    if (!found) {
      throw new McpPublicError(
        'launch_not_found',
        'Miorail has no canonical B20 launch at that address. That is a statement about what Miorail has ingested, not about the token.',
      );
    }
    const status = await pipelineStatusV1(
      b20RouteRuntime.observations(),
      b20RouteRuntime.now(),
      await b20RouteRuntime.discoverAvailable(),
    );
    // Unverified public context, and ONLY when asked for. It is a separate
    // field beside `project`, never inside it: one comes from a file a project
    // serves on a domain it controls, the other from a public search, and the
    // two have different types, different standings and no code path between
    // them. A search also costs money and a false link costs more, so nothing
    // here runs because a card was fetched.
    const wantsPublicContext = input.includePublicContext === true || Boolean(input.publicContextDomain);
    let possiblePublicContext: Record<string, unknown> | undefined;
    if (wantsPublicContext) {
      const search = b20PublicContextSearchFromEnv();
      if (search === null && !input.publicContextDomain) {
        possiblePublicContext = {
          unavailableReason:
            'This Miorail server has no public search provider configured, so it could not look. That is not a statement about the token, and it is not "nothing was found".',
        };
      } else {
        try {
          const context = await readB20PublicContextV1({
            chainId: 8453,
            tokenAddress,
            symbol: found.card.launch.symbol ?? null,
            name: found.card.launch.name ?? null,
            domain: input.publicContextDomain ?? null,
            deps: {
              search: search ?? (async () => { throw new Error('no search provider'); }),
              now: () => b20RouteRuntime.now(),
            },
          });
          possiblePublicContext = {
            ...context,
            boundary:
              'Candidates from a public search or from a domain you named. NOTHING here is verified: a matching name or symbol is not a link, and 61.7% of B20 launches share their symbol with another launch. This can never become the verified project layer above.',
          };
        } catch (error) {
          possiblePublicContext = {
            unavailableReason:
              error instanceof B20SuppliedDomainRefusedError
                ? `Miorail will not fetch that domain (${error.refusal}), so it read nothing.`
                : 'The public lookup did not complete, so Miorail read nothing. That is about the lookup, not about the token.',
          };
        }
      }
    }

    return {
      pipeline: { state: status.state, summary: status.message },
      opportunity: opportunityFromCardV1(found.card, input.verbosity ?? 'summary'),
      ...(possiblePublicContext ? { possiblePublicContext } : {}),
      // Bounded history, so an agent can see that a second comparable
      // observation exists before asking what changed.
      history: found.history.map((entry) => ({
        state: entry.state,
        reasonCode: entry.reasonCode,
        observationBlockNumber: entry.observationBlockNumber,
        optimisticRoundTripBps: entry.optimisticRoundTripBps,
        largestPassingSizeAtomic: entry.largestPassingSizeAtomic,
        measuredAt: entry.measuredAt,
        staleAfter: entry.staleAfter,
      })),
      serverTime: b20RouteRuntime.now().toISOString(),
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

/**
 * The market rails, as the server already ranked them.
 *
 * This tool used to read the newest 25 cards and sort them INSIDE the MCP —
 * `BigInt` comparisons and a `.sort()` right here. Beside it lives
 * `exitCapacityLeadersV1`, a server projection over a 1,000-row window with
 * typed exclusion reasons, which the UI rail obeys under a rule saying the
 * client sorts nothing. One product, two different answers to "largest measured
 * exit capacity", and the agent-facing one was the weaker of the two.
 *
 * So the ordering is no longer computed here. `orderBy` selects which rail to
 * return, and the exclusions come with it: absence from a rail has a reason,
 * and an agent that cannot see the reason will read absence as a negative
 * finding.
 */
export async function miorailMarketRailsV1(input: {
  orderBy?: McpLeaderDimensionV1;
  limit?: number;
}): Promise<Record<string, unknown>> {
  if (input.orderBy !== undefined && !(MCP_LEADER_DIMENSIONS_V1 as readonly string[]).includes(input.orderBy)) {
    throw new McpPublicError(
      'unknown_ordering',
      `orderBy must be one of: ${MCP_LEADER_DIMENSIONS_V1.join(', ')}. Miorail has no overall ranking to fall back on.`,
    );
  }
  try {
    const limit = Math.max(1, Math.min(MCP_MAX_PAGE_V1, Math.floor(input.limit ?? MCP_DEFAULT_PAGE_V1)));
    const rails = await readB20MarketRailsV1({ limit });
    return {
      // Both rails, because they answer different questions and an agent asking
      // for one usually wants to know the other exists.
      exitCapacityLeaders: {
        orderedBy: 'largest_measured_exit_capacity',
        orderingMeaning:
          'Ordered by measured exit coverage relative to ONE Miorail reference entry, within the stated slippage tolerance. One measured dimension, not a ranking, not a score and not a recommendation. Nothing between the largest passing and the first failing size was measured.',
        toleranceBps: rails.toleranceBps,
        results: rails.capacityLeaders,
      },
      routeCostChanges: {
        label: rails.moveLabel,
        note: rails.moveNote,
        // A pair 20-28 hours apart, and the exact interval travels with each
        // row: "24h" is a window, not a measurement.
        results: rails.movers,
        collectingHistory: rails.collectingHistory,
      },
      eligibility:
        'A launch appears on a rail only when its measurement carries the number the rail is about, at the one comparable reference profile. Absence is not a negative finding about the token.',
      pipeline: { state: rails.pipeline.state, summary: b20PipelineCopyV1(rails.pipeline) },
      serverTime: rails.serverTime,
      caveats: MIORAIL_MCP_CAVEATS_V1,
    };
  } catch (error) {
    throw publicFailureV1(error);
  }
}

// ---------------------------------------------------------------------------
// Compare, for two to five tokens.
//
// The rule is NOT this file's. `b20ComparabilityV1` decides whether two
// measurements may be set beside each other — same profile identity, same quote
// asset, same reference position, same measurement version — and it is the same
// rule the market rails pair observations with. Two tokens measured against
// different reference positions produce round trips that look comparable and
// are not.
//
// When they are not comparable this returns the numbers anyway, each stated on
// its own, with the reason. Refusing outright would push a caller to fetch two
// cards and compare them itself, which is the failure with the loud version
// removed.
//
// Every dimension is a MEASURED one. There is no aggregate, no winner, no score
// and no ordering: the values come back in the order the caller asked for them.
// `null` is `unknown` and carries its own state, because a zero here would read
// as "measured, and it was nothing".
// ---------------------------------------------------------------------------

export const MCP_COMPARE_MIN_V1 = 2;
export const MCP_COMPARE_MAX_V1 = 5;

interface CompareDimensionV1 {
  key: string;
  label: string;
  unit: string;
  note: string;
  read: (card: B20OpportunityCardV1) => { value: string | number | null; state: string };
}

const COMPARE_DIMENSIONS_V1: readonly CompareDimensionV1[] = [
  {
    key: 'round_trip_bps',
    label: 'Pre-entry round trip',
    unit: 'basis points',
    note: 'What entering and leaving immediately cost at the reference position, quoted before the entry moved the pool. A smaller number is not a better token.',
    read: (card) => {
      const value = card.observation?.optimisticRoundTripBps ?? null;
      return { value, state: value === null ? 'not_measured' : 'measured' };
    },
  },
  {
    key: 'largest_passing_exit_atomic',
    label: 'Largest tested exit',
    unit: 'atomic units of the token',
    note: 'A LOWER BOUND: the largest probe that passed within the slippage tolerance. Nothing above it was tested, and nothing between it and the first failing size was measured either.',
    read: (card) => {
      const value = card.observation?.largestPassingSizeAtomic ?? null;
      return { value, state: value === null ? 'not_measured' : 'measured' };
    },
  },
  {
    key: 'exit_route_found',
    label: 'Exit route found',
    unit: 'boolean',
    note: 'Whether the allowlisted venue search priced a way out at all. False is a statement about the venues searched at that moment.',
    read: (card) => {
      const observation = card.observation;
      if (!observation) return { value: null, state: 'not_measured' };
      return { value: observation.exitRouteFound ? 'yes' : 'no', state: 'measured' };
    },
  },
  {
    key: 'launch_window_buyers',
    label: 'Buyers in the launch window',
    unit: 'wallets',
    note: 'Unique buyers in the launch’s own block window, counted only after that window closed. Not current holders and not trading volume.',
    read: (card) => {
      const buyers = card.observation?.launchBuyers ?? null;
      if (!buyers) return { value: null, state: 'not_measured' };
      return { value: buyers.buyerCount, state: 'measured' };
    },
  },
  {
    key: 'project_standing',
    label: 'Project context',
    unit: 'standing',
    note: 'What a project PUBLISHED about itself and Miorail then checked, from a file on a domain the project controls. A different question from anything measured against a pool, and never a search result.',
    read: (card) => {
      const project = card.project;
      if (!project) return { value: null, state: 'layer_unavailable' };
      return { value: project.standing, state: project.identityVerified ? 'verified' : 'unverified' };
    },
  },
];

/**
 * Why nothing was compared, when the rule itself had nothing to say.
 *
 * `b20ComparabilityV1` answers "may these measurements be set beside each
 * other", so with fewer than two measurements in hand it returns `false` with
 * no reason — correct, and unreadable at the top of an agent-facing answer.
 * `comparable: false` beside a null reason reads as "Miorail compared them and
 * they did not match", which is a statement about the tokens. The truth is a
 * statement about Miorail: there was nothing to compare.
 *
 * The rule is not touched. This only words the case the rule declines to word.
 */
export function compareNothingToCompareReasonV1(input: {
  requested: number;
  withComparableMeasurement: number;
}): string {
  const requested = input.requested;
  const held = input.withComparableMeasurement;
  const opening =
    held === 0
      ? `None of the ${requested} tokens you asked about carries a measurement Miorail can compare`
      : `Only ${held} of the ${requested} tokens you asked about carries a measurement Miorail can compare, and a comparison needs two`;
  return (
    `${opening}, so nothing was set side by side. This is a gap in Miorail's coverage, ` +
    'not a finding about the tokens and not a verdict that they are incompatible. Each ' +
    "token's state below says which gap it is: `not_measured` is a launch Miorail has no " +
    'reading of, `not_in_index` is an address with no canonical B20 launch at all.'
  );
}

export async function miorailCompareTokensV1(input: {
  tokenAddresses: readonly string[];
}): Promise<Record<string, unknown>> {
  const wanted = (input.tokenAddresses ?? []).map((address) => String(address ?? '').toLowerCase());
  if (wanted.length < MCP_COMPARE_MIN_V1 || wanted.length > MCP_COMPARE_MAX_V1) {
    throw new McpPublicError(
      'invalid_token_count',
      `Compare takes between ${MCP_COMPARE_MIN_V1} and ${MCP_COMPARE_MAX_V1} token addresses.`,
    );
  }
  for (const address of wanted) {
    if (!ADDRESS_V1.test(address)) {
      throw new McpPublicError('invalid_token_address', `${address} is not a Base token address.`);
    }
  }
  if (new Set(wanted).size !== wanted.length) {
    throw new McpPublicError('duplicate_token_address', 'Compare takes distinct addresses.');
  }

  try {
    const { reads } = await readB20TokenReadsV1({ tokenAddresses: wanted, historyLimit: 2 });
    const comparability = b20ComparabilityV1(reads);
    // The rule returns a null reason when it never got to apply — fewer than two
    // measurements to hold beside each other. Left null, `comparable: false`
    // would read as a verdict about the tokens.
    const withComparableMeasurement = reads.filter((read) => read.profile !== null).length;
    const incomparableReason =
      comparability.comparable || comparability.reason !== null
        ? comparability.reason
        : compareNothingToCompareReasonV1({
            requested: reads.length,
            withComparableMeasurement,
          });

    const tokens = reads.map((read) => ({
      address: read.tokenAddress,
      symbol: read.card?.launch.symbol ?? null,
      // Three separate statements, never collapsed: indexed, measured, and
      // what the measurement found.
      indexStanding: read.indexStanding,
      measured: read.card?.observation != null,
      comparableObservations: read.historyCount,
    }));

    const dimensions = COMPARE_DIMENSIONS_V1.map((dimension) => ({
      key: dimension.key,
      label: dimension.label,
      unit: dimension.unit,
      note: dimension.note,
      values: reads.map((read) => ({
        token: read.tokenAddress,
        ...(read.card ? dimension.read(read.card) : { value: null, state: 'not_in_index' }),
      })),
    }));

    return {
      // First, because everything below is only meaningful when it is true.
      comparable: comparability.comparable,
      incomparableReason,
      comparabilityRule:
        'Two measurements may be set beside each other only when they share a profile identity, a quote asset, a reference position and a measurement version. When they do not, the figures below are each stated on their own and must not be subtracted from one another.',
      tokens,
      dimensions,
      ordering:
        'The order is the order you asked in. Miorail computes no aggregate, no winner and no score across tokens, and there is nothing here to sort by.',
      unknownMeaning:
        'A null value is UNKNOWN, never zero. `not_measured` means Miorail has no reading of that dimension; `not_in_index` means it has no canonical launch at that address at all.',
      caveats: MIORAIL_MCP_CAVEATS_V1,
    };
  } catch (error) {
    throw publicFailureV1(error);
  }
}

// ---------------------------------------------------------------------------
// Fundamental Intelligence, as a question an agent can ask.
//
// Deliberately NOT a filter on the opportunity list, and the reason is the
// denominator. The list answers over the measured launch window and carries a
// pipeline state and a cursor; a predicate answers over the VERIFIED PROJECT
// CLAIMS, which is a different and much smaller corpus. Bolting it onto the
// feed would hand an agent a response saying "3,000 launches read" beside an
// answer that read none of them, and the market framing is exactly what the
// fundamental answer had to have removed from it once already.
//
// So the corpus travels with the answer: "1 matched among 1 verified project
// claim; launches without a verified claim are outside this corpus and remain
// unknown." Every predicate is positive-only. There is no `no_website`, because
// Miorail cannot distinguish a project that has no website from one that never
// claimed a token — and `unknown` is not `false`.
// ---------------------------------------------------------------------------

export async function miorailFindProjectsV1(input: {
  predicate: B20FundamentalPredicateV1;
  limit?: number;
}): Promise<Record<string, unknown>> {
  if (!(B20_FUNDAMENTAL_PREDICATES_V1 as readonly string[]).includes(input.predicate)) {
    throw new McpPublicError(
      'unknown_predicate',
      `predicate must be one of: ${B20_FUNDAMENTAL_PREDICATES_V1.join(', ')}. All of them are positive: Miorail has no way to ask which projects LACK something.`,
    );
  }
  try {
    const limit = Math.max(1, Math.min(MCP_MAX_PAGE_V1, Math.floor(input.limit ?? MCP_DEFAULT_PAGE_V1)));
    const found = await readB20FundamentalMatchesV1({ predicate: input.predicate, limit });
    if (!found.available) {
      // "This server does not run the layer" is not "nothing matched".
      throw new McpPublicError(
        'project_layer_unavailable',
        'This Miorail server does not run the project-claim layer, so it cannot answer. That is not a statement about any project.',
      );
    }
    const rule = B20_FUNDAMENTAL_PREDICATE_RULES_V1[input.predicate];
    return {
      predicate: input.predicate,
      asks: rule.label,
      matched: found.matches.length,
      // The denominator, and the sentence that stops it being read as a share
      // of the chain.
      corpus: found.corpus,
      corpusMeaning: `${found.matches.length} matched among ${found.corpus} verified project claim${found.corpus === 1 ? '' : 's'}. Launches without a verified claim are outside this corpus and remain unknown — they are not negative results.`,
      projects: found.matches.map((match) => ({
        tokenAddress: match.tokenAddress,
        symbol: match.symbol,
        // Whether Discover has also ingested it. A verified claim can exist for
        // a launch older than the measurement window, and that is not a fault.
        indexedByDiscover: match.indexed,
        projectDomain: match.profile.projectDomain,
        standing: match.profile.standing,
        freshness: match.profile.freshness ?? 'unknown',
        oldestEvidenceAt: match.profile.oldestObservedAt ?? null,
        findings: match.profile.findings,
        notEstablished: match.profile.missing,
      })),
      evidenceBoundary:
        'Every state here came from a file the project serves on a domain it controls, plus probes of only what that file declared. It is not a review, not a rating and not a statement about price. Evidence older than a day is labelled stale and describes what was true when it was checked.',
      caveats: MIORAIL_MCP_CAVEATS_V1,
    };
  } catch (error) {
    throw publicFailureV1(error);
  }
}

