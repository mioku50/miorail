import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAvantisProviderHandoffV1,
  handoffToRoutesReleasedV1,
  matchBaseMcpProviderIntentV1,
} from './baseMcpProviderRouting.js';
import { baseMcpRuntimeSnapshotV1 } from './baseMcpRuntimeSnapshot.js';
import { BASE_MCP_PROVIDER_INTENTS_V1, type BaseMcpRuntimeSnapshotV1 } from '@mioagent/security';

// The runtime is stated, never inherited from whatever machine runs the suite.
// Routing now DEPENDS on the deployment — that is the fix — so a test that read
// process.env would pass or fail on whether an Alchemy key happened to be set.

/** A deployment that can prove an ordered batch: every declared handoff holds. */
function fullyCapableRuntimeV1(): BaseMcpRuntimeSnapshotV1 {
  return {
    ...baseMcpRuntimeSnapshotV1({}),
    singleCallSimulationAvailable: true,
    batchSimulationAvailable: true,
  };
}

/** A deployment with no simulator at all: server-written calldata is unsignable. */
function noSimulatorRuntimeV1(): BaseMcpRuntimeSnapshotV1 {
  return {
    ...baseMcpRuntimeSnapshotV1({}),
    singleCallSimulationAvailable: false,
    batchSimulationAvailable: false,
  };
}

test('every reviewed catalogue example keeps its disposition on a fully capable runtime', () => {
  const runtime = fullyCapableRuntimeV1();
  for (const provider of BASE_MCP_PROVIDER_INTENTS_V1) {
    for (const example of provider.examples) {
      const match = matchBaseMcpProviderIntentV1(example.prompt, runtime);
      assert.equal(match?.pluginId, provider.pluginId, example.prompt);
      assert.equal(match?.exampleId, example.id, example.prompt);
      assert.equal(match?.disposition, example.disposition, example.prompt);
      if (example.surface === 'routable') {
        assert.equal(match?.disposition, 'handoff_to_routes', example.prompt);
      }
    }
  }
});

test('a declared handoff is downgraded when this runtime cannot finish it', () => {
  // The production failure, pinned. Aerodrome, Balancer, Hydrex and o1 all
  // carry server-written or opaque calldata that Miorail refuses to sign
  // unsimulated. With no simulator the journey ends at a Safety Kernel
  // refusal, so the console must say so HERE rather than walk the user into
  // a Review screen that always says no.
  const runtime = noSimulatorRuntimeV1();
  for (const prompt of [
    'Swap 0.001 ETH to USDC on Aerodrome',
    'Swap 100 USDC for WETH on Base through Balancer',
    'Swap 5 USDC to ETH on Hydrex',
    'Swap 10 USDC to ETH with o1.exchange on Base',
  ]) {
    const match = matchBaseMcpProviderIntentV1(prompt, runtime);
    assert.equal(match?.disposition, 'route_unavailable_here', prompt);
    assert.ok(match?.routeCapability, `${prompt} must carry the reason it was downgraded`);
    assert.match(match!.routeCapability!.reason, /simulation/i, prompt);
  }
});

test('a partner-built route still hands off with no simulator at all', () => {
  // Uniswap and KyberSwap calldata is built by the provider and signable on
  // static checks alone. Downgrading these too would be the opposite mistake.
  const runtime = noSimulatorRuntimeV1();
  for (const prompt of [
    'Swap 100 USDC to ETH with Uniswap on Base',
    'Compare a 100 USDC to ETH route using KyberSwap on Base',
    'Show YO Protocol vaults on Base',
  ]) {
    assert.equal(matchBaseMcpProviderIntentV1(prompt, runtime)?.disposition, 'handoff_to_routes', prompt);
  }
});

test('the handoff gate reports why it refused, not just that it did', () => {
  const gate = handoffToRoutesReleasedV1('balancer', noSimulatorRuntimeV1());
  assert.equal(gate.released, false);
  assert.equal(gate.capability.state, 'unavailable');
  assert.match(gate.capability.reason, /no simulation provider is configured/i);
});

test('provider-specific reads stay in Extensions while released adapters alone hand off to Routes', () => {
  const runtime = fullyCapableRuntimeV1();
  const balancer = matchBaseMcpProviderIntentV1('Show Balancer liquidity on Base', runtime);
  assert.equal(balancer?.productSurface, 'routes');
  assert.equal(balancer?.disposition, 'read_in_extensions');

  for (const prompt of [
    'Show YO Protocol vaults on Base',
    'Swap 5 USDC to ETH on Hydrex',
    'Get an o1.exchange quote on Base',
  ]) {
    const match = matchBaseMcpProviderIntentV1(prompt, runtime);
    assert.equal(match?.productSurface, 'routes', prompt);
    assert.equal(match?.disposition, 'handoff_to_routes', prompt);
  }
});

test('a named provider with no released route adapter never enters Routes AI', () => {
  const runtime = fullyCapableRuntimeV1();
  for (const prompt of [
    'Buy this Flaunch token with 0.001 ETH',
    'Buy the latest Bankr token with 5 USDC',
  ]) {
    // `adapter_required`, never `route_unavailable_here`: nobody wrote the
    // adapter, which is a different fact from a runtime that fell short.
    assert.equal(matchBaseMcpProviderIntentV1(prompt, runtime)?.disposition, 'adapter_required', prompt);
  }
});

test('provider ownership keeps the explicit extension family in Extensions', () => {
  const runtime = fullyCapableRuntimeV1();
  for (const provider of ['Avantis', 'Virtuals', 'Brickken', 'Clawnch', 'Flaunch', 'Printr', 'Bankr', 'GMGN']) {
    assert.equal(matchBaseMcpProviderIntentV1(`Show ${provider} status`, runtime)?.productSurface, 'extensions', provider);
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
