import { DIAGNOSTICS_ENABLED } from '../lib/diagnostics';

// Route + command tables — the single source of truth shared by TabBar and
// CommandPalette so deep-links and palette entries stay in sync.

export interface AppRoute {
  path: string;
  label: string;
}

/**
 * Rollback path, kept for ONE iteration.
 *
 * The Route Intelligence console is now the default surface: seven tabs
 * collapsed into two entries (the flow, and proofs). These legacy tabs are only
 * reachable when the operator explicitly sets VITE_LEGACY_NAV=true, and the
 * whole table is deleted once the console has ridden a release.
 */
export const LEGACY_NAV_TABS: AppRoute[] = [
  { path: '/', label: 'cockpit' },
  { path: '/actions', label: 'actions' },
  { path: '/stream', label: 'stream' },
  { path: '/fuel', label: 'intelligence budget' },
  { path: '/configure', label: 'configure' },
];

/** The console's own navigation: the flow and its proofs. Nothing else. */
export const CONSOLE_NAV_TABS: AppRoute[] = [
  { path: '/', label: 'flow' },
  { path: '/plan/history', label: 'proofs' },
];

export const LEGACY_NAV_ENABLED: boolean =
  String(import.meta.env?.VITE_LEGACY_NAV ?? '').trim().toLowerCase() === 'true';

/**
 * Inverted in the console migration: the new interface is the default and the
 * legacy tabs appear only behind the rollback flag.
 */
export function navTabsForRouteIntelligence(enabled: boolean): AppRoute[] {
  if (!enabled) return LEGACY_NAV_TABS;
  return LEGACY_NAV_ENABLED ? [...CONSOLE_NAV_TABS, ...LEGACY_NAV_TABS] : CONSOLE_NAV_TABS;
}

export interface AppCommand {
  id: string;
  icon: string;
  label: string;
  path: string;
}

// Legacy commands keep their historical labels; they are only listed while the
// rollback flag is on, and go away with LEGACY_NAV_TABS.
export const LEGACY_COMMANDS: AppCommand[] = [
  { id: 'cockpit', icon: '', label: 'Autonomy cockpit', path: '/' },
  { id: 'actions', icon: '', label: 'Action inbox · review', path: '/actions' },
  { id: 'stream', icon: '', label: 'Agent stream · chat', path: '/stream' },
  { id: 'fuel', icon: '', label: 'Intelligence Budget', path: '/fuel' },
  { id: 'configure', icon: '', label: 'Spending limits · safety', path: '/configure' },
  { id: 'memory', icon: '', label: 'Agent history', path: '/history' },
  ...(DIAGNOSTICS_ENABLED
    ? [{ id: 'diagnostics', icon: '', label: 'Operator diagnostics', path: '/diagnostics' }]
    : []),
];

/** Console commands. No emoji, and none of the retired scanner vocabulary. */
export const CONSOLE_COMMANDS: AppCommand[] = [
  { id: 'flow', icon: '', label: 'New goal · compare routes', path: '/' },
  { id: 'proofs', icon: '', label: 'Route proofs · execution history', path: '/plan/history' },
];

export function commandsForRouteIntelligence(enabled: boolean): AppCommand[] {
  if (!enabled) return LEGACY_COMMANDS;
  return LEGACY_NAV_ENABLED ? [...CONSOLE_COMMANDS, ...LEGACY_COMMANDS] : CONSOLE_COMMANDS;
}
