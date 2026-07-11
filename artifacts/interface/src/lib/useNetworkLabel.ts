import { useAutonomy, useStatus } from '@mioagent/api-client-react';
import { CHAIN_ENV } from './chain';

// Honest network label from /api/status (falls back to the build-time env while
// status loads). Replaces the hardcoded network-mode literals that used to be
// string-pasted across TopBar, AgentStream, and ChatMessage.
export function useNetworkLabel(): { label: string; readOnly: boolean } {
  const { data } = useStatus();
  const { data: autonomy } = useAutonomy();
  const chainEnv = data?.chainEnv || CHAIN_ENV;
  const userConfirmed = data?.execution?.mode === 'user-confirmed'
    && data.execution.userConfirmedEnabled === true
    && autonomy?.sessionKey?.executionReady === true;
  const readOnly = !userConfirmed && (data?.execution?.mode === 'read-only' || chainEnv === 'mainnet-readonly' || chainEnv === 'mainnet');
  const label =
    userConfirmed ? 'Mainnet · User-confirmed'
      : chainEnv === 'mainnet-readonly' || chainEnv === 'mainnet' ? 'Base Mainnet · Read-only'
        : 'Base Sepolia';
  return { label, readOnly };
}
