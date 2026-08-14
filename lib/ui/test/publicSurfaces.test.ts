import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// Attribution is checked by DISCOVERY, not against a list.
//
// A named list of four files is a list of the surfaces we already remembered.
// ERC-8021 attribution fails silently — no error, no warning, just data that
// never arrives — so the surface most likely to lose it is the one nobody has
// written down yet. This finds every wallet call site in the repository and
// requires each one to wire a dataSuffix.
// ---------------------------------------------------------------------------

const SKIP_DIRS_V1 = new Set(['.git', 'node_modules', 'dist', '.next', 'coverage', 'screen', 'contracts']);

function sourceFilesV1(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS_V1.has(entry)) continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      sourceFilesV1(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

test('every wallet call site in the repository wires ERC-8021 attribution', () => {
  const unattributed: string[] = [];
  for (const file of sourceFilesV1(root)) {
    const text = readFileSync(file, 'utf8');
    // The wagmi hook is the only way this repo reaches wallet_sendCalls, so
    // holding it is what makes a file a wallet call site.
    if (!/\buseSendCalls\s*\(/.test(text)) continue;
    const attributed =
      /dataSuffix:\s*\{\s*value:/.test(text) ||
      // A hook may take the suffix as a prop and attach it from there.
      /capabilities:\s*dataSuffix/.test(text);
    if (!attributed) unattributed.push(path.relative(root, file));
  }
  assert.deepEqual(
    unattributed,
    [],
    'a wallet_sendCalls surface with no dataSuffix loses Builder Code attribution silently',
  );
});

test('every remaining Base Account call surface receives ERC-8021 attribution', () => {
  const b20 = source('artifacts/interface/src/features/b20/B20WatchPage.tsx');
  const mini = source('artifacts/miniapp/app/components/MiniConsole.tsx');
  const earn = source('artifacts/miniapp/app/components/EarnComparePanel.tsx');
  const routeHome = source('artifacts/miniapp/app/components/RoutePlanHome.tsx');

  for (const walletSurface of [b20, mini]) {
    assert.match(walletSurface, /builderCodeToDataSuffix/);
    assert.match(walletSurface, /dataSuffix:\s*\{\s*value:/);
    assert.match(walletSurface, /optional:\s*true/);
  }
  assert.match(earn, /builderCode=\{builderCode\}/);
  assert.match(routeHome, /builderCode=\{BUILDER_CODE\}/);
});

test('the production build injects one validated public Builder Code into web and Base App', () => {
  const deploy = source('ops/deploy.sh');
  assert.match(deploy, /VITE_BASE_BUILDER_CODE="\$public_builder_code"/);
  assert.match(deploy, /NEXT_PUBLIC_BASE_BUILDER_CODE="\$public_builder_code"/);
  assert.match(deploy, /refusing an ambiguously attributed build/);
  assert.doesNotMatch(deploy, /source\s+[^\n]*\.env/);
});

test('Metrics is sessionless on web and shared with the Base App', () => {
  const app = source('artifacts/interface/src/app/App.tsx');
  const miniMetrics = source('artifacts/miniapp/app/metrics/page.tsx');
  const dashboard = source('lib/ui/src/PublicMetricsDashboard.tsx');
  const publicRoute = app.indexOf('<Route path="/metrics">');
  const firstSessionGate = app.indexOf('<RequireSession>');

  assert.ok(publicRoute >= 0 && publicRoute < firstSessionGate, 'Metrics must render before any session gate');
  assert.match(miniMetrics, /PublicMetricsDashboard/);
  assert.match(dashboard, /What Miorail has actually/);
  assert.match(dashboard, /snapshot\.snapshotHash/);
  assert.match(dashboard, /not page views/);
});
