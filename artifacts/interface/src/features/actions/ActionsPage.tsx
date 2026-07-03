import { useEffect } from 'react';
import { useUiStore } from '../../lib/state';
import { ActionInbox } from '../inbox/ActionInbox';

export function ActionsPage({ actionId }: { actionId?: string }) {
  const focusAction = useUiStore((s) => s.focusAction);

  useEffect(() => {
    if (actionId) focusAction(actionId);
  }, [actionId, focusAction]);

  return <ActionInbox />;
}
