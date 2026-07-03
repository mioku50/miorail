import { useStatus } from '@mioagent/api-client-react';
import { CHAIN_ENV } from './chain';

// Honest network label from /api/status (falls back to the build-time env while
// status loads). Replaces the hardcoded network-mode literals that used to be
// string-pasted across TopBar, AgentStream, and ChatMessage.
export function useNetworkLabel(): { label: string; readOnly: boolean } {
  const { data } = useStatus();
  const chainEnv = data?.chainEnv || CHAIN_ENV;
  const readOnly = data?.execution?.mode === 'read-only' || chainEnv === 'mainnet-readonly';
  const label =
    chainEnv === 'mainnet-readonly' ? 'Base Mainnet · Read-only' : chainEnv === 'mainnet' ? 'Base Mainnet' : 'Base Sepolia';
  return { label, readOnly };
}
