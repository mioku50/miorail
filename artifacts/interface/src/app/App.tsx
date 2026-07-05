import { useEffect, useState } from 'react';
import { Route, Switch, Redirect } from 'wouter';
import { useUiStore } from '../lib/state';
import { TopBar } from '../shell/TopBar';
import { BottomNav } from '../shell/TabBar';
import { CommandPalette } from '../shell/CommandPalette';
import { Toaster } from '../shell/Toast';
import { CockpitRoute } from '../features/cockpit/CockpitRoute';
import { OpsRail } from '../features/cockpit/OpsRail';
import { StatusBar } from '../features/cockpit/StatusBar';
import { ActionsPage } from '../features/actions/ActionsPage';
import { StreamPage } from '../features/stream/StreamPage';
import { ActionsBuilder } from '../features/inbox/ActionsBuilder';
import { HistoryPage } from '../features/history/HistoryPage';
import { ConfigureView } from '../features/configure/ConfigureView';
import { BaseMcpView } from '../features/configure/BaseMcpView';
import { FuelMeter } from '../features/x402/FuelMeter';

export function App() {
  const togglePalette = useUiStore((s) => s.togglePalette);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        togglePalette();
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        setDrawerOpen(false);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [togglePalette, setPaletteOpen]);

  // Close drawer when viewport grows to lg
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) setDrawerOpen(false);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return (
    /* Desktop: h-screen overflow-hidden; mobile: natural scroll */
    <div className="w-full flex flex-col font-sans lg:h-screen lg:overflow-hidden">
      <TopBar onHamburgerClick={() => setDrawerOpen((v) => !v)} drawerOpen={drawerOpen} />

      {/* Mobile drawer overlay */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <div className="flex-1 flex lg:overflow-hidden min-h-0">
        {/* OpsRail: fixed sidebar on lg; slide-over drawer on <lg */}
        <div
          className={[
            'fixed top-0 left-0 h-full z-50 transition-transform duration-200 ease-out',
            'lg:static lg:translate-x-0 lg:z-auto lg:h-auto',
            drawerOpen ? 'translate-x-0' : '-translate-x-full',
          ].join(' ')}
        >
          <OpsRail onClose={() => setDrawerOpen(false)} />
        </div>

        <div className="flex-1 flex overflow-hidden min-h-0">
          <Switch>
            <Route path="/actions"><ActionsPage /></Route>
            <Route path="/actions/:actionId">{(params) => <ActionsPage actionId={params.actionId} />}</Route>
            <Route path="/stream"><StreamPage /></Route>
            <Route path="/fuel"><FuelMeter /></Route>
            <Route path="/configure"><ConfigureView /></Route>
            <Route path="/build"><ActionsBuilder /></Route>
            <Route path="/history"><HistoryPage /></Route>
            <Route path="/base-mcp"><BaseMcpView /></Route>
            <Route path="/autonomy"><CockpitRoute /></Route>
            {/* T19.2: /inbox/:actionId is a legacy alias — redirect to the
                canonical /actions/:actionId deep link (still focuses the card). */}
            <Route path="/inbox/:actionId">{(params) => <Redirect to={`/actions/${params.actionId}`} />}</Route>
            <Route path="/"><CockpitRoute /></Route>
          </Switch>
        </div>
      </div>

      <StatusBar />
      <BottomNav />
      {/* Add bottom padding on mobile so content isn't hidden under bottom nav */}
      <CommandPalette />
      <Toaster />
    </div>
  );
}

export default App;
