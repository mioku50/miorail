import { Link, useLocation } from 'wouter';
import { Monitor, Zap, MessageSquare, Fuel, Settings } from 'lucide-react';
import { NAV_TABS } from '../app/routes';

const TAB_ICONS = [Monitor, Zap, MessageSquare, Fuel, Settings];

function isTabActive(tab: { path: string }, location: string): boolean {
  return tab.path === '/'
    ? location === '/' || location === '/autonomy'
    : tab.path === '/actions'
    ? location === '/actions' || location.startsWith('/actions/') || location.startsWith('/inbox') || location === '/build'
    : location === tab.path || location.startsWith(`${tab.path}/`);
}

// Pill-style horizontal tab bar (used in TopBar on md+)
export function TabBar() {
  const [location] = useLocation();
  return (
    <div className="flex gap-0.5 ml-2">
      {NAV_TABS.map((tab) => {
        const active = isTabActive(tab, location);
        return (
          <Link
            key={tab.path}
            href={tab.path}
            className={`px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors duration-150 ${
              active ? 'bg-accent-soft text-accent-2' : 'text-ink-2 hover:text-ink hover:bg-panel-2'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

// Fixed bottom navigation for <md screens
export function BottomNav() {
  const [location] = useLocation();
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-30 md:hidden flex items-center justify-around px-2 pb-[env(safe-area-inset-bottom,0px)]"
      style={{
        background: 'color-mix(in srgb, var(--color-panel) 85%, transparent)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderTop: '1px solid var(--color-line)',
      }}
    >
      {NAV_TABS.map((tab, idx) => {
        const active = isTabActive(tab, location);
        const Icon = TAB_ICONS[idx];
        return (
          <Link
            key={tab.path}
            href={tab.path}
            className={`flex flex-col items-center gap-0.5 py-2 px-3 min-w-0 transition-colors duration-150 ${
              active ? 'text-accent-2' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            <Icon size={20} strokeWidth={active ? 2.5 : 1.75} />
            <span className={`text-[10px] font-medium capitalize ${active ? 'text-accent-2' : 'text-ink-3'}`}>
              {tab.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
