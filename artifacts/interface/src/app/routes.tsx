// Route + command tables — the single source of truth shared by TabBar and
// CommandPalette so deep-links and palette entries stay in sync.

export interface AppRoute {
  path: string;
  label: string;
}

export const NAV_TABS: AppRoute[] = [
  { path: '/', label: 'cockpit' },
  { path: '/actions', label: 'actions' },
  { path: '/stream', label: 'stream' },
  { path: '/fuel', label: 'fuel' },
  { path: '/configure', label: 'configure' },
];

export interface AppCommand {
  id: string;
  icon: string;
  label: string;
  path: string;
}

export const COMMANDS: AppCommand[] = [
  { id: 'cockpit', icon: '⏻', label: 'Autonomy cockpit', path: '/' },
  { id: 'actions', icon: '⚡', label: 'Action inbox · review', path: '/actions' },
  { id: 'stream', icon: '💬', label: 'Agent stream · chat', path: '/stream' },
  { id: 'fuel', icon: '⛽', label: 'x402 fuel meter', path: '/fuel' },
  { id: 'configure', icon: '🔑', label: 'Configure providers · keys', path: '/configure' },
  { id: 'scan', icon: '📡', label: 'Actions builder · scan', path: '/build' },
  { id: 'memory', icon: '🧠', label: 'Agent history · memory', path: '/history' },
];
