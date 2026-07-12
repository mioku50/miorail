import { useAutonomy, useStatus } from '@mioagent/api-client-react';
import { CHAIN_ENV } from './chain';
import { deriveNetworkLabel, type NetworkExecutionMode } from './networkLabel';

// T44: honest SPLIT statuses. The network label reflects the server execution
// CAPABILITY only ('Base Mainnet · User-confirmed' whenever the server enables
// the user-confirmed flow, even if no policy is saved yet). Policy readiness
// (Off/Limited/Active) is a separate badge via cockpitAutonomyPresentation.
// Consumers that gate ACTIONS must use `executionUnlocked` (strict: policy
// executionReady), never `readOnly`.
export function useNetworkLabel(): { label: string; readOnly: boolean; executionUnlocked: boolean } {
  const { data } = useStatus();
  const { data: autonomy } = useAutonomy();
  return deriveNetworkLabel({
    chainEnv: data?.chainEnv || CHAIN_ENV,
    executionMode: data?.execution?.mode as NetworkExecutionMode | undefined,
    userConfirmedEnabled: data?.execution?.userConfirmedEnabled === true,
    executionReady: autonomy?.sessionKey?.executionReady === true,
  });
}
