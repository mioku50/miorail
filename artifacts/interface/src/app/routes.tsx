// Route + command tables — the single source of truth shared by TabBar and
// CommandPalette so deep-links and palette entries stay in sync.

export interface AppRoute {
  path: string;
  label: string;
}

export const NAV_TABS: AppRoute[] = [
  { path: '/', label: 'main' },
  { path: '/build', label: 'actions builder' },
  { path: '/history', label: 'history' },
  { path: '/configure', label: 'configure' },
  { path: '/base-mcp', label: 'base mcp' },
];

export interface AppCommand {
  id: string;
  icon: string;
  label: string;
  path: string;
}

export const COMMANDS: AppCommand[] = [
  { id: 'scan', icon: '⚡', label: 'Review tokens', path: '/build' },
  { id: 'scanner', icon: '📡', label: 'New scanner', path: '/build' },
  { id: 'positions', icon: '📈', label: 'Open positions', path: '/' },
  { id: 'memory', icon: '🧠', label: 'Edit memory', path: '/history' },
  { id: 'keys', icon: '🔑', label: 'Session keys · autonomy', path: '/configure' },
  { id: 'autonomy', icon: '⏻', label: 'Autonomy cockpit', path: '/autonomy' },
  { id: 'fuel', icon: '⛽', label: 'x402 fuel meter', path: '/fuel' },
];
