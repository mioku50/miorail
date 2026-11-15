import type { ReactNode } from 'react';
import { useConfirmStillEligibilityV1, useStillEligibilityV1 } from '@mioagent/api-client-react';
import {
  StillEligibilityBarV1,
  StillEligibilityConfirmContext,
  StillEligibilityContext,
  stillEligibilityViewV1,
  stillRegionRefusalDetailV1,
} from '@mioagent/ui/still';
import { useStillWallet } from './useStillSky';

/** Where Still is offered (2026-11-10), as the server reads this connection. Since 2026-11-15:
 * - the line at the top shows only where Still is not offered or could not tell, and only on a page
 *   that starts a new loan or purchase (StillFrame `entry`: Get money, Spend);
 * - the one sentence a signed-in person confirms is asked by the review that needs it, not at the top
 *   of every page.
 * The server checks both again wherever it would hand out calls. */
export function StillEligibilityProvider({ children }: { children: ReactNode }) {
  return (
    <StillEligibilityContext.Provider value={<StillRegionNoticeV1 />}>
      <StillEligibilityConfirmContext.Provider value={StillEligibilityConfirmV1}>{children}</StillEligibilityConfirmContext.Provider>
    </StillEligibilityContext.Provider>
  );
}

function useEligibilityViewV1() {
  const session = useStillWallet();
  const read = useStillEligibilityV1(session.signedIn ? session.wallet : null, { enabled: !session.booting });
  return read.data === undefined ? null : stillEligibilityViewV1(read.data);
}

function StillRegionNoticeV1() {
  const view = useEligibilityViewV1();
  if (!view || (view.kind !== 'restricted' && view.kind !== 'unchecked')) return null;
  return <StillEligibilityBarV1 view={view} onConfirm={() => {}} />;
}

/** The confirmation, in the review that asked for it; `fallback` when there is nothing to confirm here. */
function StillEligibilityConfirmV1({ onConfirmed, fallback = null }: { onConfirmed?: () => void; fallback?: ReactNode }) {
  const view = useEligibilityViewV1();
  const confirm = useConfirmStillEligibilityV1();
  if (view?.kind !== 'confirm') return <>{fallback}</>;
  const error = confirm.error
    ? stillRegionRefusalDetailV1(confirm.error) ?? 'Your confirmation could not be saved. Nothing was prepared; try again.'
    : null;
  return <StillEligibilityBarV1 view={view} inline busy={confirm.isPending} error={error}
    onConfirm={() => confirm.mutate(view.version, { onSuccess: () => onConfirmed?.() })} />;
}
