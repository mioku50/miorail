// Route + command tables — the single source of truth shared by the console
// shell and the CommandPalette so deep-links and palette entries stay in sync.
//
// Seven tabs have collapsed into two entries. The scanner-era cockpit,
// configure and intelligence-budget pages were deleted, so there is no longer a
// LEGACY_NAV_TABS / LEGACY_COMMANDS table to fall back to — the console is the
// product. No emoji, and none of the retired vocabulary.

export interface AppRoute {
  path: string;
  label: string;
}

export const CONSOLE_NAV_TABS: AppRoute[] = [
  { path: '/', label: 'flow' },
  { path: '/plan/history', label: 'proofs' },
];

export function navTabs(): AppRoute[] {
  return CONSOLE_NAV_TABS;
}

export interface AppCommand {
  id: string;
  icon: string;
  label: string;
  path: string;
}

export const CONSOLE_COMMANDS: AppCommand[] = [
  { id: 'flow', icon: '', label: 'New goal · compare routes', path: '/' },
  { id: 'proofs', icon: '', label: 'Route proofs · execution history', path: '/plan/history' },
];

export function appCommands(): AppCommand[] {
  return CONSOLE_COMMANDS;
}
