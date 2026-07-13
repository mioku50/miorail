import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

test('production navigation hides operator diagnostics unless the build flag is enabled', () => {
  const app = source('../app/App.tsx');
  const routes = source('../app/routes.tsx');
  assert.match(app, /DIAGNOSTICS_ENABLED \? <ConfigureView diagnosticsOnly \/> : <Redirect to="\/configure" \/>/);
  assert.match(app, /DIAGNOSTICS_ENABLED && <StatusBar \/>/);
  assert.match(routes, /DIAGNOSTICS_ENABLED/);
  assert.match(routes, /Operator diagnostics/);
});

test('ordinary user surfaces do not regress to vendor or transport jargon', () => {
  const userCopy = [
    source('../features/cockpit/CockpitRoute.tsx'),
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

test('injected Base App sessions cannot launch an unsupported Spend Permission flow', () => {
  const fuel = source('../features/x402/FuelMeter.tsx');
  assert.match(fuel, /spendPermissionsSupported/);
  assert.match(fuel, /!spendPermissionsSupported/);
  assert.match(fuel, /No permission was created/);
  assert.match(fuel, /No permission was saved/);
});
