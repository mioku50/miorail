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
  readTools?: number;
  actionTools?: number;
  releasedActionTools?: number;
  routableTools?: number;
}

/** Openers that demonstrate each deterministic disposition: read, exact
 * extension action, provider handoff and Routes handoff. */
export const BASE_MCP_CONSOLE_PROMPTS_V1: readonly string[] = [
  'What does my Base Account hold?',
  'Show my recent Base transactions',
  'Send 5 USDC to alice.base.eth',
  'Pay x402 GET https://api.venice.ai/api/v1/models, max 0.10 USDC',
  'Show my open Avantis positions and PnL',
  'Open a 10x long BTC/USD with 100 USDC on Avantis',
  'Swap 100 USDC to ETH',
];

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

/**
 * The tool counts, in the words the rail beside this card already uses.
 *
 * Null counts mean the tool list has not been read, and that is said as a
 * sentence rather than as an em-dash standing in for a number.
 */
export function baseMcpToolSummaryV1(model: {
  readTools?: number;
  actionTools?: number;
  releasedActionTools?: number;
  routableTools?: number;
}): string {
  if (model.readTools === undefined && model.actionTools === undefined) {
    return 'tool list not read yet';
  }
  const parts: string[] = [];
  if (model.readTools !== undefined) parts.push(`${model.readTools} readable`);
  if (model.actionTools !== undefined) {
    parts.push(
      model.releasedActionTools === undefined
        ? `${model.actionTools} require approval`
        : `${model.releasedActionTools} of ${model.actionTools} requiring approval are released`,
    );
  }
  if (model.routableTools) parts.push(`${model.routableTools} hand off to Routes AI`);
  return parts.join(' · ');
}

export function BaseMcpConsoleCard(model: BaseMcpConsoleModelV1) {
  const answer = model.answer;
  const statusCopy = baseMcpConsoleStatusCopyV1(answer);
  const canAsk = model.question.trim().length > 0 && !model.pending;

  return (
    <div className="rp">
      <div className="rph">
        <b>Base MCP Extensions</b>
        {/* This read `— READ · — ACTION` before the tool list was fetched:
            machine words, and two em-dashes where a reader expects a count.
            The rail beside it was already saying the same numbers in words a
            person uses, so the two now agree and only the header is shorter. */}
        <span className="rt">{baseMcpToolSummaryV1(model)}</span>
      </div>
      <div className="rpb">
        <p className="lnote">
          AI Console — Base MCP capabilities. Reads stay here, direct actions require an explicit
          Base Account approval, and routable intents move to Routes AI for comparison and Safety
          Kernel checks.
        </p>

        <textarea
          className="goalinput"
          rows={2}
          value={model.question}
          placeholder="Ask Base MCP to read or act…"
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
        <div className="ctarow">
          {BASE_MCP_CONSOLE_PROMPTS_V1.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="btn sec"
              disabled={model.pending}
              onClick={() => model.onQuestionChange(prompt)}
            >
              {prompt}
            </button>
          ))}
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
                ) : (
                  <>
                    <div className="qrow">
                      <span>x402 GET cap</span>
                      <span className="v mono">{answer.action.receipt.maxPayment} USDC</span>
                    </div>
                    <p className="lnote mono">{answer.action.receipt.url}</p>
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
                      Approve in Base Account
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

                {answer.trace.map((row, index) => (
                  <div key={`${row.tool}-${index}`}>
                    <div className="qrow">
                      <span className="mono">{row.tool}</span>
                      <span className={`pill ${row.ok ? 'g' : 'n'}`}>
                        {row.ok ? 'ok' : row.errorCode || 'failed'}
                      </span>
                    </div>
                    <p className="lnote">{row.args}</p>
                    <p className="lnote">{row.result}</p>
                  </div>
                ))}
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
