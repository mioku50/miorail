import React, { useState } from 'react';

import type {
  StocksAskResponseV1,
  StocksEvidenceItemV1,
} from '@mioagent/rwa-market-reality/narration-contract';

// The JSX below compiles to React.createElement, so the import is load-bearing
// even though nothing here names React directly.
void React;

// ---------------------------------------------------------------------------
// Phase 13.2 — Ask Miorail.
//
// The panel renders an answer that has already been checked. It does not
// decide what is true, it does not soften a refusal, and it never shows a
// sentence the verifier discarded — the server sends the deterministic answer
// in that case, and `answerSource` says which one arrived.
//
// The layout is the contract, deliberately: what Miorail established, what it
// could not, and the rows each claim stands on. A reader who wants to check a
// claim can expand it and see the exact evidence line, so a citation is a
// thing you can follow rather than a decoration.
//
// AI ESTABLISHES NOTHING. The prefilled questions below are the surface's own
// vocabulary, not a model's suggestions, and the answer can only be about the
// exact question already on screen.
// ---------------------------------------------------------------------------

export interface StocksAskPanelModelV1 {
  /** Null until a reader has asked. */
  answer: StocksAskResponseV1 | null;
  asking: boolean;
  /** Why the ask did not complete. Never a claim about the market. */
  error: string | null;
  /** False when the surface is not offered — no session, no security chosen. */
  available: boolean;
}

export interface StocksAskPanelActionsV1 {
  onAsk: (question: string) => void;
}

/**
 * Questions this surface can actually answer, in the reader's words.
 *
 * Fixed, and written here rather than generated: a prompt suggested by a model
 * is a model choosing what a reader should wonder about, which is the first
 * step toward it choosing what to establish.
 */
export const STOCKS_ASK_PROMPTS_V1: readonly string[] = [
  'Why is there no price at this size?',
  'What did Miorail establish here, and what did it not?',
  // Was "Which representation costs less to exit, and how do you know?" — which
  // assumes a comparison exists. On a board reading "0 / 2 market answers" the
  // chip promised something the evidence had already denied, and the answer
  // could only be a refusal. This asks the question the board is actually in a
  // position to answer.
  'Can these representations be compared right now?',
  // Was in Russian on a fully English screen. The console is not localized, so
  // one localized string is a rendering fault, not a feature.
  'How recently was this measured?',
];

function evidenceById(
  evidence: readonly StocksEvidenceItemV1[],
): Map<string, StocksEvidenceItemV1> {
  return new Map(evidence.map((row) => [row.id, row]));
}

export function StocksAskPanel({
  model,
  actions,
}: {
  model: StocksAskPanelModelV1;
  actions: StocksAskPanelActionsV1;
}) {
  const [draft, setDraft] = useState('');
  if (!model.available) return null;

  const answer = model.answer;
  const rows = answer ? evidenceById(answer.evidence) : new Map<string, StocksEvidenceItemV1>();
  const submit = (question: string) => {
    const trimmed = question.trim();
    if (trimmed.length === 0 || model.asking) return;
    // The field shows what was asked, including when a chip asked it. A panel
    // that answers a question the reader cannot see on screen leaves them
    // guessing which of four chips the answer belongs to.
    setDraft(trimmed);
    actions.onAsk(trimmed);
  };

  return (
    <section className="ask-inline" aria-label="Ask Miorail">
      <div className="ask-inline-head">
        <h4>Ask Miorail</h4>
        {/* The provenance of the SENTENCE, not of the evidence. A reader is
            entitled to know whether a model wrote the words. */}
        {answer ? (
          <span className="rt">
            <span className="note">
              {answer.answerSource === 'verified_narration'
                ? 'Narrated, then checked against the evidence'
                : 'The evidence, verbatim'}
            </span>
          </span>
        ) : null}
      </div>

      <p className="lnote">
        Answers are built only from the measurements on this page, for the exact size and direction
        above. Miorail does not predict prices and does not advise.
      </p>

      <div className="b20-prompt-chips" role="group" aria-label="Suggested questions">
        {STOCKS_ASK_PROMPTS_V1.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="btn sec"
            disabled={model.asking}
            onClick={() => submit(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>

      <form
        className="b20-ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit(draft);
        }}
      >
        <div>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask about what is measured here…"
            maxLength={1000}
            aria-label="Ask Miorail about this security"
          />
          <button type="submit" className="btn" disabled={model.asking || draft.trim().length === 0}>
            {model.asking ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </form>

      {model.error ? <p className="lnote warn">{model.error}</p> : null}

      {answer ? (
        <div className="b20-answer">
          <p className="cr-verdict">{answer.answer.explanation}</p>

          {answer.answer.established.length > 0 ? (
            <div className="stocks-ask-block">
              <p className="mr-attribution">
                {/* The reader's word, not the engine's. "Established" is
                    this product's internal term for "carried by the evidence
                    bundle"; a person reads "Confirmed" without translating. */}
                <span className="mr-attribution-k">Confirmed</span>
              </p>
              <ul className="stocks-ask-claims">
                {answer.answer.established.map((claim, index) => (
                  <li key={`${index}-${claim.claim.slice(0, 24)}`}>
                    <span>{claim.claim}</span>
                    {/* The citation, followable. An id a reader cannot resolve
                        is a decoration, not provenance. */}
                    <details className="card-evidence stocks-ask-cite">
                      <summary>{claim.sourceIds.join(', ')}</summary>
                      <div className="card-evidence-body">
                        {claim.sourceIds.map((id) => {
                          const row = rows.get(id);
                          return (
                            <p key={id} className="cr-fact-note">
                              <span className="mr-lastseen-k">{id}</span>{' '}
                              {row ? `${row.label}: ${row.value}` : 'this row did not travel with the answer'}
                            </p>
                          );
                        })}
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {answer.answer.notEstablished.length > 0 ? (
            <div className="stocks-ask-block">
              <p className="mr-attribution">
                <span className="mr-attribution-k">Not confirmed</span>
              </p>
              <ul className="stocks-ask-claims stocks-ask-absent">
                {answer.answer.notEstablished.map((entry, index) => (
                  <li key={`${index}-${entry.slice(0, 24)}`}>{entry}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="lnote">
            Quotes are router quotes at an exact size — never a promise of execution. Nothing here
            was executed.
          </p>
        </div>
      ) : null}
    </section>
  );
}
