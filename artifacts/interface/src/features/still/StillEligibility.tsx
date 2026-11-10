import type { ReactNode } from 'react';
import { useConfirmStillEligibilityV1, useStillEligibilityV1 } from '@mioagent/api-client-react';
import { StillEligibilityBarV1, StillEligibilityContext, stillEligibilityViewV1, stillRegionRefusalDetailV1 } from '@mioagent/ui/still';
import { useStillWallet } from './useStillSky';

/** Where Still is offered, at the top of every Still frame (2026-11-10): the server's own reading of
 * this connection, and the one sentence a signed-in person confirms before a new loan, purchase or
 * stock buy. The server checks both again wherever it would hand out calls. */
export function StillEligibilityProvider({ children }: { children: ReactNode }) {
  return <StillEligibilityContext.Provider value={<StillEligibilityLineV1 />}>{children}</StillEligibilityContext.Provider>;
}

function StillEligibilityLineV1() {
  const session = useStillWallet();
  const read = useStillEligibilityV1(session.signedIn ? session.wallet : null, { enabled: !session.booting });
  const confirm = useConfirmStillEligibilityV1();
  const view = read.data === undefined ? null : stillEligibilityViewV1(read.data);
  const error = confirm.error
    ? stillRegionRefusalDetailV1(confirm.error) ?? 'Your confirmation could not be saved. Nothing was prepared; try again.'
    : null;
  return <StillEligibilityBarV1 view={view} busy={confirm.isPending} error={error}
    onConfirm={() => { if (view?.kind === 'confirm') confirm.mutate(view.version); }} />;
}
