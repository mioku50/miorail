import {
  CONSOLE_PRIMARY_SECTIONS_V1,
  CONSOLE_SECTION_TABLE_V1,
  CONSOLE_SECTIONS_V1,
  type ConsoleSectionV1,
} from '@mioagent/ui';
import { STILL_ASSISTANTS_V1, STILL_SAFETY_V1, STILL_TABS_V1 } from '@mioagent/ui/still';

// Route + command tables.
//
// T70 §8 — these are DERIVED from the shared section table in lib/ui, not typed
// out again here. The web console and Base App had already drifted apart on
// wording and order while each held its own list; a user should not have to
// re-learn the product when they change device.

export interface AppRoute {
  path: string;
  label: string;
}

/** The four primary surfaces, in the shared order: Opportunities is home. */
export const CONSOLE_NAV_TABS: AppRoute[] = CONSOLE_PRIMARY_SECTIONS_V1.map((section) => ({
  path: CONSOLE_SECTION_TABLE_V1[section].path,
  label: CONSOLE_SECTION_TABLE_V1[section].label,
}));

export function navTabs(): AppRoute[] {
  return CONSOLE_NAV_TABS;
}

export interface AppCommand {
  id: string;
  icon: string;
  label: string;
  path: string;
}

/** Discover and Watch left Still (operator, 2026-11-17): these sections' addresses
 * lead to More now, so the palette does not offer them. The shared table keeps
 * them for the Base App. */
const RETIRED_SECTIONS_V1: ReadonlySet<ConsoleSectionV1> = new Set(['opportunities', 'investigate', 'portfolio', 'radar']);

/** Every section, Settings included — the palette is where you reach the things
 * that are deliberately not in the header. All but Wallet MCP, which is
 * Coinbase's wallet and not a place of Still's (operator, 2026-11-03): its page
 * stays at its path for the links that lead into it. */
export const CONSOLE_COMMANDS: AppCommand[] = CONSOLE_SECTIONS_V1.filter((section) => section !== 'extensions' && !RETIRED_SECTIONS_V1.has(section)).map((section: ConsoleSectionV1) => {
  const definition = CONSOLE_SECTION_TABLE_V1[section];
  return {
    id: definition.id,
    icon: '',
    label: `${definition.label} · ${definition.blurb}`,
    path: definition.path,
  };
});

// The frame's own places lead; every existing console destination stays reachable.
// Stocks already has its console command, including its existing deep links.
const STILL_COMMANDS: AppCommand[] = [
  ...STILL_TABS_V1.filter((tab) => tab.id !== 'stocks').map((tab) => ({
    id: `still-${tab.id}`,
    icon: '',
    label: tab.label,
    path: tab.path,
  })),
  { id: 'still-assistants', icon: '', label: STILL_ASSISTANTS_V1.label, path: STILL_ASSISTANTS_V1.path },
  { id: 'still-safety', icon: '', label: STILL_SAFETY_V1.label, path: STILL_SAFETY_V1.path },
];

export function appCommands(): AppCommand[] {
  return [...STILL_COMMANDS, ...CONSOLE_COMMANDS];
}
