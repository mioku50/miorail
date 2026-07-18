import { useEffect, useState } from 'react';
import { Route, Switch, Redirect } from 'wouter';
import { useStatus } from '@mioagent/api-client-react';
import { useUiStore } from '../lib/state';
import { CHAIN_ENV } from '../lib/chain';
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
import { DIAGNOSTICS_ENABLED } from '../lib/diagnostics';
import { BaseMcpOAuthBridge } from './BaseMcpOAuthBridge';
import { RequireSession } from './RequireSession';
import { PlanPage } from '../features/plan/PlanPage';
import { RouteHistoryPage } from '../features/plan/RouteHistoryPage';

function ChainEnvMismatchBanner() {
  const { data: sd } = useStatus();
  const backendChainEnv = sd?.chainEnv;
  if (!backendChainEnv || backendChainEnv === CHAIN_ENV) return null;
  return (
    <div className="border-b border-warn/25 bg-warn-soft px-4 py-2 text-[12px] text-warn font-sans">
      Frontend/backend chain env mismatch: frontend <span className="font-mono font-bold">{CHAIN_ENV}</span>, API{' '}
      <span className="font-mono font-bold">{backendChainEnv}</span>. Rebuild the frontend or update VITE_CHAIN_ENV before signing x402 payments.
    </div>
  );
}

export function App() {
  const { data: statusData, isPending: statusPending } = useStatus();
  const routeIntelligenceEnabled = statusData?.productMigration.routeIntelligenceV1 === true;
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
      <ChainEnvMismatchBanner />

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
            {/* Private surfaces: gated behind a wallet session (T48a). Public
                routes (cockpit, diagnostics, build, history, base-mcp) stay
                reachable read-only, unauthenticated. */}
            <Route path="/actions"><RequireSession><ActionsPage /></RequireSession></Route>
            <Route path="/actions/:actionId">{(params) => <RequireSession><ActionsPage actionId={params.actionId} /></RequireSession>}</Route>
            <Route path="/stream"><RequireSession><StreamPage /></RequireSession></Route>
            <Route path="/fuel"><RequireSession><FuelMeter /></RequireSession></Route>
            <Route path="/configure"><RequireSession><ConfigureView /></RequireSession></Route>
            <Route path="/diagnostics">
              {DIAGNOSTICS_ENABLED ? <ConfigureView diagnosticsOnly /> : <Redirect to="/configure" />}
            </Route>
            <Route path="/build"><ActionsBuilder /></Route>
            <Route path="/history"><HistoryPage /></Route>
            <Route path="/base-mcp">
              {DIAGNOSTICS_ENABLED ? <BaseMcpView /> : <Redirect to="/configure" />}
            </Route>
            <Route path="/autonomy"><CockpitRoute /></Route>
            {/* T58: route history lives under /plan/history — the legacy
                /history page (chat + action inbox) is untouched. Same flag +
                session gate as /plan. */}
            <Route path="/plan/history">
              {statusPending
                ? <div className="flex flex-1 items-center justify-center text-sm text-ink-3">Checking route intelligence…</div>
                : routeIntelligenceEnabled
                  ? <RequireSession><RouteHistoryPage /></RequireSession>
                  : <Redirect to="/" />}
            </Route>
            <Route path="/plan">
              {statusPending
                ? <div className="flex flex-1 items-center justify-center text-sm text-ink-3">Checking route intelligence…</div>
                : routeIntelligenceEnabled
                  ? <RequireSession><PlanPage /></RequireSession>
                  : <Redirect to="/" />}
            </Route>
            {/* T19.2: /inbox/:actionId is a legacy alias — redirect to the
                canonical /actions/:actionId deep link (still focuses the card). */}
            <Route path="/inbox/:actionId">{(params) => <Redirect to={`/actions/${params.actionId}`} />}</Route>
            <Route path="/">{routeIntelligenceEnabled ? <Redirect to="/plan" /> : <CockpitRoute />}</Route>
          </Switch>
        </div>
      </div>

      {DIAGNOSTICS_ENABLED && <StatusBar />}
      <BottomNav />
      {/* Add bottom padding on mobile so content isn't hidden under bottom nav */}
      <CommandPalette />
      <Toaster />
      <BaseMcpOAuthBridge />
    </div>
  );
}

export default App;
