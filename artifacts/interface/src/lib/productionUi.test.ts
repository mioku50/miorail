import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function exists(relativePath: string): boolean {
  return existsSync(fileURLToPath(new URL(relativePath, import.meta.url)));
}

// The scanner-era cockpit, the separate configure page and the standalone
// Intelligence Budget page were DELETED, not hidden — these assertions pin the
// removal so nothing quietly reintroduces them.
test('the retired cockpit surfaces are deleted, not merely unlinked', () => {
  for (const relative of [
    '../features/cockpit/CockpitRoute.tsx',
    '../features/cockpit/OpsRail.tsx',
    '../features/cockpit/RiskQueue.tsx',
    '../features/cockpit/StatusBar.tsx',
    '../features/configure/ConfigureView.tsx',
    '../features/x402/FuelMeter.tsx',
    '../features/x402/FuelCard.tsx',
    '../features/autonomy/AutonomyCockpit.tsx',
    '../shell/TopBar.tsx',
    '../shell/TabBar.tsx',
  ]) {
    assert.equal(exists(relative), false, `${relative} must no longer exist`);
  }
});

test('the console is the app root and old entry points redirect into the flow', () => {
  const app = source('../app/App.tsx');
  assert.match(app, /<RouteIntelligenceConsole \/>/);
  // Mounted unconditionally: no fallback to a product that no longer exists.
  assert.equal(/routeIntelligenceEnabled/.test(app), false);
  for (const retired of ['/configure', '/fuel', '/autonomy', '/diagnostics']) {
    assert.ok(app.includes(`path="${retired}"`), `${retired} must still resolve`);
  }
  assert.equal(/CockpitRoute|OpsRail|FuelMeter|ConfigureView|BottomNav|TopBar/.test(app), false);
});

test('no surviving surface uses the retired vocabulary in navigation', () => {
  const routes = source('../app/routes.tsx');
  assert.equal(/cockpit|kill switch|\bscan\b/i.test(routes.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), false);
});

test('ordinary user surfaces do not regress to vendor or transport jargon', () => {
  const userCopy = [
    source('../features/portfolio/PortfolioCard.tsx'),
    source('../features/portfolio/PortfolioProviderChips.tsx'),
    source('../features/portfolio/ProtocolsCard.tsx'),
    source('../features/inbox/PortfolioAnalysisView.tsx'),
    source('../features/inbox/ApprovalAnalysisView.tsx'),
    source('../features/history/HistoryPage.tsx'),
  ].join('\n');
  for (const phrase of [
    'Alchemy rate-limited',
    'via Moralis',
    'via CoinGecko',
    'GoPlus connected',
    'Settlement ledger wired',
    'resolves on first payment',
    'database-backed',
    'Active & Live',
  ]) {
    assert.equal(userCopy.includes(phrase), false, `forbidden user-facing copy: ${phrase}`);
  }
});

test('Agent Stream exposes the Base MCP reconnect CTA outside diagnostics', () => {
  const stream = source('../features/stream/AgentStream.tsx');
  assert.match(stream, /baseMcpNeedsAuth\(statusData\?\.baseMcp\)/);
  assert.match(stream, /<BaseMcpConnectButton/);
  assert.match(stream, /returnTo="\/stream"/);
  assert.match(stream, /baseMcpConnectLabel\(statusData\?\.baseMcp\)/);
});
