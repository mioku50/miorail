import React from 'react';
import {
  baseMcpExampleBadgeV1,
  selectBaseMcpExampleV1,
  type BaseMcpExampleDispositionUiV1,
} from './BaseMcpPluginsCard';
import { giftShareLinksV1 } from './giftView';
import { ShareLinkV1 } from './shareHost';

// The app uses the automatic JSX runtime; the node render suite uses the
// classic transform and needs this binding.
void React;

// ---------------------------------------------------------------------------
// The Base MCP console — a second room, and the reason there are two.
//
// Miorail's Routes flow answers with a Route Card: a measured route, a quote
// it is aligned to, and a typed reason when it refuses. Base MCP answers with
// whatever a third-party plugin returned. Both used to speak from the same
// thread, in the same typeface, and nothing on screen said which guarantee the
// reader was being handed.
//
// So the console states its own limits before it says anything else, and the
// TRACE is part of the answer rather than a debug drawer. "Which tool said
// this" is the question the separation exists to answer, and an answer without
// its trace is exactly the undifferentiated voice this replaces.
//
// Direct actions only arrive here through a deterministic typed adapter. The
// model itself still reads; it never receives a write tool. A released action
// may render an ephemeral Base Account approval URL and a durable Action
// Receipt, but never a Route Card or Route Proof.
// ---------------------------------------------------------------------------

export interface BaseMcpConsoleTraceRowV1 {
  tool: string;
  args: string;
  ok: boolean;
  result: string;
  errorCode: string | null;
}

export type BaseMcpConsoleStatusV1 =
  | 'answered'
  | 'handoff'
  | 'action'
  | 'needs_input'
  | 'no_tools'
  | 'needs_reauth'
  | 'disabled'
  | 'failed';

interface BaseMcpActionReceiptCommonUiV1 {
  id: string;
  status: 'preparing' | 'approval_required' | 'pending' | 'reconciling' | 'completed' | 'rejected' | 'failed';
  /** Wallet MCP, or the wallet in use on the page (Found's claims only). */
  provider: 'base-mcp' | 'wallet';
  chainId: 8453;
  reconciliationState: 'not_started' | 'pending' | 'matched' | 'provider_confirmed' | 'mismatched' | 'unavailable';
  transactionHash: string | null;
  blockNumber: string | null;
  errorCode: string | null;
  routeVerified: false;
  approvalRequired?: boolean;
}

export type BaseMcpActionReceiptUiV1 = BaseMcpActionReceiptCommonUiV1 & (
  | {
      actionType: 'aerodrome_claim'; operation: 'claim'; recipient: string;
      claimCount: number; poolsRead: number; poolsTotal: number; managedSkipped: number;
      readBlock: string | null; simulationStatus: 'passed' | 'failed' | 'unavailable';
      reconciliationBasis: 'aerodrome_claim_events';
    }
  | {
      actionType: 'uniswap_collect'; operation: 'collect'; recipient: string;
      positionCount: number; positionsHeld: number;
      readBlock: string | null; simulationStatus: 'passed' | 'failed' | 'unavailable';
      reconciliationBasis: 'uniswap_collect_events';
    }
  | {
      actionType: 'send';
      /** ETH is the chain's own asset: no contract, read back from the
       * wallet's operation rather than a Transfer event. */
      asset: { symbol: 'USDC'; address: string; decimals: 6 } | { symbol: 'ETH'; address: null; decimals: 18 };
      amount: string;
      recipient: string;
      recipientName?: string | null;
      reconciliationBasis: 'erc20_transfer_event' | 'native_value_call';
    }
  | {
      actionType: 'x402';
      method: 'GET';
      url: string;
      maxPayment: string;
      paymentAsset: { symbol: 'USDC'; address: string; decimals: 6 };
      responseHash: string | null;
      reconciliationBasis: 'x402_endpoint_response';
    }
  | {
      actionType: 'virtuals';
      extensionProvider: 'virtuals';
      operation: 'agent_create' | 'sign_in';
      agentName: string | null;
      agentDescription: string | null;
      providerObjectId: string | null;
      reconciliationBasis: 'virtuals_provider_response';
    }
);

export interface BaseMcpConsoleAnswerV1 {
  status: BaseMcpConsoleStatusV1;
  reply: string | null;
  trace: readonly BaseMcpConsoleTraceRowV1[];
  toolsAvailable: number;
  truncated: boolean;
  /** How long the answer took. Shown, because a twenty-second wait the user
   * counted themselves is worse than a twenty-second wait the page owns. */
  elapsedMs?: number;
  errorCode: string | null;
  handoff?: {
    target: 'routes' | 'provider';
    path: string;
    originalMessage: string;
    provider?: string | null;
    summary?: string;
    risk?: 'liquidation';
  } | null;
  action?: {
    receipt: BaseMcpActionReceiptUiV1;
    approvalUrl: string | null;
    resultPreview?: string | null;
  } | null;
  /**
   * A reviewed link to the provider's own interface.
   *
   * Built server-side from a code-owned registry keyed by the plugin the router
   * resolved — never by the model, which is the whole reason this is a field
   * and not a URL inside `reply`. Absent for routable intents on purpose: a
   * swap finishes in Swap AI, and offering "go do it on Aerodrome" because
   * our own simulator fell short hands the user our unfinished work.
   */
  cta?: { label: string; url: string } | null;
  /** Exact phrases to ask next, written by the reviewed code that answered,
   * never by the model: "Claim my Aerodrome fees" under a reading that found
   * some. Pressing one fills the box like any example. */
  next?: readonly BaseMcpConsoleNextUiV1[];
  /** Found's claim: the exact calls the server read, guarded and simulated,
   * for the wallet in use on this page to send. Only while the receipt waits
   * for that wallet. */
  walletCalls?: readonly { to: string; value: string; data: string }[] | null;
}

export interface BaseMcpConsoleNextUiV1 {
  prompt: string;
  kind: 'read' | 'claim' | 'alert';
}

/** The badge on a next step, in the words the examples already use, plus one
 * for an alert: keeping one is neither a read nor a wallet approval. */
export function baseMcpNextBadgeV1(kind: BaseMcpConsoleNextUiV1['kind']): { label: string; tone: string } {
  if (kind === 'claim') return { label: 'You approve', tone: 'action' };
  if (kind === 'alert') return { label: 'Alert', tone: 'read' };
  return { label: 'Reads', tone: 'read' };
}

export interface BaseMcpConsoleModelV1 {
  question: string;
  onQuestionChange: (value: string) => void;
  onAsk: () => void;
  pending: boolean;
  answer: BaseMcpConsoleAnswerV1 | null;
  /** Set when the request itself failed. Rendered instead of any answer. */
  unavailableReason: string | null;
  /** Offered when the console reports the session is gone. */
  onConnect?: () => void;
  onOpenRoutes?: (message: string) => void;
  onReconcileAction?: (receiptId: string) => void;
  reconcilingAction?: boolean;
  /** One taxonomy for the whole page — see `baseMcpCapabilityTallyV1`. */
  routing?: BaseMcpRoutingCountsV1 | null;
  /** Keeps the command surface discoverable while making execution state
   * explicit, for example before a Base App wallet session exists. */
  disabledReason?: string | null;
  /** A visitor with no session: the one thing to press is signing in. */
  onSignIn?: () => void;
  /** Fills the box from a next step under the answer, which can sit a screen
   * below it. Falls back to `onQuestionChange`. */
  onSelectNext?: (prompt: string) => void;
  /** Makes the share card of a completed Found claim or collect. */
  onShareAction?: (receiptId: string) => void;
  /** The card, once made: its link and the post that goes with it. */
  share?: { url: string; text: string } | null;
  sharing?: boolean;
  shareError?: string | null;
  /** Sends a Found claim from the wallet in use on this page. Absent where the
   * page has no wallet to send it with. */
  walletClaim?: BaseMcpWalletClaimUiV1 | null;
}

export interface BaseMcpWalletClaimUiV1 {
  onConfirm: () => void;
  /** From the press until the server has the transactions. */
  busy: boolean;
  /** What is happening now, in words; null at rest. */
  note: string | null;
  error: string | null;
  /** The transactions the wallet reported, linked while they are checked. */
  transactionHashes?: readonly string[];
}

/** Whether this answer holds a Found claim waiting for the page's wallet. */
export function baseMcpWalletClaimReadyV1(answer: Pick<BaseMcpConsoleAnswerV1, 'action' | 'walletCalls'> | null): boolean {
  return Boolean(answer?.action && answer.action.receipt.provider === 'wallet'
    && answer.action.receipt.status === 'approval_required' && answer.walletCalls?.length);
}

/** What a Found card makes public, said before it is made. */
export const FOUND_SHARE_NOTE_V1 =
  'A card shows what arrived (the dollar value when shared, the tokens and the block). It names no wallet and no transaction.';

/** Whether a receipt is a Found claim that completed on its own events. */
export function foundShareableV1(receipt: Pick<BaseMcpActionReceiptUiV1, 'actionType' | 'status' | 'reconciliationState'>): boolean {
  return (receipt.actionType === 'aerodrome_claim' || receipt.actionType === 'uniswap_collect')
    && receipt.status === 'completed' && receipt.reconciliationState === 'matched';
}

export interface BaseMcpQuickExampleV1 {
  prompt: string;
  surface: 'read' | 'action' | 'routable';
  disposition: BaseMcpExampleDispositionUiV1;
}

/** Things a person asks, one of each kind the console answers: reads, a send
 * their wallet approves, and a swap that goes to Swap AI. It used to be
 * seven routing demonstrations, among them a 10x perp, which read as a
 * capability matrix rather than a first screen (operator, 2026-10-04).
 * Every plugin's own examples are still one tap away in the catalogue.
 *
 * Found is here too: the operator could not find it when it lived only
 * under Aerodrome's "More examples" (2026-10-11). It reads Aerodrome and
 * Uniswap at once, and its answer carries each claim and the alert as
 * buttons. */
export const BASE_MCP_QUICK_EXAMPLES_V1: readonly BaseMcpQuickExampleV1[] = [
  { prompt: 'What does my wallet hold?', surface: 'read', disposition: 'read_in_extensions' },
  { prompt: 'What can I claim?', surface: 'read', disposition: 'read_in_extensions' },
  { prompt: 'Show my recent Base transactions', surface: 'read', disposition: 'read_in_extensions' },
  { prompt: 'Send 5 USDC to alice.base.eth', surface: 'action', disposition: 'action_in_extensions' },
  { prompt: 'Swap 100 USDC to ETH', surface: 'routable', disposition: 'handoff_to_routes' },
] as const;

/** Kept as a string projection for existing consumers; labels are always
 * derived from the structured examples above. */
export const BASE_MCP_CONSOLE_PROMPTS_V1: readonly string[] =
  BASE_MCP_QUICK_EXAMPLES_V1.map((example) => example.prompt);

export const BASE_MCP_CONSOLE_INPUT_ID_V1 = 'base-mcp-console-input';

/**
 * The reply is shown as written text, so Markdown arrives as literal marks:
 * "**read-only mode**" on prod, 2026-10-19. Emphasis, heading and inline-code
 * marks are removed and the words stay. A lone asterisk between spaces, as in
 * arithmetic, is not emphasis and stays too.
 */
export function baseMcpPlainReplyV1(reply: string): string {
  return reply
    .replace(/\*\*(?=\S)([^*]+?)\*\*/gu, '$1')
    .replace(/__(?=\S)([^_]+?)__/gu, '$1')
    .replace(/(^|[\s(])\*(?=\S)([^*\n]+?)\*(?=[\s).,;:!?]|$)/gmu, '$1$2')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/`([^`\n]+)`/gu, '$1');
}

/**
 * What the console says about its own outcome.
 *
 * `no_tools` gets its own sentence and never falls back to a model answer. The
 * server refuses to run the LLM with an empty Base MCP inventory, because
 * "Base MCP returned nothing" and "here is what I recall about Base" are
 * different claims and only the first one is true.
 */
/** Found's own readings: Miorail's code, never the model's. */
const FOUND_READ_TOOLS_V1 = new Set(['aerodrome_rewards_read', 'uniswap_fees_read']);

/**
 * A Found reading that could not finish still says what it read and what it
 * did not: "Could not read all of Aerodrome just now (17,375 of 39,256
 * pools), so this is not 'nothing to claim'". Those words are code-owned, so
 * they are shown in place of the generic failure line, which told the operator
 * nothing at all (2026-10-11).
 */
export function baseMcpFoundReadingV1(answer: Pick<BaseMcpConsoleAnswerV1, 'trace' | 'reply'>): boolean {
  return Boolean(answer.reply) && answer.trace.length > 0 && answer.trace.every((row) => FOUND_READ_TOOLS_V1.has(row.tool));
}

export function baseMcpConsoleStatusCopyV1(answer: BaseMcpConsoleAnswerV1 | null): string | null {
  if (!answer) return null;
  if (answer.status === 'failed' && baseMcpFoundReadingV1(answer)) return null;
  // A Found claim that was not prepared says why in reviewed words: what the
  // reading covered and the step that stopped it. Never model text.
  if (answer.status === 'failed' && !answer.action && answer.reply
    && /^(aerodrome|uniswap|found)_/u.test(answer.errorCode ?? '')) return answer.reply;
  // A failed deterministic action can still carry the original immutable
  // receipt (for example, an idempotency conflict). The receipt and its exact
  // error are more useful than the generic console failure copy.
  if (answer.action) return null;
  if (answer.status === 'failed' && answer.errorCode?.startsWith('virtuals_')) {
    const otp = answer.errorCode.startsWith('virtuals_otp_') || answer.trace.some(row => row.tool === 'virtuals_agent_email_extract_otp');
    return answer.errorCode === 'virtuals_session_expired'
      ? `Your Virtuals sign-in expired. Ask “Sign in to Virtuals”, then retry.${otp ? ' Whether the message contains a code was not established.' : ''}`
      : otp ? 'The private Virtuals read could not finish. Whether the message contains a code was not established. Retry; a failed read does not mean there is no code.'
        : 'The private Virtuals read could not finish. No result was established. Retry or sign in again.';
  }
  if (answer.status === 'failed' && [
    'hydrex_positions_invalid_response', 'hydrex_positions_incomplete',
    'hydrex_positions_wallet_mismatch', 'hydrex_positions_duplicate',
  ].includes(answer.errorCode ?? '')) {
    // A reviewed read failure has fixed copy, never provider-supplied text.
    return 'Hydrex’s position list could not be read in full. Your positions were not established. Try again or open Hydrex.';
  }
  switch (answer.status) {
    case 'answered':
    case 'handoff':
    case 'action':
      return null;
    case 'needs_input':
      return answer.reply;
    case 'no_tools':
      return 'Wallet MCP offered no readable tools, so nothing was asked. This is a statement about the connection, not about Base.';
    case 'needs_reauth':
      return 'Your Wallet MCP session expired. Connect again and ask once more.';
    case 'disabled':
      return 'Wallet MCP is switched off on this server.';
    default:
      return 'The console could not complete that. Nothing here is a statement about what Wallet MCP can do.';
  }
}

/** The one-line summary above the trace. */
export function baseMcpConsoleTraceSummaryV1(answer: BaseMcpConsoleAnswerV1): string {
  if (answer.trace.length === 0) {
    return 'No tool was called, so this answer used no Wallet MCP data.';
  }
  // Found is not a Wallet MCP call: Miorail read the chain itself.
  if (answer.trace.every((row) => FOUND_READ_TOOLS_V1.has(row.tool))) {
    const took = answer.elapsedMs ? ` Took ${(answer.elapsedMs / 1000).toFixed(1)}s.` : '';
    return `Read by Miorail from Base itself; no Wallet MCP tool and no provider was called.${took}`;
  }
  const failed = answer.trace.filter((row) => !row.ok).length;
  const calls = `${answer.trace.length} Wallet MCP tool call${answer.trace.length === 1 ? '' : 's'}`;
  const failures = failed > 0 ? `, ${failed} failed` : '';
  // The elapsed time belongs next to the call count, because the call count is
  // the explanation: each one is a round trip to somebody else's server with a
  // model turn on either side.
  const took = answer.elapsedMs ? ` Took ${(answer.elapsedMs / 1000).toFixed(1)}s.` : '';
  return `${calls}${failures}. Everything below came from these, or from nowhere.${took}`;
}

// ---------------------------------------------------------------------------
// ONE way to count a capability on this page.
//
// The header said `8 readable · 4 of 5 requiring approval are released · 1 hand
// off to Swap AI` while the rail beside it said `Readable 8 · Needs your
// approval 7 · Not callable here 0`. Both were computed correctly, from two
// different taxonomies over the same fifteen tools: the rail grouped them by
// SAFETY CLASS (may this be called without approval), the header by ROUTING
// (where does this intent finish). A reader has no way to know that, and sees
// 7 next to 5 and concludes one of them is wrong.
//
// Routing wins, because it is the one a person can act on. Safety class is a
// property of our permission model; routing is the answer to "what happens if I
// ask for this". Both surfaces read `baseMcpCapabilityTallyV1` now, so the two
// numbers cannot disagree again — there is only one.
// ---------------------------------------------------------------------------

export interface BaseMcpCapabilityTallyV1 {
  label: string;
  count: number;
  /** The words after the number in the header sentence, for one and for more. */
  one: string;
  many: string;
}

export interface BaseMcpRoutingCountsV1 {
  read: number;
  action: number;
  routable: number;
  blocked: number;
  releasedActions: number;
}

/**
 * The five mutually exclusive buckets, in reading order. Rows with a zero count
 * are dropped by the caller that renders a list, and kept by the caller that
 * renders a sentence only when they are non-zero — an empty bucket is not a
 * finding.
 */
export function baseMcpCapabilityTallyV1(
  routing: BaseMcpRoutingCountsV1 | null | undefined,
): readonly BaseMcpCapabilityTallyV1[] {
  if (!routing) return [];
  const actionsBlocked = Math.max(0, routing.action - routing.releasedActions);
  return [
    { label: 'Reads', count: routing.read, one: 'read', many: 'reads' },
    { label: 'Actions ready', count: routing.releasedActions, one: 'action ready', many: 'actions ready' },
    {
      label: 'Actions needing an adapter',
      count: actionsBlocked,
      one: 'action needing an adapter',
      many: 'actions needing an adapter',
    },
    { label: 'Swap AI handoffs', count: routing.routable, one: 'Swap AI handoff', many: 'Swap AI handoffs' },
    { label: 'Not callable here', count: routing.blocked, one: 'not callable here', many: 'not callable here' },
  ];
}

/**
 * The same tally as one line. Null counts mean the tool list has not been read,
 * and that is said as a sentence rather than as an em-dash standing in for a
 * number.
 */
export function baseMcpToolSummaryV1(model: {
  routing?: BaseMcpRoutingCountsV1 | null;
}): string {
  const tally = baseMcpCapabilityTallyV1(model.routing);
  if (tally.length === 0) return 'tool list not read yet';
  const parts = tally
    .filter((entry) => entry.count > 0)
    // In the sentence's own words: lowercasing the rail's label printed
    // "1 routes ai handoffs".
    .map((entry) => `${entry.count} ${entry.count === 1 ? entry.one : entry.many}`);
  return parts.length > 0 ? parts.join(' · ') : 'no callable tools';
}

// ---------------------------------------------------------------------------
// When the answer names a missing field, the input asks for THAT field.
//
// "Paste the Base token contract address (0x…)" is a good answer — honest,
// specific, and it refuses to resolve a symbol on the user's behalf because two
// tokens can share one. It is followed by an input box that still says "Ask
// Base MCP to read or act…", so the reader has to carry the requirement from
// the answer to the box themselves.
//
// Keyed off the ERROR CODE, not the prose: the code is the contract between the
// reviewed read and this surface, and matching on sentences would break the
// first time somebody improved the wording.
// ---------------------------------------------------------------------------
const MISSING_INPUT_PLACEHOLDER_V1: Readonly<Record<string, string>> = {
  gmgn_token_address_required: '0x… Base token contract address',
  printr_token_id_required: 'Printr token id from the launch',
  bankr_token_address_required: '0x… Base token address',
  opensea_token_required: '0x… NFT contract address and token id',
  virtuals_otp_facts_required: 'Virtuals OTP status for agent ID… message ID…',
};

export function baseMcpInputPlaceholderV1(answer: BaseMcpConsoleAnswerV1 | null): string {
  const named = answer?.errorCode ? MISSING_INPUT_PLACEHOLDER_V1[answer.errorCode] : undefined;
  return named ?? 'Ask your wallet to read or act…';
}

export function BaseMcpConsoleCard(model: BaseMcpConsoleModelV1) {
  const answer = model.answer;
  const statusCopy = baseMcpConsoleStatusCopyV1(answer);
  // A failed call is not supporting material — it is the reason the answer says
  // what it says, so it never goes behind a fold.
  const failedRows = (answer?.trace ?? []).filter((row) => !row.ok);
  const canAsk = model.question.trim().length > 0 && !model.pending && !model.disabledReason;

  return (
    <div className="rp">
      <div className="rph">
        <b>Ask Wallet MCP</b>
        {/* This read `— READ · — ACTION` before the tool list was fetched:
            machine words, and two em-dashes where a reader expects a count.
            The rail beside it was already saying the same numbers in words a
            person uses, so the two now agree and only the header is shorter.
            A visitor has no tool list to wait for, so the header says what
            the sentence under it says instead of "tool list not read yet". */}
        <span className="rt">
          {model.onSignIn ? 'sign in to ask' : baseMcpToolSummaryV1({ routing: model.routing })}
        </span>
      </div>
      <div className="rpb">
        <p className="lnote">
          Ask your Coinbase Wallet in plain words. A read is answered here; sending money opens your
          wallet for approval; a swap goes to Swap AI to compare routes first. Miorail never signs.
        </p>
        {model.disabledReason && <p className="empty">{model.disabledReason}</p>}

        <textarea
          id={BASE_MCP_CONSOLE_INPUT_ID_V1}
          className="goalinput"
          rows={2}
          value={model.question}
          placeholder={baseMcpInputPlaceholderV1(answer)}
          onChange={(event) => model.onQuestionChange(event.target.value)}
        />
        <div className="ctarow">
          {model.onSignIn ? (
            <button type="button" className="btn" onClick={model.onSignIn}>
              Sign in to ask
            </button>
          ) : (
            <button type="button" className="btn" onClick={model.onAsk} disabled={!canAsk}>
              {model.pending ? 'Working…' : 'Ask'}
            </button>
          )}
          {model.onConnect && answer?.status === 'needs_reauth' && (
            <button type="button" className="btn sec" onClick={model.onConnect}>
              Connect Wallet MCP
            </button>
          )}
        </div>
        <div className="mcp-quick-head">
          <b>Try</b>
          <span>fills the box — nothing runs until you ask</span>
        </div>
        <div className="mcp-quick-examples">
          {BASE_MCP_QUICK_EXAMPLES_V1.map((example) => {
            const badge = baseMcpExampleBadgeV1(example);
            return (
            <button
              key={example.prompt}
              type="button"
              className="mcp-example"
              disabled={model.pending}
              title="Fills the box — nothing runs until you ask"
              onClick={() => selectBaseMcpExampleV1(model.onQuestionChange, example.prompt)}
            >
              <span className={`mcp-disposition ${badge.tone}`}>{badge.label}</span>
              <span>{example.prompt}</span>
            </button>
            );
          })}
        </div>

        {model.unavailableReason ? (
          <p className="empty">{model.unavailableReason}</p>
        ) : model.pending ? (
          <p className="empty">Working with Wallet MCP…</p>
        ) : !answer ? (
          <p className="empty">Nothing asked yet.</p>
        ) : (
          <>
            {statusCopy && <p className="empty">{statusCopy}</p>}

            {answer.status === 'handoff' && answer.handoff && (
              <div>
                <div className="qrow">
                  <span className="pill br">Swap AI</span>
                  <span className="v">
                    {answer.handoff.target === 'routes' ? 'Swap AI' : 'Avantis'}
                  </span>
                </div>
                <p className="lnote">{answer.reply}</p>
                {answer.handoff.summary && <p className="note warn">{answer.handoff.summary}</p>}
                {answer.handoff.target === 'routes' && model.onOpenRoutes && (
                  <div className="ctarow">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => model.onOpenRoutes?.(answer.handoff!.originalMessage)}
                    >
                      Open Swap AI
                    </button>
                  </div>
                )}
                {answer.handoff.target === 'provider' && (
                  <div className="ctarow">
                    <a className="btn" href={answer.handoff.path} target="_blank" rel="noopener noreferrer">
                      Continue in Avantis
                    </a>
                  </div>
                )}
              </div>
            )}

            {answer.action && (
              <div>
                <div className="qrow">
                  <span className={`pill ${answer.action.receipt.status === 'completed' ? 'g' : answer.action.receipt.status === 'failed' || answer.action.receipt.status === 'rejected' ? 'n' : 'a'}`}>
                    {answer.action.receipt.status}
                  </span>
                  <span className="v">Action Receipt</span>
                </div>
                {answer.action.receipt.actionType === 'send' ? (
                  <>
                    <div className="qrow">
                      <span>Send</span>
                      <span className="v mono">{answer.action.receipt.amount} {answer.action.receipt.asset.symbol}</span>
                    </div>
                    <div className="qrow">
                      <span>To</span>
                      <span className="v mono">
                        {answer.action.receipt.recipientName ?? answer.action.receipt.recipient}
                      </span>
                    </div>
                    {answer.action.receipt.recipientName && (
                      <div className="qrow">
                        <span>Resolved Base address</span>
                        <span className="v mono">{answer.action.receipt.recipient}</span>
                      </div>
                    )}
                  </>
                ) : answer.action.receipt.actionType === 'x402' ? (
                  <>
                    <div className="qrow">
                      <span>x402 GET cap</span>
                      <span className="v mono">{answer.action.receipt.maxPayment} USDC</span>
                    </div>
                    <p className="lnote mono">{answer.action.receipt.url}</p>
                  </>
                ) : answer.action.receipt.actionType === 'aerodrome_claim' ? (
                  <>
                    <div className="qrow"><span>Aerodrome fees and AERO</span><span className="v mono">{answer.action.receipt.claimCount} claims</span></div>
                    <div className="qrow"><span>Recipient</span><span className="v mono">{answer.action.receipt.recipient}</span></div>
                    <div className="qrow"><span>Pools read</span><span className="v mono">{answer.action.receipt.poolsRead} / {answer.action.receipt.poolsTotal}</span></div>
                    <div className="qrow"><span>Batch simulation</span><span className="v">{answer.action.receipt.simulationStatus}</span></div>
                    {answer.action.receipt.managedSkipped > 0 && <p className="lnote">{answer.action.receipt.managedSkipped} managed or locked positions excluded.</p>}
                  </>
                ) : answer.action.receipt.actionType === 'uniswap_collect' ? (
                  <>
                    <div className="qrow"><span>Uniswap v3 fees</span><span className="v mono">{answer.action.receipt.positionCount} position{answer.action.receipt.positionCount === 1 ? '' : 's'}</span></div>
                    <div className="qrow"><span>Recipient</span><span className="v mono">{answer.action.receipt.recipient}</span></div>
                    <div className="qrow"><span>Positions read</span><span className="v mono">{answer.action.receipt.positionsHeld}</span></div>
                    <div className="qrow"><span>Batch simulation</span><span className="v">{answer.action.receipt.simulationStatus}</span></div>
                  </>
                ) : (
                  <>
                    <div className="qrow">
                      <span>Virtuals action</span>
                      <span className="v">{answer.action.receipt.operation === 'sign_in' ? 'Sign in' : 'Create agent'}</span>
                    </div>
                    {answer.action.receipt.operation === 'agent_create' ? (
                      <>
                        <div className="qrow">
                          <span>Agent</span>
                          <span className="v">{answer.action.receipt.agentName}</span>
                        </div>
                        <p className="lnote">{answer.action.receipt.agentDescription}</p>
                      </>
                    ) : null}
                    {answer.action.receipt.providerObjectId && (
                      <p className="lnote mono">agent ID {answer.action.receipt.providerObjectId}</p>
                    )}
                  </>
                )}
                <div className="qrow">
                  <span>Network</span>
                  <span className="v">Base</span>
                </div>
                <div className="qrow">
                  <span>Sent by</span>
                  <span className="v">{answer.action.receipt.provider === 'wallet' ? 'Your wallet' : 'Wallet MCP'}</span>
                </div>
                <div className="qrow">
                  <span>Reconciliation</span>
                  <span className="v mono">{answer.action.receipt.reconciliationState}</span>
                </div>
                {answer.reply && <p className="lnote">{answer.reply}</p>}
                {answer.action.resultPreview && (
                  <pre className="mono aitext">{answer.action.resultPreview}</pre>
                )}
                {/* Found's claim, sent from the wallet on this page: one press,
                    one wallet prompt, and nothing sent again on its own. */}
                {baseMcpWalletClaimReadyV1(answer) && model.walletClaim && (
                  <div className="ctarow">
                    <button
                      type="button"
                      className="btn"
                      disabled={model.walletClaim.busy}
                      onClick={model.walletClaim.onConfirm}
                    >
                      {model.walletClaim.busy ? 'Waiting for your wallet…' : 'Confirm in your wallet'}
                    </button>
                  </div>
                )}
                {answer.action.receipt.provider === 'wallet' && model.walletClaim?.note && (
                  <p className="lnote">{model.walletClaim.note}</p>
                )}
                {answer.action.receipt.provider === 'wallet' && model.walletClaim?.error && (
                  <p className="note warn">{model.walletClaim.error}</p>
                )}
                {answer.action.receipt.provider === 'wallet' && !answer.action.receipt.transactionHash
                  && (model.walletClaim?.transactionHashes?.length ?? 0) > 0 && (
                  <p className="lnote">
                    sent{' '}
                    {model.walletClaim!.transactionHashes!.map((hash, index) => (
                      <span key={hash}>
                        {index > 0 ? ', ' : ''}
                        <a className="mono" href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noopener noreferrer">
                          {hash.slice(0, 10)}…
                        </a>
                      </span>
                    ))}
                  </p>
                )}
                <div className="ctarow">
                  {answer.action.approvalUrl && (
                    <a
                      className="btn"
                      href={answer.action.approvalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {answer.action.receipt.actionType === 'virtuals' ? 'Approve Sign-In' : 'Approve in your wallet'}
                    </a>
                  )}
                  {model.onReconcileAction && !['completed', 'failed', 'rejected'].includes(answer.action.receipt.status)
                    // A claim still waiting for this page's wallet has nothing on Base to check.
                    && !(answer.action.receipt.provider === 'wallet' && answer.action.receipt.status === 'approval_required') && (
                    <button
                      type="button"
                      className="btn sec"
                      disabled={model.reconcilingAction}
                      onClick={() => model.onReconcileAction?.(answer.action!.receipt.id)}
                    >
                      {model.reconcilingAction ? 'Checking…' : 'Check status'}
                    </button>
                  )}
                </div>
                {/* A completed claim or collect can become a card to post.
                    Made by this click and never before; the note says what
                    it shows before anything is made. */}
                {foundShareableV1(answer.action.receipt) && (model.share ? (
                  <div className="found-share">
                    <p className="lnote">Your card is ready: {model.share.url}</p>
                    <div className="ctarow">
                      <ShareLinkV1 className="btn" href={giftShareLinksV1(model.share).x}>Post on X</ShareLinkV1>
                      <ShareLinkV1 className="btn sec" href={giftShareLinksV1(model.share).farcaster}>Cast on Farcaster</ShareLinkV1>
                    </div>
                  </div>
                ) : model.onShareAction ? (
                  <div className="found-share">
                    <p className="lnote">{FOUND_SHARE_NOTE_V1}</p>
                    <div className="ctarow">
                      <button
                        type="button"
                        className="btn"
                        disabled={model.sharing}
                        onClick={() => model.onShareAction?.(answer.action!.receipt.id)}
                      >
                        {model.sharing ? 'Making the card…' : 'Make a share card'}
                      </button>
                    </div>
                    {model.shareError && <p className="note warn">{model.shareError}</p>}
                  </div>
                ) : null)}
                {answer.action.receipt.transactionHash && (
                  <p className="lnote">
                    tx{' '}
                    <a
                      className="mono"
                      href={`https://basescan.org/tx/${answer.action.receipt.transactionHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {answer.action.receipt.transactionHash}
                    </a>
                    {answer.action.receipt.blockNumber ? ` · block ${answer.action.receipt.blockNumber}` : ''}
                  </p>
                )}
                {answer.action.receipt.provider === 'wallet' ? (
                  <p className="note warn">
                    Sent from your own wallet, not Wallet MCP. Miorail wrote these calls from its own reading,
                    checked each one and simulated them together; the claim counts only when Base&apos;s events
                    pay this wallet for every one. This is not a Miorail verified route.
                  </p>
                ) : (
                  <p className="note warn">
                    Wallet MCP action — capability policy passed and your wallet&apos;s approval is
                    required. Send is reconciled against exact onchain transfer facts; x402 is confirmed
                    by the paid endpoint response and stored only as a hash. This is not a Miorail verified route.
                  </p>
                )}
              </div>
            )}

            {(answer.status === 'answered' || (answer.status === 'failed' && baseMcpFoundReadingV1(answer))) && (
              <>
                <div className="qrow">
                  <span className={`pill ${answer.status === 'failed' ? 'n' : answer.trace.length > 0 ? 'g' : 'n'}`}>
                    {answer.status === 'failed' ? 'not read in full' : answer.trace.length > 0 ? 'answered from tools' : 'no tool used'}
                  </span>
                  <span className="v mono">{answer.trace.length}</span>
                </div>
                <p className="lnote">{baseMcpConsoleTraceSummaryV1(answer)}</p>

                {answer.reply ? (
                  <pre className="mono aitext">{baseMcpPlainReplyV1(answer.reply)}</pre>
                ) : (
                  <p className="empty">Wallet MCP returned tool results but no written answer.</p>
                )}

                {/* The answer names what to ask next; these are those exact
                    phrases, so nobody has to retype "Claim my Aerodrome
                    fees" from the text above. They fill the box, like every
                    example on this page. */}
                {answer.next && answer.next.length > 0 && (
                  <>
                    <div className="mcp-quick-head">
                      <b>Next</b>
                      <span>fills the box — nothing runs until you ask</span>
                    </div>
                    <div className="mcp-quick-examples">
                      {answer.next.map((item) => {
                        const badge = baseMcpNextBadgeV1(item.kind);
                        return (
                          <button
                            key={item.prompt}
                            type="button"
                            className="mcp-example"
                            disabled={model.pending}
                            title="Fills the box — nothing runs until you ask"
                            onClick={() => selectBaseMcpExampleV1(model.onSelectNext ?? model.onQuestionChange, item.prompt)}
                          >
                            <span className={`mcp-disposition ${badge.tone}`}>{badge.label}</span>
                            <span>{item.prompt}</span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}

                {answer.truncated && (
                  <p className="note warn">
                    The tool budget for one question ran out, so this stopped part-way. It is not a
                    finished answer.
                  </p>
                )}

                {/* The next step, when there is an honest one. It sits under
                    the answer and above the evidence: Miorail keeps the finding,
                    and the provider's own interface is where a reader goes to
                    act on it. */}
                {answer.cta && (
                  <p className="mcp-cta">
                    <a className="btn sec" href={answer.cta.url} target="_blank" rel="noopener noreferrer">
                      {answer.cta.label} ↗
                    </a>
                  </p>
                )}

                {/* Evidence stays; it stops dominating.
                    The written answer used to be followed immediately by every
                    tool's raw payload — on Venice that is a serialized model
                    catalogue that fills half a screen and buries the sentence
                    the reader came for. Nothing is dropped and nothing moves
                    behind a debug flag: both folds sit directly under the
                    answer, one click from open, and a FAILED call stays open
                    because a failure is part of the answer rather than
                    supporting material for it. */}
                {answer.trace.length > 0 && (
                  <>
                    {failedRows.length > 0 && (
                      <div className="mcp-evidence-open">
                        {failedRows.map((row, index) => (
                          <div key={`failed-${row.tool}-${index}`}>
                            <div className="qrow">
                              <span className="mono">{row.tool}</span>
                              <span className="pill n">{row.errorCode || 'failed'}</span>
                            </div>
                            <p className="lnote">{row.result}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    <details className="mcp-tech">
                      <summary>Tool evidence ({answer.trace.length})</summary>
                      {answer.trace.map((row, index) => (
                        <div key={`${row.tool}-${index}`}>
                          <div className="qrow">
                            <span className="mono">{row.tool}</span>
                            <span className={`pill ${row.ok ? 'g' : 'n'}`}>
                              {row.ok ? 'ok' : row.errorCode || 'failed'}
                            </span>
                          </div>
                          <p className="lnote">{row.args}</p>
                        </div>
                      ))}
                    </details>
                    <details className="mcp-tech">
                      <summary>Raw provider response</summary>
                      {answer.trace.map((row, index) => (
                        <p className="lnote mcp-raw" key={`raw-${row.tool}-${index}`}>
                          {row.result}
                        </p>
                      ))}
                    </details>
                  </>
                )}
              </>
            )}
          </>
        )}

        <p className="lnote">
          Coinbase does not operate, endorse or audit the plugins behind these tools, and neither
          does Miorail. Swaps and deposits go to Swap AI, which compares routes first.
        </p>
      </div>
    </div>
  );
}
