import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAvantisProviderHandoffV1,
  matchBaseMcpProviderIntentV1,
} from './baseMcpProviderRouting.js';
import { BASE_MCP_PROVIDER_INTENTS_V1 } from '@mioagent/security';

test('every reviewed catalogue example keeps its exact routing disposition', () => {
  for (const provider of BASE_MCP_PROVIDER_INTENTS_V1) {
    for (const example of provider.examples) {
      const match = matchBaseMcpProviderIntentV1(example.prompt);
      assert.equal(match?.pluginId, provider.pluginId, example.prompt);
      assert.equal(match?.exampleId, example.id, example.prompt);
      assert.equal(match?.disposition, example.disposition, example.prompt);
      if (example.surface === 'routable') {
        assert.equal(match?.disposition, 'handoff_to_routes', example.prompt);
      }
    }
  }
});

test('provider ownership routes Balancer, YO, Hydrex and o1.exchange to Routes', () => {
  for (const prompt of [
    'Show Balancer liquidity on Base',
    'Show YO Protocol vaults on Base',
    'Swap 5 USDC to ETH on Hydrex',
    'Get an o1.exchange quote on Base',
  ]) {
    const match = matchBaseMcpProviderIntentV1(prompt);
    assert.equal(match?.productSurface, 'routes', prompt);
    assert.equal(match?.disposition, 'handoff_to_routes', prompt);
  }
});

test('provider ownership keeps the explicit extension family in Extensions', () => {
  for (const provider of ['Avantis', 'Virtuals', 'Brickken', 'Clawnch', 'Flaunch', 'Printr', 'Bankr', 'GMGN']) {
    assert.equal(matchBaseMcpProviderIntentV1(`Show ${provider} status`)?.productSurface, 'extensions', provider);
  }
});

test('Avantis write intent becomes a fixed provider UI handoff with parsed facts', () => {
  const handoff = buildAvantisProviderHandoffV1('Open a 10x long BTC/USD with 100 USDC on Avantis');
  assert.ok(handoff);
  assert.equal(handoff.path, 'https://www.avantisfi.com/trade?asset=BTC-USD');
  assert.match(handoff.summary, /10x/);
  assert.match(handoff.summary, /100 USDC/);
  assert.equal(handoff.risk, 'liquidation');
});

test('Avantis never invents BTC when the market is missing or unrecognized', () => {
  assert.equal(buildAvantisProviderHandoffV1('Open a long on Avantis'), null);
  assert.equal(buildAvantisProviderHandoffV1('Open DOGE/USD on Avantis'), null);
});
