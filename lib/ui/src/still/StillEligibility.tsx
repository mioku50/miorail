import React, { createContext, useState, type ReactNode } from 'react';
import { STILL_REGION_ATTRIBUTION_V1, STILL_US_PERSON_DEFINITION_V1 } from '@mioagent/still-engine/eligibility';

import { stillPlaceInSentenceV1, type StillEligibilityViewV1 } from './stillEligibility';

void React;

/** The app's line about where Still is offered, shown at the top of every Still page (StillFrame).
 * It needs the app's session and API, so it is provided, not built here. */
export const StillEligibilityContext = createContext<ReactNode>(null);

const Attribution = () => (
  <a href={STILL_REGION_ATTRIBUTION_V1.url} target="_blank" rel="noopener noreferrer">{STILL_REGION_ATTRIBUTION_V1.text}</a>
);

/** Where Still is offered, as the server sees this connection: a refusal from the United States, a
 * check that could not be made, or the one sentence a signed-in person confirms before a new loan,
 * purchase or stock buy. Nothing here opens anything: the server asks the same questions again. */
export function StillEligibilityBarV1({ view, busy = false, error = null, onConfirm }: {
  view: StillEligibilityViewV1 | null;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  const [checked, setChecked] = useState(false);
  if (!view || view.kind === 'clear') return null;
  if (view.kind === 'restricted') {
    // What stays open comes first, said once (audit UI-11: a loan holder read two "not available" before
    // learning a repayment works from here), and a person who is not there learns why they were placed there.
    return (
      <section className="still-eligibility is-restricted" role="status" aria-label="Where Still is offered">
        <strong>New loans, purchases and stock buys are not offered from here</strong>
        <p>{view.open}</p>
        <p>{view.reason}</p>
        <p className="still-eligibility-source">This connection is placed in {stillPlaceInSentenceV1(view.place)} by its IP address. If you are not there,
          the address may belong to a VPN, a proxy or a network that routes through it. <Attribution /></p>
      </section>
    );
  }
  if (view.kind === 'unchecked') {
    return (
      <section className="still-eligibility is-unchecked" role="status" aria-label="Where Still is offered">
        <strong>Still could not check where you are connecting from</strong>
        <p>{view.detail}</p>
      </section>
    );
  }
  return (
    <section className="still-eligibility is-confirm" aria-label="Before a new loan, purchase or stock buy">
      <p>Still is offered only in eligible jurisdictions, and never to U.S. persons. Before it prepares a new loan, purchase or stock buy, confirm once for this sign-in:</p>
      <label className="still-eligibility-check">
        <input type="checkbox" checked={checked} disabled={busy} onChange={(event) => setChecked(event.target.checked)} />
        <span>{view.statement}</span>
      </label>
      <p className="still-eligibility-define">{STILL_US_PERSON_DEFINITION_V1}</p>
      <div className="still-eligibility-actions">
        <button type="button" className="still-eligibility-confirm" disabled={!checked || busy} onClick={onConfirm}>
          {busy ? 'Saving…' : 'Confirm'}
        </button>
        <span className="still-eligibility-source">Repaying, taking collateral back and selling never ask for this. <Attribution /></span>
      </div>
      {error ? <p className="still-warn" role="alert">{error}</p> : null}
    </section>
  );
}
