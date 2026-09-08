import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  B20_EXIT_STANDING_KINDS_V1,
  B20_FUNDAMENTAL_PREDICATES_V1,
  B20_STANDING_GROUPS_V1,
} from '@mioagent/opportunity-rail';
import {
  MCP_COMPARE_MAX_V1,
  MCP_COMPARE_MIN_V1,
  MCP_DEFAULT_PAGE_V1,
  MCP_LEADER_DIMENSIONS_V1,
  MCP_MAX_PAGE_V1,
  MIORAIL_MCP_CAVEATS_V1,
  McpPublicError,
  miorailDiscoverStatusV1,
  miorailExplainRejectionV1,
  miorailGetOpportunityV1,
  miorailListOpportunitiesV1,
  miorailCompareTokensV1,
  miorailFindProjectsV1,
  miorailMarketRailsV1,
  miorailSummariseUniverseV1,
} from './tools.js';
import {
  MarketRealityAgentChangesInputV1Schema,
  MarketRealityAgentChangesOutputV1Schema,
  MarketRealityAgentComparisonInputV1Schema,
  MarketRealityAgentComparisonMcpOutputV1Schema,
  MarketRealityAgentRepresentationsInputV1Schema,
  MarketRealityAgentRepresentationsOutputV1Schema,
  MarketRealityAgentStocksInputV1Schema,
  MarketRealityAgentStocksOutputV1Schema,
  miorailCompareMarketRealityV1,
  miorailGetMarketChangesV1,
  miorailGetRepresentationsV1,
  miorailListReviewedStocksV1,
} from './marketRealityTools.js';
import {
  UseAccessAgentInputV1Schema,
  UseAccessAgentOutputV1Schema,
  miorailGetUseAccessV1,
} from './useAccessTools.js';

// ---------------------------------------------------------------------------
// T72/Phase 12B.1 — eight legacy B20 tools plus three read-only Market Reality
// tools over the same stored evidence used by the consumer application.
//
// It cannot execute anything. There is no signer, no wallet_sendCalls, no
// clearance, no entry plan, no submission and no x402 payment on this surface,
// and `mcpServer.test.ts` asserts that by reading these files (§5).
//
// It also takes no wallet address, on any tool. That is not an oversight: a
// wallet-bound answer is exactly the thing this server must not produce, and
// an argument it does not accept is a boundary that cannot be crossed by
// accident later.
//
// The tool DESCRIPTIONS carry as much weight as the code. An assistant decides
// from them whether to call a tool and how to summarise it, and the failure
// mode here is not a crash — it is a model telling somebody that a provisional
// measurement means a token is safe to buy.
// ---------------------------------------------------------------------------

export const MIORAIL_MCP_NAME_V1 = 'miorail';
export const MIORAIL_MCP_VERSION_V1 = '1.3.0';

/** §7 — what the assistant is told about the whole server, once. */
export const MIORAIL_MCP_INSTRUCTIONS_V1 = `Miorail is a Base L2 route-intelligence product. This server is READ-ONLY: it reports what Miorail's background workers measured about B20 token launches, and it can neither trade, sign, quote a wallet, nor prepare a transaction.

Five things you must preserve when you summarise anything from this server:

1. ${MIORAIL_MCP_CAVEATS_V1.provisional}

2. ${MIORAIL_MCP_CAVEATS_V1.routeCoverage}

3. ${MIORAIL_MCP_CAVEATS_V1.capacity}

4. ${MIORAIL_MCP_CAVEATS_V1.poolHook}

5. ${MIORAIL_MCP_CAVEATS_V1.launchBuying}

Miorail measures unique buying wallets only inside a completed launch window. It does not measure buyers beyond that window, trading volume, current holder concentration, related-wallet clusters, organic buy pressure, future price or profit probability. Do not infer any of them from what is here, and do not describe a token as safe, unsafe, good, promising or a scam on this evidence — none of those are things Miorail measured.

An empty result is not the same as a quiet chain. Call miorail_discover_status first: the workers may be behind, unconfigured or degraded, and the status says which.

The Stocks tools are a separate read-only product surface for reviewed tokenized-stock representations. An underlying key groups representations but never selects one. Preserve every exact Base address. A router quote is not execution evidence; provider failure is not an asset finding; an expired quote is history; ranking is withheld. get_market_changes requires an exact address or CAIP-10 and reads only public append-only market evidence — never tenant Radar watches or user metadata.

get_use_access reports what one exact representation can be used for and what gates it, including the POOLS that hold it — a question about LP or liquidity is answered from \`pools\`, never from the lending venues in \`defi\`. ANNOUNCED IS NOT LIVE: a dated public claim by a named party is carried beside what the venue itself answered, and the four states are not interchangeable — \`unchecked\` means nobody read that venue and is never \`not_listed\`. Base announced on 2026-08-24 that Coinbase tokenized stocks are collateral on Aave; Aave's reserve list on Base does not name those addresses today, and telling a user they can post that collateral now is wrong. A venue listing an address is still not permission to act: caps, pause flags, available liquidity and risk parameters are not read. The block in \`blockTag\` governs only the fields named in \`blockTagCovers\` and never the venue rows, which carry their own provenance. The tool is public and wallet-free, so it can never say whether a particular wallet may transfer or use a token, and it states nothing about KYC, jurisdiction or legal eligibility.`;

/**
 * The read-only tools, registered onto whichever server asked for them.
 *
 * A connected client reached `/mcp/private`, which held the seven wallet-bound
 * tools and NONE of the read-only ones — so an assistant could prepare a review
 * of an exact representation and had no way to find that representation, and
 * the consent screen's promise to "read your reviewed plans and measurements"
 * was true of a surface the client had not been given. The fix is one registry
 * used by both servers.
 *
 * The dependency runs one way only, and that direction is the boundary: the
 * authenticated server imports these, and nothing here imports anything from
 * `mcpPrivate/`. `mcpServer.test.ts` §5 scans every file in this directory for
 * signer, submission, clearance and payment vocabulary, so the public surface
 * stays physically unable to execute even while it is also the connected one's
 * read half.
 */
export function registerMiorailReadOnlyToolsV1(server: McpServer): void {
  /** One shape for every reply: MCP content plus the structured payload. */
  const reply = (payload: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  });

  /** A refusal an assistant can act on, without a stack trace or an endpoint. */
  const refuse = (error: unknown) => {
    const failure =
      error instanceof McpPublicError
        ? error
        : new McpPublicError('miorail_unavailable', 'Miorail could not answer that right now.');
    return {
      isError: true as const,
      content: [{ type: 'text' as const, text: `${failure.code}: ${failure.message}` }],
    };
  };

  server.registerTool(
    'miorail_discover_status',
    {
      title: 'Miorail Discover pipeline status',
      description:
        'Reports whether Miorail is currently reading Base for B20 launches, and how far behind it is. CALL THIS FIRST when an opportunity list comes back empty: an empty list has several causes and only one of them is "nothing is launching". The others are that ingestion was never configured, is still catching up, has nothing measured yet, or is degraded. This tool says which.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

    },
    async () => {
      try {
        return reply(await miorailDiscoverStatusV1());
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_list_b20_opportunities',
    {
      title: 'List measured B20 launches',
      description: `Lists B20 token launches Miorail has measured, newest first, with the Exit-First measurement for each. Returns at most ${MCP_MAX_PAGE_V1} per call (default ${MCP_DEFAULT_PAGE_V1}); pass the returned nextCursor to continue.

Each result carries a state you must keep: "provisional" (measured, but before any entry moved the pool — NOT qualified, NOT a recommendation), "rejected" (a specific measured condition was not met — not a safety verdict), or "unmeasured" (Miorail could not complete a reading — says nothing about the token).

Numbers may be null. A null round-trip cost means it was not measured; it does not mean zero, free or cheap. Results also include the exact display-safe Discover Card plus measured route sources, pool-hook permissions and completed launch-window buying evidence. Hook permissions are not behavior, and launch-window buying is not current holdings.

Every measurement also carries a "standing": what the reading CONCLUDED, with an "aboutToken" flag. When aboutToken is false the card is describing a limit of Miorail's own measurement — a venue it did not find, a call that did not answer — and you must not report it as a property of the token. Use the "standing" filter to ask for one section instead of reading the whole feed: most launches sit in "no_buyers_yet" and "miorail_limit".`,
      inputSchema: {
        state: z
          .enum(['all', 'candidate', 'provisional', 'rejected', 'unmeasured'])
          .optional()
          .describe('Filter by measurement state. Default "all".'),
        standing: z
          .enum(['all', ...B20_STANDING_GROUPS_V1])
          .optional()
          .describe(
            'Filter by what the measurement concluded. "bought_not_sellable": wallets bought and Miorail could not price a sale. "two_sided": a purchase and a sale both priced. "no_buyers_yet": nobody bought, so there is nothing to sell into. "miorail_limit": the card describes Miorail\'s own measurement failing, not the token. Default "all".',
          ),
        freshness: z
          .enum(['all', 'fresh', 'stale'])
          .optional()
          .describe(
            'A stale measurement is still what was true when taken, but is past its window.',
          ),
        standingKind: z
          .enum(B20_EXIT_STANDING_KINDS_V1)
          .optional()
          .describe(
            'One exact conclusion rather than its whole section. "venue_not_searched" and "venue_not_found" share a section and are different statements: the first means Miorail did not look at the venue where these tokens trade.',
          ),
        bothRoutes: z
          .boolean()
          .optional()
          .describe(
            'Only launches where a purchase AND a sale both priced. Still not executable quotes.',
          ),
        maxRoundTripBps: z
          .number()
          .int()
          .min(0)
          .max(100000)
          .optional()
          .describe(
            'Upper bound on the MEASURED round trip, in basis points. A launch whose round trip was never measured is excluded, never treated as zero.',
          ),
        minBuyers: z
          .number()
          .int()
          .min(0)
          .max(1000000)
          .optional()
          .describe(
            'Lower bound on COMPLETED launch-window buying. A window that has not closed has counted nobody and is excluded, never read as zero.',
          ),
        project: z
          .enum(['all', 'product_backed', 'verified_project', 'unknown'])
          .optional()
          .describe(
            'Filter by PROJECT CONTEXT, which is a different axis from anything measured. "verified_project": a project proved a link to this token by serving a file on a domain it controls. "product_backed": that, plus a product endpoint the domain declared answered a real request. "unknown": no project has proven a link — where almost every launch on this chain belongs, and NOT a negative finding. A verified link is a check on publication, never a review of the project.',
          ),
        limit: z.number().int().min(1).max(MCP_MAX_PAGE_V1).optional(),
        cursor: z.string().max(500).optional().describe('Opaque; from a previous call.'),
        verbosity: z
          .enum(['summary', 'full'])
          .optional()
          .describe(
            'summary (default) omits the duplicated discoverCard and the per-item caveat block, which together are ~73% of a full payload. full keeps the old shape for a caller that reads discoverCard directly.',
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

    },
    async (args) => {
      try {
        return reply(await miorailListOpportunitiesV1(args ?? {}));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_summarise_b20_universe',
    {
      title: 'Count the measured B20 universe',
      description: `Counts stored measurements across a launch-age window, broken down by what each measurement CONCLUDED, by typed reason code, by which venues were searched, and by launch-window buying band. Call this instead of paging the opportunity list to answer "how many": the list returns at most ${MCP_MAX_PAGE_V1} per call and the window holds over a thousand launches.

Every number is a count of STORED MEASUREMENTS inside that window, never a count of tokens on Base.

Read "aboutToken" on each standing row before quoting it. When it is false the bucket counts what MIORAIL could not measure — a venue it did not search, a call that did not answer — and reporting such a count as a property of tokens is wrong.

Counts may be up to a minute old; "computedAt" says when they were taken.`,
      inputSchema: {
        launchAgeHours: z
          .number()
          .int()
          .min(1)
          .max(720)
          .optional()
          .describe('How far back to count, by launch age. Default 48 hours, the Discover window.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

    },
    async (args) => {
      try {
        return reply(await miorailSummariseUniverseV1(args ?? {}));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_get_b20_opportunity',
    {
      title: 'One measured B20 launch',
      description:
        'Returns Miorail’s latest Exit-First measurement for one Base token address, with its exact display-safe Discover Card, controls, route sources, pool-hook permissions, completed launch-window buying evidence and capacity bounds. Hook permissions are not behavior, and launch-window buying is not current holdings. Looked up DIRECTLY by address, so it is not bounded by a feed page. "Launch not found" means Miorail has ingested no canonical B20 launch at that address — a statement about what Miorail has read, not about the token.',
      inputSchema: {
        tokenAddress: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/)
          .describe('The B20 token contract address on Base mainnet.'),
        verbosity: z
          .enum(['summary', 'full'])
          .optional()
          .describe(
            'summary (default) omits the duplicated discoverCard and the per-item caveat block, which together are ~73% of a full payload. full keeps the old shape for a caller that reads discoverCard directly.',
          ),
        includePublicContext: z
          .boolean()
          .optional()
          .describe(
            'Opt-in. Runs a public search for a website, repository or social account and fetches each result to look for this token address. NOTHING it returns is verified. Omit it and the field is absent entirely — which is not the same as an empty result.',
          ),
        publicContextDomain: z
          .string()
          .max(253)
          .optional()
          .describe(
            'A bare hostname you already know, e.g. orbitlab.xyz — no scheme, no path, no port. When present NO SEARCH RUNS: Miorail fetches that domain and looks for this token address on it. It believes the domain no more than it believes a ranked search result.',
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

    },
    async (args) => {
      try {
        return reply(await miorailGetOpportunityV1(args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_explain_b20_rejection',
    {
      title: 'What a Miorail reason code means',
      description:
        'Returns the exact meaning of Miorail’s typed rejection and unmeasured reason codes, and whether each finding depends on which wallet is asking. Use this instead of paraphrasing a reason code — "no_exit_route" means Miorail found no route out on the venues it supports, not that a token cannot be sold anywhere on Base. Call with no argument to get the whole vocabulary.',
      inputSchema: {
        reasonCode: z.string().max(64).optional().describe('Omit to list every reason code.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

    },
    async (args) => {
      try {
        return reply(miorailExplainRejectionV1(args ?? {}));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_b20_market_rails',
    {
      title: 'Both measured market rails, as the server ranked them',
      description: `Returns Miorail's two market rails over the bounded active window: measured exit liquidity, and the change in what a measured round trip COSTS between two observations about 24 hours apart.

This is NOT a ranking, a score, a recommendation or a prediction. Miorail computes no overall rating and there is no "best" list to ask for. A token's position says only that one measured number is larger or smaller than another's, at ONE reference profile.

Absence from a rail is not a negative finding. A launch appears only when its measurement carries the number the rail is about — rejected, unmeasured and stale readings do not, and a route-cost change needs a second comparable observation that may simply not exist yet.

The cost change is in percentage POINTS and a rise means the exit got MORE expensive. Every row carries the exact interval between its two observations, because "24h" is a window of 20-28 hours rather than a measurement.

Replaces miorail_get_b20_market_leaders, which sorted a page of the feed inside the MCP and could disagree with the same rail on Miorail's own screens.`,
      inputSchema: {
        orderBy: z
          .enum(MCP_LEADER_DIMENSIONS_V1)
          .optional()
          .describe('Accepted for compatibility. Both rails are returned either way.'),
        limit: z.number().int().min(1).max(MCP_MAX_PAGE_V1).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

    },
    async (args) => {
      try {
        return reply(await miorailMarketRailsV1(args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_compare_b20_tokens',
    {
      title: 'Two to five B20 tokens, side by side, on measured dimensions only',
      description: `Compares between ${MCP_COMPARE_MIN_V1} and ${MCP_COMPARE_MAX_V1} Base token addresses on the dimensions Miorail actually measured.

It answers "comparable" FIRST, and you must read that before the numbers. Two measurements may be set beside each other only when they share a profile identity, a quote asset, a reference position and a measurement version — two tokens measured against different reference positions produce round trips that LOOK comparable and are not. When they are not comparable the figures still come back, each stated on its own, with the reason; do not subtract them from one another.

There is no aggregate, no winner, no score and no ordering. Values come back in the order you asked. A null value is UNKNOWN and never zero: "not_measured" means Miorail has no reading of that dimension, and "not_in_index" means it has no canonical launch at that address at all.

Project context is included as its own dimension because it answers a different question from anything measured against a pool — what a project published about itself on a domain it controls, and what Miorail then checked.`,
      inputSchema: {
        tokenAddresses: z
          .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
          .min(MCP_COMPARE_MIN_V1)
          .max(MCP_COMPARE_MAX_V1)
          .describe('Distinct Base token addresses. The order is preserved in the answer.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

    },
    async (args) => {
      try {
        return reply(await miorailCompareTokensV1(args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_find_b20_projects',
    {
      title: 'B20 launches a project has proven a link to',
      description: `Answers questions like "which B20 tokens have a live product" or "which have a verified website" from Miorail's project-claim corpus.

The denominator is NOT the launch universe. A project claims a token by serving a file on a domain it controls; this searches the VERIFIED CLAIMS, and the answer says so — "1 matched among 1 verified project claim". Launches without a verified claim are outside the corpus and remain UNKNOWN. They are not negative results, and most launches on this chain are never claimed.

Every predicate is positive. There is deliberately no way to ask which projects LACK something: Miorail cannot tell a project with no website from one that never claimed a token, and reporting the second as the first would be inventing a finding.

Evidence older than a day is labelled stale and describes what was true when it was checked, not what is true now.`,
      inputSchema: {
        predicate: z
          .enum(B20_FUNDAMENTAL_PREDICATES_V1)
          .describe('Required. There is no default question.'),
        limit: z.number().int().min(1).max(MCP_MAX_PAGE_V1).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

    },
    async (args) => {
      try {
        return reply(await miorailFindProjectsV1(args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  // Discovery, and the first tool in the Stocks order. Everything else needs a
  // namespaced key or an exact address, and nothing produced one — a connected
  // assistant had to already know `security:isin:US67066G1040`.
  server.registerTool(
    'list_reviewed_stocks',
    {
      title: 'Search the reviewed tokenized stocks Miorail holds',
      description:
        'Lists the reviewed underlyings Miorail has bound to Base representations, so a caller can turn a company name or ticker into the namespaced underlying key every other Stocks tool requires. Pass `query` to match a ticker, a company name or an identifier value as a case-insensitive substring; omit it to list everything. Many reviewed rows are named by TICKER rather than by company name, so a short list of company-name aliases bound to an ISIN covers the common ones \u2014 `nvidia` reaches NVDA \u2014 and every row says in `matchedBy` whether it was the issuer\u2019s own naming or a Miorail alias that found it. A query that matches nothing says so in its own `note` rather than implying the instrument has no representation. Pass `assetClass` to narrow: this corpus is not all common stock, and `reviewedByAssetClass` reports the whole breakdown on every call, because Miorail\u2019s web Stocks screen shows the equity rows only. THIS TOOL NEVER SELECTS A REPRESENTATION: it returns no contract address and no issuer choice, because different issuers publish different contracts for the same company and choosing between them is not Miorail\u2019s decision. Read `liveRepresentationCount` before comparing anything \u2014 it is a measured count of representations with tokens outstanding, and zero means nothing is outstanding on any reviewed contract at any size. An empty list means Miorail holds no reviewed binding matching that query; it is never a claim about what exists on Base or anywhere else.',
      inputSchema: MarketRealityAgentStocksInputV1Schema,
      outputSchema: MarketRealityAgentStocksOutputV1Schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return reply(await miorailListReviewedStocksV1(args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'get_representations',
    {
      title: 'Reviewed Base representations of one underlying',
      description:
        'Returns every reviewed Base representation bound to one namespaced underlying key, separately and by exact contract address. The underlying and its display ticker are grouping metadata only: this tool never chooses Coinbase, Backed, Dinari, a wrapper, or any other representation for the caller. Each row retains CAIP-10, issuer, representation kind, current supply evidence, and the reviewed identity trust root. An empty list means Miorail has no reviewed binding for that exact underlying key; it does not mean the instrument has no tokenized representations elsewhere.',
      inputSchema: MarketRealityAgentRepresentationsInputV1Schema,
      outputSchema: MarketRealityAgentRepresentationsOutputV1Schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return reply(await miorailGetRepresentationsV1(args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'compare_market_reality',
    {
      title: 'Compare one exact Market Reality question across representations',
      description:
        'Returns the same typed market-reality/v2 answer used by Miorail Stocks for one namespaced underlying, exact USD size, direction, destination and Base chain. Every reviewed representation stays separate by exact address. The canonical engine preserves supply-denominator, route-policy, normalization, provider outcome, reference/session/basis, current-versus-history, and ranking-withheld semantics. This is quote-only evidence: it never simulates execution, requests approval, returns calldata, signs, or submits a transaction. Provider/RPC failure remains Miorail uncertainty and one venue miss never becomes universal market absence. READ `miorailSummary` FIRST and prefer its wording to your own: it is Miorail\u2019s deterministic reading of the same counts, written by no model, and it exists because `establishedOutcomeCount: 0` describes MIORAIL\u2019S FRESHNESS at this exact size rather than the market. A missing current answer never means illiquid, untradeable, cheaper or better \u2014 `miorailSummary.notEstablished` says so in words you may repeat. When `currentComparisonAvailable` is false, offer `miorailSummary.nextSafeStep` instead of concluding anything.',
      inputSchema: MarketRealityAgentComparisonInputV1Schema,
      outputSchema: MarketRealityAgentComparisonMcpOutputV1Schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return reply(await miorailCompareMarketRealityV1(args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'get_market_changes',
    {
      title: 'Comparable public Market Reality changes for one exact representation',
      description:
        'Requires an exact Base contract address or CAIP-10 plus exact USD size, direction, destination and bounded window. Returns only stored public-ladder observations and transitions derived by the same Radar comparability logic. It never resolves a ticker, interpolates a missing point, reconstructs old evidence, crosses size/direction/destination/router-policy boundaries, or exposes tenant watches and users. Provider/RPC failures are explicit non-asset gaps and cannot replace the last comparable baseline. CALL IT WITH `detail: "summary"` FIRST: that returns the counts, the span and a per-kind tally of what changed with no rows at all, and a 7d window can otherwise be hundreds of observations. The rows themselves are paged newest-first by `limit` (10 by default, 500 at most \u2014 one observation is about 1.2 KB, so a large page is a large fraction of your context); pass the returned `nextCursor` as `before` to walk back. Changes are always derived over the whole window and only then paged, so a page never invents a gap \u2014 and `nextCursor: null` means this window is exhausted, never that nothing older exists.',
      inputSchema: MarketRealityAgentChangesInputV1Schema,
      outputSchema: MarketRealityAgentChangesOutputV1Schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return reply(await miorailGetMarketChangesV1(args));
      } catch (error) {
        return refuse(error);
      }
    },
  );
  // Phase 17.6 — the DeFi gap. Until this tool existed, neither MCP surface
  // carried a single venue field, so an assistant asked whether a tokenized
  // stock could be posted as collateral had nothing to read and answered from
  // the announcement it could reach. Silence is what let a blog post become
  // the answer; this is the reading that stands beside it.
  server.registerTool(
    'get_use_access',
    {
      title: 'What one exact representation can be used for, and what gates it',
      description: 'Reports what one EXACT Base representation can be used for and what gates it, measured rather than announced. Requires an exact contract address or CAIP-10: this tool never resolves a ticker or a company name, because different issuers publish different contracts for the same company and choosing between them is not Miorail’s decision — call list_reviewed_stocks then get_representations to obtain one. Returns, for that exact address: whether transfers are paused on chain, the issuer transfer policy bound to each of the sender, receiver and executor scopes, whether an LayerZero OFT bridge is configured, and whether each reviewed lending venue names this address — with the three DeFi axes (lend, borrow, collateral) kept separate, because an asset accepted as collateral is not necessarily one anybody can borrow. READ `miorailSummary` FIRST and prefer its wording to your own: it is Miorail’s deterministic reading of the same rows, written by no model, and it names the two leaps this data invites — from "these venues did not list it" to "it cannot be used in DeFi", and from "it was announced" to "you can do it now". ANNOUNCED IS NOT LIVE. `announcements` carries dated public claims by named parties joined to what the venue itself answered, in four states: `listed`, `not_listed`, `unread`, and `unchecked`. `unchecked` is NOT `not_listed` — a venue nobody read must never be reported as a venue that refused. Base announced on 2026-08-24 that Coinbase tokenized stocks are collateral on Aave; Aave’s reserve list on Base does not name these addresses today. Both are true, and telling a user they can post this collateral now is wrong. `blockTag` covers only the fields named in `blockTagCovers`. It does NOT cover `defi`: two venues answer from chain state read at head and two from their own catalogues, which publish no block at all, so each venue row carries its own `observed` provenance instead. A listing is not permission to act: caps, pause flags, available liquidity and risk parameters are not read here, and `miorailSummary.notStated` lists every question this tool leaves open. POOLS ARE WHERE THESE TOKENS ACTUALLY LIVE. `defi` answers a LENDING question and for tokenized stocks the honest answer is almost always no, while an Aerodrome concentrated-liquidity pool held 3,715 NVDAc against $1.6M of USDC. If a user asks about LP, liquidity, pools or AMMs, answer from `pools` — reporting no DeFi use from the lending venues alone is false, and it is our omission rather than the token’s property. `pools.rows` is ranked by MEASURED balance, deepest first, and `deepestSharePercent` must travel with `poolCount`: thirty-nine pools hold NVDAc and one holds about 88% of it while twenty-four of the rest are memecoin pairs, so a count on its own is true arithmetic about a market that does not exist. A pool balance is every position the contract holds, in range or out, plus uncollected fees — it is NOT depth and NOT a quote. `venueTier` decides how a pool may be named: `protocol` names the exchange, `engine` names only the AMM machinery (Algebra licenses its engine to many DEXes, so it is not an exchange name), and `shape` says only whether the pool is concentrated or a constant-product pair — for the last two, name the pool by its address. `pools.state = not_measured` means nobody checked and is never a statement that there are no pools. It is public and wallet-free — `walletBound` is always false — so it can never say whether a particular wallet may transfer or use the token, and it states nothing about KYC, jurisdiction or legal eligibility. A venue that answered `unread` said nothing either way and is never a "no". An address Miorail holds no reviewed binding for is refused, which is a statement about Miorail’s corpus and never about the token.',
      inputSchema: UseAccessAgentInputV1Schema,
      outputSchema: UseAccessAgentOutputV1Schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return reply(await miorailGetUseAccessV1(args));
      } catch (error) {
        return refuse(error);
      }
    },
  );
}

export function createMiorailMcpServerV1(): McpServer {
  const server = new McpServer(
    { name: MIORAIL_MCP_NAME_V1, version: MIORAIL_MCP_VERSION_V1 },
    { instructions: MIORAIL_MCP_INSTRUCTIONS_V1 },
  );
  registerMiorailReadOnlyToolsV1(server);
  return server;
}
