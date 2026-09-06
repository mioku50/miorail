import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MarketRealityAgentComparisonInputV1Schema } from '@mioagent/rwa-market-reality';
import {
  MCP_SUBMISSION_RESULTS_V1,
  MIORAIL_PRIVATE_CAVEATS_V1,
  McpPrivateError,
  miorailCheckExitProfileV1,
  miorailGetBaseMcpActionV1,
  miorailGetExecutionStatusV1,
  miorailPrepareB20EntryV1,
  miorailGetStockBaseMcpActionV1,
  miorailMeasureMarketRealityV1,
  miorailPrepareStockActionV1,
  miorailRecordBaseMcpSubmissionV1,
  privateFailureV1,
} from './tools.js';
import { registerMiorailReadOnlyToolsV1 } from '../mcp/server.js';
import {
  MiorailCheckExitProfileOutputV1Schema,
  MiorailExecutionStatusOutputV1Schema,
  MiorailGetBaseMcpActionOutputV1Schema,
  MiorailGetStockBaseMcpActionOutputV1Schema,
  MiorailPrepareB20EntryOutputV1Schema,
  MiorailMeasureMarketRealityOutputV1Schema,
  MiorailPrepareStockActionOutputV1Schema,
  MiorailRecordSubmissionOutputV1Schema,
} from './outputs.js';
import type { McpPrivateIdentityV1 } from './session.js';

// ---------------------------------------------------------------------------
// T72-B §2 — the authenticated MCP server.
//
// One server instance per request, constructed around ONE already-authenticated
// identity. The wallet is closed over, not passed in: no tool on this surface
// accepts a wallet, an owner, an account or a tenant, so there is no argument an
// assistant could fill in to act as somebody else (§10).
//
// The descriptions are load-bearing. An assistant decides from them whether to
// call a tool, in what order, and what to say about the result — and the
// failure mode is not a crash, it is a model resending a batch it could not
// find the status of.
// ---------------------------------------------------------------------------

/**
 * What a client displays.
 *
 * "private" describes the ROUTE's trust zone and reads to a user as something
 * hidden. What this surface actually is, from where they stand, is the one
 * they connected their Base Account to — so the product name is "Miorail
 * Connected" and the path stays `/mcp/private`, which nobody has to see.
 */
export const MIORAIL_PRIVATE_MCP_NAME_V1 = 'miorail-connected';
export const MIORAIL_PRIVATE_MCP_VERSION_V1 = '1.1.0';

export const MIORAIL_PRIVATE_INSTRUCTIONS_V1 = `Miorail Connected — the authenticated surface, bound to ONE wallet: the one that issued the token you are using. You cannot read, prepare or execute anything for any other wallet, and there is no argument that would let you try.

Miorail never signs and never broadcasts. It holds no private key. What it can do is prove a route is executable, persist the exact calls it simulated, and hand those calls to you so the USER can approve them in their own Base Account through Base MCP.

THIS SURFACE ALSO CARRIES EVERY READ-ONLY MIORAIL TOOL. You do not need a second connection to find anything: list_reviewed_stocks turns a company or ticker into an underlying key, get_representations returns every reviewed Base representation of it separately by exact address, compare_market_reality answers one exact question, get_market_changes reads stored public history, and the miorail_* B20 tools read the launch corpus. Those tools take no wallet and are identical to the public server's — the wallet-bound seven below are what this surface adds. Find the exact representation with the read tools FIRST; nothing below will guess one for you.

The order is fixed and every step exists for a reason:

1. miorail_check_exit_profile — the live wallet-bound simulation. ${MIORAIL_PRIVATE_CAVEATS_V1.qualification}
2. miorail_prepare_b20_entry — turns a clearance into a persisted, simulated plan. Returns a review, deliberately no calls.
3. Show the review to the user and get an explicit yes.
4. miorail_get_base_mcp_action — the exact stored calls.
5. Base MCP send_calls — unchanged. ${MIORAIL_PRIVATE_CAVEATS_V1.approval}
6. miorail_record_base_mcp_submission — exactly once.
7. miorail_get_execution_status — a wallet approval is not an entry.

${MIORAIL_PRIVATE_CAVEATS_V1.onePlanOneSubmission}

${MIORAIL_PRIVATE_CAVEATS_V1.entryOnly}

This surface buys B20 tokens through a route Miorail certified. It is not a general swap tool: there is no path here to an arbitrary token, an arbitrary router or calldata of your own.`;

const ADDRESS_ARG_V1 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe('The B20 token contract address on Base mainnet.');

const POSITION_ARG_V1 = z
  .string()
  .regex(/^[0-9]{1,30}$/)
  .describe(
    'The USDC position size in atomic units (6 decimals, so 25 USDC is "25000000"). This is the user’s money — never guess it, and state it back to them before preparing anything.',
  );

const ROUND_TRIP_ARG_V1 = z
  .number()
  .int()
  .min(1)
  .max(10_000)
  .optional()
  .describe('Maximum acceptable measured round-trip cost, in basis points. Defaults to 300 (3%).');

const SLIPPAGE_ARG_V1 = z
  .number()
  .int()
  .min(1)
  .max(10_000)
  .optional()
  .describe('Maximum acceptable exit slippage, in basis points. Defaults to 300 (3%).');

export function createMiorailPrivateMcpServerV1(identity: McpPrivateIdentityV1): McpServer {
  const server = new McpServer(
    { name: MIORAIL_PRIVATE_MCP_NAME_V1, version: MIORAIL_PRIVATE_MCP_VERSION_V1 },
    { instructions: MIORAIL_PRIVATE_INSTRUCTIONS_V1 },
  );

  // The read half, first — because it is the half a connected assistant needs
  // before any of the seven below can be called at all. A client that connected
  // here used to be able to prepare a review of an exact representation with no
  // way to FIND that representation, and had to be pointed at a second,
  // separately configured server to do it. The import runs one way: this file
  // reaches into the public registry, never the reverse, so the public surface
  // keeps its physical inability to execute.
  registerMiorailReadOnlyToolsV1(server);

  const reply = (payload: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  });

  const refuse = (error: unknown) => {
    const failure = error instanceof McpPrivateError ? error : privateFailureV1(error);
    return {
      isError: true as const,
      content: [{ type: 'text' as const, text: `${failure.code}: ${failure.message}` }],
    };
  };

  // -------------------------------------------------------------------------
  // Connected Intelligence 1 — the stock-native prepare.
  //
  // Registered first because it is the one an assistant reaches from the public
  // Stocks tools, and because its contract is the strictest on this surface: it
  // returns no financial term at all.
  // -------------------------------------------------------------------------
  server.registerTool(
    'miorail_prepare_stock_action',
    {
      title: 'Prepare a review of ONE exact reviewed stock representation',
      description: `Turns a reviewed Stocks representation into a short-lived review link for the signed-in wallet. Use it after the public tools (get_representations, compare_market_reality) have identified an EXACT address the user chose.

WHAT THIS RETURNS: which representation and which question are about to be reviewed. THAT IS ALL. It deliberately contains no price, no cash return, no premium or discount, and no comparison — do not supply one from an earlier message either. The review page is the only place the current terms are established, because a router quote is open for about twenty seconds and anything you carry into prose is already history.

Pass the identity fields exactly as Miorail returned them. A ticker cannot select a representation: different issuers publish different contracts for the same company, and Miorail will not guess which one you meant. If any field disagrees with Miorail's reviewed evidence the call is refused rather than corrected.

A representation with zero outstanding supply refuses. It is NOT redirected to its wrapper, its underlying, or another issuer's contract — those are different contracts and a different question.

This creates nothing executable. There is no path from here to calldata, an approval or a transaction; the user reviews, and only their own Base Account can move anything.`,
      inputSchema: {
        chainId: z.literal(8453).describe('Base mainnet. The only chain this surface reviews.'),
        tokenAddress: ADDRESS_ARG_V1.describe(
          'The EXACT reviewed representation contract on Base. Never a ticker, never a symbol.',
        ),
        underlyingKey: z
          .string()
          .min(1)
          .max(200)
          .describe('The security this representation claims, e.g. "security:isin:US67066G1040".'),
        issuerId: z.enum(['coinbase', 'dinari', 'backed']).describe('As Miorail returned it.'),
        issuerInstrumentKey: z.string().min(1).max(200).describe('As Miorail returned it.'),
        representationKind: z
          .enum(['b20_asset', 'rebasing_erc20', 'non_rebasing_erc4626_wrapper', 'dinari_dshare'])
          .describe('As Miorail returned it.'),
        direction: z.enum(['buy', 'sell']).describe('The exact direction the user asked about.'),
        requestedCashAtomic: POSITION_ARG_V1.describe(
          'The exact cash size in USDC atomic units. A $10,000 question is not a $100 question multiplied.',
        ),
        destination: z.literal('USDC').describe('The cash side of every reviewed question.'),
        routePolicyKey: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/)
          .describe('The reviewed router policy Miorail measured under, as it returned it.'),
      },
      outputSchema: MiorailPrepareStockActionOutputV1Schema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return reply(await miorailPrepareStockActionV1(identity, args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_get_stock_base_mcp_action',
    {
      title: 'The unsigned Base MCP request for a CONFIRMED stock action',
      description: `Turns a confirmed stock clearance into the same unsigned EIP-5792 request the Miorail web console produces. A clearance comes from the review page after the USER pressed confirm — you cannot mint one, and there is no argument here that would let you act for another wallet.

Nothing about this is a price. Do not describe the terms, restate a figure from earlier in the conversation, or characterise the route as good, cheap or best: the review surface established the terms, it is the only place they are current, and the user approves them there and in their own Base Account.

Miorail plans, simulates and runs its Safety Kernel over this before returning anything, and refuses rather than offering a stale request if the market moved after the confirmation.

A SELL is confirmed as an exact number of TOKEN atoms, and the user states that number on the review page — a reviewed sell question is "cash worth", and no quote may be spent as the size. You do not supply it and cannot: hand over the review link, and the clearance that comes back already carries what the holder confirmed. A clearance minted without one is refused here.

Pass the calls to Base MCP send_calls UNCHANGED, then record the submission exactly once.`,
      inputSchema: {
        clearance: z
          .string()
          .min(1)
          .max(4000)
          .describe('From the review page, after the user confirmed. Never construct one.'),
        requestId: z
          .string()
          .min(1)
          .max(200)
          .describe('Your idempotency handle. Reuse it on a retry; never generate a new one for the same intent.'),
      },
      outputSchema: MiorailGetStockBaseMcpActionOutputV1Schema,
      // NOT read-only, and the annotation is the only thing a host has to go
      // on. This call checks the clearance, reads the token on chain, plans and
      // prepares a route, runs the Safety Kernel, creates a blueprint, writes
      // an `action_released` audit row and returns executable calls. A host
      // that auto-approves low-risk tools on `readOnlyHint: true` — which is
      // exactly what several of them do — would run all of that unattended.
      //
      // `openWorldHint` is true for the same reason: the route is quoted from
      // live external routers, so two calls a minute apart are two different
      // answers. `idempotentHint` stays true because `requestId` is a real
      // idempotency key — the route run is stored under it and reused.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return reply(await miorailGetStockBaseMcpActionV1(identity, args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  // -----------------------------------------------------------------------
  // Connected Intelligence 2 — the missing verb.
  //
  // Every other Stocks tool reads what was already measured, so an assistant
  // could truthfully report "no fresh answer at this size" and had no way on
  // this surface to get one. Only the web button could measure. This is that
  // button, with the same coordinator behind it.
  // -----------------------------------------------------------------------
  server.registerTool(
    'miorail_measure_market_reality',
    {
      title: 'Measure one exact Market Reality question now',
      description: "Takes a FRESH measurement of one exact Market Reality question, right now, and returns it in the same shape compare_market_reality returns.\n\nUSE THIS WHEN A READ SAYS THERE IS NO CURRENT ANSWER. compare_market_reality reads stored evidence; when it reports `currentComparisonAvailable: false` or `establishedOutcomeCount: 0`, that describes MIORAIL'S FRESHNESS at that exact size, not the market — and this is the tool that fixes it. Read first, measure only if the read has no current answer at the size the user actually asked about.\n\nTHE QUESTION IS THE SIZE. A $10,000 measurement is not a $100 measurement multiplied: a route walks liquidity, and measuring a size nobody asked about answers a question nobody asked. Pass the exact size, direction and destination the user meant, and the same values you would pass to compare_market_reality.\n\nWHAT IT COSTS. This spends real router calls and writes evidence, so it is rate limited per wallet and it is not free to repeat. Miorail measures one identical question once: a repeat joins the run already in flight or reuses one taken seconds ago, and the `measurement` block says exactly which — `measured` LISTS the representations this call really quoted, `reusedCooldown` and `reusedOpen` list what it did not, and `joinedInFlight` is a boolean. Reading `measured: []` beside a non-empty `reusedCooldown` means the answer is fresh and pressing again buys nothing.\n\nIF IT TIMES OUT, DO NOT CALL IT AGAIN. `measure_still_running` means the measurement is being taken for you and has not been abandoned. Call compare_market_reality in a few seconds and read the answer it produced.\n\nThis is quote-only evidence. It never simulates execution, requests approval, returns calldata, signs or submits anything, and a router quote never becomes execution evidence. Provider or RPC failure stays Miorail's uncertainty: one venue missing is never universal market absence, and a failed measurement is never a finding about the representation. READ `miorailSummary` FIRST and prefer its wording to your own — it is written by no model and it is the same reading the public comparison ships.",
      inputSchema: MarketRealityAgentComparisonInputV1Schema,
      outputSchema: MiorailMeasureMarketRealityOutputV1Schema,
      // Not read-only: it spends router calls and writes evidence rows. An
      // annotation is a safety claim, and this surface has shipped a false one
      // before -- classify by what the handler writes, never by what it feels
      // like from the caller's side.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return reply(await miorailMeasureMarketRealityV1(identity, args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_check_exit_profile',
    {
      title: 'Live wallet-bound exit check and sequential simulation',
      description: `Runs Miorail's live check for the signed-in wallet: it quotes the entry, simulates it, re-quotes the exit at the size the entry actually produced, and simulates all four calls in one state. This is the ONLY thing that can qualify a token for execution.

${MIORAIL_PRIVATE_CAVEATS_V1.qualification}

A "provisional" result from the public Discover feed is not a substitute and cannot be promoted. If this returns anything other than qualified, there is no clearance and nothing can be prepared — say so plainly rather than describing the token as tradeable.

The token's controls must have been read on this server first; if they have not, this refuses with b20_controls_unread rather than pricing a token whose transfer controls were never checked.`,
      inputSchema: {
        tokenAddress: ADDRESS_ARG_V1,
        positionAtomic: POSITION_ARG_V1,
        maxRoundTripBps: ROUND_TRIP_ARG_V1,
        maxExitSlippageBps: SLIPPAGE_ARG_V1,
      },
      outputSchema: MiorailCheckExitProfileOutputV1Schema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return reply(await miorailCheckExitProfileV1(identity, args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_prepare_b20_entry',
    {
      title: 'Turn a clearance into a persisted, simulated entry plan',
      description: `Consumes a clearance from miorail_check_exit_profile and produces a stored Entry Plan: Miorail re-reads the token's controls, re-quotes the cleared route, rebuilds every byte server-side, runs its safety kernel over the result and simulates the exact calls on offer.

Returns a REVIEW and no executable calls. That is deliberate — show the review to the user and get an explicit yes before calling miorail_get_base_mcp_action.

Pass the SAME position and tolerances you used for the check. Different numbers describe a different plan and the clearance will be refused.

requestId is an idempotency handle you choose. Reusing it returns the stored plan instead of re-quoting the pool, so a retry never offers the user different numbers.`,
      inputSchema: {
        clearanceId: z.string().min(1).max(200).describe('From miorail_check_exit_profile.'),
        positionAtomic: POSITION_ARG_V1,
        maxRoundTripBps: ROUND_TRIP_ARG_V1,
        maxExitSlippageBps: SLIPPAGE_ARG_V1,
        requestId: z
          .string()
          .min(1)
          .max(200)
          .describe('Your idempotency handle. Reuse it on a retry; never generate a new one for the same intent.'),
      },
      outputSchema: MiorailPrepareB20EntryOutputV1Schema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return reply(await miorailPrepareB20EntryV1(identity, args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_get_base_mcp_action',
    {
      title: 'The exact persisted calls, for Base MCP send_calls',
      description: `Returns the exact calls Miorail simulated, in the shape Base MCP's send_calls takes. Call this only AFTER the user has seen the review and said yes.

${MIORAIL_PRIVATE_CAVEATS_V1.approval}

Pass the calls through UNCHANGED. Do not reorder, merge, re-encode, add or drop a call, and do not substitute a recipient, amount or router of your own: the returned callsHash covers these exact bytes, and a modified batch is one Miorail never simulated and will refuse to record.

This opens the plan's ONE submission slot. ${MIORAIL_PRIVATE_CAVEATS_V1.onePlanOneSubmission}`,
      inputSchema: {
        planId: z.string().min(1).max(200).describe('From miorail_prepare_b20_entry.'),
        positionAtomic: POSITION_ARG_V1,
        maxRoundTripBps: ROUND_TRIP_ARG_V1,
        maxExitSlippageBps: SLIPPAGE_ARG_V1,
        attemptRequestId: z
          .string()
          .min(1)
          .max(200)
          .describe('Idempotency handle for this submission attempt. Reuse it on a retry.'),
      },
      outputSchema: MiorailGetBaseMcpActionOutputV1Schema,
      // NOT read-only. This opens the plan's ONE submission slot and writes an
      // `action_released` audit row before a single byte leaves the server —
      // both are state changes, and the slot is the reason a plan cannot be
      // sent twice. The bytes themselves are read from storage, so
      // `openWorldHint` stays false; `attemptRequestId` really does dedupe the
      // attempt, so `idempotentHint` stays true.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return reply(await miorailGetBaseMcpActionV1(identity, args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_record_base_mcp_submission',
    {
      title: 'Record what Base MCP reported',
      description: `Tells Miorail what happened when you passed the calls to Base MCP. Call it exactly once per action.

You are reporting the WALLET'S BEHAVIOUR, not a result. You cannot tell Miorail that an entry succeeded; only on-chain reconciliation establishes that.

- "submitted": Base MCP returned a batch id. Pass it.
- "user_rejected": the user declined. Nothing reached the chain.
- "unknown": you could not establish what happened. Pass the batch id if you have one. If you do not, Miorail records nothing and permanently locks this plan — that is the safe outcome, and you must NOT prepare, fetch or send again. Tell the user to check their wallet activity.

submittedCallsHash must be the callsHash you were given. A mismatch means what was sent is not what Miorail prepared, and nothing will be recorded.`,
      inputSchema: {
        planId: z.string().min(1).max(200),
        attemptId: z.string().min(1).max(200).describe('From miorail_get_base_mcp_action.'),
        submittedCallsHash: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/)
          .describe('The callsHash you were given. Do not compute your own.'),
        result: z.enum(MCP_SUBMISSION_RESULTS_V1),
        batchId: z
          .string()
          .min(1)
          .max(200)
          .nullish()
          .describe('The Base MCP request/batch id. Required for "submitted".'),
      },
      outputSchema: MiorailRecordSubmissionOutputV1Schema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return reply(await miorailRecordBaseMcpSubmissionV1(identity, args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  server.registerTool(
    'miorail_get_execution_status',
    {
      title: 'What the submitted batch actually did',
      description: `Reads Miorail's reconciliation for one plan and returns a named outcome: awaiting_wallet_approval, submitted, reconciling, entry_succeeded, entry_reverted, submitted_unknown, reconciliation_required or user_rejected.

Report the state you are given; do not upgrade it. In particular:

- "submitted" means a batch exists, NOT that the entry happened.
- "reconciliation_required" means the batch was confirmed but the expected token receipt was not found in it. A confirmed approval is not an entry.
- "submitted_unknown" is neither success nor failure, and is never a reason to send again.

Only "entry_succeeded" means the wallet's own decoded movements show USDC spent and the token received.`,
      inputSchema: {
        planId: z.string().min(1).max(200),
      },
      outputSchema: MiorailExecutionStatusOutputV1Schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return reply(await miorailGetExecutionStatusV1(identity, args));
      } catch (error) {
        return refuse(error);
      }
    },
  );

  return server;
}
