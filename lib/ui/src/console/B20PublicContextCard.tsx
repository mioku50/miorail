import React from 'react';
import {
  B20_PUBLIC_CONTEXT_DISCLAIMER_V1,
  B20_PUBLIC_CONTEXT_GROUND_LABEL_V1,
  B20_PUBLIC_CONTEXT_PATH_TO_VERIFIED_V1,
  B20_PUBLIC_CONTEXT_STANDING_COPY_V1,
  type B20PublicContextV1,
} from '@mioagent/opportunity-rail/publicContext';

void React;

// ---------------------------------------------------------------------------
// Possible public context, and everything about this card is about not being
// mistaken for the verified one above it.
//
// Different chip, different words, and the disclaimer is NOT behind a control:
// a warning a reader has to open is not a warning, and the thing they are most
// likely to assume — that a matching name means the project — is exactly what
// this card must deny in its own body.
//
// It renders nothing until a reader asks. A search costs money and a false link
// costs more, and neither should be spent on a card nobody opened.
// ---------------------------------------------------------------------------

export interface B20PublicContextModelV1 {
  /** The token the panel is currently about, or null when none was opened. */
  tokenAddress: string | null;
  loading: boolean;
  context: B20PublicContextV1 | null;
  /** Why there is no answer. Never a claim about the token. */
  error: string | null;
  onLook: (tokenAddress: string) => void;
}

const GROUND_TONE_V1: Record<string, string> = {
  found: 'ok',
  absent: 'off',
  unchecked: 'off',
};

const GROUND_VALUE_V1: Record<string, string> = {
  found: 'Found',
  absent: 'Not on the page',
  unchecked: 'Not checked',
};

export function B20PublicContextCard({
  tokenAddress,
  symbol,
  model,
}: {
  tokenAddress: string;
  symbol: string;
  model: B20PublicContextModelV1;
}) {
  const owns = model.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase();
  const context = owns ? model.context : null;

  return (
    <details className="card-evidence">
      <summary>Look for public accounts</summary>
      <div className="card-evidence-body">
        <p className="lnote">
          Miorail can search the public web for a website, repository or social account that mentions this
          token. Nothing is searched until you ask, and nothing found this way is verified.
        </p>

        {!owns || (!context && !model.loading && !model.error) ? (
          <button type="button" className="btn sec" onClick={() => model.onLook(tokenAddress)}>
            Search public accounts
          </button>
        ) : null}

        {owns && model.loading && <p className="empty">Searching, then reading each result…</p>}
        {owns && model.error && <p className="note warn">{model.error}</p>}

        {context && (
          <section className="project-context" aria-label={`Possible public context for ${symbol}`}>
            <div className="project-head">
              <span className="project-name">{symbol}</span>
              {/* Never `data-tone="measured"`. That tone belongs to the verified
                  layer, and the two must not look alike at a glance. */}
              <span className="pill n cr-status">
                {B20_PUBLIC_CONTEXT_STANDING_COPY_V1[context.standing].chip}
              </span>
            </div>
            <p className="lnote">{context.headline}</p>
            <p className="note warn">{context.detail}</p>

            {context.candidates.length > 0 && (
              <dl className="cr-facts">
                {context.candidates.map((candidate) => (
                  <div key={`${candidate.kind}:${candidate.url}`}>
                    <dt>{candidate.kind === 'repository' ? 'GitHub' : candidate.kind === 'social' ? 'X' : 'Website'}</dt>
                    <dd>
                      {/* The host, not the full URL, and never a link: a card
                          about possible accounts must not be a way to click
                          through to whatever a search engine ranked first. */}
                      <strong className="mono">{candidate.host}</strong>
                      {!candidate.fetched && <span className="cr-fact-note"> · not read</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {/* The whole checklist, always. Three ticks with no denominator
                reads as "everything matched". */}
            <div className="card-evidence-body">
              {context.findings.map((finding) => (
                <div className="kv" key={finding.ground}>
                  <span className="k">{B20_PUBLIC_CONTEXT_GROUND_LABEL_V1[finding.ground]}</span>
                  <span className={`v ${GROUND_TONE_V1[finding.state] ?? 'off'}`}>
                    {GROUND_VALUE_V1[finding.state] ?? finding.state}
                  </span>
                </div>
              ))}
            </div>

            <p className="lnote">{B20_PUBLIC_CONTEXT_DISCLAIMER_V1}</p>
            <p className="lnote">{B20_PUBLIC_CONTEXT_PATH_TO_VERIFIED_V1}</p>
            <p className="lnote mono">
              read {context.observedAt.slice(0, 16).replace('T', ' ')} UTC
            </p>
          </section>
        )}
      </div>
    </details>
  );
}
