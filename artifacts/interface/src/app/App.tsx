import { lazy, Suspense, useEffect, useMemo } from 'react';
import { Route, Switch, Redirect } from 'wouter';
import { useStatus } from '@mioagent/api-client-react';
import { useUiStore } from '../lib/state';
import { CHAIN_ENV } from '../lib/chain';
import { CommandPalette } from '../shell/CommandPalette';
import { Toaster } from '../shell/Toast';
import { BaseMcpOAuthBridge } from './BaseMcpOAuthBridge';
import {
  baseMcpPopupMessageV1,
  deliverBaseMcpPopupResultV1,
  type BaseMcpOAuthMessageV1,
} from './baseMcpPopupHandoff';
import { RequireSession } from './RequireSession';
import { HomeRoute } from '../features/console/HomeRoute';


// ---------------------------------------------------------------------------
// Every screen behind the router is loaded when its route is entered.
//
// This was one 1.14 MB chunk holding every page in the product, so a visitor
// reading the public metrics page downloaded the settings screen, the console,
// the B20 watch page and the wallet-confirm flow before anything rendered. On a
// good connection that is invisible; on a bad one it is the whole experience,
// and the people most likely to be on a bad one are the ones we have never met.
//
// `HomeRoute` stays eager on purpose: it is a redirect resolver, not a screen,
// and making it lazy would put a network round trip in front of every visit to
// "/" before we even know where the visitor is going.
// ---------------------------------------------------------------------------

const ActionsPage = lazy(() =>
  import('../features/actions/ActionsPage').then((m) => ({ default: m.ActionsPage })),
);
const ActionsBuilder = lazy(() =>
  import('../features/inbox/ActionsBuilder').then((m) => ({ default: m.ActionsBuilder })),
);
const HistoryPage = lazy(() =>
  import('../features/history/HistoryPage').then((m) => ({ default: m.HistoryPage })),
);
const ExtensionsPage = lazy(() =>
  import('../features/extensions/ExtensionsPage').then((m) => ({ default: m.ExtensionsPage })),
);
const RouteHistoryPage = lazy(() =>
  import('../features/plan/RouteHistoryPage').then((m) => ({ default: m.RouteHistoryPage })),
);
const RouteIntelligenceConsole = lazy(() =>
  import('../features/console/RouteIntelligenceConsole').then((m) => ({ default: m.RouteIntelligenceConsole })),
);
const PublicProofPage = lazy(() =>
  import('../features/proof/PublicProofPage').then((m) => ({ default: m.PublicProofPage })),
);
const B20WatchPage = lazy(() =>
  import('../features/b20/B20WatchPage').then((m) => ({ default: m.B20WatchPage })),
);
const OpportunitiesPage = lazy(() =>
  import('../features/opportunities/OpportunitiesPage').then((m) => ({ default: m.OpportunitiesPage })),
);
const RwaDiscoverPage = lazy(() =>
  import('../features/rwa/RwaDiscoverPage').then((m) => ({ default: m.RwaDiscoverPage })),
);
const InvestigatePage = lazy(() =>
  import('../features/rwa/InvestigatePage').then((m) => ({ default: m.InvestigatePage })),
);
const SettingsPage = lazy(() =>
  import('../features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const PublicMetricsPage = lazy(() =>
  import('../features/metrics/PublicMetricsPage').then((m) => ({ default: m.PublicMetricsPage })),
);

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

/**
 * What sits there while a screen's own chunk arrives.
 *
 * Deliberately quiet and deliberately NOT a spinner: on a fast connection it is
 * never seen, and on a slow one a spinner claims progress it cannot measure.
 * `aria-busy` is what actually carries the state to anyone not looking at it.
 */
function RoutePending() {
  // No class: `console.css` owns the console vocabulary, and inventing a name
  // here would ship an element no stylesheet knows about.
  return <div aria-busy="true" aria-live="polite" />;
}

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

/**
 * The OAuth popup, which must never become a second copy of Miorail.
 *
 * Rendered INSTEAD of the app, decided from the URL before anything mounts.
 * Doing this inside an effect further down meant the router, the queries and
 * the Extensions page all rendered first — and when the close did not happen,
 * the user was left looking at a narrower duplicate of the console while the
 * window that opened it still said "connect again".
 */
function BaseMcpOAuthPopup({ message }: { message: BaseMcpOAuthMessageV1 }) {
  useEffect(() => {
    deliverBaseMcpPopupResultV1(message);
  }, [message]);
  // Shown only if `close()` was refused, which happens when the browser did
  // not consider this window script-opened.
  return (
    <main className="mio-console">
      <p className="note">Base Account authorization finished. You can close this window.</p>
    </main>
  );
}

export function App() {
  const togglePalette = useUiStore((s) => s.togglePalette);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  // Read once, before the router: a popup is not a session.
  const popupMessage = useMemo(() => baseMcpPopupMessageV1(window.location.search), []);

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

  if (popupMessage) return <BaseMcpOAuthPopup message={popupMessage} />;

  return (
    <>
      <ChainEnvMismatchBanner />
      <Suspense fallback={<RoutePending />}>
      <Switch>
        {/* Public aggregate telemetry. No tenant, wallet or session: grant
            reviewers and builders can inspect what Miorail has actually
            measured and reconciled without entering the product. */}
        <Route path="/metrics">
          <PublicMetricsPage />
        </Route>

        {/* T67C.2: a published proof. NOT wrapped in RequireSession — a proof
            only its owner can open is not a proof anybody else can check. */}
        <Route path="/proof/:publicId">
          <PublicProofPage />
        </Route>

        {/* Phase 6 — Discover opens on the official corpus: assets an issuer
            publishes, what it costs to get back out of one, what has changed,
            and which contracts are wearing an official name.

            The launch feed below is not deleted — it is the deepest thing
            Miorail has measured. It is no longer the first screen, because a
            contract anybody can deploy is not an asset an issuer publishes.
            The more specific path is declared FIRST: wouter matches in order,
            and `/opportunities` would otherwise swallow nothing while
            `/opportunities/launches` fell through to the 404. */}
        <Route path="/opportunities/launches">
          <RequireSession>
            <OpportunitiesPage />
          </RequireSession>
        </Route>
        <Route path="/opportunities">
          <RequireSession>
            <RwaDiscoverPage />
          </RequireSession>
        </Route>

        {/* Phase 7 — one address, read as deeply as the evidence allows. The
            address lives in `?token=`, so a refresh, a Back press and a link
            from Discover all land on the same read. */}
        <Route path="/investigate">
          <RequireSession>
            <InvestigatePage />
          </RequireSession>
        </Route>

        {/* Portfolio — the B20 tokens you hold and what their controls have
            done since. No longer buried inside a technical tab called B20. */}
        <Route path="/portfolio">
          <RequireSession>
            <B20WatchPage />
          </RequireSession>
        </Route>

        {/* Extensions — the Base MCP plugin catalogue. Read and classify; the
            approval of any write tool happens in Base Account, never here. */}
        <Route path="/extensions">
          <RequireSession>
            <ExtensionsPage />
          </RequireSession>
        </Route>

        {/* Routes — the goal flow. It kept "/" for two releases; the section
            now has a name of its own so home can be decided rather than
            assumed. */}
        <Route path="/routes">
          <RequireSession>
            <RouteIntelligenceConsole />
          </RequireSession>
        </Route>

        {/* T70 §2/§3 — Budget & payments, adapters, providers, network and the
            technical block. Off the flow, in the place people look for things
            they configure. */}
        <Route path="/settings">
          <RequireSession>
            <SettingsPage />
          </RequireSession>
        </Route>

        {/* The old B20 path. Bookmarked by anyone who used the tab. */}
        <Route path="/b20">{() => <Redirect to="/portfolio" replace />}</Route>

        {/* Activity — route runs, paid intelligence, and proofs once a route
            is signed. No longer wrapped in DeepLink: it renders its own
            ConsoleShell, so opening it from the drawer keeps the navigation
            instead of stranding the reader on a page with one back link. */}
        <Route path="/plan/history">
          <RequireSession>
            <RouteHistoryPage />
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

        {/* The mixed thread. Base MCP and our own providers answered from one
            loop in one voice, which is the confusion the Base MCP console was
            built to end — so the console is where it goes, not Routes. Nothing
            linked here; it was reachable only by typing the URL, and the last
            message anyone sent was 2026-07-13. */}
        <Route path="/stream">{() => <Redirect to="/extensions" replace />}</Route>
        <Route path="/configure">{() => <Redirect to="/routes" replace />}</Route>
        <Route path="/fuel">{() => <Redirect to="/routes" replace />}</Route>
        <Route path="/autonomy">{() => <Redirect to="/routes" replace />}</Route>
        <Route path="/diagnostics">{() => <Redirect to="/settings" replace />}</Route>
        <Route path="/base-mcp">{() => <Redirect to="/settings" replace />}</Route>
        <Route path="/plan">{() => <Redirect to="/routes" replace />}</Route>

        {/* "/" resolves to a section rather than BEING one. Everything else
            falls through to the flow, which is the safe surface: it needs no
            wallet, no Discover and no stored evidence to be useful. */}
        <Route path="/">
          <RequireSession>
            <HomeRoute />
          </RequireSession>
        </Route>
        <Route>
          <RequireSession>
            <RouteIntelligenceConsole />
          </RequireSession>
        </Route>
      </Switch>
      </Suspense>
      <CommandPalette />
      <Toaster />
      <BaseMcpOAuthBridge />
    </>
  );
}

export default App;
