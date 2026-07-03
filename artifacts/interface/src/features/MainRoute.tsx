import { useEffect } from 'react';
import { useUiStore } from '../lib/state';
import { PortfolioRail } from './portfolio/PortfolioRail';
import { ActionInbox } from './inbox/ActionInbox';
import { AgentStream } from './stream/AgentStream';

// The main 3-column view (rail / inbox / stream). `actionId` (from the
// /inbox/:actionId deep-link) is forwarded to the focus store so ActionInbox
// scrolls to it without remounting the view.
export function MainRoute({ actionId }: { actionId?: string }) {
  const focusAction = useUiStore((s) => s.focusAction);
  useEffect(() => {
    if (actionId) focusAction(actionId);
  }, [actionId, focusAction]);

  return (
    <>
      <PortfolioRail />
      <ActionInbox />
      <AgentStream />
    </>
  );
}
