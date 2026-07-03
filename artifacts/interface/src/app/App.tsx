import { useEffect } from 'react';
import { Route, Switch } from 'wouter';
import { useUiStore } from '../lib/state';
import { TopBar } from '../shell/TopBar';
import { CommandPalette } from '../shell/CommandPalette';
import { Toaster } from '../shell/Toast';
import { MainRoute } from '../features/MainRoute';
import { ActionsBuilder } from '../features/inbox/ActionsBuilder';
import { HistoryPage } from '../features/history/HistoryPage';
import { ConfigureView } from '../features/configure/ConfigureView';
import { BaseMcpView } from '../features/configure/BaseMcpView';
import { AutonomyCockpit } from '../features/autonomy/AutonomyCockpit';
import { FuelMeter } from '../features/x402/FuelMeter';

export function App() {
  const togglePalette = useUiStore((s) => s.togglePalette);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        togglePalette();
      }
      if (e.key === 'Escape') setPaletteOpen(false);
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [togglePalette, setPaletteOpen]);

  return (
    <div className="h-screen w-full flex flex-col font-sans">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        <Switch>
          <Route path="/build"><ActionsBuilder /></Route>
          <Route path="/history"><HistoryPage /></Route>
          <Route path="/configure"><ConfigureView /></Route>
          <Route path="/base-mcp"><BaseMcpView /></Route>
          <Route path="/autonomy"><AutonomyCockpit /></Route>
          <Route path="/fuel"><FuelMeter /></Route>
          <Route path="/inbox/:actionId">{(params) => <MainRoute actionId={params.actionId} />}</Route>
          <Route path="/"><MainRoute /></Route>
        </Switch>
      </div>
      <CommandPalette />
      <Toaster />
    </div>
  );
}

export default App;
