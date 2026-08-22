import React from 'react';
import {
  baseMcpExampleBadgeV1,
  selectBaseMcpExampleV1,
  type BaseMcpExampleDispositionUiV1,
} from './BaseMcpPluginsCard';

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
  provider: 'base-mcp';
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
      actionType: 'send';
      asset: { symbol: 'USDC'; address: string; decimals: 6 };
      amount: string;
      recipient: string;
      recipientName?: string | null;
      reconciliationBasis: 'erc20_transfer_event';
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
      operation: 'agent_create';
      agentName: string;
      agentDescription: string;
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
   * swap finishes in Routes AI, and offering "go do it on Aerodrome" because
   * our own simulator fell short hands the user our unfinished work.
   */
  cta?: { label: string; url: string } | null;
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
}

export interface BaseMcpQuickExampleV1 {
  prompt: string;
  surface: 'read' | 'action' | 'routable';
  disposition: BaseMcpExampleDispositionUiV1;
}

/** Seven routing demonstrations, separate from the plugin catalogue. The
 * Venice public model list is a READ; presenting it as a paid x402 GET caused
 * production to wait for a durable request ID that this endpoint never owed. */
export const BASE_MCP_QUICK_EXAMPLES_V1: readonly BaseMcpQuickExampleV1[] = [
  { prompt: 'What does my Base Account hold?', surface: 'read', disposition: 'read_in_extensions' },
  { prompt: 'Show my recent Base transactions', surface: 'read', disposition: 'read_in_extensions' },
  { prompt: 'Send 5 USDC to alice.base.eth', surface: 'action', disposition: 'action_in_extensions' },
  { prompt: 'Show the models available from Venice AI', surface: 'read', disposition: 'read_in_extensions' },
  { prompt: 'Show my open Avantis positions and PnL', surface: 'read', disposition: 'read_in_extensions' },
  { prompt: 'Open a 10x long BTC/USD with 100 USDC on Avantis', surface: 'action', disposition: 'handoff_to_provider_ui' },
  { prompt: 'Swap 100 USDC to ETH', surface: 'routable', disposition: 'handoff_to_routes' },
] as const;

/** Kept as a string projection for existing consumers; labels are always
 * derived from the structured examples above. */
export const BASE_MCP_CONSOLE_PROMPTS_V1: readonly string[] =
  BASE_MCP_QUICK_EXAMPLES_V1.map((example) => example.prompt);

export const BASE_MCP_CONSOLE_INPUT_ID_V1 = 'base-mcp-console-input';

/**
 * What the console says about its own outcome.
 *
 * `no_tools` gets its own sentence and never falls back to a model answer. The
 * server refuses to run the LLM with an empty Base MCP inventory, because
 * "Base MCP returned nothing" and "here is what I recall about Base" are
 * different claims and only the first one is true.
 */
export function baseMcpConsoleStatusCopyV1(answer: BaseMcpConsoleAnswerV1 | null): string | null {
  if (!answer) return null;
  // A failed deterministic action can still carry the original immutable
  // receipt (for example, an idempotency conflict). The receipt and its exact
  // error are more useful than the generic console failure copy.
  if (answer.action) return null;
  switch (answer.status) {
    case 'answered':
    case 'handoff':
    case 'action':
      return null;
    case 'needs_input':
      return answer.reply;
    case 'no_tools':
      return 'Base MCP offered no readable tools, so nothing was asked. This is a statement about the connection, not about Base.';
    case 'needs_reauth':
      return 'Your Base MCP session expired. Connect again and ask once more.';
    case 'disabled':
      return 'Base MCP is switched off on this server.';
    default:
      return 'The console could not complete that. Nothing here is a statement about what Base MCP can do.';
  }
}

/** The one-line summary above the trace. */
export function baseMcpConsoleTraceSummaryV1(answer: BaseMcpConsoleAnswerV1): string {
  if (answer.trace.length === 0) {
    return 'No tool was called, so this answer used no Base MCP data.';
  }
  const failed = answer.trace.filter((row) => !row.ok).length;
  const calls = `${answer.trace.length} Base MCP tool call${answer.trace.length === 1 ? '' : 's'}`;
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
// off to Routes AI` while the rail beside it said `Readable 8 · Needs your
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
    { label: 'Reads', count: routing.read },
    { label: 'Actions ready', count: routing.releasedActions },
    { label: 'Actions needing an adapter', count: actionsBlocked },
    { label: 'Routes AI handoffs', count: routing.routable },
    { label: 'Not callable here', count: routing.blocked },
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
    .map((entry) => `${entry.count} ${entry.label.toLowerCase()}`);
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
};

export function baseMcpInputPlaceholderV1(answer: BaseMcpConsoleAnswerV1 | null): string {
  const named = answer?.errorCode ? MISSING_INPUT_PLACEHOLDER_V1[answer.errorCode] : undefined;
  return named ?? 'Ask Base MCP to read or act…';
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
        <b>Base MCP Extensions</b>
        {/* This read `— READ · — ACTION` before the tool list was fetched:
            machine words, and two em-dashes where a reader expects a count.
            The rail beside it was already saying the same numbers in words a
            person uses, so the two now agree and only the header is shorter. */}
        <span className="rt">{baseMcpToolSummaryV1({ routing: model.routing })}</span>
      </div>
      <div className="rpb">
        <p className="lnote">
          AI Console — Base MCP capabilities. Reads stay here, direct actions require an explicit
          Base Account approval, and routable intents move to Routes AI for comparison and Safety
          Kernel checks.
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
          <button type="button" className="btn" onClick={model.onAsk} disabled={!canAsk}>
            {model.pending ? 'Working…' : 'Ask Base MCP'}
          </button>
          {model.onConnect && answer?.status === 'needs_reauth' && (
            <button type="button" className="btn sec" onClick={model.onConnect}>
              Connect Base Account
            </button>
          )}
        </div>
        <div className="mcp-quick-head">
          <b>Quick examples</b>
          <span>routing demonstrations — the full plugin catalogue is below</span>
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
              title="Fill the console — this does not execute the prompt"
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
          <p className="empty">Working with Base MCP…</p>
        ) : !answer ? (
          <p className="empty">Nothing asked yet.</p>
        ) : (
          <>
            {statusCopy && <p className="empty">{statusCopy}</p>}

            {answer.status === 'handoff' && answer.handoff && (
              <div>
                <div className="qrow">
                  <span className="pill br">ROUTABLE</span>
                  <span className="v">
                    {answer.handoff.target === 'routes' ? 'Routes AI' : 'Avantis'}
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
                      Open Routes AI
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
                      <span className="v mono">{answer.action.receipt.amount} USDC</span>
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
                ) : (
                  <>
                    <div className="qrow">
                      <span>Virtuals action</span>
                      <span className="v mono">agent_create</span>
                    </div>
                    <div className="qrow">
                      <span>Agent</span>
                      <span className="v">{answer.action.receipt.agentName}</span>
                    </div>
                    <p className="lnote">{answer.action.receipt.agentDescription}</p>
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
                  <span>Provider</span>
                  <span className="v">Base MCP</span>
                </div>
                <div className="qrow">
                  <span>Reconciliation</span>
                  <span className="v mono">{answer.action.receipt.reconciliationState}</span>
                </div>
                {answer.reply && <p className="lnote">{answer.reply}</p>}
                {answer.action.resultPreview && (
                  <pre className="mono aitext">{answer.action.resultPreview}</pre>
                )}
                <div className="ctarow">
                  {answer.action.approvalUrl && (
                    <a
                      className="btn"
                      href={answer.action.approvalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {answer.action.receipt.actionType === 'virtuals' ? 'Approve Sign-In' : 'Approve in Base Account'}
                    </a>
                  )}
                  {model.onReconcileAction && !['completed', 'failed', 'rejected'].includes(answer.action.receipt.status) && (
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
                <p className="note warn">
                  Base MCP extension action — capability policy passed and Base Account approval is
                  required. Send is reconciled against exact onchain transfer facts; x402 is confirmed
                  by the paid endpoint response and stored only as a hash. This is not a Miorail verified route.
                </p>
              </div>
            )}

            {answer.status === 'answered' && (
              <>
                <div className="qrow">
                  <span className={`pill ${answer.trace.length > 0 ? 'g' : 'n'}`}>
                    {answer.trace.length > 0 ? 'answered from tools' : 'no tool used'}
                  </span>
                  <span className="v mono">{answer.trace.length}</span>
                </div>
                <p className="lnote">{baseMcpConsoleTraceSummaryV1(answer)}</p>

                {answer.reply ? (
                  <pre className="mono aitext">{answer.reply}</pre>
                ) : (
                  <p className="empty">Base MCP returned tool results but no written answer.</p>
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
          Base does not operate, endorse or audit the plugins behind these tools, and Miorail does
          not either. Swap and yield intents always go to Routes AI. A direct extension action is
          shown as an Action Receipt and never as a Route Proof.
        </p>
      </div>
    </div>
  );
}
