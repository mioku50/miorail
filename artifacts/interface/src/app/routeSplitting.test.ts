import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Every routed screen has to stay behind its own `import()`.
//
// This is a size test written as a source test, because the size only shows up
// somewhere nobody looks. All eleven screens were once imported at the top of
// App.tsx, which put the whole product — settings, the console, the B20 watch
// page, the wallet-confirm flow — into one 1.14 MB chunk that every visitor
// downloaded before anything rendered. Splitting them took the entry chunk to
// 475 kB, and a single re-added static import silently undoes it: the build
// still succeeds, the tests still pass, and the bundle is large again.
//
// `HomeRoute` is deliberately absent from this list. It is a redirect resolver
// rather than a screen, and making it lazy would put a network round trip in
// front of every visit to "/".
// ---------------------------------------------------------------------------

const LAZY_SCREENS_V1 = [
  'ActionsPage',
  'ActionsBuilder',
  'HistoryPage',
  'ExtensionsPage',
  'RouteHistoryPage',
  'RouteIntelligenceConsole',
  'PublicProofPage',
  'B20WatchPage',
  'OpportunitiesPage',
  'RwaDiscoverPage',
  'InvestigatePage',
  'MarketRealityPage',
  'MarketRealityRadarPage',
  'SettingsPage',
  'PublicMetricsPage',
] as const;

const app = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');

test('no routed screen is imported at the top of the router', () => {
  for (const screen of LAZY_SCREENS_V1) {
    const staticImport = new RegExp(`import\\s*{[^}]*\\b${screen}\\b[^}]*}\\s*from`);
    assert.ok(
      !staticImport.test(app),
      `${screen} is imported statically — it belongs in the entry chunk of nobody's browser`,
    );
  }
});

test('every routed screen is reached through its own dynamic import', () => {
  for (const screen of LAZY_SCREENS_V1) {
    const lazyBinding = new RegExp(`const ${screen} = lazy\\(\\(\\) =>\\s*\\n?\\s*import\\(`);
    assert.ok(lazyBinding.test(app), `${screen} has no lazy() binding`);
  }
});

test('the routed screens sit inside a Suspense boundary', () => {
  // Without one, React throws the moment a route is entered — a failure that
  // only appears on the second page a person visits.
  assert.match(app, /<Suspense fallback=\{<RoutePending \/>\}>/);
  assert.match(app, /<\/Suspense>/);
});
