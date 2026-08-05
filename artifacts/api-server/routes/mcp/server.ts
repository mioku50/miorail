import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
  miorailMarketLeadersV1,
} from './tools.js';

// ---------------------------------------------------------------------------
// T72 — the Miorail MCP server: five read-only tools over stored evidence.
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
export const MIORAIL_MCP_VERSION_V1 = '1.0.0';

/** §7 — what the assistant is told about the whole server, once. */
export const MIORAIL_MCP_INSTRUCTIONS_V1 = `Miorail is a Base L2 route-intelligence product. This server is READ-ONLY: it reports what Miorail's background workers measured about B20 token launches, and it can neither trade, sign, quote a wallet, nor prepare a transaction.

Three things you must preserve when you summarise anything from this server:

1. ${MIORAIL_MCP_CAVEATS_V1.provisional}

2. ${MIORAIL_MCP_CAVEATS_V1.routeCoverage}

3. ${MIORAIL_MCP_CAVEATS_V1.capacity}

Miorail does not measure unique buyers, trading volume, holder concentration, related-wallet clusters, organic buy pressure, future price or profit probability. Do not infer any of them from what is here, and do not describe a token as safe, unsafe, good, promising or a scam on this evidence — none of those are things Miorail measured.

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

Numbers may be null. A null round-trip cost means it was not measured; it does not mean zero, free or cheap.`,
      inputSchema: {
        state: z
          .enum(['all', 'candidate', 'provisional', 'rejected', 'unmeasured'])
          .optional()
          .describe('Filter by measurement state. Default "all".'),
        freshness: z
          .enum(['all', 'fresh', 'stale'])
          .optional()
          .describe('A stale measurement is still what was true when taken, but is past its window.'),
        limit: z.number().int().min(1).max(MCP_MAX_PAGE_V1).optional(),
        cursor: z.string().max(500).optional().describe('Opaque; from a previous call.'),
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
    'miorail_get_b20_opportunity',
    {
      title: 'One measured B20 launch',
      description:
        'Returns Miorail’s latest Exit-First measurement for one Base token address, with its controls, route coverage and capacity bounds. "Not in feed" means Miorail has not measured that address inside its current window — a statement about what Miorail has read, not about the token.',
      inputSchema: {
        tokenAddress: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/)
          .describe('The B20 token contract address on Base mainnet.'),
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
    'miorail_get_b20_market_leaders',
    {
      title: 'Fresh provisional launches, sorted by one measured dimension',
      description: `Sorts fresh PROVISIONAL measurements by a single measured dimension that you must name. This is NOT a ranking, a score, a recommendation or a prediction — Miorail computes no overall rating, and there is no "best" list to ask for.

"${MCP_LEADER_DIMENSIONS_V1[0]}" orders by the largest exit size that stayed within the reference slippage tolerance. "${MCP_LEADER_DIMENSIONS_V1[1]}" orders by measured pre-entry round-trip cost, cheapest first.

A token’s position here says only that one number is larger or smaller than another’s. Absence from the list is not a negative finding: rejected, unmeasured and stale tokens are excluded because they do not carry the number being sorted on.`,
      inputSchema: {
        orderBy: z
          .enum(MCP_LEADER_DIMENSIONS_V1)
          .describe('Required. There is no default, because there is no default notion of "leading".'),
        limit: z.number().int().min(1).max(MCP_MAX_PAGE_V1).optional(),
      },
    },
    async (args) => {
      try {
        return reply(await miorailMarketLeadersV1(args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  return server;
}
