import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAvantisProviderHandoffV1,
  matchBaseMcpProviderIntentV1,
} from './baseMcpProviderRouting.js';

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
  assert.equal(handoff.path, 'https://www.avantisfi.com/trade?asset=BTC-USD');
  assert.match(handoff.summary, /10x/);
  assert.match(handoff.summary, /100 USDC/);
  assert.equal(handoff.risk, 'liquidation');
});
