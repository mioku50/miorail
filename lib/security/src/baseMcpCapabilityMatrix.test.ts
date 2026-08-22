import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  baseMcpCapabilityMatrixV1,
  mayHandOffToRoutesV1,
  providerRouteCapabilityV1,
  type BaseMcpRuntimeSnapshotV1,
} from './baseMcpCapabilityMatrix.js';

function runtimeV1(overrides: Partial<BaseMcpRuntimeSnapshotV1> = {}): BaseMcpRuntimeSnapshotV1 {
  return {
    reviewedReadPlugins: ['bankr', 'venice'],
    releasedRouteProviders: ['uniswap', 'kyberswap', 'aerodrome', 'balancer'],
    simulationRequiredProviders: ['aerodrome', 'balancer'],
    singleCallSimulationAvailable: true,
    batchSimulationAvailable: true,
    releasedActionPlugins: [],
    providerUiPlugins: ['avantis'],
    typedX402Plugins: ['brickken'],
    ...overrides,
  };
}

// The invariant: nothing is `released` unless the runtime can carry that exact
// intent to its honest end point. Production violated it for two providers at
// once — a quote adapter existed, so the console offered a handoff, and the
// journey ended at a Safety Kernel refusal nobody could clear.

describe('a released route needs more than a quote adapter', () => {
  it('releases a partner-built route without any simulator', () => {
    const capability = providerRouteCapabilityV1('uniswap', runtimeV1({
      singleCallSimulationAvailable: false,
      batchSimulationAvailable: false,
    }));
    assert.equal(capability.state, 'released');
  });

  it('refuses a server-written route when no simulator can execute a batch', () => {
    const capability = providerRouteCapabilityV1('balancer', runtimeV1({ batchSimulationAvailable: false }));
    assert.equal(capability.state, 'unavailable');
    assert.match(capability.reason, /single-call simulator/i);
    assert.equal(mayHandOffToRoutesV1('balancer', runtimeV1({ batchSimulationAvailable: false })), false);
  });

  it('names the absence of any simulator differently from a narrow one', () => {
    const none = providerRouteCapabilityV1('aerodrome', runtimeV1({
      singleCallSimulationAvailable: false,
      batchSimulationAvailable: false,
    }));
    assert.equal(none.state, 'unavailable');
    assert.match(none.reason, /no simulation provider is configured/i);
  });

  it('releases a server-written route once a batch simulator is configured', () => {
    assert.equal(providerRouteCapabilityV1('aerodrome', runtimeV1()).state, 'released');
  });

  it('reports a provider with no adapter as unsupported, not unavailable', () => {
    // The two are different facts: nobody wrote it vs. it cannot finish here.
    const capability = providerRouteCapabilityV1('clawnch', runtimeV1());
    assert.equal(capability.state, 'unsupported');
  });
});

describe('the matrix answers for every published plugin', () => {
  it('covers the whole catalogue', () => {
    const rows = baseMcpCapabilityMatrixV1(runtimeV1());
    assert.equal(rows.length, 20);
    for (const row of rows) {
      for (const cell of Object.values(row.cells)) {
        assert.ok(cell.reason.length > 0, `${row.pluginId} ${cell.operation} has no reason`);
      }
    }
  });

  it('keeps a quote released while its route is not', () => {
    // Comparison genuinely works where signing does not, and saying so is the
    // honest version of the conflation this module replaced.
    const row = baseMcpCapabilityMatrixV1(runtimeV1({ batchSimulationAvailable: false }))
      .find((entry) => entry.pluginId === 'balancer')!;
    assert.equal(row.cells.quote.state, 'released');
    assert.equal(row.cells.routes.state, 'unavailable');
    assert.equal(row.cells.prepare.state, 'unavailable');
    assert.equal(row.cells.simulate.state, 'unavailable');
  });

  it('reports a read with no reviewed recipe as unavailable, not unsupported', () => {
    const row = baseMcpCapabilityMatrixV1(runtimeV1()).find((entry) => entry.pluginId === 'clawnch')!;
    assert.equal(row.cells.read.state, 'unavailable');
    assert.match(row.cells.read.reason, /Miorail has no reviewed recipe/i);
  });

  it('reports an x402 provider as requires_input rather than unsupported', () => {
    const row = baseMcpCapabilityMatrixV1(runtimeV1()).find((entry) => entry.pluginId === 'brickken')!;
    assert.equal(row.cells.action.state, 'requires_input');
  });

  it('reports a provider-UI write as external_ui', () => {
    const row = baseMcpCapabilityMatrixV1(runtimeV1()).find((entry) => entry.pluginId === 'avantis')!;
    assert.equal(row.cells.action.state, 'external_ui');
    assert.equal(row.cells.provider_ui.state, 'external_ui');
  });
});
