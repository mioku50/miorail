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
    // T67X-A4: the pre-console payment surfaces. PaidActionButton had no
    // importer, PlanPage's route already redirected into the flow, and
    // x402PaidFetch was a re-export kept alive only by the two of them.
    '../features/x402/PaidActionButton.tsx',
    '../features/plan/PlanPage.tsx',
    '../features/plan/EarnComparePanel.tsx',
    '../lib/x402PaidFetch.ts',
    '../features/autonomy/AutonomyCockpit.tsx',
    '../shell/TopBar.tsx',
    '../shell/TabBar.tsx',
    // Agent Stream: Base MCP and our own providers answering from one loop in
    // one voice. The Base MCP console exists because that voice could not say
    // which guarantee it was handing you, so keeping the old thread alongside
    // it would have preserved the exact confusion the split removed.
    '../features/stream/AgentStream.tsx',
    '../features/stream/StreamPage.tsx',
    '../features/stream/AgentComposer.tsx',
    '../features/stream/ChatMessage.tsx',
    '../features/stream/ToolCallTrace.tsx',
    '../features/stream/agentComposerState.ts',
    '../features/stream/chatMessageState.ts',
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

test('the Base MCP reconnect CTA lives outside diagnostics', () => {
  // The guarantee outlived the surface that used to carry it. Agent Stream is
  // gone — a Base MCP session that has expired must still be repairable from
  // the page that noticed, not from a settings screen the reader has no reason
  // to open.
  const extensions = source('../features/extensions/ExtensionsPage.tsx');
  assert.match(extensions, /<BaseMcpConnectButton/);
  assert.match(extensions, /Reconnect Base Account/);
  assert.match(extensions, /returnTo=\{consoleSectionPathV1\('extensions'\)\}/);

  // And from the console card itself, which is where an expired session is
  // actually reported.
  const card = source('../../../../lib/ui/src/console/BaseMcpConsoleCard.tsx');
  assert.match(card, /needs_reauth/);
  assert.match(card, /Connect Base Account/);
});
