import { Link, useLocation } from 'wouter';
import { NAV_TABS } from '../app/routes';

// Each tab is a route (deep-linkable) rather than useState('main').
export function TabBar() {
  const [location] = useLocation();
  return (
    <div className="flex gap-1 ml-4">
      {NAV_TABS.map((tab) => {
        const active = tab.path === '/'
          ? location === '/' || location === '/autonomy'
          : tab.path === '/actions'
          ? location === '/actions' || location.startsWith('/inbox') || location === '/build'
          : location === tab.path || location.startsWith(`${tab.path}/`);
        return (
          <Link
            key={tab.path}
            href={tab.path}
            className={`px-[13px] py-[7px] rounded-[10px] text-[13px] font-medium transition-colors ${
              active ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-bg'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
