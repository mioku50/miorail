'use client';

import React, { useCallback, useEffect, useState } from 'react';

import {
  publicIdentityViewV1,
  type PublicIdentityReadingV1,
  type PublicIdentityViewV1,
} from './console/publicIdentityView';

void React;

// ---------------------------------------------------------------------------
// The public "is this the real one" page.
//
// No session, no wallet, no connect button. The reader arrives holding an
// address they do not trust, and the only thing this page owes them is an
// answer they can check themselves — which is why the official contract's
// ADDRESS is the largest thing on a lookalike verdict. A symbol is what an
// impostor supplies.
//
// It renders `unknown_to_miorail` as prominently as the other four. A surface
// that showed nothing for an address it knows nothing about would let a reader
// conclude somebody checked and found nothing wrong.
// ---------------------------------------------------------------------------

export interface PublicIdentityCheckProps {
  /** Pre-filled from the URL when somebody was linked here. */
  tokenAddress?: string | null;
  /** Overridable so a test can serve a fixture. */
  endpoint?: string;
  productHref?: string;
  productLabel?: string;
}

type StateV1 =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; view: PublicIdentityViewV1 }
  | { kind: 'refused'; detail: string }
  | { kind: 'error' };

const ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/;

export function PublicIdentityCheck(props: PublicIdentityCheckProps) {
  const endpoint = props.endpoint ?? '/api/public/identity';
  const [query, setQuery] = useState(props.tokenAddress ?? '');
  const [state, setState] = useState<StateV1>({ kind: 'idle' });

  const check = useCallback(
    async (raw: string) => {
      const address = raw.trim();
      if (!ADDRESS_V1.test(address)) {
        setState({
          kind: 'refused',
          detail:
            'That is not a Base contract address. A ticker cannot select a contract: different issuers publish different contracts for the same company, and the address is the identity.',
        });
        return;
      }
      setState({ kind: 'loading' });
      try {
        const response = await fetch(`${endpoint}/${address}`, {
          headers: { accept: 'application/json' },
        });
        const body = (await response.json()) as Record<string, unknown>;
        if (!response.ok) {
          setState({
            kind: 'refused',
            detail:
              typeof body.detail === 'string'
                ? body.detail
                : 'Miorail could not answer for this address.',
          });
          return;
        }
        const view = publicIdentityViewV1(body as unknown as PublicIdentityReadingV1);
        setState(view ? { kind: 'ready', view } : { kind: 'error' });
      } catch {
        setState({ kind: 'error' });
      }
    },
    [endpoint],
  );

  useEffect(() => {
    if (props.tokenAddress && ADDRESS_V1.test(props.tokenAddress.trim())) {
      void check(props.tokenAddress);
    }
  }, [props.tokenAddress, check]);

  return (
    <main className="mio-console pi-page">
      <header className="pi-head">
        <p className="pi-eyebrow">Miorail · Base mainnet</p>
        <h1>Is this the real one?</h1>
        <p className="lnote">
          Paste an exact contract address. Miorail answers from evidence it has already
          written down — the reviewed issuer corpus, the issuer registries, and every
          contract recorded as wearing an official asset&rsquo;s name. Nothing is read from
          the chain for this check, and no answer here is financial advice.
        </p>
      </header>

      <form
        className="pi-form"
        onSubmit={(event) => {
          event.preventDefault();
          void check(query);
        }}
      >
        <label className="pi-label" htmlFor="pi-address">
          Contract address
        </label>
        <input
          id="pi-address"
          className="pi-input mono"
          value={query}
          spellCheck={false}
          autoComplete="off"
          placeholder="0x…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="btn" type="submit" disabled={state.kind === 'loading'}>
          {state.kind === 'loading' ? 'Checking…' : 'Check'}
        </button>
      </form>

      {state.kind === 'refused' && <p className="empty">{state.detail}</p>}
      {state.kind === 'error' && (
        <p className="empty">
          Miorail could not reach its own records just now. That is an outage here and says
          nothing about the token.
        </p>
      )}

      {state.kind === 'ready' && (
        <section className="panel pi-verdict">
          <div className="cr-top">
            <span className="cr-name mono">{state.view.tokenAddress}</span>
            <span className="pill cr-status" data-tone={state.view.tone}>
              {state.view.verdict}
            </span>
          </div>
          <p className="cr-verdict">{state.view.answer}</p>

          {state.view.compareWith && (
            /* The largest thing on the page when it exists. The reader's job
               here is a character-by-character comparison, and everything else
               on this card is context for it. */
            <div className="pi-compare">
              <p className="pi-compare-label">
                The real {state.view.compareWith.label} is
              </p>
              <p className="pi-compare-address mono">{state.view.compareWith.address}</p>
              <p className="lnote">
                Compare this with the address you were given, character by character. A
                symbol is what an impostor supplies; the address is the identity.
              </p>
            </div>
          )}

          {state.view.facts.length > 0 && (
            <dl className="cr-facts">
              {state.view.facts.map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>
                    <span className={fact.mono ? 'mono' : undefined}>{fact.value}</span>
                    {fact.note && <span className="vl"> — {fact.note}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <ul className="pi-caveats">
            {state.view.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </section>
      )}

      {props.productHref && (
        <p className="lnote">
          <a href={props.productHref}>{props.productLabel ?? 'Open Miorail'}</a>
        </p>
      )}
    </main>
  );
}
