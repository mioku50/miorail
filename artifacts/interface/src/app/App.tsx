import { useEffect } from 'react';
import { Route, Switch, Redirect } from 'wouter';
import { useStatus } from '@mioagent/api-client-react';
import { useUiStore } from '../lib/state';
import { CHAIN_ENV } from '../lib/chain';
import { CommandPalette } from '../shell/CommandPalette';
import { Toaster } from '../shell/Toast';
import { ActionsPage } from '../features/actions/ActionsPage';
import { StreamPage } from '../features/stream/StreamPage';
import { ActionsBuilder } from '../features/inbox/ActionsBuilder';
import { HistoryPage } from '../features/history/HistoryPage';
import { BaseMcpOAuthBridge } from './BaseMcpOAuthBridge';
import { RequireSession } from './RequireSession';
import { RouteHistoryPage } from '../features/plan/RouteHistoryPage';
import { RouteIntelligenceConsole } from '../features/console/RouteIntelligenceConsole';
import { PublicProofPage } from '../features/proof/PublicProofPage';
import { B20WatchPage } from '../features/b20/B20WatchPage';

// ---------------------------------------------------------------------------
// The Route Intelligence console IS the app.
//
// The scanner-era cockpit is gone, not hidden: the CAPABILITIES toggles, KILL
// SWITCH, SYSTEM AUTONOMY ENGINE, RISK QUEUE, AUTONOMY BOUNDARIES and LATEST
// AGENT TRACE blocks, and the separate cockpit / configure / intelligence-budget
// pages, were deleted with their files. Their content now lives in the console's
// left and right columns and on the Review screen, and the seven tabs have
// collapsed into two entries — the flow, and proofs.
//
// The console mounts UNCONDITIONALLY. It deliberately does not wait on
// productMigration.routeIntelligenceV1: that server flag gates the route
// intelligence API, and when it is off the console states that on the surface,
// the same way it states every other missing source — rather than falling back
// to a product that no longer exists.
// ---------------------------------------------------------------------------

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

/** Deep links that survive the migration but are no longer in the navigation.
 * They render plainly — the deleted chrome is not coming back. */
function DeepLink({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen w-full bg-bg font-sans">{children}</div>;
}

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
    <>
      <ChainEnvMismatchBanner />
      <Switch>
        {/* T67C.2: a published proof. NOT wrapped in RequireSession — a proof
            only its owner can open is not a proof anybody else can check. */}
        <Route path="/proof/:publicId">
          <PublicProofPage />
        </Route>

        {/* B20 — what the tokens you hold have done since Miorail last read
            them. Its own surface because it is not part of a route's flow. */}
        <Route path="/b20">
          <RequireSession>
            <B20WatchPage />
          </RequireSession>
        </Route>

        {/* Proofs — the console's third entry. */}
        <Route path="/plan/history">
          <RequireSession>
            <DeepLink>
              <RouteHistoryPage />
            </DeepLink>
          </RequireSession>
        </Route>

        {/* Surviving deep links, off-navigation. */}
        <Route path="/actions">
          <RequireSession>
            <DeepLink>
              <ActionsPage />
            </DeepLink>
          </RequireSession>
        </Route>
        <Route path="/actions/:actionId">
          {(params) => (
            <RequireSession>
              <DeepLink>
                <ActionsPage actionId={params.actionId} />
              </DeepLink>
            </RequireSession>
          )}
        </Route>
        <Route path="/stream">
          <RequireSession>
            <DeepLink>
              <StreamPage />
            </DeepLink>
          </RequireSession>
        </Route>
        <Route path="/build">
          <DeepLink>
            <ActionsBuilder />
          </DeepLink>
        </Route>
        <Route path="/history">
          <DeepLink>
            <HistoryPage />
          </DeepLink>
        </Route>
        <Route path="/inbox/:actionId">{(params) => <Redirect to={`/actions/${params.actionId}`} />}</Route>

        {/* Retired surfaces. Old bookmarks land on the flow instead of a 404. */}
        <Route path="/configure">{() => <Redirect to="/" />}</Route>
        <Route path="/fuel">{() => <Redirect to="/" />}</Route>
        <Route path="/autonomy">{() => <Redirect to="/" />}</Route>
        <Route path="/diagnostics">{() => <Redirect to="/" />}</Route>
        <Route path="/base-mcp">{() => <Redirect to="/" />}</Route>
        <Route path="/plan">{() => <Redirect to="/" />}</Route>

        {/* The flow. */}
        <Route>
          <RequireSession>
            <RouteIntelligenceConsole />
          </RequireSession>
        </Route>
      </Switch>
      <CommandPalette />
      <Toaster />
      <BaseMcpOAuthBridge />
    </>
  );
}

export default App;
