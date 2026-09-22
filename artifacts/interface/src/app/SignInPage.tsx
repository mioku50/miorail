import { Redirect, useSearch } from 'wouter';
import { safeNextPathV1 } from '../lib/signInReturn';
import { RequireSession } from './RequireSession';

// ---------------------------------------------------------------------------
// The one door a signed-out reader is sent through.
//
// The Stocks board is public now, and its session-only controls — measure
// again, watch, ask, buy and sell — lead here instead of to a refusal. The
// gate is the ordinary one; what this adds is the way back: once the wallet
// has signed, the reader lands on the page they pressed the button on.
// ---------------------------------------------------------------------------

export function SignInPage() {
  const search = useSearch();
  const next = safeNextPathV1(new URLSearchParams(search).get('next'));
  return (
    <RequireSession
      copy={{
        eyebrow: 'Sign in',
        body: 'Connect the wallet you want to measure, watch or trade with. One signature proves it is yours. It does not send a transaction.',
      }}
    >
      <Redirect to={next} replace />
    </RequireSession>
  );
}
