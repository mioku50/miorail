import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { B20_EXIT_STANDING_KINDS_V1, B20_STANDING_GROUPS_V1 } from '@mioagent/opportunity-rail';
import {
  MCP_DEFAULT_PAGE_V1,
  MCP_LEADER_DIMENSIONS_V1,
  MCP_MAX_PAGE_V1,
  MIORAIL_MCP_CAVEATS_V1,
  McpPublicError,
  miorailDiscoverStatusV1,
  miorailExplainRejectionV1,
  miorailGetOpportunityV1,
  miorailListOpportunitiesV1,
  miorailMarketRailsV1,
  miorailSummariseUniverseV1,
} from './tools.js';

// ---------------------------------------------------------------------------
// T72 — the Miorail MCP server: six read-only tools over stored evidence.
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
export const MIORAIL_MCP_VERSION_V1 = '1.1.0';

/** §7 — what the assistant is told about the whole server, once. */
export const MIORAIL_MCP_INSTRUCTIONS_V1 = `Miorail is a Base L2 route-intelligence product. This server is READ-ONLY: it reports what Miorail's background workers measured about B20 token launches, and it can neither trade, sign, quote a wallet, nor prepare a transaction.

Five things you must preserve when you summarise anything from this server:

1. ${MIORAIL_MCP_CAVEATS_V1.provisional}

2. ${MIORAIL_MCP_CAVEATS_V1.routeCoverage}

3. ${MIORAIL_MCP_CAVEATS_V1.capacity}

4. ${MIORAIL_MCP_CAVEATS_V1.poolHook}

5. ${MIORAIL_MCP_CAVEATS_V1.launchBuying}

Miorail measures unique buying wallets only inside a completed launch window. It does not measure buyers beyond that window, trading volume, current holder concentration, related-wallet clusters, organic buy pressure, future price or profit probability. Do not infer any of them from what is here, and do not describe a token as safe, unsafe, good, promising or a scam on this evidence — none of those are things Miorail measured.

An empty result is not the same as a quiet chain. Call miorail_discover_status first: the workers may be behind, unconfigured or degraded, and the status says which.`;

export function createMiorailMcpServerV1(): McpServer {
  const server = new McpServer(
    { name: MIORAIL_MCP_NAME_V1, version: MIORAIL_MCP_VERSION_V1 },
    { instructions: MIORAIL_MCP_INSTRUCTIONS_V1 },
  );

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
          .describe('Only launches where a purchase AND a sale both priced. Still not executable quotes.'),
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
      },
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
    },
    async (args) => {
      try {
        return reply(await miorailMarketRailsV1(args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  return server;
}
