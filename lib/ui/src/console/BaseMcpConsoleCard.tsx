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
// What the card can never render, because the server never produces it: an
// approval URL, a prepared transaction, a Route Card, a clearance. This
// surface reads.
// ---------------------------------------------------------------------------

export interface BaseMcpConsoleTraceRowV1 {
  tool: string;
  args: string;
  ok: boolean;
  result: string;
  errorCode: string | null;
}

export type BaseMcpConsoleStatusV1 = 'answered' | 'no_tools' | 'needs_reauth' | 'disabled' | 'failed';

export interface BaseMcpConsoleAnswerV1 {
  status: BaseMcpConsoleStatusV1;
  reply: string | null;
  trace: readonly BaseMcpConsoleTraceRowV1[];
  toolsAvailable: number;
  truncated: boolean;
  errorCode: string | null;
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
}

/** Openers that exercise Base MCP and nothing else — no route, no swap. A chip
 * that asked for a swap would advertise a capability this console refuses. */
export const BASE_MCP_CONSOLE_PROMPTS_V1: readonly string[] = [
  'What can you read with Base MCP right now?',
  'What does my Base Account hold?',
  'Which Base MCP tools did you just use?',
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
  switch (answer.status) {
    case 'answered':
      return null;
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
  return `${calls}${failures}. Everything below came from these, or from nowhere.`;
}

export function BaseMcpConsoleCard(model: BaseMcpConsoleModelV1) {
  const answer = model.answer;
  const statusCopy = baseMcpConsoleStatusCopyV1(answer);
  const canAsk = model.question.trim().length > 0 && !model.pending;

  return (
    <div className="rp">
      <div className="rph">
        <b>Base MCP console</b>
        {answer && <span className="rt mono">{answer.toolsAvailable} tools</span>}
      </div>
      <div className="rpb">
        <p className="lnote">
          This console reaches Base MCP and nothing else. Miorail’s own routers are not connected to
          it, so an answer here is never a verified route — and every tool it can use is read-only,
          so nothing here can reach your wallet.
        </p>

        <textarea
          className="goalinput"
          rows={2}
          value={model.question}
          placeholder="Ask something Base MCP can read…"
          onChange={(event) => model.onQuestionChange(event.target.value)}
        />
        <div className="ctarow">
          <button type="button" className="btn" onClick={model.onAsk} disabled={!canAsk}>
            {model.pending ? 'Asking…' : 'Ask Base MCP'}
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
          <p className="empty">Asking Base MCP…</p>
        ) : !answer ? (
          <p className="empty">Nothing asked yet.</p>
        ) : (
          <>
            {statusCopy && <p className="empty">{statusCopy}</p>}

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
          not either. Swaps, sends and anything that needs signing stay in Routes, where they get a
          Route Card and your Base Account confirmation.
        </p>
      </div>
    </div>
  );
}
