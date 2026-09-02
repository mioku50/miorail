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

// ---------------------------------------------------------------------------
// A file git thinks is binary is a file nobody reviewed.
//
// Six source files carried a raw NUL byte, written as a separator inside a
// string literal — `parts.join('\0')` — instead of the `\u0000` escape. Git
// treats a NUL in the first 8,000 bytes as binary, so those files had no line
// diffs, no merges and no reviewable history. One of them was the shared Stocks
// console; another computed the deterministic id of every audit row we have
// ever written, where an invisible byte is one whitespace pass away from
// silently changing all of them.
//
// The value is identical either way. Only the reviewability differs.
// ---------------------------------------------------------------------------

test('no tracked source file hides a NUL byte from git', () => {
  const offenders: string[] = [];
  for (const file of sourceFilesV1(root)) {
    if (readFileSync(file).includes(0)) offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, [], `write \\u0000 rather than a raw NUL: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// A freeze a deploy silently lifts is worse than no freeze.
//
// Phase 17 stopped and disabled the two B20 ingestion workers and set a flag so
// the surface says the feed was frozen by decision. The very next deploy
// re-enabled and restarted both, while the flag stayed set — so /status kept
// answering `feed_frozen` about workers that were reading again. One state is
// held in the env file; the deploy has to read the same file.
// ---------------------------------------------------------------------------

test('a frozen launch feed survives a deploy', () => {
  const deploy = source('ops/deploy.sh');
  assert.match(deploy, /MIORAIL_B20_LAUNCH_FEED_FROZEN_V1/);
  // Disabled, not merely stopped: an enabled-but-stopped unit returns on the
  // next reboot, which is a freeze with an expiry nobody chose.
  assert.match(deploy, /systemctl disable --now "\$\{B20_INGESTION_SERVICES\[@\]\}"/);
  // And the restart loop must not hold them either, or the disable above is
  // undone one step later by `systemctl restart`.
  const services = /^SERVICES=\(([^)]*)\)/m.exec(deploy)?.[1] ?? '';
  assert.doesNotMatch(services, /b20-discover|b20-measure/);
  assert.match(deploy, /SERVICES\+=\("\$\{B20_INGESTION_SERVICES\[@\]\}"\)/);
});

test('the production build injects one validated public Builder Code into web and Base App', () => {
  const deploy = source('ops/deploy.sh');
  assert.match(deploy, /VITE_BASE_BUILDER_CODE="\$public_builder_code"/);
  assert.match(deploy, /NEXT_PUBLIC_BASE_BUILDER_CODE="\$public_builder_code"/);
  assert.match(deploy, /refusing an ambiguously attributed build/);
  assert.doesNotMatch(deploy, /source\s+[^\n]*\.env/);
});

// ---------------------------------------------------------------------------
// An OAuth endpoint the edge does not forward is an endpoint that does not
// exist.
//
// Every path MCP OAuth publishes lives at the API root, and the Nginx snippet
// forwarded only /api/, /mcp and /health. The server was complete and
// correct; a client asking miorail.xyz where to authorize got the SPA's HTML
// and reported a broken server. Code and edge config are one fact, so they are
// asserted together — and the deploy is required to check it against the
// public origin rather than against the app.
// ---------------------------------------------------------------------------

test('every published MCP OAuth path is forwarded by the edge and verified by the deploy', () => {
  const nginx = source('ops/nginx/miorail-app.conf');
  const deploy = source('ops/deploy.sh');

  // The paths the MCP SDK's auth router mounts from the advertised metadata.
  for (const location of [
    'location ^~ /authorize',
    'location ^~ /token',
    'location ^~ /register',
    'location ^~ /revoke',
    'location ^~ /.well-known/oauth-',
  ]) {
    assert.ok(nginx.includes(location), `Nginx does not forward ${location}`);
  }
  // Forwarding it to the static bundle would satisfy the check above and break
  // the flow, so the API is named too.
  const oauthBlock = nginx.slice(nginx.indexOf('location ^~ /authorize'));
  assert.match(oauthBlock.slice(0, 400), /proxy_pass http:\/\/127\.0\.0\.1:8080;/);

  assert.match(deploy, /\.well-known\/oauth-protected-resource\/mcp\/private/);
  assert.match(deploy, /\.well-known\/oauth-authorization-server/);
  assert.match(deploy, /code_challenge_methods_supported/);
  // The discriminator that catches the SPA answering: a bare /authorize must
  // be refused as a bad OAuth request, never rendered as a page.
  assert.match(deploy, /the SPA is still serving it/);
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
