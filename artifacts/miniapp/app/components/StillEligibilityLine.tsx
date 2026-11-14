"use client";
import React from 'react';
import { useConfirmStillEligibilityV1, useSession, useStillEligibilityV1 } from '@mioagent/api-client-react';
import { StillEligibilityBarV1, stillEligibilityViewV1, stillRegionRefusalDetailV1 } from '@mioagent/ui/still';

void React;

// ---------------------------------------------------------------------------
// Where Still is offered, above a review in the mini app (audit UI-15,
// 2026-11-14).
//
// The web draws this line at the top of every Still page (StillFrame). The
// mini app's own pages at /app/lending/<draft> and /app/action/<draft> drew
// none, while the server refused a new loan or stock buy there until this
// sign-in confirmed it is not a US person, and the stock buy's refusal said
// "Confirm at the top of this page": there was nothing there to confirm. Now
// the same line and box sit above both reviews. The server asks the same
// questions again wherever it would hand out calls.
// ---------------------------------------------------------------------------

/** The signed-in wallet's eligibility, as the web page reads it; the review reads itself again once it is clear. */
export function useMiniStillEligibilityV1() {
  const session = useSession({ retry: false, staleTime: 0 });
  const wallet = session.data?.user?.address ?? null;
  const read = useStillEligibilityV1(wallet, { enabled: !session.isPending });
  const view = read.data === undefined ? null : stillEligibilityViewV1(read.data);
  return { view, clear: view?.kind === 'clear' };
}

/** The line itself. `scoped` wraps it in Still's colours for a page drawn in the console's own. */
export function MiniStillEligibilityLine({ scoped = false }: { scoped?: boolean }) {
  const { view } = useMiniStillEligibilityV1();
  const confirm = useConfirmStillEligibilityV1();
  const error = confirm.error
    ? stillRegionRefusalDetailV1(confirm.error) ?? 'Your confirmation could not be saved. Nothing was prepared; try again.'
    : null;
  const bar = <StillEligibilityBarV1 view={view} busy={confirm.isPending} error={error}
    onConfirm={() => { if (view?.kind === 'confirm') confirm.mutate(view.version); }} />;
  return scoped && view && view.kind !== 'clear' ? <div className="still">{bar}</div> : bar;
}
