import { useCallback, useMemo } from 'react';
import { useLocation } from 'wouter';
import {
  CONSOLE_DRAWER_SECTIONS_V1,
  CONSOLE_PRIMARY_SECTIONS_V1,
  consoleNavModelV1,
  consoleSectionPathV1,
  type ConsoleNavItemV1,
  type ConsoleSectionV1,
} from '@mioagent/ui';
import { useStatus } from '@mioagent/api-client-react';

// ---------------------------------------------------------------------------
// T70 §8 — the web console's navigation, built once.
//
// Every console page calls this instead of writing a tab array. That is the
// whole mechanism: there is no second place where a label, an order or a path
// can be introduced, so the header and the drawer cannot disagree with each
// other or with Base App.
//
// Navigation state lives in the URL and nowhere else, which is what makes it
// survive a refresh, a wallet reconnect and a trip through Review. The URL
// carries the SECTION only — never an address, a balance or a goal.
// ---------------------------------------------------------------------------

export const DISCOVER_OFF_COPY_V1 =
  'B20 Discover is off on this server, so there is no launch feed to show. This is not a statement about what is launching.';

export interface ConsoleNavV1 {
  /** Three entries for the header bar. */
  header: readonly ConsoleNavItemV1[];
  /** Six entries for the rail, which is the drawer on a phone. */
  rail: readonly ConsoleNavItemV1[];
  navigate: (section: ConsoleSectionV1) => void;
}

export function useConsoleNav(active: ConsoleSectionV1 | null): ConsoleNavV1 {
  const [, setLocation] = useLocation();
  const status = useStatus();

  // The one section that can be mounted and still have nothing behind it. The
  // server flag is the honest source: when it is off the endpoint refuses, and
  // a tab that leads to a refusal should say so before the click, not after.
  const discoverOn = status.data?.productMigration?.b20ControlV1 === true;
  const unavailable = useMemo(
    () => (discoverOn ? undefined : { opportunities: DISCOVER_OFF_COPY_V1 }),
    [discoverOn],
  );

  const header = useMemo(
    () => consoleNavModelV1({ mounted: CONSOLE_PRIMARY_SECTIONS_V1, active, unavailable }),
    [active, unavailable],
  );
  const rail = useMemo(
    () => consoleNavModelV1({ mounted: CONSOLE_DRAWER_SECTIONS_V1, active, unavailable }),
    [active, unavailable],
  );

  const navigate = useCallback(
    (section: ConsoleSectionV1) => setLocation(consoleSectionPathV1(section)),
    [setLocation],
  );

  return { header, rail, navigate };
}
