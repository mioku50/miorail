import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { settingsStatusRowsV1, type SettingsServerStatusV1 } from '../src/console/settingsStatusRows';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, rel), 'utf8');

const STATUS: SettingsServerStatusV1 = {
  productMigration: { routeIntelligenceV1: true, paidIntelligence: false, earnRouteV1: false, b20ControlV1: true },
  chainId: 8453,
  chainEnv: 'mainnet',
  rpc: { status: 'connected', provider: 'rpc' },
  prices: { status: 'connected', provider: 'CoinGecko' },
  tokenBalances: { status: 'rate_limited', provider: 'Alchemy' },
  chain: { blockNumber: '36123456', gasPriceGwei: '0.004', observedAt: null, gasPoints: [], reason: 'ok' },
};

describe('Settings reads the server the same way on both surfaces', () => {
  test('a provider the server reports is listed with its state; one it never mentions is absent', () => {
    const rows = settingsStatusRowsV1(STATUS);
    assert.deepEqual(
      rows.providers.map((row) => [row.name, row.tone]),
      [
        ['Prices', 'ok'],
        ['Balances', 'off'],
      ],
    );
    assert.equal(rows.providers[0]!.label, 'CoinGecko · connected');
    // Risk and Approvals were never reported: not "broken", simply not there.
    assert.ok(!rows.providers.some((row) => row.name === 'Risk' || row.name === 'Approvals'));
  });

  test('network and the technical facts come from the report, and nothing is invented', () => {
    const rows = settingsStatusRowsV1(STATUS);
    assert.deepEqual(rows.network.map((row) => [row.label, row.value]), [
      ['Network', 'Base mainnet · 8453'],
      ['RPC', 'connected'],
      ['Block', '36123456'],
      ['Gas', '0.004 gwei'],
    ]);
    assert.deepEqual(rows.technical, [
      { label: 'Chain env', value: 'mainnet' },
      { label: 'Chain id', value: '8453' },
      { label: 'Paid intelligence', value: 'off' },
      { label: 'B20 Discover', value: 'on' },
    ]);
  });

  test('an unread status says so rather than reading as a healthy server', () => {
    const rows = settingsStatusRowsV1(null);
    assert.deepEqual(rows.providers, []);
    // "None listed" must not read as "none configured", and an adapter list
    // built from unread flags would draw all thirteen as switched off.
    assert.match(rows.providersUnavailableReason ?? '', /were not read/);
    assert.match(rows.adaptersUnavailableReason ?? '', /did not report its adapters/);
    assert.equal(settingsStatusRowsV1(STATUS).providersUnavailableReason, null);
    assert.equal(settingsStatusRowsV1(STATUS).adaptersUnavailableReason, null);
    assert.deepEqual(rows.network.map((row) => row.value), ['chain unknown', 'unknown', '—', '—']);
    assert.equal(rows.network[1]!.tone, 'off');
    assert.deepEqual(rows.technical.map((row) => row.value), ['not reported', 'not reported', 'off', 'off']);
  });

  test('signed out, the Base App asks for a wallet instead of drawing the server as switched off', () => {
    // The web keeps Settings behind its session gate; the Base App reaches it
    // from the drawer, where every read on it answers 401 to a visitor.
    const mini = read('../../../artifacts/miniapp/app/components/MiniConsole.tsx');
    const gate = mini.indexOf('section === "settings" && stocksSignedOut');
    assert.ok(gate > 0, 'the Base App renders Settings to a signed-out reader');
    assert.ok(gate < mini.indexOf('} else if (section === "settings") {'), 'the gate must come before the page');
    for (const surface of [mini, read('../../../artifacts/interface/src/features/settings/SettingsPage.tsx')]) {
      assert.match(surface, /adaptersUnavailableReason=\{statusRows\.adaptersUnavailableReason\}/);
    }
  });

  test('the web and the Base App both build Settings from the shared parts', () => {
    const web = read('../../../artifacts/interface/src/features/settings/SettingsPage.tsx');
    const mini = read('../../../artifacts/miniapp/app/components/MiniConsole.tsx');
    for (const [surface, source] of [
      ['web', web],
      ['Base App', mini],
    ] as const) {
      assert.match(source, /settingsStatusRowsV1\(/, `${surface} reads the status rows on its own`);
      assert.match(source, /<ConnectedAppsSettingsV1 \/>/, `${surface} wires Connected apps on its own`);
      assert.ok(!source.includes('useMcpHandoffGrants'), `${surface} keeps a second copy of the grants wiring`);
    }
  });
});
