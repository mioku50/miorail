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

// T67E — three surfaces. Budget & payments is deliberately absent: it is a
// drawer inside a flow, not a place you navigate to.
export const CONSOLE_NAV_TABS: AppRoute[] = [
  { path: '/', label: 'Routes' },
  { path: '/b20', label: 'B20' },
  { path: '/plan/history', label: 'Proofs' },
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
  { id: 'b20', icon: '', label: 'B20 control watch · what your tokens changed', path: '/b20' },
  { id: 'proofs', icon: '', label: 'Route proofs · execution history', path: '/plan/history' },
];

export function appCommands(): AppCommand[] {
  return CONSOLE_COMMANDS;
}
