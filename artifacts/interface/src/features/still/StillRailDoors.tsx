import type { ReactNode } from 'react';
import { useTelegramAlertsV1 } from '@mioagent/ui';
import { StillDoors, StillRailDoorsContext } from '@mioagent/ui/still';
import { useStillWallet } from './useStillSky';

/** Still in an assistant and alerts in Telegram, under the pages in the left
 * rail (operator, 2026-11-03). Telegram needs this app's session, so the app
 * provides the doors to every Still frame; a phone shows them on Home. */
export function StillRailDoorsProvider({ children }: { children: ReactNode }) {
  return <StillRailDoorsContext.Provider value={<StillRailDoorsV1 />}>{children}</StillRailDoorsContext.Provider>;
}

function StillRailDoorsV1() {
  const { signedIn } = useStillWallet();
  const telegram = useTelegramAlertsV1({ enabled: signedIn });
  return <StillDoors telegram={telegram} rail />;
}
