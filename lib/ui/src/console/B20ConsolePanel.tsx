import React, { useState } from 'react';

// The app bundlers use the automatic JSX runtime and need no import; the test
// runner compiles this same file with the classic transform and emits
// React.createElement. Without the reference the panel builds fine and is
// unrenderable by the suite that proves it renders.
void React;

// ---------------------------------------------------------------------------
// Stage 07 — the global console.
//
// The per-card copilot answers about one measurement a reader is already
// looking at. This answers about the universe, and the difference that matters
// on screen is what it can be held to: there is no observation to pin, so the
// panel shows WHAT WAS READ beside every answer. A count with no denominator
// and no read behind it is the shape this product's worst bugs have taken.
//
// The three scopes are not a filter and not a mode. They are three different
// questions — how does the universe look, what is true of these tokens, what
// changed — and each one reads different rows. The scope the server ANSWERED
// in is what labels the panel, because an address in the question moves the
// answer to that token whichever tab is open.
// ---------------------------------------------------------------------------

export const B20_CONSOLE_SCOPES_V1 = ['explore', 'investigate', 'changes', 'portfolio'] as const;
export type B20ConsoleScopeViewV1 = (typeof B20_CONSOLE_SCOPES_V1)[number];

export const B20_CONSOLE_SCOPE_COPY_V1: Readonly<
  Record<B20ConsoleScopeViewV1, { label: string; blurb: string; prompts: readonly string[] }>
> = {
  explore: {
    label: 'Explore',
    blurb: 'Counts across every B20 launch Miorail measured in the last 48 hours.',
    // Written the way a reader would ask, not the way the schema is spelled.
    // The matcher no longer needs "both routes" or "coverage" — those were
    // Miorail's words for its own fields, and a reader had no way to guess them.
    prompts: [
      'How many launches were measured?',
      'Which tokens were bought but a sale could not be priced?',
      'Which launches need more evidence, and why?',
      'What is worth looking at?',
    ],
  },
  investigate: {
    label: 'Investigate',
    blurb: 'One to five named tokens, side by side — and a refusal to rank them when they were not measured the same way.',
    prompts: ['What was measured here?', 'What evidence is missing?', 'How do these compare?'],
  },
  changes: {
    label: 'Changes',
    blurb: 'The same token measured twice, about 24 hours apart. Two quotes Miorail took itself, divided.',
    prompts: ['What changed in the last day?', 'Which launches moved most?'],
  },
  portfolio: {
    label: 'Portfolio',
    // Says the boundary before the reader asks, because it is the thing that
    // makes this scope honest: the ranking is of what was measured, and the
    // reference size is nobody's actual position.
    blurb: 'The B20 tokens this wallet holds, hardest to close first — ordered by what Miorail measured at its reference size, which is not the size you hold.',
    prompts: ['Which of my positions is hardest to close?', 'Which of mine priced no sale at all?'],
  },
};

export interface B20ConsoleAnswerViewV1 {
  schemaVersion: 'b20-console-answer/v1';
  /** The scope that ANSWERED, which is not always the one that was asked. */
  scope: B20ConsoleScopeViewV1;
  intent: string;
  answerSource: 'deterministic_evidence' | 'verified_narration';
  answer: string;
  facts: readonly { label: string; value: string; tone: 'neutral' | 'positive' | 'warning' }[];
  missingEvidence: readonly string[];
  caveats: readonly string[];
  reads: readonly { tool: string; detail: string }[];
  serverTime: string;
}

export interface B20ConsolePanelModelV1 {
  /**
   * How this console sits on the page.
   *
   * `panel` is a card of its own, which is what a screen whose subject IS the
   * console needs. `inline` is a strip inside another panel's body, used on
   * Discover so the order a reader meets is: what this page lists, one row to
   * ask, the filters, the cards. One component, two placements — a separate
   * mobile console would be a second set of copy to keep true.
   */
  variant?: 'panel' | 'inline';
  scope: B20ConsoleScopeViewV1;
  /** Tokens the reader put in the Investigate scope. Addresses only. */
  tokenAddresses: readonly string[];
  /**
   * The B20 tokens this wallet holds, supplied by the surface that already
   * read them. Miorail does not enumerate a wallet, so an empty list here is
   * "nothing was read", never "this wallet holds nothing" — and the Portfolio
   * scope is not offered at all until a surface passes one.
   */
  heldTokenAddresses?: readonly string[];
  loading: boolean;
  answer: B20ConsoleAnswerViewV1 | null;
  error: string | null;
  onScopeChange: (scope: B20ConsoleScopeViewV1) => void;
  onTokensChange: (tokenAddresses: readonly string[]) => void;
  onAsk: (input: { scope: B20ConsoleScopeViewV1; question: string; tokenAddresses: readonly string[] }) => void;
}

const SHORT_ADDRESS_V1 = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function B20ConsolePanel(model: B20ConsolePanelModelV1) {
  const [question, setQuestion] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [dismissedAnswer, setDismissedAnswer] = useState<string | null>(null);
  const held = model.heldTokenAddresses ?? [];
  // Offered only when a surface actually read a wallet. A Portfolio tab above
  // a disconnected wallet would answer "nothing held", which is a claim
  // nobody measured.
  const scopes: readonly B20ConsoleScopeViewV1[] = held.length > 0
    ? B20_CONSOLE_SCOPES_V1
    : B20_CONSOLE_SCOPES_V1.filter((entry) => entry !== 'portfolio');
  const scope: B20ConsoleScopeViewV1 = scopes.includes(model.scope) ? model.scope : 'explore';
  const copy = B20_CONSOLE_SCOPE_COPY_V1[scope];
  const answer = model.answer;

  const ask = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setDismissedAnswer(null);
    model.onAsk({
      scope,
      question: trimmed,
      // Portfolio asks about the wallet's own tokens; every other scope asks
      // about the ones the reader picked.
      tokenAddresses: scope === 'portfolio' ? held : model.tokenAddresses,
    });
  };

  const inline = model.variant === 'inline';

  // Collapsed by default. The full panel — scope blurb, four example questions,
  // the input label — stood between the reader and the first B20 card, so
  // Discover opened on an explanation of itself. Everything is one focus away
  // and nothing was removed.
  //
  // It opens on focus and on the explicit control, so a reader who starts
  // typing gets the hints without having asked for them. It no longer opens
  // because an ANSWER arrived: the answer is the thing to read then, and
  // reprinting the mode's description above it pushed the answer down a screen.
  const hintsOpen = expanded || model.loading;

  // An answer is dismissable, and it is open when it arrives.
  //
  // On a 390px screen a five-fact answer with three folds runs longer than the
  // viewport, and it sits between the reader and the cards Discover exists to
  // show. Collapsing does not discard it — the same answer reopens — and the
  // dismissal is keyed to the answer, so the next question always opens.
  const answerHidden = answer !== null && dismissedAnswer === answer.serverTime;

  const body = (
    <>
      <div className="filter-row">
        <span className="filter-row-k">Scope</span>
        <nav className="crumb" aria-label="What to ask about">
          {scopes.map((entry) => (
            <button
              key={entry}
              type="button"
              className={`btn sec${scope === entry ? ' on' : ''}`}
              aria-pressed={scope === entry}
              onClick={() => model.onScopeChange(entry)}
            >
              {B20_CONSOLE_SCOPE_COPY_V1[entry].label}
            </button>
          ))}
        </nav>
      </div>

      {/* ALWAYS visible, never behind the fold. This is not a hint — it is
          what the scope reads, and Portfolio's version carries the sentence
          saying the ranking uses a reference size nobody holds. A disclosure a
          reader has to expand is not a disclosure. */}
      <p className="lnote">{copy.blurb}</p>

      {scope === 'investigate' && (
        <div className="b20-token-chips" aria-label="Tokens in this comparison">
          {model.tokenAddresses.length === 0
            ? // Named rather than left blank: a symbol is not an identifier on
              // Base, and Miorail will not choose which token one means. The
              // second sentence is what changed: a pasted address no longer
              // only reads a stored measurement, it causes one when there is
              // none, and a reader waiting on a request deserves to know that
              // before they wait.
              (
                <p className="lnote">
                  No token selected. Paste a Base token address into the question, or open a card below and add it.
                  If Miorail holds no current reading of it, it takes one.
                </p>
              )
            : model.tokenAddresses.map((address) => (
                <button
                  key={address}
                  type="button"
                  className="mono"
                  aria-label={`Remove ${address}`}
                  onClick={() => model.onTokensChange(model.tokenAddresses.filter((entry) => entry !== address))}
                >
                  {SHORT_ADDRESS_V1(address)} ×
                </button>
              ))}
        </div>
      )}

      {hintsOpen && (
        <div className="b20-prompt-chips" aria-label="Example questions">
          {copy.prompts.map((prompt) => (
            <button key={prompt} type="button" onClick={() => { setQuestion(prompt); ask(prompt); }}>
              {prompt}
            </button>
          ))}
        </div>
      )}

      <form
        className="b20-ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          ask(question);
        }}
      >
        <label htmlFor="b20-console-ask" className={hintsOpen ? undefined : 'sr-only'}>
          Ask about measured B20 launches
        </label>
        <div>
          <input
            id="b20-console-ask"
            value={question}
            maxLength={500}
            placeholder={copy.prompts[0]}
            onFocus={() => setExpanded(true)}
            onChange={(event) => setQuestion(event.currentTarget.value)}
          />
          <button type="submit" className="btn" disabled={!question.trim() || model.loading}>
            {model.loading ? 'Reading…' : 'Ask'}
          </button>
        </div>
      </form>

      {model.error && <p className="note warn">{model.error}</p>}

      {answer && (
        <div className="b20-answer" aria-live="polite">
          <div className="b20-answer-head">
            {/* The scope that answered, when it is not the one on the tab. A
                token answer under an "Explore" heading would be mislabelled,
                and a universe answer under "Investigate" doubly so now that
                Investigate routes those questions instead of refusing them. */}
            {answer.scope !== scope ? (
              <span className="lnote">
                Answered in {B20_CONSOLE_SCOPE_COPY_V1[answer.scope].label} — the question named something more
                specific than the scope.
              </span>
            ) : (
              <span className="lnote">Answer</span>
            )}
            <button
              type="button"
              className="btn sec"
              aria-expanded={!answerHidden}
              onClick={() => setDismissedAnswer(answerHidden ? null : answer.serverTime)}
            >
              {answerHidden ? 'Show' : 'Hide'}
            </button>
          </div>
          {!answerHidden && (
            <>
              <p>{answer.answer}</p>
              <p className="lnote">
                {answer.answerSource === 'verified_narration'
                  ? 'Rephrased from the evidence below. Every figure in it was checked against that evidence.'
                  : answer.intent === 'find_possible_public_context'
                    ? 'Built from an UNVERIFIED public-context read. Any verified Fundamental evidence is shown separately below and does not upgrade a candidate.'
                  : 'Built directly from the stored measurements below.'}
              </p>
              {answer.facts.length > 0 && (
                <dl className="b20-answer-facts">
                  {answer.facts.map((fact) => (
                    <div key={`${fact.label}:${fact.value}`}>
                      <dt>{fact.label}</dt>
                      <dd className={fact.tone === 'warning' ? 'warn' : fact.tone === 'positive' ? 'ok' : ''}>
                        {fact.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {answer.missingEvidence.length > 0 && (
                <details className="b20-answer-unknowns">
                  <summary>{answer.missingEvidence.length} evidence gaps</summary>
                  <ul>{answer.missingEvidence.map((item) => <li key={item}>{item}</li>)}</ul>
                </details>
              )}
              {/* This panel's replacement for the card's observation stamp. A
                  global answer has no single measurement to pin, so what it owes
                  a reader instead is which reads produced it. */}
              {answer.reads.length > 0 && (
                <details className="b20-answer-reads">
                  <summary>What was read</summary>
                  <ul>
                    {answer.reads.map((read) => (
                      <li key={`${read.tool}:${read.detail}`}>
                        <span className="mono">{read.tool}</span> — {read.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <details className="b20-answer-caveats">
                <summary>Evidence boundaries</summary>
                <ul>{answer.caveats.map((item) => <li key={item}>{item}</li>)}</ul>
              </details>
            </>
          )}
        </div>
      )}
    </>
  );

  // Inline: a strip inside another panel's body, with no card chrome of its
  // own. It keeps the heading — a reader has to know what the input is — but
  // as a row rather than as a panel header, so Discover's own header stays the
  // top of the page.
  if (inline) {
    return (
      <section className="ask-inline" aria-label="Ask Miorail">
        <div className="ask-inline-head">
          <h4>Ask Miorail</h4>
          <span className="rt">
            <button
              type="button"
              className="btn sec"
              aria-expanded={hintsOpen}
              onClick={() => setExpanded((open) => !open)}
            >
              {hintsOpen ? 'Less' : 'Examples'}
            </button>
            <span className="sub">read-only</span>
          </span>
        </div>
        {body}
      </section>
    );
  }

  return (
    <div className="panel">
      <div className="ph">
        <h3>Ask Miorail</h3>
        <span className="rt">
          <button
            type="button"
            className="btn sec"
            aria-expanded={hintsOpen}
            onClick={() => setExpanded((open) => !open)}
          >
            {hintsOpen ? 'Less' : 'Examples'}
          </button>
          <span className="sub">read-only</span>
        </span>
      </div>
      <div className="pb tight">{body}</div>
    </div>
  );
}
